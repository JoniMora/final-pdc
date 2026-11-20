const fs = require("node:fs");
const https = require("node:https");
const amqp = require("amqplib");

const { crearValidadorDeMensajes } = require("../../../compartido/src/contrato");
const { conexionRabbit } = require("../../../compartido/src/tls");
const { crearMetricas } = require("../../../compartido/src/metricas");
const { crearSalud, atenderSalud } = require("../../../compartido/src/salud");

const { crearPool, esErrorDeInfraestructura } = require("./db");
const { reservar } = require("./reservar");
const { cancelar, marcarFallida } = require("./cancelar");
const { procesar } = require("./procesar");
const { configurarParticiones } = require("../../../compartido/src/particiones");
const { cola: COLA } = configurarParticiones();
const PAUSA_INFRAESTRUCTURA_MS = 5000;

const pool = crearPool();
const validar = crearValidadorDeMensajes();
const metricas = crearMetricas("worker");

// RabbitMQ: si se pierde la conexión el proceso termina y Docker lo
// reinicia; mientras tanto /health lo informa.
let rabbitConectado = false;
const salud = crearSalud({ servicio: "worker", pool, rabbitmq: () => rabbitConectado });

function salir(error) {
    console.error("[WORKER]", error.message);
    process.exit(1);
}

function esperar(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const dependencias = {
    validar,
    acciones: {
        reservar: comando => reservar(pool, comando),
        cancelar: comando => cancelar(pool, comando)
    },
    marcarFallida: comando => marcarFallida(pool, comando),
    esErrorDeInfraestructura,
    esperar
};

function describir(comando, resultado) {
    const reserva = `${comando.comando} ${comando.reserva_id} (actividad ${comando.actividad_id})`;

    if (resultado.repetido) {
        return `${reserva}: ya estaba ${resultado.estado}, comando repetido sin cambios`;
    }

    if (resultado.cupoDevuelto) {
        return `${reserva}: cancelada, cupo devuelto`;
    }

    return `${reserva}: ${resultado.estado}`;
}

// Registra el resultado observado sin cambiar la decisión del worker.
function registrarResultado(resultado) {
    if (resultado.accion === "ack") {
        metricas.eventos.inc({
            tipo: resultado.comando.comando,
            resultado: resultado.resultado.repetido
                ? "repetido"
                : resultado.resultado.estado
        });

        return;
    }

    metricas.eventos.inc({
        tipo: "comando",
        resultado: resultado.accion === "reencolar"
            ? "reencolar"
            : "dlq"
    });
}

async function iniciar() {
    const conexion = await amqp.connect(
        ...conexionRabbit({ heartbeat: 10 })
    );

    conexion.on("error", salir);

    conexion.on("close", () => {
        rabbitConectado = false;
        salir(new Error("Se perdió la conexión con RabbitMQ"));
    });

    const canal = await conexion.createChannel();
    rabbitConectado = true;

    canal.on("error", salir);

    canal.on("close", () => {
        salir(new Error("Se cerró el canal de RabbitMQ"));
    });

    // Mismos argumentos que declara el relay.
    await canal.assertQueue(COLA, {
        durable: true,
        arguments: {
            "x-dead-letter-exchange": "reservas.dlx",
            "x-dead-letter-routing-key": "fallido"
        }
    });

    // Un mensaje sin confirmar por consumidor.
    await canal.prefetch(1);

    await canal.consume(
        COLA,
        async entrega => {
            if (!entrega) {
                salir(new Error("RabbitMQ canceló el consumidor"));
                return;
            }

            const resultado = await procesar(
                entrega.content,
                dependencias
            );

            registrarResultado(resultado);

            switch (resultado.accion) {
                case "ack":
                    console.log(
                        `[WORKER] ${describir(
                            resultado.comando,
                            resultado.resultado
                        )}` + (
                            resultado.motivo
                                ? ` (${resultado.motivo})`
                                : ""
                        )
                    );

                    // Se confirma el mensaje después del procesamiento
                    // y del COMMIT realizado por la operación.
                    canal.ack(entrega);
                    break;

                case "reencolar":
                    console.error(
                        "[WORKER] MySQL no disponible, se reintentará:",
                        resultado.motivo
                    );

                    await esperar(PAUSA_INFRAESTRUCTURA_MS);
                    canal.nack(entrega, false, true);
                    break;

                default:
                    console.error(
                        "[WORKER] Comando a la DLQ:",
                        resultado.motivo
                    );

                    canal.nack(entrega, false, false);
            }
        },
        { noAck: false, exclusive: true }
    );

    console.log(
        `[WORKER] Esperando comandos en ${COLA} ` +
        "(contrato de mensajería validado)"
    );
}

// Exporta métricas por HTTPS dentro de la red de Docker.
const servidorMetricas = https.createServer({
    cert: fs.readFileSync(process.env.TLS_CERT),
    key: fs.readFileSync(process.env.TLS_KEY),
    minVersion: "TLSv1.2"
}, async (req, res) => {
    if (await atenderSalud(req, res, salud)) return;

    if (req.method !== "GET" || req.url !== "/metrics") {
        res.writeHead(404);
        res.end();
        return;
    }

    try {
        const contenido = await metricas.registro.metrics();

        res.writeHead(200, {
            "Content-Type": metricas.registro.contentType
        });

        res.end(contenido);
    } catch (error) {
        console.error(
            "[WORKER] Error al exportar métricas:",
            error.message
        );

        res.writeHead(500);
        res.end();
    }
});

servidorMetricas.on("error", salir);

servidorMetricas.listen(9464, "0.0.0.0", () => {
    console.log(
        "[WORKER] Métricas disponibles en puerto interno 9464"
    );
});

iniciar().catch(salir);
