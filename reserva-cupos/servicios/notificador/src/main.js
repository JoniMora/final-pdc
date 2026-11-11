const mysql = require("mysql2/promise");
const amqp = require("amqplib");
const { crearValidadorDeMensajes } = require("../../../compartido/src/contrato");
const { firmar } = require("./firma");
const { ErrorDestino, validarUrl, crearLookup } = require("./destino");
const { enviar } = require("./enviar");

// Entrega los webhooks de los tenants. Consume webhooks.entregas, firma
// cada evento y hace el POST descrito en contrato/openapi.yaml (sección
// webhooks). Si el tenant no responde 2xx, reprograma la entrega en las
// colas de espera (10 s, 1 min y 5 min); agotadas, va a webhooks.dlq. El
// feed /v1/cambios sigue teniendo el evento: la DLQ no implica pérdida.

const COLA = "webhooks.entregas";
const ESPERAS = ["webhooks.espera.10s", "webhooks.espera.1m", "webhooks.espera.5m"];
const PREFETCH = 10;
const TIMEOUT_MS = Number(process.env.WEBHOOK_TIMEOUT_MS || 5000);
const CACHE_TENANTS_MS = 30000;
const PAUSA_INFRAESTRUCTURA_MS = 5000;
const BYTES_SECRETO = 32;

const PERMITIDOS = new Set(
    (process.env.NOTIFICADOR_HOSTS_PERMITIDOS || "")
        .split(",")
        .map(host => host.trim())
        .filter(Boolean)
);

const lookup = crearLookup(PERMITIDOS);
const validar = crearValidadorDeMensajes();

const pool = mysql.createPool({
    host: process.env.DB_HOST,
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

// URL y secreto del tenant, con una caché corta para no consultar MySQL en
// cada entrega.
const tenants = new Map();

async function datosDelTenant(id) {
    const enCache = tenants.get(id);
    if (enCache && enCache.expira > Date.now()) return enCache.datos;

    const [filas] = await pool.query(
        "SELECT webhook_url, webhook_secret, activo FROM tenants WHERE id = ?",
        [id]
    );

    const datos = filas[0] || null;
    tenants.set(id, { datos, expira: Date.now() + CACHE_TENANTS_MS });
    return datos;
}

async function iniciar() {
    const conexion = await amqp.connect({
        hostname: process.env.RABBITMQ_HOST,
        username: process.env.RABBITMQ_USER,
        password: process.env.RABBITMQ_PASSWORD,
        heartbeat: 10
    });

    conexion.on("error", salir);
    conexion.on("close", () => salir(new Error("Se perdió la conexión con RabbitMQ")));

    // Canal con confirmaciones: una reprogramación se confirma antes de
    // descartar el mensaje original.
    const canal = await conexion.createConfirmChannel();

    canal.on("error", salir);
    canal.on("close", () => salir(new Error("Se cerró el canal de RabbitMQ")));

    await canal.prefetch(PREFETCH);

    async function reprogramar(entrega, motivo) {
        const intento = Number(entrega.properties.headers?.["x-intento"] || 0);
        const id = entrega.properties.messageId;

        if (intento >= ESPERAS.length) {
            console.error(`[notificador] ${id}: ${motivo}. Sin más reintentos, a webhooks.dlq`);
            canal.nack(entrega, false, false);
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

        console.error(`[notificador] ${id}: ${motivo}. Reintento ${intento + 1} en ${ESPERAS[intento]}`);
    }

    async function procesar(entrega) {
        const id = entrega.properties.messageId;
        let mensaje;

        try {
            mensaje = validar("EntregaWebhook", JSON.parse(entrega.content.toString("utf8")));
        } catch (error) {
            console.error(`[notificador] ${id}: fuera de contrato, a webhooks.dlq: ${error.message}`);
            canal.nack(entrega, false, false);
            return;
        }

        let tenant;

        try {
            tenant = await datosDelTenant(mensaje.tenant_id);
        } catch (error) {
            console.error(`[notificador] MySQL no disponible, se reintentará: ${error.code || error.message}`);
            await esperar(PAUSA_INFRAESTRUCTURA_MS);
            canal.nack(entrega, false, true);
            return;
        }

        if (!tenant || !tenant.activo || !tenant.webhook_url || !tenant.webhook_secret) {
            // El tenant no registró webhook: sincroniza leyendo el feed.
            canal.ack(entrega);
            return;
        }

        // El contrato fija un secreto de 32 bytes: con otro largo, el tenant
        // no podría verificar la firma. Es un error de configuración.
        if (tenant.webhook_secret.length !== BYTES_SECRETO) {
            console.error(`[notificador] ${id}: el secreto del tenant no tiene ${BYTES_SECRETO} bytes, a webhooks.dlq`);
            canal.nack(entrega, false, false);
            return;
        }

        let url;

        try {
            url = validarUrl(tenant.webhook_url, PERMITIDOS);
        } catch (error) {
            console.error(`[notificador] ${id}: destino rechazado, a webhooks.dlq: ${error.message}`);
            canal.nack(entrega, false, false);
            return;
        }

        const cuerpo = JSON.stringify(mensaje.evento);

        try {
            const estado = await enviar(url, cuerpo, {
                "Content-Type": "application/json",
                "User-Agent": "reserva-cupos-notificador/1.0",
                "X-Firma": firmar(tenant.webhook_secret, cuerpo),
                "X-Webhook-Id": String(mensaje.cambio_id)
            }, { timeoutMs: TIMEOUT_MS, lookup });

            if (estado >= 200 && estado < 300) {
                console.log(`[notificador] ${id}: ${mensaje.evento.tipo} entregado a ${url.host} (${estado})`);
                canal.ack(entrega);
                return;
            }

            await reprogramar(entrega, `el tenant respondió ${estado}`);
        } catch (error) {
            if (error instanceof ErrorDestino) {
                console.error(`[notificador] ${id}: destino rechazado, a webhooks.dlq: ${error.message}`);
                canal.nack(entrega, false, false);
                return;
            }

            await reprogramar(entrega, error.code || error.message);
        }
    }

    await canal.consume(COLA, entrega => {
        if (!entrega) return salir(new Error("RabbitMQ canceló el consumidor"));

        procesar(entrega).catch(salir);
    }, { noAck: false });

    console.log(`[notificador] Entregando webhooks desde ${COLA} · hosts permitidos: ${[...PERMITIDOS].join(", ") || "ninguno"}`);
}

iniciar().catch(salir);
