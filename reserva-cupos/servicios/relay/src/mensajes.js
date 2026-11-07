// Construcción de los mensajes que publica el relay a partir de una fila
// del outbox. Su forma la define contrato/asyncapi.yaml.

// Tipo de cambio → comando que se envía al worker.
const COMANDOS = {
    "reserva.solicitada": "reservar",
    "reserva.cancelacion_solicitada": "cancelar"
};

// Comando → esquema del contrato.
const ESQUEMAS = {
    reservar: "ComandoReservar",
    cancelar: "ComandoCancelar"
};

function comandoDesdeCambio(fila) {
    const comando = COMANDOS[fila.tipo];
    if (!comando) return null;

    return {
        comando,
        cambio_id: Number(fila.id),
        tenant_id: fila.tenant_id,
        reserva_id: fila.entidad_id,
        actividad_id: fila.snapshot.actividad_id
    };
}

function entregaDesdeCambio(fila) {
    return {
        cambio_id: Number(fila.id),
        tenant_id: fila.tenant_id,
        evento: {
            secuencia: Number(fila.secuencia),
            tipo: fila.tipo,
            ocurrido_en: new Date(fila.creado_en).toISOString(),
            entidad: fila.snapshot
        }
    };
}

module.exports = { COMANDOS, ESQUEMAS, comandoDesdeCambio, entregaDesdeCambio };
