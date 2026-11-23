const test = require("node:test");
const assert = require("node:assert/strict");
const { crearProyeccion } = require("../src/proyeccion");
const { crearSincronizacion } = require("../src/sincronizacion");

const ACTIVIDAD = "019a0000-0000-7000-8000-000000000001";

const actividad = (version, extra = {}) => ({
    id: ACTIVIDAD, nombre: "Turno 20 h", capacidad: 10, cupos_disponibles: 10,
    estado: "abierta", version, metadata: null, creado_en: "2026-11-22T20:00:00.000Z", ...extra
});

const reserva = (n, estado, version) => ({
    id: `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`,
    actividad_id: ACTIVIDAD, participante: `jugador-${n}`, estado, version,
    metadata: null, creado_en: "2026-11-22T20:00:01.000Z"
});

test("aplica cada instantánea solo si su versión es mayor", () => {
    const p = crearProyeccion();
    assert.equal(p.aplicarActividad(actividad(1)), true);
    assert.equal(p.aplicarActividad(actividad(3, { cupos_disponibles: 8 })), true);
    assert.equal(p.aplicarActividad(actividad(2, { cupos_disponibles: 9 })), false, "una versión atrasada no pisa");
    assert.equal(p.detalle(ACTIVIDAD).actividad.cupos_disponibles, 8);

    assert.equal(p.aplicarReserva(reserva(100, "confirmada", 2)), true);
    assert.equal(p.aplicarReserva(reserva(100, "pendiente", 1)), false, "un webhook repetido o atrasado no cambia nada");
    assert.equal(p.aplicarReserva(reserva(100, "cancelada", 3)), true);
    assert.deepEqual(p.detalle(ACTIVIDAD).actividad.conteo,
        { pendiente: 0, confirmada: 0, rechazada: 0, cancelada: 1, fallida: 0 });
});

test("cuenta las reservas por estado e ignora tipos de cambio desconocidos", () => {
    const p = crearProyeccion();
    p.aplicarCambio({ secuencia: 1, tipo: "actividad.creada", entidad: actividad(1) });
    p.aplicarCambio({ secuencia: 2, tipo: "reserva.confirmada", entidad: reserva(101, "confirmada", 2) });
    p.aplicarCambio({ secuencia: 3, tipo: "reserva.rechazada", entidad: reserva(102, "rechazada", 2) });
    p.aplicarCambio({ secuencia: 4, tipo: "reserva.solicitada", entidad: reserva(103, "pendiente", 1) });
    assert.equal(p.aplicarCambio({ secuencia: 5, tipo: "otra.cosa", entidad: {} }), false);

    const [listada] = p.listar();
    assert.deepEqual(listada.conteo, { pendiente: 1, confirmada: 1, rechazada: 1, cancelada: 0, fallida: 0 });
});

test("guarda los últimos webhooks y cuenta válidos y rechazados", () => {
    const p = crearProyeccion({ maxWebhooks: 2 });
    p.registrarWebhook({ valido: true, webhook_id: "1" });
    p.registrarWebhook({ valido: false, webhook_id: "2", motivo: "Firma inválida" });
    p.registrarWebhook({ valido: true, webhook_id: "3" });
    assert.deepEqual(p.webhooks().map(w => w.webhook_id), ["3", "2"]);
    assert.deepEqual(p.recibidos(), { validos: 2, rechazados: 1 });
});

function apiConFeed(paginas) {
    const pedidos = [];
    return {
        pedidos,
        llamar: async (operacion, { query }) => {
            pedidos.push(query.desde);
            const pagina = paginas.shift() || { datos: [], ultima_secuencia: query.desde };
            return { status: 200, cuerpo: pagina };
        }
    };
}

test("la sincronización lee el feed desde el punto de control", async () => {
    const p = crearProyeccion();
    const api = apiConFeed([
        { datos: [{ secuencia: 7, tipo: "actividad.creada", entidad: actividad(1) }], ultima_secuencia: 7 }
    ]);
    const s = crearSincronizacion({ api, proyeccion: p, claveActual: () => "rc_a" });

    await s.sincronizar();
    await s.sincronizar();

    assert.deepEqual(api.pedidos, [0, 7]);
    assert.equal(p.listar().length, 1);
    assert.equal(s.estado.error, null);
});

test("otra clave es otro tenant: la proyección vuelve a empezar", async () => {
    const p = crearProyeccion();
    let clave = "rc_a";
    const api = apiConFeed([
        { datos: [{ secuencia: 7, tipo: "actividad.creada", entidad: actividad(1) }], ultima_secuencia: 7 }
    ]);
    const s = crearSincronizacion({ api, proyeccion: p, claveActual: () => clave });

    await s.sincronizar();
    clave = "rc_b";
    await s.sincronizar();

    assert.deepEqual(api.pedidos, [0, 0]);
    assert.equal(p.listar().length, 0);
});

test("sin tenant o con la API rechazando la clave, informa qué hacer", async () => {
    const p = crearProyeccion();
    const sinClave = crearSincronizacion({ api: apiConFeed([]), proyeccion: p, claveActual: () => null });
    await sinClave.sincronizar();
    assert.match(sinClave.estado.error, /sistema\.js demo/);

    const rechaza = crearSincronizacion({
        api: { llamar: async () => ({ status: 401, cuerpo: null }) },
        proyeccion: p,
        claveActual: () => "rc_vieja"
    });
    await rechaza.sincronizar();
    assert.match(rechaza.estado.error, /no autentica/);
});
