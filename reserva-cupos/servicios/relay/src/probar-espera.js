const amqp = require("amqplib");
const { randomUUID } = require("node:crypto");

async function probar() {
    let conexion;
    let canal;
    let entrega;
    let confirmada = false;

    try {
        conexion = await amqp.connect({
            hostname: process.env.RABBITMQ_HOST,
            username: process.env.RABBITMQ_USER,
            password: process.env.RABBITMQ_PASSWORD,
            heartbeat: 10
        });

        conexion.on("error", error => {
            console.error("[prueba]", error.message);
        });

        canal = await conexion.createConfirmChannel();

        canal.on("error", error => {
            console.error("[prueba]", error.message);
        });

        // Evitamos mezclar esta prueba con otros mensajes.
        for (const nombre of [
            "webhooks.espera.10s",
            "webhooks.entregas"
        ]) {
            const estado = await canal.checkQueue(nombre);

            if (
                estado.messageCount !== 0 ||
                estado.consumerCount !== 0
            ) {
                throw new Error(
                    `La prueba requiere ${nombre} vacia y sin consumidores`
                );
            }
        }

        const id = randomUUID();
        const inicio = Date.now();

        canal.sendToQueue(
            "webhooks.espera.10s",
            Buffer.from(JSON.stringify({
                id,
                texto: "Prueba de espera de diez segundos"
            })),
            {
                persistent: true,
                messageId: id,
                contentType: "application/json"
            }
        );

        await canal.waitForConfirms();

        console.log(
            "[prueba] Publicado en webhooks.espera.10s:",
            id
        );

        // Buscamos el mensaje en la cola de destino.
        while (Date.now() - inicio < 25000) {
            entrega = await canal.get(
                "webhooks.entregas",
                { noAck: false }
            );

            if (entrega) break;

            await new Promise(resolve => {
                setTimeout(resolve, 250);
            });
        }

        if (!entrega) {
            throw new Error("El mensaje no llego en 25 segundos");
        }

        if (entrega.properties.messageId !== id) {
            throw new Error(
                "Se encontro otro mensaje; se devolvera a la cola"
            );
        }

        const segundos = (Date.now() - inicio) / 1000;

        if (segundos < 10) {
            throw new Error(
                "El mensaje llego antes de cumplir la espera"
            );
        }

        console.log(
            "[prueba] Recibido en webhooks.entregas:",
            entrega.content.toString()
        );

        console.log(
            "[prueba] Tiempo transcurrido:",
            segundos.toFixed(2),
            "segundos"
        );

        canal.ack(entrega);
        confirmada = true;

        console.log(
            "[prueba] OK: espera y enrutamiento comprobados"
        );
    } finally {
        if (canal && entrega && !confirmada) {
            try {
                canal.nack(entrega, false, true);
            } catch (_) {}
        }

        if (canal) await canal.close().catch(() => {});
        if (conexion) await conexion.close().catch(() => {});
    }
}

probar().catch(error => {
    console.error("[prueba] ERROR:", error.message);
    process.exitCode = 1;
});