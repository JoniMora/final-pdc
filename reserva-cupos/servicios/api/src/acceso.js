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
//
// Con un limitador, una clave cuyo balde ya está vacío recibe 429 antes de
// consultar MySQL: un tenant que inunda la API no le cuesta a la base una
// consulta por cada solicitud que de todos modos se rechaza.
function crearAutenticacion(pool, limitador, { cache, observarConsulta = () => {} } = {}) {
    return async function autenticar(req, res, next) {
        const clave = claveBearer(req);

        if (!clave) throw problemas.noAutenticado();

        const hash = sha256(clave);
        req.claveHash = hash.toString("hex");

        await limitador?.rechazarSiAgotado?.(req.claveHash);

        async function cargar() {
            observarConsulta();
            const [filas] = await pool.query(
                `SELECT id, nombre, scopes, limite_por_segundo, limite_rafaga
                   FROM tenants WHERE api_key_hash = ? AND activo = TRUE`,
                [hash]
            );
            return filas[0] || null;
        }
        const fila = cache ? await cache.buscar(req.claveHash, cargar) : await cargar();
        if (!fila) throw problemas.noAutenticado();

        req.tenantId = fila.id;
        // Para las métricas por tenant. Una entrada de la caché anterior a
        // este campo usa el id hasta que vence.
        req.tenantNombre = fila.nombre ?? fila.id;
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

// Token bucket por clave de tenant (por su hash), en memoria de cada
// instancia. Con N instancias detrás de Traefik el límite efectivo es hasta
// N veces el configurado; la Entrega 6 lo lleva a Redis para que sea global.
//
// limitar es el middleware que descuenta una ficha una vez autenticado el
// tenant (con su límite propio o el de la plataforma). rechazarSiAgotado lo
// usa la autenticación para responder 429 sin tocar la base cuando el balde
// de esa clave ya está vacío.
function crearLimitador({ porSegundo, rafaga, reloj = Date.now }) {
    const baldes = new Map();

    function recargar(balde, ahora) {
        balde.fichas = Math.min(balde.rafaga, balde.fichas + (ahora - balde.ultimo) / 1000 * balde.porSegundo);
        balde.ultimo = ahora;
    }

    function rechazar(balde) {
        const segundos = Math.max(1, Math.ceil((1 - balde.fichas) / balde.porSegundo));
        throw problemas.demasiadasSolicitudes(segundos);
    }

    function limitar(req, res, next) {
        const clave = req.claveHash ?? req.tenantId;
        const limite = req.limite || { porSegundo, rafaga };
        const ahora = reloj();
        let balde = baldes.get(clave);

        if (!balde || balde.rafaga !== limite.rafaga || balde.porSegundo !== limite.porSegundo) {
            balde = { fichas: limite.rafaga, ultimo: ahora, ...limite };
            baldes.set(clave, balde);
        }

        recargar(balde, ahora);

        if (balde.fichas < 1) rechazar(balde);

        balde.fichas -= 1;
        next();
    }

    limitar.rechazarSiAgotado = clave => {
        const balde = baldes.get(clave);

        if (!balde) return;

        recargar(balde, reloj());

        if (balde.fichas < 1) rechazar(balde);
    };

    return limitar;
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
