const fs = require("node:fs");
const https = require("node:https");
const mysql = require("mysql2/promise");
const amqp = require("amqplib");

const { crearValidadorDeMensajes } = require("../../../compartido/src/contrato");
const { opcionesMysql, conexionRabbit } = require("../../../compartido/src/tls");
const { crearMetricas, crearMetricasCircuitos, crearMetricaWebhooksTenant } = require("../../../compartido/src/metricas");
const { crearSalud, atenderSalud } = require("../../../compartido/src/salud");
const { crearCircuitos, ErrorHttp } = require("./circuitos");
const { planReintento } = require('./reintento');

const { firmar } = require("./firma");
const { ErrorDestino, validarUrl, crearLookup } = require("./destino");
const { enviar } = require("./enviar");

const COLA = "webhooks.entregas";

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
const metricasCircuitos = crearMetricasCircuitos(metricas.registro);
const webhooksTenant = crearMetricaWebhooksTenant(metricas.registro);
const circuitos = crearCircuitos({
    enviar: enviarMedido,
    metricas: metricasCircuitos,
    resetTimeout: Number(process.env.WEBHOOK_CIRCUITO_ESPERA_MS || 10000),
    volumeThreshold: Number(process.env.WEBHOOK_CIRCUITO_MINIMOS || 3),
    errorFilter: error => error instanceof ErrorDestino,
    onTransicion: evento => console.log('[notificador] circuito', JSON.stringify(evento))
});

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    ...opcionesMysql(),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionLimit: 2,
    connectTimeout: 3000
});

// RabbitMQ: si se pierde la conexión el proceso termina y Docker lo
// reinicia; mientras tanto /health lo informa.
let rabbitConectado = false;
const salud = crearSalud({ servicio: "notificador", pool, rabbitmq: () => rabbitConectado });

function salir(error) {
    console.error("[notificador]", error.message);
    process.exit(1);
}

function esperar(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Con el tenant ya leído, también por tenant (con su nombre): así Grafana
// muestra que la falla del receptor de uno no frena las entregas a otro.
function contar(resultado, tenant) {
    metricas.eventos.inc({
        tipo: "webhook",
        resultado
    });

    if (tenant?.nombre) webhooksTenant.inc({ tenant: tenant.nombre, resultado });
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
        "SELECT nombre, webhook_url, webhook_secret, activo FROM tenants WHERE id = ?",
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
        rabbitConectado = false;
        salir(new Error("Se perdió la conexión con RabbitMQ"));
    });

    // Confirma la reprogramación antes de descartar el original.
    const canal = await conexion.createConfirmChannel();
    rabbitConectado = true;

    canal.on("error", salir);

    canal.on("close", () => {
        salir(new Error("Se cerró el canal de RabbitMQ"));
    });

    await canal.prefetch(PREFETCH);

    async function reprogramar(entrega, motivo, { consumirIntento = true } = {}) {
        const cabeceras = entrega.properties.headers || {};
        const intento = Number(cabeceras["x-intento"] || 0);
        const id = entrega.properties.messageId;
        const plan = planReintento(intento, {
            consumir: consumirIntento,
            primerFallo: Number(cabeceras["x-primer-fallo"])
        });

        if (plan.agotado) {
            console.error(`[notificador] ${id}: ${motivo}. ${plan.motivo}, a webhooks.dlq`);

            canal.nack(entrega, false, false);
            contar("dlq_reintentos_agotados");
            return;
        }

        canal.sendToQueue(plan.cola, entrega.content, {
            persistent: true,
            contentType: "application/json",
            messageId: id,
            type: "entrega",
            headers: { "x-intento": plan.intento, "x-primer-fallo": plan.primerFallo }
        });

        await canal.waitForConfirms();
        canal.ack(entrega);

        contar("reintento_programado");

        console.error(
            `[notificador] ${id}: ${motivo}. ` +
            `${consumirIntento ? "Reintento " + (intento + 1) : "Diferido sin intento HTTP"} en ${plan.cola}`
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
            contar("omitido", tenant);
            return;
        }

        if (tenant.webhook_secret.length !== BYTES_SECRETO) {
            console.error(
                `[notificador] ${id}: el secreto del tenant no tiene ` +
                `${BYTES_SECRETO} bytes, a webhooks.dlq`
            );

            canal.nack(entrega, false, false);
            contar("dlq_secreto", tenant);
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
            contar("dlq_destino", tenant);
            return;
        }

        const cuerpo = JSON.stringify(mensaje.evento);

        try {
            const estado = await circuitos.ejecutar(mensaje.tenant_id, url, cuerpo, {
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
                contar("entregado", tenant);
                const demora = (Date.now() - Date.parse(mensaje.evento.ocurrido_en)) / 1000;
                if (Number.isFinite(demora)) metricasCircuitos.demora.observe(Math.max(0, demora));
                return;
            }

            contar("error_http", tenant);

            await reprogramar(
                entrega,
                `el tenant respondió ${estado}`
            );
        } catch (error) {
            if (error.code === 'EOPENBREAKER') {
                contar('diferido_circuito', tenant);
                await reprogramar(entrega, "circuito abierto o prueba de recuperación en curso", { consumirIntento: false });
                return;
            }
            if (error instanceof ErrorDestino) {
                console.error(
                    `[notificador] ${id}: destino rechazado, ` +
                    `a webhooks.dlq: ${error.message}`
                );

                canal.nack(entrega, false, false);
                contar("dlq_destino", tenant);
                return;
            }

            contar(error instanceof ErrorHttp ? 'error_http' : 'error_envio', tenant);

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
