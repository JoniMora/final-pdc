const fs = require("node:fs");
const { timingSafeEqual } = require("node:crypto");
const { problemas } = require("./problemas");
const { sha256 } = require("./modelo");

// Control de acceso de la API (Entrega 5): quién llama (autenticación del
// tenant o del operador), qué puede hacer (permisos de la clave) y cuánto
// (límite de tasa por tenant).

// --- Tenants -------------------------------------------------------------

// El tenant se deriva siempre de la clave, nunca de la ruta ni del cuerpo.
// Se leen además sus permisos y su límite de tasa.
function crearAutenticacion(pool) {
    return async function autenticar(req, res, next) {
        const clave = claveBearer(req);

        if (!clave) throw problemas.noAutenticado();

        const [filas] = await pool.query(
            `SELECT id, scopes, limite_por_segundo, limite_rafaga
               FROM tenants WHERE api_key_hash = ? AND activo = TRUE`,
            [sha256(clave)]
        );

        if (filas.length === 0) throw problemas.noAutenticado();

        const fila = filas[0];

        req.tenantId = fila.id;
        req.scopes = new Set(fila.scopes ? fila.scopes.split(",") : []);
        req.limite = fila.limite_por_segundo
            ? { porSegundo: fila.limite_por_segundo, rafaga: fila.limite_rafaga }
            : null;

        next();
    };
}

function claveBearer(req) {
    const [esquema, clave] = (req.get("authorization") || "").split(" ");
    return esquema === "Bearer" && clave ? clave : null;
}

// Los permisos que exige cada operación son los que declara el contrato en
// su `security` (claveApi: [...]). El validador del contrato deja la
// operación en req.openapi.schema, así la API aplica exactamente lo que el
// contrato publica y no una lista paralela que pueda desincronizarse.
function permisosDeOperacion(operacion, global = []) {
    const requisitos = operacion?.security ?? global;
    const claveApi = requisitos.find(requisito => "claveApi" in requisito);
    return claveApi ? claveApi.claveApi : [];
}

function crearExigirPermisos(contrato) {
    return function exigirPermisos(req, res, next) {
        const faltan = permisosDeOperacion(req.openapi?.schema, contrato.security)
            .filter(scope => !req.scopes.has(scope));

        if (faltan.length > 0) throw problemas.permisoInsuficiente(faltan);

        next();
    };
}

// Token bucket por tenant, en memoria de cada instancia. Con N instancias
// detrás de Traefik el límite efectivo es hasta N veces el configurado; la
// Entrega 6 lo lleva a Redis para que sea global.
function crearLimitador({ porSegundo, rafaga, reloj = Date.now }) {
    const baldes = new Map();

    return function limitar(req, res, next) {
        const limite = req.limite || { porSegundo, rafaga };
        const ahora = reloj();
        let balde = baldes.get(req.tenantId);

        if (!balde || balde.rafaga !== limite.rafaga || balde.porSegundo !== limite.porSegundo) {
            balde = { fichas: limite.rafaga, ultimo: ahora, ...limite };
            baldes.set(req.tenantId, balde);
        }

        balde.fichas = Math.min(balde.rafaga, balde.fichas + (ahora - balde.ultimo) / 1000 * balde.porSegundo);
        balde.ultimo = ahora;

        if (balde.fichas < 1) {
            const segundos = Math.max(1, Math.ceil((1 - balde.fichas) / balde.porSegundo));
            throw problemas.demasiadasSolicitudes(segundos);
        }

        balde.fichas -= 1;
        next();
    };
}

// --- Operador de la plataforma -------------------------------------------

// La clave del operador no está en la base ni en el compose: el script de
// preparación la genera y la API recibe solo su hash SHA-256 en un archivo
// montado. Sin ese archivo, /admin no acepta ninguna clave.
function leerHashAdministrador(ruta) {
    if (!ruta) return null;

    try {
        const hex = fs.readFileSync(ruta, "utf8").trim();
        return /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, "hex") : null;
    } catch (_) {
        return null;
    }
}

// Autenticación en /admin, antes de validar contra el contrato: sin clave
// o con una desconocida responde 401. Una clave válida de tenant se
// reconoce (req.esOperador = false) y recibe 403 recién después de la
// validación, en exigirOperador: así un método o una ruta que no existen
// responden 405 o 404 igual que en /v1.
function crearAutenticacionAdministrador(pool, hashAdministrador) {
    return async function autenticarAdministrador(req, res, next) {
        const clave = claveBearer(req);

        if (!clave) throw problemas.noAutenticadoAdministrador();

        const hash = sha256(clave);

        if (hashAdministrador && timingSafeEqual(hash, hashAdministrador)) {
            req.esOperador = true;
            return next();
        }

        const [filas] = await pool.query(
            "SELECT 1 FROM tenants WHERE api_key_hash = ? AND activo = TRUE",
            [hash]
        );

        if (filas.length === 0) throw problemas.noAutenticadoAdministrador();

        req.esOperador = false;
        next();
    };
}

function exigirOperador(req, res, next) {
    if (!req.esOperador) throw problemas.soloAdministrador();
    next();
}

module.exports = {
    crearAutenticacion,
    crearExigirPermisos,
    crearLimitador,
    crearAutenticacionAdministrador,
    exigirOperador,
    leerHashAdministrador,
    permisosDeOperacion
};
