const { enTransaccion } = require("./db");
const {
    ErrorDeDatos,
    reservaJson,
    actividadJson,
    registrarCambio,
    COLUMNAS_RESERVA,
    COLUMNAS_ACTIVIDAD
} = require("./modelo");

const TERMINALES = new Set(["cancelada", "rechazada", "fallida"]);

// Cancela una reserva. Si estaba confirmada, devuelve el cupo en la misma
// transacción. Es idempotente: reentregar el comando de una reserva que ya
// no está activa no cambia nada.
async function cancelar(pool, comando) {
    return enTransaccion(pool, async conexion => {
        // Mismo orden de bloqueos que reservar: reservas → actividades.
        const [filas] = await conexion.query(
            `SELECT ${COLUMNAS_RESERVA} FROM reservas
              WHERE id = ? AND tenant_id = ?
                FOR UPDATE`,
            [comando.reserva_id, comando.tenant_id]
        );

        const fila = filas[0];

        if (!fila || fila.actividad_id !== comando.actividad_id) {
            throw new ErrorDeDatos("La reserva del comando no existe");
        }

        if (TERMINALES.has(fila.estado)) {
            return { estado: fila.estado, repetido: true };
        }

        if (fila.estado === "confirmada") {
            // El CHECK de la tabla impide superar la capacidad; la condición
            // lo hace explícito y detecta una inconsistencia.
            const [devolucion] = await conexion.query(
                `UPDATE actividades
                    SET cupos_disponibles = cupos_disponibles + 1,
                        version = version + 1
                  WHERE id = ? AND tenant_id = ? AND cupos_disponibles < capacidad`,
                [fila.actividad_id, fila.tenant_id]
            );

            if (devolucion.affectedRows !== 1) {
                throw new Error("La actividad ya tiene todos sus cupos disponibles");
            }
        }

        const [cambio] = await conexion.query(
            `UPDATE reservas SET estado = 'cancelada', version = version + 1
              WHERE id = ? AND estado = ?`,
            [fila.id, fila.estado]
        );

        if (cambio.affectedRows !== 1) {
            throw new Error("La reserva cambió de estado bajo el bloqueo");
        }

        const reserva = reservaJson({ ...fila, estado: "cancelada", version: Number(fila.version) + 1 });

        await registrarCambio(conexion, fila.tenant_id, "reserva", reserva, "reserva.cancelada", true);

        if (fila.estado === "confirmada") {
            const [actividades] = await conexion.query(
                `SELECT ${COLUMNAS_ACTIVIDAD} FROM actividades WHERE id = ?`,
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

        return { estado: "cancelada", repetido: false, cupoDevuelto: fila.estado === "confirmada" };
    });
}

// Último recurso para un comando reservar que sigue fallando por un error
// de datos: la reserva pendiente pasa a fallida, se notifica y el
// participante puede volver a intentarlo. Solo aplica a reservas
// pendientes: una confirmada tiene un cupo asignado y no se toca.
async function marcarFallida(pool, comando) {
    return enTransaccion(pool, async conexion => {
        const [filas] = await conexion.query(
            `SELECT ${COLUMNAS_RESERVA} FROM reservas
              WHERE id = ? AND tenant_id = ?
                FOR UPDATE`,
            [comando.reserva_id, comando.tenant_id]
        );

        const fila = filas[0];

        if (!fila) throw new ErrorDeDatos("La reserva del comando no existe");
        if (fila.estado !== "pendiente") return { estado: fila.estado, repetido: true };

        await conexion.query(
            "UPDATE reservas SET estado = 'fallida', version = version + 1 WHERE id = ? AND estado = 'pendiente'",
            [fila.id]
        );

        const reserva = reservaJson({ ...fila, estado: "fallida", version: Number(fila.version) + 1 });

        await registrarCambio(conexion, fila.tenant_id, "reserva", reserva, "reserva.fallida", true);

        return { estado: "fallida", repetido: false };
    });
}

module.exports = { cancelar, marcarFallida };
