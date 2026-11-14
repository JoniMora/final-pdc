const os = require("node:os");
const path = require("node:path");
const express = require("express");
const OpenApiValidator = require("express-openapi-validator");
const { pool, esErrorDeInfraestructura } = require("./db");
const { Problema, enviarProblema, problemas } = require("./problemas");
const { rutas, autenticar } = require("./rutas");

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

const app = express();

app.disable("x-powered-by");

// metadata admite hasta 16 KB; el resto del cuerpo es chico.
app.use(express.json({ limit: "24kb" }));

// Salud del proceso. Informa la base sin fallar si no responde. La
// instancia permite ver a qué réplica llegó cada solicitud detrás del
// gateway.
// Pool exclusivo para salud: no espera detrás de las reservas.
// Conserva la verificación TLS cuando el entorno seguro está activo.
const poolSalud = require("mysql2/promise").createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionLimit: 1,
    waitForConnections: false,
    connectTimeout: 1000,
    ...(process.env.DB_SSL_CA
        ? {
            ssl: {
                ca: require("node:fs").readFileSync(
                    process.env.DB_SSL_CA
                ),
                rejectUnauthorized: true,
                verifyIdentity: true
            }
        }
        : {})
});

app.get("/health", async (req, res) => {
    let mysql = "conectado";

    try {
        await poolSalud.query({
            sql: "SELECT 1",
            timeout: 500
        });
    } catch {
        mysql = "no disponible";
    }

    res.json({
        servicio: "api",
        instancia: INSTANCIA,
        estado: "ok",
        mysql
    });
});

// El tenant se autentica antes de validar: una solicitud sin clave
// responde 401 aunque además sea inválida.
app.use("/v1", autenticar);

app.use(OpenApiValidator.middleware({
    apiSpec: CONTRATO,
    validateRequests: true,
    validateResponses: VALIDAR_RESPUESTAS,
    // La autenticación la resuelve la API (el tenant sale de la clave).
    validateSecurity: false,
    // Una ruta que no está en el contrato responde 404.
    ignoreUndocumented: false
}));

app.use("/v1", rutas);

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

const servidor = process.env.TLS_CERT
    ? require('node:https').createServer({
        cert:require('node:fs').readFileSync(process.env.TLS_CERT),
        key:require('node:fs').readFileSync(process.env.TLS_KEY),minVersion:'TLSv1.2'
    },app) : require('node:http').createServer(app);
servidor.listen(PORT, "0.0.0.0", () => {
    console.log(`[API] Escuchando en puerto ${PORT} · contrato ${CONTRATO}`);
});

servidor.on("error", error => {
    console.error("[API]", error.message);
    process.exit(1);
});
