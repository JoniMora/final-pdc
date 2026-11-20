const fs = require('node:fs');
const { createClient } = require('redis');

function noRedis(causa) {
    const error = new Error('Redis no disponible', { cause: causa });
    error.code = 'REDIS_UNAVAILABLE';
    return error;
}

// Cliente de Redis de la API (límite global y caché de autenticación).
// Sin Redis, cada uso falla con REDIS_UNAVAILABLE (503): no hay plan B local.
//
// Al conectar o reconectar, antes de atender se incrementa la generación de
// la caché de permisos, por si una invalidación no llegó a hacerse durante
// la caída. Esa preparación se reintenta en cada uso hasta que sale bien:
// si Redis todavía está cargando su AOF cuando la conexión queda lista, el
// INCR responde LOADING, y con un solo intento (en el evento "ready") la API
// quedaba respondiendo 503 aunque Redis ya estuviera sano. Lo encontró la
// matriz de fallos en el CI.
function crearRedis(entorno = process.env, { crearCliente = createClient } = {}) {
    if (!entorno.REDIS_URL) return null; // Solo pruebas locales sin Compose.
    const url = new URL(entorno.REDIS_URL);
    if (url.protocol !== 'rediss:') throw new Error('REDIS_URL debe usar TLS (rediss)');
    const client = crearCliente({ url: url.href, password: entorno.REDIS_PASSWORD,
        disableOfflineQueue: true,
        socket: { tls: true, servername: url.hostname, rejectUnauthorized: true,
            ca: fs.readFileSync(entorno.TLS_CA), connectTimeout: 2000,
            reconnectStrategy: intentos => Math.min(2000, 100 + intentos * 100) } });

    let listo = false;
    let preparando = null;

    function preparar() {
        preparando ??= client.withCommandOptions({ timeout: 2000 }).incr('pdc:auth:generacion')
            .then(() => { listo = true; })
            .finally(() => { preparando = null; });
        return preparando;
    }

    client.on('error', () => { listo = false; });
    client.on('reconnecting', () => { listo = false; });
    client.on('ready', () => { preparar().catch(() => {}); });
    client.connect().catch(() => {});

    async function usar(fn) {
        if (!client.isReady) throw noRedis();
        try {
            if (!listo) await preparar();
            return await fn(client.withCommandOptions({ timeout: 2000 }));
        } catch (error) { throw noRedis(error); }
    }

    return {
        eval: (script, opciones) => usar(c => c.eval(script, opciones)),
        cerrar: () => client.destroy()
    };
}

module.exports = { crearRedis, noRedis };
