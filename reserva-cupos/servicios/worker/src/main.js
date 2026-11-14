const amqp = require("amqplib");
const { crearValidadorDeMensajes } = require("../../../compartido/src/contrato");
const { crearPool, esErrorDeInfraestructura } = require("./db");
const { reservar } = require("./reservar");
const { cancelar, marcarFallida } = require("./cancelar");
const { procesar } = require("./procesar");

const COLA = "reservas.comandos.0";
const PAUSA_INFRAESTRUCTURA_MS = 5000;

const pool = crearPool();
const validar = crearValidadorDeMensajes();

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

async function iniciar() {
    const conexion = await amqp.connect({
        protocol: process.env.RABBITMQ_TLS === 'true' ? 'amqps' : 'amqp',
            port: process.env.RABBITMQ_TLS === 'true' ? 5671 : 5672,
            hostname: process.env.RABBITMQ_HOST || "rabbitmq",
        username: process.env.RABBITMQ_USER,
        password: process.env.RABBITMQ_PASSWORD,
        heartbeat: 10
    }, process.env.RABBITMQ_TLS === 'true' ? {ca:[require('node:fs').readFileSync(process.env.TLS_CA)],rejectUnauthorized:true,servername:process.env.RABBITMQ_HOST} : {});

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

            const resultado = await procesar(entrega.content, dependencias);

            switch (resultado.accion) {
                case "ack":
                    console.log(`[WORKER] ${describir(resultado.comando, resultado.resultado)}`
                        + (resultado.motivo ? ` (${resultado.motivo})` : ""));
                    // Recién después del COMMIT se confirma el mensaje.
                    canal.ack(entrega);
                    break;

                case "reencolar":
                    // Pausa sin consumir reintentos ni derivar a la DLQ:
                    // el comando vuelve a la cola.
                    console.error("[WORKER] MySQL no disponible, se reintentará:", resultado.motivo);
                    await esperar(PAUSA_INFRAESTRUCTURA_MS);
                    canal.nack(entrega, false, true);
                    break;

                default:
                    console.error("[WORKER] Comando a la DLQ:", resultado.motivo);
                    canal.nack(entrega, false, false);
            }
        },
        { noAck: false }
    );

    console.log(`[WORKER] Esperando comandos en ${COLA} (contrato de mensajería validado)`);
}

iniciar().catch(salir);
