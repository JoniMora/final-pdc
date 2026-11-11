// Representación de las entidades y escritura en el outbox, compartidas
// por los comandos del worker.

// Error de datos permanente: reintentar no lo resuelve.
class ErrorDeDatos extends Error {}

function reservaJson(fila) {
    return {
        id: fila.id,
        actividad_id: fila.actividad_id,
        participante: fila.participante_id,
        estado: fila.estado,
        version: Number(fila.version),
        metadata: fila.metadata ?? null,
        creado_en: new Date(fila.creado_en).toISOString()
    };
}

function actividadJson(fila) {
    return {
        id: fila.id,
        nombre: fila.nombre,
        capacidad: fila.capacidad,
        cupos_disponibles: fila.cupos_disponibles,
        estado: fila.estado,
        version: Number(fila.version),
        metadata: fila.metadata ?? null,
        creado_en: new Date(fila.creado_en).toISOString()
    };
}

// Los cambios del worker no generan comandos: nacen con
// publicado_comando = TRUE. Las decisiones sobre reservas sí generan webhook.
async function registrarCambio(conexion, tenantId, entidad, snapshot, tipo, webhook) {
    await conexion.query(
        `INSERT INTO cambios
             (tenant_id, entidad, entidad_id, tipo, version, snapshot,
              publicado_comando, publicado_webhook)
         VALUES (?, ?, ?, ?, ?, ?, TRUE, ?)`,
        [tenantId, entidad, snapshot.id, tipo, snapshot.version, JSON.stringify(snapshot), !webhook]
    );
}

const COLUMNAS_RESERVA = "id, tenant_id, actividad_id, participante_id, estado, version, metadata, creado_en";
const COLUMNAS_ACTIVIDAD = "id, nombre, capacidad, cupos_disponibles, estado, version, metadata, creado_en";

module.exports = { ErrorDeDatos, reservaJson, actividadJson, registrarCambio, COLUMNAS_RESERVA, COLUMNAS_ACTIVIDAD };
