const amqp = require("amqplib");

const COLA = "infraestructura.pruebas";

function salir(error) {
    console.error("[WORKER]", error.message);
    process.exit(1);
}

async function iniciar() {
    const conexion = await amqp.connect({
        hostname: process.env.RABBITMQ_HOST || "rabbitmq",
        username: process.env.RABBITMQ_USER,
        password: process.env.RABBITMQ_PASSWORD,
        heartbeat: 10
    });

    conexion.on("error", salir);
    conexion.on("close", () => {
        salir(new Error("Se perdió la conexión con RabbitMQ"));
    });

    const canal = await conexion.createChannel();

    canal.on("error", salir);
    canal.on("close", () => {
        salir(new Error("Se cerró el canal de RabbitMQ"));
    });

    await canal.assertQueue(COLA, { durable: true });

    // Recibimos un mensaje sin confirmar por vez.
    await canal.prefetch(1);

    await canal.consume(
        COLA,
        (entrega) => {
            if (!entrega) {
                salir(new Error("RabbitMQ canceló el consumidor"));
                return;
            }

            try {
                const mensaje = JSON.parse(
                    entrega.content.toString("utf8")
                );

                if (
                    typeof mensaje.id !== "string" ||
                    typeof mensaje.texto !== "string"
                ) {
                    throw new Error("Formato de mensaje inválido");
                }

                // En esta prueba, procesar significa mostrar el mensaje.
                console.log("[WORKER] Mensaje procesado:", mensaje);

                // Confirmamos después de procesarlo.
                canal.ack(entrega);
            } catch (error) {
                console.error(
                    "[WORKER] Mensaje inválido:",
                    error.message
                );

                // Descartamos los mensajes malformados.
                canal.nack(entrega, false, false);
            }
        },
        { noAck: false }
    );

    console.log(`[WORKER] Esperando mensajes en ${COLA}`);
}

iniciar().catch(salir);