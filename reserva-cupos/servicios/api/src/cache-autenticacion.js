const { randomUUID } = require('node:crypto');
const { noRedis } = require('./redis');

// Versión global: una rotación o un cambio de permisos invalida todas las
// entradas; una lectura de MySQL anterior nunca repuebla la generación nueva.
// Mientras dura el cambio (la clave pdc:auth:mutacion), las lecturas van a
// MySQL sin pasar por la caché.
const LEER = `
if redis.call('EXISTS',KEYS[2]) == 1 then return {'-1',''} end
local g = redis.call('GET',KEYS[1]) or '0'
return {g,redis.call('GET','pdc:auth:'..g..':'..ARGV[1]) or ''}
`;
const GUARDAR = `
if redis.call('EXISTS',KEYS[2]) == 1 then return 0 end
if (redis.call('GET',KEYS[1]) or '0') ~= ARGV[1] then return 0 end
redis.call('SET','pdc:auth:'..ARGV[1]..':'..ARGV[2],ARGV[3],'EX',ARGV[4]); return 1
`;
const INICIAR = `
if redis.call('EXISTS',KEYS[2]) == 1 then return 0 end
redis.call('SET',KEYS[2],ARGV[1],'PX',30000)
redis.call('INCR',KEYS[1]); return 1
`;
const FINALIZAR = `
redis.call('INCR',KEYS[1])
if redis.call('GET',KEYS[2]) == ARGV[1] then redis.call('DEL',KEYS[2]) end
return 1
`;
const KEYS = ['pdc:auth:generacion', 'pdc:auth:mutacion'];

function crearCacheAutenticacion(redis, { ttl = 30, observar = () => {} } = {}) {
    const enVuelo = new Map();
    return {
        async buscar(hash, cargar) {
            const [generacion, valor] = await redis.eval(LEER, { keys: KEYS, arguments: [hash] });
            // Hay una rotación o un cambio de permisos en curso: se consulta
            // MySQL directo, sin guardar, como si no hubiera caché. Así un
            // cambio de un tenant no deja sin servicio a los demás (antes
            // respondía 503 a todos, hasta 30 s si la API caía a mitad).
            if (generacion === '-1') { observar('bypass'); return cargar(); }
            if (valor) { observar('hit'); return JSON.parse(valor); }
            observar('miss');
            const llave = `${generacion}:${hash}`;
            if (enVuelo.has(llave)) return enVuelo.get(llave);
            const lectura = (async () => {
                const fila = await cargar();
                await redis.eval(GUARDAR, { keys: KEYS,
                    arguments: [generacion, hash, JSON.stringify(fila), String(fila ? ttl : 1)] });
                return fila;
            })();
            enVuelo.set(llave, lectura);
            try { return await lectura; }
            finally { enVuelo.delete(llave); }
        },
        async mutar(fn) {
            const token = randomUUID();
            const adquirido = await redis.eval(INICIAR, { keys: KEYS, arguments: [token] });
            if (!Number(adquirido)) throw noRedis(new Error('Otra actualización de permisos en curso'));
            try { return await fn(); }
            finally { await redis.eval(FINALIZAR, { keys: KEYS, arguments: [token] }); }
        }
    };
}

module.exports = { crearCacheAutenticacion, LEER, GUARDAR, INICIAR, FINALIZAR };
