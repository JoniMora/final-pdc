// Cliente de referencia liviano (issue #63): el mismo código atiende a
// Canchas (turnos de fútbol 5) y a Eventos (entradas), cada uno con su
// propio tenant. Muestra que el servicio es multi-tenant: varias
// organizaciones a la vez, cada una con sus datos, su límite de tasa y su
// webhook, sin verse entre sí.
//
// No tiene base propia ni cuentas de usuarios: lo usa el organizador. Las
// personas, los roles y la contingencia con base local los muestra Aula.

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const express = require("express");
const { crearClienteApi, ErrorDeContrato } = require("../../../compartido/src/cliente-api");
const { verificarFirma } = require("../../../compartido/src/firma-webhook");
const { perfil: elegirPerfil, metadataDeActividad } = require("./perfiles");
const { crearProyeccion } = require("./proyeccion");
const { crearSincronizacion } = require("./sincronizacion");
const { crearCredenciales } = require("./credenciales");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAVE_IDEMPOTENCIA = /^[A-Za-z0-9_-]{8,64}$/;

class ErrorDeCliente extends Error {
    constructor(status, mensaje) {
        super(mensaje);
        this.status = status;
    }
}

// Traduce la respuesta de la API para el navegador. El 404 de un recurso
// ajeno es el aislamiento entre tenants: para el servicio no existe.
function errorDeApi(respuesta, perfil) {
    const detalle = respuesta.cuerpo?.detail || respuesta.cuerpo?.title || `HTTP ${respuesta.status}`;

    switch (respuesta.status) {
        case 400:
        case 409:
        case 422:
            return new ErrorDeCliente(respuesta.status, detalle);
        case 404:
            return new ErrorDeCliente(404,
                `No existe para el tenant ${perfil.nombre} (404): el servicio no muestra recursos de otro tenant`);
        case 429:
            return Object.assign(new ErrorDeCliente(429,
                `Límite de tasa del tenant: reintentar en ${respuesta.retryAfter || 1} s`), { retryAfter: respuesta.retryAfter });
        case 401:
        case 403:
            return new ErrorDeCliente(502, `La API rechazó la clave del tenant (${respuesta.status}): correr node scripts/sistema.js demo`);
        default:
            return new ErrorDeCliente(503, `La API no pudo atender la solicitud (${respuesta.status})`);
    }
}

function crearApp({ perfil, api, credenciales, proyeccion, sincronizacion }) {
    const app = express();
    app.disable("x-powered-by");

    // Sin scripts ni estilos en línea: el tema sale de /tema.css.
    app.use((req, res, next) => {
        res.set({
            "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer"
        });
        next();
    });

    // Receptor de webhooks. Antes del parser JSON: la firma se verifica
    // sobre el cuerpo exacto recibido.
    app.post("/webhooks/reservas", express.raw({ type: "application/json", limit: "64kb" }), (req, res) => {
        const cuerpo = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
        const webhookId = req.get("x-webhook-id") || null;
        const firma = verificarFirma(cuerpo, req.get("x-firma"), credenciales.secreto());

        if (!firma.valida) {
            console.error(`[${perfil.id}] Webhook ${webhookId || "-"} rechazado: ${firma.motivo}`);
            proyeccion.registrarWebhook({ webhook_id: webhookId, valido: false, motivo: firma.motivo });
            return res.status(401).end();
        }

        let evento;

        try {
            evento = api.contrato.validarEsquema("EventoReserva", JSON.parse(cuerpo));
        } catch (error) {
            console.error(`[${perfil.id}] Webhook ${webhookId} fuera de contrato: ${error.message}`);
            proyeccion.registrarWebhook({ webhook_id: webhookId, valido: false, motivo: "Fuera de contrato" });
            return res.status(400).end();
        }

        const aplicado = proyeccion.aplicarReserva(evento.entidad);
        proyeccion.registrarWebhook({
            webhook_id: webhookId,
            valido: true,
            aplicado,
            tipo: evento.tipo,
            secuencia: evento.secuencia,
            participante: evento.entidad.participante,
            actividad_id: evento.entidad.actividad_id
        });

        // Una reserva de una actividad que todavía no se vio (creada por
        // otro proceso, como k6): el feed la trae.
        if (!proyeccion.conoce(evento.entidad.actividad_id)) sincronizacion.sincronizar();

        res.status(204).end();
    });

    app.use(express.json({ limit: "16kb" }));
    app.use(express.static(path.join(__dirname, "../public")));

    app.get("/health", (req, res) => res.json({ estado: "ok", cliente: perfil.id }));

    app.get("/tema.css", (req, res) => {
        const { acento, acentoOscuro, suave, suaveOscuro } = perfil.colores;
        res.type("text/css").send(
            `:root{--acento:${acento};--acento-suave:${suave}}\n` +
            `@media (prefers-color-scheme: dark){:root{--acento:${acentoOscuro};--acento-suave:${suaveOscuro}}}\n`);
    });

    app.get("/api/config", (req, res) => {
        const { id, nombre, titulo, actividad, participante, capacidad, campos } = perfil;
        res.json({ id, nombre, titulo, actividad, participante, capacidad, campos });
    });

    app.get("/api/estado", (req, res) => {
        res.json({
            tenant: {
                ...credenciales.tenant(),
                configurado: Boolean(credenciales.clave()),
                ...sincronizacion.estado
            },
            actividades: proyeccion.listar(),
            webhooks: proyeccion.webhooks(),
            recibidos: proyeccion.recibidos()
        });
    });

    // Sin cuentas no hay sesión que robar, pero un sitio ajeno no debe poder
    // crear ni cancelar nada desde el navegador del organizador: las
    // escrituras exigen JSON (un formulario de otro sitio no puede enviarlo
    // sin una consulta previa de CORS, que no se permite) y el mismo origen.
    app.use("/api", (req, res, next) => {
        if (req.method === "GET") return next();

        const sitio = req.get("sec-fetch-site");
        const origen = req.get("origin");
        const mismoOrigen = !origen || origen === `https://${req.get("host")}` || origen === `http://${req.get("host")}`;

        if (!req.is("application/json") || (sitio && sitio !== "same-origin") || !mismoOrigen) {
            throw new ErrorDeCliente(403, "Solo desde la propia página del cliente");
        }

        next();
    });

    app.post("/api/actividades", async (req, res) => {
        const nombre = typeof req.body?.nombre === "string" ? req.body.nombre.trim() : "";
        const capacidad = Number(req.body?.capacidad);

        if (!nombre || nombre.length > 200) throw new ErrorDeCliente(400, "El nombre es obligatorio (hasta 200 caracteres)");
        if (!Number.isInteger(capacidad) || capacidad < 1 || capacidad > 100000) {
            throw new ErrorDeCliente(400, `${perfil.capacidad.etiqueta}: un entero entre 1 y 100000`);
        }

        let metadata;
        try {
            metadata = metadataDeActividad(perfil, req.body?.metadata);
        } catch (error) {
            throw new ErrorDeCliente(400, error.message);
        }

        const respuesta = await api.llamar("crearActividad", { cuerpo: { nombre, capacidad, metadata } });
        if (respuesta.status !== 201) throw errorDeApi(respuesta, perfil);

        proyeccion.aplicarActividad(respuesta.cuerpo);
        res.status(201).json(respuesta.cuerpo);
    });

    // Lo que ya está en la proyección sale de ella; un id desconocido se
    // consulta a la API (así se ve el 404 de un recurso de otro tenant).
    app.get("/api/actividades/:id", async (req, res) => {
        if (!UUID.test(req.params.id)) throw new ErrorDeCliente(400, "El id tiene que ser un UUID");

        const conocida = proyeccion.detalle(req.params.id);
        if (conocida) return res.json(conocida);

        const respuesta = await api.llamar("consultarActividad", { parametros: { id: req.params.id } });
        if (respuesta.status !== 200) throw errorDeApi(respuesta, perfil);

        proyeccion.aplicarActividad(respuesta.cuerpo);
        sincronizacion.sincronizar();
        res.json(proyeccion.detalle(req.params.id));
    });

    app.patch("/api/actividades/:id", async (req, res) => {
        if (!UUID.test(req.params.id)) throw new ErrorDeCliente(400, "El id tiene que ser un UUID");
        if (!["abierta", "cerrada"].includes(req.body?.estado)) throw new ErrorDeCliente(400, "estado: abierta o cerrada");

        const respuesta = await api.llamar("cambiarEstadoActividad", {
            parametros: { id: req.params.id },
            cuerpo: { estado: req.body.estado }
        });
        if (respuesta.status !== 200) throw errorDeApi(respuesta, perfil);

        proyeccion.aplicarActividad(respuesta.cuerpo);
        res.json(respuesta.cuerpo);
    });

    // La clave de idempotencia la genera el navegador por intento de
    // reserva: si reintenta, es la misma y el servicio no duplica.
    app.post("/api/actividades/:id/reservas", async (req, res) => {
        if (!UUID.test(req.params.id)) throw new ErrorDeCliente(400, "El id tiene que ser un UUID");

        const participante = typeof req.body?.participante === "string" ? req.body.participante.trim() : "";
        if (!participante || participante.length > 128) {
            throw new ErrorDeCliente(400, `Falta el ${perfil.participante.singular} (hasta 128 caracteres)`);
        }
        if (!CLAVE_IDEMPOTENCIA.test(req.body?.clave || "")) throw new ErrorDeCliente(400, "Falta la clave de idempotencia");

        const respuesta = await api.llamar("solicitarReserva", {
            parametros: { id: req.params.id },
            cuerpo: { participante },
            encabezados: { "Idempotency-Key": `${perfil.id}-${req.body.clave}` }
        });
        if (respuesta.status !== 202 && respuesta.status !== 200) throw errorDeApi(respuesta, perfil);

        proyeccion.aplicarReserva(respuesta.cuerpo);
        res.status(respuesta.status).json(respuesta.cuerpo);
    });

    app.post("/api/reservas/:id/cancelacion", async (req, res) => {
        if (!UUID.test(req.params.id)) throw new ErrorDeCliente(400, "El id tiene que ser un UUID");

        const respuesta = await api.llamar("cancelarReserva", { parametros: { id: req.params.id } });
        if (respuesta.status !== 202 && respuesta.status !== 200) throw errorDeApi(respuesta, perfil);

        proyeccion.aplicarReserva(respuesta.cuerpo);
        res.status(respuesta.status).json(respuesta.cuerpo);
    });

    // eslint-disable-next-line no-unused-vars
    app.use((error, req, res, next) => {
        if (error instanceof ErrorDeCliente) {
            if (error.retryAfter) res.set("Retry-After", error.retryAfter);
            return res.status(error.status).json({ mensaje: error.message });
        }
        if (error.type === "entity.parse.failed") return res.status(400).json({ mensaje: "JSON inválido" });
        if (error.type === "entity.too.large") return res.status(413).json({ mensaje: "Cuerpo demasiado grande" });
        if (error instanceof ErrorDeContrato) {
            console.error(`[${perfil.id}] Respuesta de la API fuera de contrato: ${error.message}`);
            return res.status(502).json({ mensaje: "La API respondió fuera de contrato" });
        }
        if (error.name === "TimeoutError" || error.name === "AbortError" || error.cause) {
            return res.status(503).json({ mensaje: "La API no responde" });
        }

        console.error(`[${perfil.id}] Error interno:`, error);
        res.status(500).json({ mensaje: "Error interno del cliente" });
    });

    return app;
}

function main() {
    const perfil = elegirPerfil();
    const credenciales = crearCredenciales(process.env.CREDENCIALES_DIR || "/credenciales");
    const api = crearClienteApi({ baseUrl: process.env.API_URL || "https://traefik", clave: credenciales.clave });
    const proyeccion = crearProyeccion();
    const sincronizacion = crearSincronizacion({ api, proyeccion, claveActual: credenciales.clave });
    const app = crearApp({ perfil, api, credenciales, proyeccion, sincronizacion });
    const puerto = Number(process.env.PORT || 3003);

    // Por HTTPS al navegador y al notificador (webhooks). Sin TLS_CERT,
    // solo para pruebas fuera de Docker.
    const servidor = process.env.TLS_CERT
        ? https.createServer({
            cert: fs.readFileSync(process.env.TLS_CERT),
            key: fs.readFileSync(process.env.TLS_KEY),
            minVersion: "TLSv1.2"
        }, app)
        : http.createServer(app);

    servidor.listen(puerto, "0.0.0.0", () => {
        console.log(`[${perfil.id}] ${perfil.nombre} escuchando en ${process.env.TLS_CERT ? "https" : "http"}://0.0.0.0:${puerto}`);
        sincronizacion.iniciar();
    });

    const salir = () => {
        sincronizacion.detener();
        servidor.close(() => process.exit(0));
    };
    process.on("SIGTERM", salir);
    process.on("SIGINT", salir);
}

if (require.main === module) main();

module.exports = { crearApp, errorDeApi };
