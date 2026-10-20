const amqp = require("amqplib");
const { crearPool, esErrorDeInfraestructura } = require("./db");
const { reservar } = require("./reservar");

const COLA = "reservas.comandos.0";
const PAUSA_INFRAESTRUCTURA_MS = 5000;

const pool = crearPool();

function salir(error) {
    console.error("[WORKER]", error.message);
    process.exit(1);
}

function esperar(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function leerComando(entrega) {
    const comando = JSON.parse(entrega.content.toString("utf8"));

    if (
        comando.comando !== "reservar" ||
        typeof comando.reserva_id !== "string" ||
        typeof comando.actividad_id !== "string" ||
        typeof comando.tenant_id !== "string"
    ) {
        throw new Error("Formato de comando inválido");
    }

    return comando;
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

    // Mismos argumentos que declara el relay en configurar-colas.js.
    await canal.assertQueue(COLA, {
        durable: true,
        arguments: {
            "x-dead-letter-exchange": "reservas.dlx",
            "x-dead-letter-routing-key": "fallido"
        }
    });

    // Un comando sin confirmar por vez: nivela la carga sobre MySQL.
    await canal.prefetch(1);

    await canal.consume(
        COLA,
        async entrega => {
            if (!entrega) {
                salir(new Error("RabbitMQ canceló el consumidor"));
                return;
            }

            let comando;

            try {
                comando = leerComando(entrega);
            } catch (error) {
                console.error("[WORKER] Comando descartado a la DLQ:", error.message);
                canal.nack(entrega, false, false);
                return;
            }

            try {
                const resultado = await reservar(pool, comando);

                const reserva = `Reserva ${comando.reserva_id} (actividad ${comando.actividad_id})`;

                console.log(
                    resultado.repetido
                        ? `[WORKER] ${reserva} ya estaba ${resultado.estado}: comando repetido, sin cambios`
                        : `[WORKER] ${reserva} ${resultado.estado}`
                );

                // Recién después del COMMIT se confirma el mensaje.
                canal.ack(entrega);
            } catch (error) {
                if (esErrorDeInfraestructura(error)) {
                    // Pausa sin consumir reintentos ni derivar a la DLQ:
                    // el comando vuelve a la cola.
                    console.error(
                        "[WORKER] MySQL no disponible, se reintentará:",
                        error.code || error.message
                    );
                    await esperar(PAUSA_INFRAESTRUCTURA_MS);
                    canal.nack(entrega, false, true);
                } else {
                    console.error("[WORKER] Error de datos, comando a la DLQ:", error.message);
                    canal.nack(entrega, false, false);
                }
            }
        },
        { noAck: false }
    );

    console.log(`[WORKER] Esperando comandos en ${COLA}`);
}

iniciar().catch(salir);
