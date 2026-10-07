const express = require("express");
const amqp = require("amqplib");
const { randomUUID } = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const COLA = "infraestructura.pruebas";

function salir(error) {
    console.error("[API]", error.message);
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

    const canal = await conexion.createConfirmChannel();

    canal.on("error", salir);
    canal.on("close", () => {
        salir(new Error("Se cerró el canal de RabbitMQ"));
    });

    await canal.assertQueue(COLA, { durable: true });

    const app = express();

    app.use(express.json({ limit: "16kb" }));

    app.get("/health", (req, res) => {
        res.json({
            servicio: "api",
            estado: "ok",
            rabbitmq: "conectado"
        });
    });

    app.post("/pruebas/mensajes", async (req, res) => {
        const texto = req.body?.texto;

        if (
            typeof texto !== "string" ||
            texto.trim() === "" ||
            texto.length > 1000
        ) {
            return res.status(400).json({
                error: "texto debe tener entre 1 y 1000 caracteres"
            });
        }

        const mensaje = {
            id: randomUUID(),
            texto: texto.trim(),
            creadoEn: new Date().toISOString()
        };

        let temporizador;

        try {
            // Esperamos la confirmación de RabbitMQ antes de responder.
            await new Promise((resolve, reject) => {
                temporizador = setTimeout(() => {
                    reject(new Error("RabbitMQ no confirmó la publicación"));
                }, 5000);

                canal.sendToQueue(
                    COLA,
                    Buffer.from(JSON.stringify(mensaje)),
                    {
                        persistent: true,
                        contentType: "application/json",
                        messageId: mensaje.id
                    },
                    (error) => {
                        if (error) reject(error);
                        else resolve();
                    }
                );
            });

            console.log("[API] Mensaje publicado:", mensaje);

            res.status(202).json({
                estado: "aceptado",
                ...mensaje
            });
        } catch (error) {
            console.error("[API] Error al publicar:", error.message);

            res.status(503).json({
                error: "No se pudo confirmar la publicación"
            });
        } finally {
            clearTimeout(temporizador);
        }
    });

    app.use((error, req, res, next) => {
        const codigo = error.type === "entity.too.large" ? 413 : 400;

        res.status(codigo).json({
            error: "JSON inválido o demasiado grande"
        });
    });

    const servidor = app.listen(PORT, "0.0.0.0", () => {
        console.log(`[API] Escuchando en puerto ${PORT}`);
    });

    servidor.on("error", salir);
}

iniciar().catch(salir);