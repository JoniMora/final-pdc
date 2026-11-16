const fs = require("node:fs");
const https = require("node:https");
const mysql = require("mysql2/promise");
const amqp = require("amqplib");

const { crearValidadorDeMensajes } = require("../../../compartido/src/contrato");
const { opcionesMysql, conexionRabbit } = require("../../../compartido/src/tls");
const { crearMetricas } = require("../../../compartido/src/metricas");

const { firmar } = require("./firma");
const { ErrorDestino, validarUrl, crearLookup } = require("./destino");
const { enviar } = require("./enviar");

const COLA = "webhooks.entregas";
const ESPERAS = [
    "webhooks.espera.10s",
    "webhooks.espera.1m",
    "webhooks.espera.5m"
];

const PREFETCH = 10;
const TIMEOUT_MS = Number(process.env.WEBHOOK_TIMEOUT_MS || 5000);
const CACHE_TENANTS_MS = 30000;
const PAUSA_INFRAESTRUCTURA_MS = 5000;
const BYTES_SECRETO = 32;
const EXIGIR_HTTPS = process.env.WEBHOOK_EXIGIR_HTTPS !== "false";

const PERMITIDOS = new Set(
    (process.env.NOTIFICADOR_HOSTS_PERMITIDOS || "")
        .split(",")
        .map(host => host.trim())
        .filter(Boolean)
);

const lookup = crearLookup(PERMITIDOS);
const validar = crearValidadorDeMensajes();
const metricas = crearMetricas("notificador");

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    ...opcionesMysql(),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionLimit: 2,
    connectTimeout: 3000
});

function salir(error) {
    console.error("[notificador]", error.message);
    process.exit(1);
}

function esperar(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function contar(resultado) {
    metricas.eventos.inc({
        tipo: "webhook",
        resultado
    });
}

// Mide cada intento HTTP, sin registrar URLs, secretos ni identificadores.
async function enviarMedido(url, cuerpo, encabezados) {
    const inicio = process.hrtime.bigint();
    let estado = "error";

    try {
        const respuesta = await enviar(
            url,
            cuerpo,
            encabezados,
            { timeoutMs: TIMEOUT_MS, lookup }
        );

        estado = String(respuesta);
        return respuesta;
    } finally {
        const etiquetas = {
            metodo: "POST",
            ruta: "webhook",
            estado
        };

        const segundos = Number(
            process.hrtime.bigint() - inicio
        ) / 1e9;

        metricas.solicitudes.inc(etiquetas);
        metricas.duracion.observe(etiquetas, segundos);
    }
}

// Caché corta de configuración del tenant.
const tenants = new Map();

async function datosDelTenant(id) {
    const enCache = tenants.get(id);

    if (enCache && enCache.expira > Date.now()) {
        return enCache.datos;
    }

    const [filas] = await pool.query(
        "SELECT webhook_url, webhook_secret, activo FROM tenants WHERE id = ?",
        [id]
    );

    const datos = filas[0] || null;

    tenants.set(id, {
        datos,
        expira: Date.now() + CACHE_TENANTS_MS
    });

    return datos;
}

async function iniciar() {
    const conexion = await amqp.connect(
        ...conexionRabbit({ heartbeat: 10 })
    );

    conexion.on("error", salir);

    conexion.on("close", () => {
        salir(new Error("Se perdió la conexión con RabbitMQ"));
    });

    // Confirma la reprogramación antes de descartar el original.
    const canal = await conexion.createConfirmChannel();

    canal.on("error", salir);

    canal.on("close", () => {
        salir(new Error("Se cerró el canal de RabbitMQ"));
    });

    await canal.prefetch(PREFETCH);

    async function reprogramar(entrega, motivo) {
        const intento = Number(
            entrega.properties.headers?.["x-intento"] || 0
        );

        const id = entrega.properties.messageId;

        if (intento >= ESPERAS.length) {
            console.error(
                `[notificador] ${id}: ${motivo}. ` +
                "Sin más reintentos, a webhooks.dlq"
            );

            canal.nack(entrega, false, false);
            contar("dlq_reintentos_agotados");
            return;
        }

        canal.sendToQueue(ESPERAS[intento], entrega.content, {
            persistent: true,
            contentType: "application/json",
            messageId: id,
            type: "entrega",
            headers: { "x-intento": intento + 1 }
        });

        await canal.waitForConfirms();
        canal.ack(entrega);

        contar("reintento_programado");

        console.error(
            `[notificador] ${id}: ${motivo}. ` +
            `Reintento ${intento + 1} en ${ESPERAS[intento]}`
        );
    }

    async function procesar(entrega) {
        const id = entrega.properties.messageId;
        let mensaje;

        try {
            mensaje = validar(
                "EntregaWebhook",
                JSON.parse(entrega.content.toString("utf8"))
            );
        } catch (error) {
            console.error(
                `[notificador] ${id}: fuera de contrato, ` +
                `a webhooks.dlq: ${error.message}`
            );

            canal.nack(entrega, false, false);
            contar("dlq_contrato");
            return;
        }

        let tenant;

        try {
            tenant = await datosDelTenant(mensaje.tenant_id);
        } catch (error) {
            contar("error_mysql");

            console.error(
                "[notificador] MySQL no disponible, se reintentará:",
                error.code || error.message
            );

            await esperar(PAUSA_INFRAESTRUCTURA_MS);
            canal.nack(entrega, false, true);
            return;
        }

        if (
            !tenant
            || !tenant.activo
            || !tenant.webhook_url
            || !tenant.webhook_secret
        ) {
            canal.ack(entrega);
            contar("omitido");
            return;
        }

        if (tenant.webhook_secret.length !== BYTES_SECRETO) {
            console.error(
                `[notificador] ${id}: el secreto del tenant no tiene ` +
                `${BYTES_SECRETO} bytes, a webhooks.dlq`
            );

            canal.nack(entrega, false, false);
            contar("dlq_secreto");
            return;
        }

        let url;

        try {
            url = validarUrl(
                tenant.webhook_url,
                PERMITIDOS,
                { exigirHttps: EXIGIR_HTTPS }
            );
        } catch (error) {
            console.error(
                `[notificador] ${id}: destino rechazado, ` +
                `a webhooks.dlq: ${error.message}`
            );

            canal.nack(entrega, false, false);
            contar("dlq_destino");
            return;
        }

        const cuerpo = JSON.stringify(mensaje.evento);

        try {
            const estado = await enviarMedido(url, cuerpo, {
                "Content-Type": "application/json",
                "User-Agent": "reserva-cupos-notificador/1.0",
                "X-Firma": firmar(tenant.webhook_secret, cuerpo),
                "X-Webhook-Id": String(mensaje.cambio_id)
            });

            if (estado >= 200 && estado < 300) {
                console.log(
                    `[notificador] ${id}: ${mensaje.evento.tipo} ` +
                    `entregado a ${url.host} (${estado})`
                );

                canal.ack(entrega);
                contar("entregado");
                return;
            }

            contar("error_http");

            await reprogramar(
                entrega,
                `el tenant respondió ${estado}`
            );
        } catch (error) {
            if (error instanceof ErrorDestino) {
                console.error(
                    `[notificador] ${id}: destino rechazado, ` +
                    `a webhooks.dlq: ${error.message}`
                );

                canal.nack(entrega, false, false);
                contar("dlq_destino");
                return;
            }

            contar("error_envio");

            await reprogramar(
                entrega,
                error.code || error.message
            );
        }
    }

    await canal.consume(
        COLA,
        entrega => {
            if (!entrega) {
                return salir(
                    new Error("RabbitMQ canceló el consumidor")
                );
            }

            procesar(entrega).catch(salir);
        },
        { noAck: false }
    );

    console.log(
        `[notificador] Entregando webhooks desde ${COLA}` +
        ` · hosts permitidos: ${[...PERMITIDOS].join(", ") || "ninguno"}`
    );
}

// Métricas HTTPS disponibles únicamente en el puerto interno.
const servidorMetricas = https.createServer({
    cert: fs.readFileSync(process.env.TLS_CERT),
    key: fs.readFileSync(process.env.TLS_KEY),
    minVersion: "TLSv1.2"
}, async (req, res) => {
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
            "[notificador] Error al exportar métricas:",
            error.message
        );

        res.writeHead(500);
        res.end();
    }
});

servidorMetricas.on("error", salir);

servidorMetricas.listen(9464, "0.0.0.0", () => {
    console.log(
        "[notificador] Métricas disponibles en puerto interno 9464"
    );
});

iniciar().catch(salir);
