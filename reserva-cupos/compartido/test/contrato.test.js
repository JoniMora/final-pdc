const test = require("node:test");
const assert = require("node:assert/strict");
const { crearValidadorDeMensajes, crearContratoHttp, ErrorDeContrato } = require("../src/contrato");

const ID = "0193a4b2-7c1d-7e2f-8a3b-4c5d6e7f8091";

const reserva = {
    id: ID,
    actividad_id: ID,
    participante: "alumno-1",
    estado: "confirmada",
    version: 2,
    metadata: null,
    creado_en: "2026-11-07T12:00:00.000Z"
};

test("un comando reservar válido cumple el contrato de mensajería", () => {
    const validar = crearValidadorDeMensajes();
    const comando = { comando: "reservar", cambio_id: 7, tenant_id: ID, reserva_id: ID, actividad_id: ID };

    assert.deepEqual(validar("ComandoReservar", comando), comando);
});

test("un comando sin reserva_id o con campos de más se rechaza", () => {
    const validar = crearValidadorDeMensajes();

    assert.throws(
        () => validar("ComandoReservar", { comando: "reservar", tenant_id: ID, actividad_id: ID }),
        ErrorDeContrato
    );
    assert.throws(
        () => validar("ComandoCancelar", { comando: "cancelar", tenant_id: ID, reserva_id: ID, actividad_id: ID, extra: 1 }),
        ErrorDeContrato
    );
    assert.throws(
        () => validar("ComandoCancelar", { comando: "reservar", tenant_id: ID, reserva_id: ID, actividad_id: ID }),
        ErrorDeContrato
    );
});

test("la entrega de webhook reutiliza el evento definido en openapi.yaml", () => {
    const validar = crearValidadorDeMensajes();
    const evento = { secuencia: 10, tipo: "reserva.confirmada", ocurrido_en: "2026-11-07T12:00:01.000Z", entidad: reserva };

    assert.ok(validar("EntregaWebhook", { cambio_id: 10, tenant_id: ID, evento }));
    assert.throws(
        () => validar("EntregaWebhook", { cambio_id: 10, tenant_id: ID, evento: { ...evento, tipo: "reserva.solicitada" } }),
        ErrorDeContrato
    );
});

test("las rutas se arman desde las plantillas del contrato", () => {
    const contrato = crearContratoHttp();

    assert.equal(contrato.ruta("solicitarReserva", { id: ID }), `/v1/actividades/${ID}/reservas`);
    assert.equal(contrato.metodo("cancelarReserva"), "POST");
    assert.equal(contrato.ruta("cancelarReserva", { id: ID }), `/v1/reservas/${ID}/cancelacion`);
    assert.throws(() => contrato.ruta("consultarReserva", {}), /Falta el parámetro id/);
});

test("una respuesta que no cumple el esquema documentado se detecta", () => {
    const contrato = crearContratoHttp();

    assert.ok(contrato.validarRespuesta("consultarReserva", 200, reserva));
    assert.throws(() => contrato.validarRespuesta("consultarReserva", 200, { ...reserva, estado: "otra" }), ErrorDeContrato);
    assert.ok(contrato.validarRespuesta("consultarReserva", 404, { type: "about:blank", title: "No encontrado", status: 404 }, "application/problem+json"));
    assert.throws(() => contrato.validarRespuesta("consultarReserva", 418, {}), /no documentado/);
});

test("el evento de webhook se valida como esquema del contrato", () => {
    const contrato = crearContratoHttp();
    const evento = { secuencia: 1, tipo: "reserva.cancelada", ocurrido_en: "2026-11-07T12:00:00.000Z", entidad: { ...reserva, estado: "cancelada" } };

    assert.ok(contrato.validarEsquema("EventoReserva", evento));
    assert.throws(() => contrato.validarEsquema("EventoReserva", { ...evento, secuencia: 0 }), ErrorDeContrato);
});

test("la firma del webhook trae un vector de prueba en el contrato", () => {
    const vector = crearContratoHttp().operacion("recibirCambioDeReserva")["x-vector-de-prueba"];

    assert.match(vector.secreto, /^[0-9a-f]{64}$/);
    assert.match(vector["X-Firma"], new RegExp(`^t=${vector.t},v1=[0-9a-f]{64}$`));
    assert.ok(crearContratoHttp().validarEsquema("EventoReserva", JSON.parse(vector.cuerpo)));
});
