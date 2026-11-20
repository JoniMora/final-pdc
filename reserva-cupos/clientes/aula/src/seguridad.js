const { randomBytes, createHash, scrypt, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");
const { readFile } = require("node:fs/promises");

// Personas de Aula (Entrega 5): login, sesiones, CSRF y roles. La clave del
// tenant identifica a Aula frente al servicio; estas identidades son las de
// los docentes y alumnos, que el servicio no conoce.
//
// Las identidades están en un archivo de solo lectura y no en PostgreSQL:
// así el login sigue funcionando cuando aula-db cae (modo contingencia).

const derivar = promisify(scrypt);
const COOKIE = "aula_sesion";
const ROLES = ["administrador", "alumno"];

// Fuerza bruta: 10 contraseñas incorrectas desde una misma IP bloquean el
// login de esa IP durante 15 minutos. Solo cuentan los fallos: los logins
// correctos no gastan intentos.
const MAX_FALLOS = 10;
const VENTANA_FALLOS_MS = 15 * 60 * 1000;
const MAX_ENTRADAS = 10000;

// Hash con el que se compara cuando el usuario no existe: así la respuesta
// tarda lo mismo y no revela qué usuarios existen.
const HASH_DE_RELLENO = `scrypt$${"0".repeat(32)}$${"0".repeat(128)}`;

function sha256(valor) {
    return createHash("sha256").update(valor).digest("hex");
}

async function hashPassword(password, sal = randomBytes(16).toString("hex")) {
    const hash = await derivar(password, sal, 64, { N: 16384, r: 8, p: 1 });
    return `scrypt$${sal}$${hash.toString("hex")}`;
}

async function verificarPassword(password, guardado) {
    if (typeof password !== "string" || password.length > 256) return false;

    const [algoritmo, sal, hash] = (guardado || "").split("$");

    if (algoritmo !== "scrypt" || !/^[0-9a-f]{32}$/.test(sal || "") || !/^[0-9a-f]{128}$/.test(hash || "")) {
        return false;
    }

    const calculado = await hashPassword(password, sal);
    return timingSafeEqual(Buffer.from(calculado), Buffer.from(guardado));
}

// Un navegador envía Origin en las escrituras: tiene que ser este mismo
// sitio. Un cliente que no es navegador no lo envía, pero igual necesita la
// cookie y el token CSRF.
function mismoOrigen(req) {
    const origen = req.get("origin");

    if (!origen) return true;

    try {
        return new URL(origen).host === req.get("host");
    } catch (_) {
        return false;
    }
}

// Un alumno solo ve y opera sus propias reservas; el administrador, todas
// las del tenant.
function puedeVer(usuario, reserva) {
    return usuario.rol === "administrador" || reserva.participante === usuario.participante;
}

function publico(persona) {
    return { usuario: persona.usuario, rol: persona.rol, participante: persona.participante || null };
}

// HSTS obliga al navegador a usar HTTPS con ese nombre durante el plazo
// indicado, en cualquier puerto. En localhost afectaría a cualquier otro
// servicio local por HTTP, así que solo se envía con un nombre real.
function esLocal(req) {
    return ["localhost", "127.0.0.1", "[::1]"].includes(req.hostname) || req.hostname?.endsWith(".localhost");
}

function crearSeguridad({ archivo, secure = true, ttlMs = 60 * 60 * 1000, reloj = Date.now, cargarUsuarios } = {}) {
    const sesiones = new Map();
    const fallos = new Map();
    const usuarios = cargarUsuarios || (async () => JSON.parse(await readFile(archivo, "utf8")));

    function limpiar() {
        const ahora = reloj();

        for (const [clave, sesion] of sesiones) if (sesion.vence <= ahora) sesiones.delete(clave);
        for (const [ip, contador] of fallos) if (contador.vence <= ahora) fallos.delete(ip);
    }

    function fallo(res, status, error) {
        res.status(status).json({ error });
    }

    async function buscar(usuario) {
        const lista = await usuarios();
        return lista.find(persona => persona.usuario === usuario && persona.activo !== false && ROLES.includes(persona.rol));
    }

    function leerToken(req) {
        const entrada = (req.headers.cookie || "")
            .split(";")
            .map(cookie => cookie.trim())
            .find(cookie => cookie.startsWith(`${COOKIE}=`));

        return entrada ? entrada.slice(COOKIE.length + 1) : null;
    }

    function exigirTransporte(req, res, next) {
        if (secure && !req.secure) return fallo(res, 400, "Se requiere HTTPS");

        res.set("Cache-Control", "no-store");
        res.set("X-Content-Type-Options", "nosniff");
        res.set("Referrer-Policy", "same-origin");
        res.set("X-Frame-Options", "DENY");

        if (secure && !esLocal(req)) res.set("Strict-Transport-Security", "max-age=86400");

        next();
    }

    async function login(req, res) {
        limpiar();

        if (!mismoOrigen(req)) return fallo(res, 403, "Origen no permitido");

        const { usuario, password } = req.body || {};

        if (typeof usuario !== "string" || usuario.length > 80 || typeof password !== "string" || password.length > 256) {
            return fallo(res, 400, "Credenciales inválidas");
        }

        const contador = fallos.get(req.ip);

        if ((contador && contador.cantidad >= MAX_FALLOS) || (!contador && fallos.size >= MAX_ENTRADAS)) {
            res.set("Retry-After", String(Math.ceil(VENTANA_FALLOS_MS / 1000)));
            return fallo(res, 429, "Demasiados intentos fallidos; espere antes de reintentar");
        }

        let persona;

        try {
            persona = await buscar(usuario);
        } catch (_) {
            return fallo(res, 503, "Identidades no disponibles");
        }

        const valida = await verificarPassword(password, persona?.passwordHash || HASH_DE_RELLENO);

        if (!persona || !valida) {
            const actual = contador || { cantidad: 0, vence: reloj() + VENTANA_FALLOS_MS };
            actual.cantidad++;
            fallos.set(req.ip, actual);
            return fallo(res, 401, "Usuario o contraseña incorrectos");
        }

        if (sesiones.size >= MAX_ENTRADAS) return fallo(res, 503, "Límite de sesiones alcanzado");

        // Fijación de sesión: el login siempre emite un token nuevo y
        // descarta el que traía el navegador.
        const anterior = leerToken(req);
        if (anterior) sesiones.delete(sha256(anterior));

        const token = randomBytes(32).toString("hex");
        const sesion = { usuario: persona.usuario, csrf: randomBytes(32).toString("hex"), vence: reloj() + ttlMs };

        // Se guarda el hash del token: un volcado de memoria no entrega
        // sesiones utilizables.
        sesiones.set(sha256(token), sesion);
        res.cookie(COOKIE, token, { httpOnly: true, secure, sameSite: "strict", path: "/", maxAge: ttlMs });
        res.json({ usuario: publico(persona), csrf: sesion.csrf });
    }

    // Se vuelve a leer la persona en cada pedido: desactivarla o cambiar su
    // rol afecta de inmediato a las sesiones abiertas.
    async function autenticar(req, res, next) {
        limpiar();

        const token = leerToken(req);
        const sesion = token && sesiones.get(sha256(token));

        if (!sesion) return fallo(res, 401, "Inicie sesión");

        let persona;

        try {
            persona = await buscar(sesion.usuario);
        } catch (_) {
            return fallo(res, 503, "Identidades no disponibles");
        }

        if (!persona) return fallo(res, 401, "Sesión inválida");

        req.usuario = publico(persona);
        req.sesion = sesion;
        req.tokenSesion = token;

        if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
            if (!mismoOrigen(req) || req.get("x-csrf-token") !== sesion.csrf) {
                return fallo(res, 403, "Token CSRF u origen inválido");
            }
        }

        next();
    }

    function administrador(req, res, next) {
        if (req.usuario.rol !== "administrador") return fallo(res, 403, "Se requiere rol administrador");
        next();
    }

    function montar(app) {
        app.post("/auth/login", exigirTransporte, login);

        app.get("/auth/me", exigirTransporte, autenticar, (req, res) => {
            res.json({ usuario: req.usuario, csrf: req.sesion.csrf });
        });

        app.post("/auth/logout", exigirTransporte, autenticar, (req, res) => {
            sesiones.delete(sha256(req.tokenSesion));
            res.clearCookie(COOKIE, { httpOnly: true, secure, sameSite: "strict", path: "/" });
            res.json({ estado: "sesión cerrada" });
        });
    }

    return { montar, autenticar, administrador, exigirTransporte };
}

module.exports = { crearSeguridad, hashPassword, verificarPassword, puedeVer, mismoOrigen };
