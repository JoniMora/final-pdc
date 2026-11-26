const { enTransaccion } = require("./transaccion");
const { ErrorDeSecreto, secretoDesdeHex, verificarFirma, VENTANA_S } = require("../../../compartido/src/firma-webhook");

// La verificación de la firma es común a los clientes de referencia
// (compartido/src/firma-webhook.js).

// Proyección local: una inscripción se actualiza solo si la versión que
// llega es mayor. Así un evento repetido o atrasado no cambia nada.
async function aplicarReserva(cliente, reserva) {
    const resultado = await cliente.query(
        `INSERT INTO inscripciones (reserva_id, actividad_id, alumno, estado, version)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (reserva_id) DO UPDATE
            SET estado = EXCLUDED.estado,
                version = EXCLUDED.version,
                actualizado_en = CURRENT_TIMESTAMP
          WHERE inscripciones.version < EXCLUDED.version`,
        [reserva.id, reserva.actividad_id, reserva.participante, reserva.estado, reserva.version]
    );

    return resultado.rowCount === 1;
}

// Aplica un evento y avanza el registro de la última secuencia recibida.
// Los webhooks pueden llegar fuera de orden: la reconciliación por feed
// (Entrega 5) parte de un punto de control propio y aplica por versión.
async function aplicarEvento(pool, evento) {
    return enTransaccion(pool, async cliente => {
        const aplicado = await aplicarReserva(cliente, evento.entidad);

        await cliente.query(
            `UPDATE punto_control
                SET ultima_secuencia_webhook = GREATEST(ultima_secuencia_webhook, $1),
                    actualizado_en = CURRENT_TIMESTAMP
              WHERE id = 1`,
            [evento.secuencia]
        );

        return aplicado;
    });
}

module.exports = { ErrorDeSecreto, secretoDesdeHex, verificarFirma, aplicarReserva, aplicarEvento, VENTANA_S };
