// Simula una reentrega del broker: publica otra vez el comando reservar
// de una reserva existente. El worker debe detectar que ya fue decidida
// y no descontar otro cupo.
//
// Uso: node src/reenviar-comando.js <reserva_id>

const mysql = require("mysql2/promise");
const amqp = require("amqplib");

async function reenviar() {
    const reservaId = process.argv[2];

    if (!reservaId) {
        throw new Error("Uso: node src/reenviar-comando.js <reserva_id>");
    }

    const conexionDb = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });

    let conexion;

    try {
        const [filas] = await conexionDb.query(
            "SELECT id, tenant_id, actividad_id, estado FROM reservas WHERE id = ?",
            [reservaId]
        );

        if (filas.length === 0) {
            throw new Error("La reserva no existe");
        }

        const reserva = filas[0];

        conexion = await amqp.connect({
            hostname: process.env.RABBITMQ_HOST,
            username: process.env.RABBITMQ_USER,
            password: process.env.RABBITMQ_PASSWORD
        });

        const canal = await conexion.createConfirmChannel();

        canal.publish(
            "reservas.comandos",
            reserva.actividad_id,
            Buffer.from(JSON.stringify({
                comando: "reservar",
                tenant_id: reserva.tenant_id,
                reserva_id: reserva.id,
                actividad_id: reserva.actividad_id
            })),
            {
                persistent: true,
                contentType: "application/json",
                messageId: `reenvio-${reserva.id}`,
                type: "reservar"
            }
        );

        await canal.waitForConfirms();

        console.log(
            `[prueba] Comando reservar reenviado para ${reserva.id} ` +
            `(estado actual: ${reserva.estado})`
        );
    } finally {
        await conexionDb.end();
        if (conexion) await conexion.close().catch(() => {});
    }
}

reenviar().catch(error => {
    console.error("[prueba] ERROR:", error.message);
    process.exitCode = 1;
});
