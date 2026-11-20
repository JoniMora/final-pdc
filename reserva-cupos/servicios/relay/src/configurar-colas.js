const amqp = require("amqplib");
const { conexionRabbit } = require("../../../compartido/src/tls");
const { configurarParticiones } = require("../../../compartido/src/particiones");
const { colas } = configurarParticiones();

// Máximo de particiones que admite COMANDOS_PARTICIONES.
const MAXIMO_PARTICIONES = 32;

// Al bajar la cantidad de particiones (por ejemplo, de 4 a 1), las colas
// sobrantes seguirían enlazadas al exchange y recibirían comandos que ningún
// worker consume. Se desenlazan, y sus comandos pendientes vuelven a pasar
// por el exchange para caer en la partición que ahora les corresponde. Esto
// corre antes de que el relay publique (npm start), así que los comandos
// viejos de cada actividad quedan delante de los nuevos.
async function retirarParticionesSobrantes(conexion) {
    for (let numero = colas.length; numero < MAXIMO_PARTICIONES; numero++) {
        const cola = `reservas.comandos.${numero}`;

        // checkQueue cierra el canal si la cola no existe: uno por cola.
        const canal = await conexion.createConfirmChannel();
        canal.on("error", () => {});

        try {
            await canal.checkQueue(cola);
        } catch {
            continue;
        }

        try {
            await canal.unbindQueue(cola, "reservas.comandos", "1");

            let movidos = 0;
            let mensaje;

            while ((mensaje = await canal.get(cola, { noAck: false }))) {
                canal.publish("reservas.comandos", mensaje.fields.routingKey, mensaje.content, mensaje.properties);
                await canal.waitForConfirms();
                canal.ack(mensaje);
                movidos++;
            }

            console.log(`[colas] ${cola} desenlazada; ${movidos} comandos reenviados al exchange`);
        } catch (error) {
            // Por ejemplo, si todavía hay un worker consumiendo esa cola.
            console.error(`[colas] No se pudo retirar ${cola}:`, error.message);
        } finally {
            await canal.close().catch(() => {});
        }
    }
}

async function configurar() {
    let conexion;
    let canal;

    try {
        conexion = await amqp.connect(...conexionRabbit({ heartbeat: 10 }));

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

        // Cada partición recibe el mismo peso en el exchange.
        for (const cola of colas) {
            await canal.assertQueue(cola, {
                durable: true,
                arguments: {
                    "x-dead-letter-exchange": "reservas.dlx",
                    "x-dead-letter-routing-key": "fallido"
                }
            });

            await canal.bindQueue(
                cola,
                "reservas.comandos",
                "1"
            );
        }
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

        await retirarParticionesSobrantes(conexion);

        console.log(
            `[colas] Topología de RabbitMQ configurada (${colas.length} particiones)`
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