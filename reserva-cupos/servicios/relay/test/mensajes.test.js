const test = require("node:test");
const assert = require("node:assert/strict");
const { crearValidadorDeMensajes } = require("../../../compartido/src/contrato");
const { comandoDesdeCambio, entregaDesdeCambio, ESQUEMAS } = require("../src/mensajes");

const ID = "0193a4b2-7c1d-7e2f-8a3b-4c5d6e7f8091";
const TENANT = "01a1542d-7ee2-7d8b-b3b3-40474b8dec7e";
const validar = crearValidadorDeMensajes();

const reserva = {
    id: ID,
    actividad_id: ID,
    participante: "alumno-1",
    estado: "pendiente",
    version: 1,
    metadata: { legajo: 1 },
    creado_en: "2026-11-07T12:00:00.000Z"
};

function fila(tipo, snapshot = reserva) {
    return { id: 41, tenant_id: TENANT, entidad_id: ID, tipo, snapshot, secuencia: 40, creado_en: new Date("2026-11-07T12:00:02Z") };
}

test("los pedidos del outbox se convierten en comandos que cumplen el contrato", () => {
    for (const tipo of ["reserva.solicitada", "reserva.cancelacion_solicitada"]) {
        const comando = comandoDesdeCambio(fila(tipo));
        assert.ok(validar(ESQUEMAS[comando.comando], comando));
    }

    assert.equal(comandoDesdeCambio(fila("reserva.confirmada")), null);
});

test("las decisiones del worker se convierten en entregas de webhook válidas", () => {
    for (const estado of ["confirmada", "rechazada", "cancelada", "fallida"]) {
        const entrega = entregaDesdeCambio(fila(`reserva.${estado}`, { ...reserva, estado, version: 2 }));
        assert.ok(validar("EntregaWebhook", entrega));
    }
});

test("un cambio que no es una decisión sobre una reserva no cumple el contrato de webhook", () => {
    assert.throws(() => validar("EntregaWebhook", entregaDesdeCambio(fila("reserva.solicitada"))));
});
