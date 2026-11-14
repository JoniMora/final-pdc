const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const express = require("express");
const yaml = require("js-yaml");
const OpenApiValidator = require("express-openapi-validator");
const { pool, esErrorDeInfraestructura } = require("./db");
const { Problema, enviarProblema, problemas } = require("./problemas");
const { rutas } = require("./rutas");
const { rutasAdmin } = require("./admin");
const {
    crearAutenticacion,
    crearExigirPermisos,
    crearLimitador,
    crearAutenticacionAdministrador,
    exigirOperador,
    leerHashAdministrador
} = require("./acceso");

const PORT = Number(process.env.PORT || 3000);
const INSTANCIA = os.hostname();

// El contrato es la fuente de verdad de la interfaz: la API valida cada
// solicitud contra él antes de ejecutar la ruta y, en desarrollo y CI,
// también cada respuesta que devuelve.
const CONTRATO = path.join(
    process.env.CONTRATO_DIR || path.resolve(__dirname, "../../../contrato"),
    "openapi.yaml"
);
const VALIDAR_RESPUESTAS = process.env.VALIDAR_RESPUESTAS === "true";
const contrato = yaml.load(fs.readFileSync(CONTRATO, "utf8"));

// Límite de tasa por defecto de cada tenant; el operador puede fijar otro
// por tenant con PATCH /admin/v1/tenants/{id}.
const limitar = crearLimitador({
    porSegundo: Number(process.env.LIMITE_POR_SEGUNDO || 50),
    rafaga: Number(process.env.LIMITE_RAFAGA || 100)
});

const hashAdministrador = leerHashAdministrador(process.env.ADMIN_CLAVE_SHA256_ARCHIVO);

if (!hashAdministrador) {
    console.warn("[API] Sin clave de administrador configurada: /admin/v1 rechaza todas las solicitudes");
}

const app = express();

app.disable("x-powered-by");

// metadata admite hasta 16 KB; el resto del cuerpo es chico.
app.use(express.json({ limit: "24kb" }));

// Salud del proceso. Informa la base sin fallar si no responde. La
// instancia permite ver a qué réplica llegó cada solicitud detrás del
// gateway.
//
// Responde en 1 s como máximo aunque el pool de MySQL esté ocupado (por
// ejemplo, todas las conexiones esperando la confirmación semisíncrona
// cuando cae la réplica). Si tardara más que el health check de Traefik
// (3 s), Traefik sacaría de servicio a una instancia que está funcionando.
app.get("/health", async (req, res) => {
    const mysql = await Promise.race([
        pool.query({ sql: "SELECT 1", timeout: 1000 }).then(() => "conectado", () => "no disponible"),
        new Promise(resolve => setTimeout(resolve, 1000, "ocupado"))
    ]);

    res.json({ servicio: "api", instancia: INSTANCIA, estado: "ok", mysql });
});

// El tenant se autentica antes de validar: una solicitud sin clave
// responde 401 aunque además sea inválida. Después se descuenta del límite
// de tasa del tenant, también antes de validar: una ráfaga de solicitudes
// inválidas consume el cupo igual que una de válidas.
app.use("/v1", crearAutenticacion(pool, limitar), limitar);
app.use("/admin", crearAutenticacionAdministrador(pool, hashAdministrador));

app.use(OpenApiValidator.middleware({
    apiSpec: CONTRATO,
    validateRequests: true,
    validateResponses: VALIDAR_RESPUESTAS,
    // La autenticación la resuelve la API (el tenant sale de la clave).
    validateSecurity: false,
    // Formatos según su RFC (el modo rápido acepta, por ejemplo, una URL
    // con caracteres no ASCII como format: uri). Lo encontró Schemathesis
    // en webhook_url de la administración de tenants.
    ajvFormats: { mode: "full" },
    // Una ruta que no está en el contrato responde 404.
    ignoreUndocumented: false
}));

// Los permisos se comprueban con la operación que identificó el validador:
// son los que el contrato declara en su `security`.
app.use("/v1", crearExigirPermisos(contrato), rutas);
app.use("/admin/v1", exigirOperador, rutasAdmin);

app.use((req, res) => {
    enviarProblema(res, problemas.noEncontrado());
});

// Errores del validador del contrato → Problem Details.
function problemaDeContrato(error) {
    const detalle = (error.errors || [])
        .map(e => `${e.path ? `${e.path}: ` : ""}${e.message}`)
        .join("; ") || error.message;

    switch (error.status) {
        case 400:
            return problemas.solicitudInvalida(detalle);
        case 404:
            return problemas.noEncontrado();
        case 405:
            return new Problema(405, "metodo-no-permitido", "Método no permitido", null, error.headers || {});
        case 413:
            return new Problema(413, null, "Cuerpo demasiado grande");
        case 415:
            return new Problema(415, "tipo-no-soportado", "El cuerpo debe ser application/json");
        default:
            // Una respuesta que no cumple el contrato es un error del
            // servidor: se registra y no se entrega al cliente.
            console.error("[API] Respuesta fuera del contrato:", detalle);
            return new Problema(500, "fuera-de-contrato", "La respuesta no cumple el contrato");
    }
}

app.use((error, req, res, next) => {
    if (error instanceof Problema) {
        return enviarProblema(res, error);
    }

    if (error.type === "entity.too.large") {
        return enviarProblema(res, new Problema(413, null, "Cuerpo demasiado grande"));
    }

    if (error.type === "entity.parse.failed") {
        return enviarProblema(res, problemas.solicitudInvalida("JSON inválido"));
    }

    // La base no responde: lo admitido ya está guardado y el cliente
    // puede reintentar con la misma Idempotency-Key.
    if (esErrorDeInfraestructura(error)) {
        console.error("[API] MySQL no disponible:", error.code || error.message);
        return enviarProblema(res, problemas.noDisponible());
    }

    if (Number.isInteger(error.status) && Array.isArray(error.errors)) {
        return enviarProblema(res, problemaDeContrato(error));
    }

    console.error("[API] Error inesperado:", error);
    enviarProblema(res, new Problema(500, null, "Error interno"));
});

// Desde la Entrega 5 la API atiende solo por HTTPS: Traefik le habla
// cifrado y verifica su certificado. Sin TLS_CERT (pruebas fuera de
// Docker) atiende por HTTP.
const servidor = process.env.TLS_CERT
    ? https.createServer({
        cert: fs.readFileSync(process.env.TLS_CERT),
        key: fs.readFileSync(process.env.TLS_KEY),
        minVersion: "TLSv1.2"
    }, app)
    : http.createServer(app);

servidor.listen(PORT, "0.0.0.0", () => {
    console.log(`[API] Escuchando en puerto ${PORT} · contrato ${CONTRATO}`);
});

servidor.on("error", error => {
    console.error("[API]", error.message);
    process.exit(1);
});
