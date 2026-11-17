const fs = require('node:fs');
const { createClient } = require('redis');

function noRedis(causa) {
    const error = new Error('Redis no disponible', { cause: causa });
    error.code = 'REDIS_UNAVAILABLE';
    return error;
}

function crearRedis(entorno = process.env) {
    if (!entorno.REDIS_URL) return null; // Solo pruebas locales sin Compose.
    const url = new URL(entorno.REDIS_URL);
    if (url.protocol !== 'rediss:') throw new Error('REDIS_URL debe usar TLS (rediss)');
    const client = createClient({ url: url.href, password: entorno.REDIS_PASSWORD,
        disableOfflineQueue: true,
        socket: { tls: true, servername: url.hostname, rejectUnauthorized: true,
            ca: fs.readFileSync(entorno.TLS_CA), connectTimeout: 2000,
            reconnectStrategy: intentos => Math.min(2000, 100 + intentos * 100) } });
    let listo = false;
    client.on('error', () => { listo = false; });
    client.on('reconnecting', () => { listo = false; });
    client.on('ready', async () => {
        // Invalidar caches de permisos potencialmente viejos tras una caida.
        try { await client.incr('pdc:auth:generacion'); listo = true; }
        catch (_) { listo = false; }
    });
    client.connect().catch(() => {});
    async function usar(fn) {
        if (!listo || !client.isReady) throw noRedis();
        try {
            return await fn(client.withCommandOptions({ timeout: 2000 }));
        } catch (error) { throw noRedis(error); }
    }
    return {
        eval: (script, opciones) => usar(c => c.eval(script, opciones)),
        cerrar: () => client.destroy()
    };
}

module.exports = { crearRedis, noRedis };
