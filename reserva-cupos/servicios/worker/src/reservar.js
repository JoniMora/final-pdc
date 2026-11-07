const { enTransaccion } = require("./db");

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
// publicado_comando = TRUE. Las decisiones sí generan webhook.
async function registrarCambio(conexion, tenantId, entidad, snapshot, tipo, webhook) {
    await conexion.query(
        `INSERT INTO cambios
             (tenant_id, entidad, entidad_id, tipo, version, snapshot,
              publicado_comando, publicado_webhook)
         VALUES (?, ?, ?, ?, ?, ?, TRUE, ?)`,
        [tenantId, entidad, snapshot.id, tipo, snapshot.version, JSON.stringify(snapshot), !webhook]
    );
}

// Decide una reserva. La garantía de no sobreasignación la da el UPDATE
// condicional de InnoDB, no la cantidad de workers ni el prefetch.
// Es idempotente: si RabbitMQ reentrega el comando de una reserva ya
// decidida, no vuelve a descontar el cupo.
async function reservar(pool, comando) {
    return enTransaccion(pool, async conexion => {
        // 1. Bloquea la reserva. Orden fijo de bloqueos: reservas → actividades.
        const [filas] = await conexion.query(
            `SELECT id, tenant_id, actividad_id, participante_id, estado, version, metadata, creado_en
               FROM reservas
              WHERE id = ? AND tenant_id = ?
                FOR UPDATE`,
            [comando.reserva_id, comando.tenant_id]
        );

        const fila = filas[0];

        if (!fila || fila.actividad_id !== comando.actividad_id) {
            throw new ErrorDeDatos("La reserva del comando no existe");
        }

        // 2. Reentrega de un comando ya procesado: no se hace nada.
        if (fila.estado !== "pendiente") {
            return { estado: fila.estado, repetido: true };
        }

        // 3. Descuento atómico: una fila afectada si había cupo.
        const [descuento] = await conexion.query(
            `UPDATE actividades
                SET cupos_disponibles = cupos_disponibles - 1,
                    version = version + 1
              WHERE id = ? AND tenant_id = ?
                AND estado = 'abierta' AND cupos_disponibles > 0`,
            [fila.actividad_id, fila.tenant_id]
        );

        const estado = descuento.affectedRows === 1 ? "confirmada" : "rechazada";

        const [cambioReserva] = await conexion.query(
            `UPDATE reservas SET estado = ?, version = version + 1
              WHERE id = ? AND estado = 'pendiente'`,
            [estado, fila.id]
        );

        if (cambioReserva.affectedRows !== 1) {
            throw new Error("La reserva cambió de estado bajo el bloqueo");
        }

        // 4. Outbox: el cambio se registra en la misma transacción.
        const reserva = reservaJson({ ...fila, estado, version: Number(fila.version) + 1 });

        await registrarCambio(conexion, fila.tenant_id, "reserva", reserva, `reserva.${estado}`, true);

        if (estado === "confirmada") {
            const [actividades] = await conexion.query(
                `SELECT id, nombre, capacidad, cupos_disponibles, estado, version, metadata, creado_en
                   FROM actividades WHERE id = ?`,
                [fila.actividad_id]
            );

            await registrarCambio(
                conexion,
                fila.tenant_id,
                "actividad",
                actividadJson(actividades[0]),
                "actividad.actualizada",
                false
            );
        }

        return { estado, repetido: false };
    });
}

module.exports = { reservar, ErrorDeDatos };
