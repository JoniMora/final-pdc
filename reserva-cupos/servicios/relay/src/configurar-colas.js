const amqp = require("amqplib");

async function configurar() {
    let conexion;
    let canal;

    try {
        conexion = await amqp.connect({
            hostname: process.env.RABBITMQ_HOST,
            username: process.env.RABBITMQ_USER,
            password: process.env.RABBITMQ_PASSWORD,
            heartbeat: 10
        });

        conexion.on("error", error => {
            console.error("[colas]", error.message);
        });

        canal = await conexion.createChannel();

        canal.on("error", error => {
            console.error("[colas]", error.message);
        });

        // Exchanges: reciben mensajes y los dirigen hacia las colas.
        await canal.assertExchange(
            "reservas.comandos",
            "x-consistent-hash",
            { durable: true }
        );

        await canal.assertExchange(
            "reservas.dlx",
            "direct",
            { durable: true }
        );

        await canal.assertExchange(
            "webhooks.eventos",
            "direct",
            { durable: true }
        );

        await canal.assertExchange(
            "webhooks.dlx",
            "direct",
            { durable: true }
        );

        // Cola de comandos fallidos.
        await canal.assertQueue("reservas.dlq", {
            durable: true
        });

        await canal.bindQueue(
            "reservas.dlq",
            "reservas.dlx",
            "fallido"
        );

        // Primera partición de comandos.
        await canal.assertQueue("reservas.comandos.0", {
            durable: true,
            arguments: {
                "x-dead-letter-exchange": "reservas.dlx",
                "x-dead-letter-routing-key": "fallido"
            }
        });

        // En el exchange de hash, "1" es el peso de esta cola.
        await canal.bindQueue(
            "reservas.comandos.0",
            "reservas.comandos",
            "1"
        );

        // Cola de webhooks fallidos.
        await canal.assertQueue("webhooks.dlq", {
            durable: true
        });

        await canal.bindQueue(
            "webhooks.dlq",
            "webhooks.dlx",
            "fallido"
        );

        // Cola de entregas de webhooks.
        await canal.assertQueue("webhooks.entregas", {
            durable: true,
            arguments: {
                "x-dead-letter-exchange": "webhooks.dlx",
                "x-dead-letter-routing-key": "fallido"
            }
        });

        await canal.bindQueue(
            "webhooks.entregas",
            "webhooks.eventos",
            "entrega"
        );

        // Al vencer la espera, el mensaje vuelve a la cola de entregas.
        const esperas = [
            ["webhooks.espera.10s", 10000],
            ["webhooks.espera.1m", 60000],
            ["webhooks.espera.5m", 300000]
        ];

        for (const [nombre, ttl] of esperas) {
            await canal.assertQueue(nombre, {
                durable: true,
                arguments: {
                    "x-message-ttl": ttl,
                    "x-dead-letter-exchange": "webhooks.eventos",
                    "x-dead-letter-routing-key": "entrega"
                }
            });
        }

        console.log(
            "[colas] Topologia de RabbitMQ configurada"
        );
    } finally {
        if (canal) {
            await canal.close().catch(() => {});
        }

        if (conexion) {
            await conexion.close().catch(() => {});
        }
    }
}

configurar().catch(error => {
    console.error(
        "[colas] No se pudo configurar:",
        error.message
    );

    process.exitCode = 1;
});