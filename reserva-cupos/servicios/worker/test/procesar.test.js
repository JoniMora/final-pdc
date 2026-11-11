const test = require("node:test");
const assert = require("node:assert/strict");
const { crearValidadorDeMensajes } = require("../../../compartido/src/contrato");
const { procesar, INTENTOS } = require("../src/procesar");
const { ErrorDeDatos } = require("../src/modelo");

const ID = "0193a4b2-7c1d-7e2f-8a3b-4c5d6e7f8091";
const validar = crearValidadorDeMensajes();

function mensaje(datos) {
    return Buffer.from(JSON.stringify(datos));
}

function dependencias(acciones, extra = {}) {
    return {
        validar,
        acciones,
        marcarFallida: async () => ({ estado: "fallida" }),
        esErrorDeInfraestructura: error => error.code === "ECONNREFUSED",
        esperar: async () => {},
        ...extra
    };
}

const reservar = { comando: "reservar", cambio_id: 3, tenant_id: ID, reserva_id: ID, actividad_id: ID };

test("un comando válido se ejecuta y se confirma", async () => {
    const r = await procesar(mensaje(reservar), dependencias({ reservar: async () => ({ estado: "confirmada" }) }));

    assert.equal(r.accion, "ack");
    assert.equal(r.resultado.estado, "confirmada");
});

test("un mensaje fuera de contrato va a la DLQ sin ejecutarse", async () => {
    let ejecutado = false;
    const acciones = { reservar: async () => { ejecutado = true; } };

    for (const contenido of [
        Buffer.from("no es JSON"),
        mensaje({ ...reservar, reserva_id: "123" }),
        mensaje({ ...reservar, comando: "borrar" })
    ]) {
        assert.equal((await procesar(contenido, dependencias(acciones))).accion, "dlq");
    }

    assert.equal(ejecutado, false);
});

test("un error de infraestructura reencola sin consumir reintentos", async () => {
    let llamadas = 0;
    const error = Object.assign(new Error("caída"), { code: "ECONNREFUSED" });
    const r = await procesar(mensaje(reservar), dependencias({ reservar: async () => { llamadas++; throw error; } }));

    assert.equal(r.accion, "reencolar");
    assert.equal(llamadas, 1);
});

test("una reserva inexistente va a la DLQ sin reintentos", async () => {
    let llamadas = 0;
    const r = await procesar(mensaje(reservar), dependencias({
        reservar: async () => { llamadas++; throw new ErrorDeDatos("no existe"); }
    }));

    assert.equal(r.accion, "dlq");
    assert.equal(llamadas, 1);
});

test("agotados los reintentos, un reservar deja la reserva fallida", async () => {
    let llamadas = 0;
    let marcada = false;
    const r = await procesar(mensaje(reservar), dependencias(
        { reservar: async () => { llamadas++; throw new Error("dato corrupto"); } },
        { marcarFallida: async () => { marcada = true; return { estado: "fallida" }; } }
    ));

    assert.equal(llamadas, INTENTOS);
    assert.equal(marcada, true);
    assert.equal(r.accion, "ack");
    assert.equal(r.resultado.estado, "fallida");
});

test("agotados los reintentos, un cancelar va a la DLQ y no se marca fallida", async () => {
    let marcada = false;
    const r = await procesar(
        mensaje({ ...reservar, comando: "cancelar" }),
        dependencias(
            { cancelar: async () => { throw new Error("inconsistencia"); } },
            { marcarFallida: async () => { marcada = true; } }
        )
    );

    assert.equal(r.accion, "dlq");
    assert.equal(marcada, false);
});
