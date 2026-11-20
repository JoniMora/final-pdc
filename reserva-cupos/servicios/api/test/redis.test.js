const test = require('node:test');
const assert = require('node:assert/strict');
const { crearAutenticacion } = require('../src/acceso');
const { crearCacheAutenticacion, LEER, GUARDAR, INICIAR, FINALIZAR } = require('../src/cache-autenticacion');
const { crearLimitadorRedis } = require('../src/limite-redis');

// Doble del transporte, no una validación del motor Lua. La atomicidad real
// y el limite entre procesos se comprueban en pruebas/final/redis.js.
function transporte() {
    let generacion = '0';
    let bloqueo = null;
    const cache = new Map();
    return { async eval(script, { arguments: a }) {
        if (script === LEER) return bloqueo ? ['-1', ''] : [generacion, cache.get(`${generacion}:${a[0]}`) || ''];
        if (script === GUARDAR) {
            if (!bloqueo && generacion === a[0]) cache.set(`${generacion}:${a[1]}`, a[2]);
            return 1;
        }
        if (script === INICIAR) {
            if (bloqueo) return 0;
            bloqueo = a[0]; generacion = String(Number(generacion) + 1); return 1;
        }
        if (script === FINALIZAR) {
            generacion = String(Number(generacion) + 1);
            if (bloqueo === a[0]) bloqueo = null;
            return 1;
        }
        throw new Error('Script desconocido');
    } };
}

test('cache-aside comparte resultado y reduce lecturas MySQL', async () => {
    const redis = transporte();
    const a = crearCacheAutenticacion(redis), b = crearCacheAutenticacion(redis);
    let consultas = 0;
    const cargar = async () => { consultas++; return { id: 'tenant', scopes: 'lectura' }; };
    assert.deepEqual(await a.buscar('hash', cargar), await b.buscar('hash', cargar));
    assert.equal(consultas, 1);
});

test('una rafaga fria del mismo hash comparte la consulta en vuelo', async () => {
    const cache = crearCacheAutenticacion(transporte());
    let consultas = 0;
    const respuestas = await Promise.all(Array.from({ length: 100 }, () => cache.buscar('mismo-hash', async () => {
        consultas++;
        await new Promise(resolve => setTimeout(resolve, 10));
        return { id: 'tenant' };
    })));
    assert.equal(consultas, 1);
    assert.ok(respuestas.every(r => r.id === 'tenant'));
});

test('cambio de permisos invalida cache de todas las instancias', async () => {
    const redis = transporte();
    const a = crearCacheAutenticacion(redis), b = crearCacheAutenticacion(redis);
    let fila = { id: 'tenant', scopes: 'lectura' };
    await a.buscar('hash', async () => fila);
    await a.mutar(async () => { fila = { id: 'tenant', scopes: 'reservas:escribir' }; });
    assert.equal((await b.buscar('hash', async () => fila)).scopes, 'reservas:escribir');
});

test('lectura anterior a rotacion no repuebla la generacion nueva', async () => {
    const cache = crearCacheAutenticacion(transporte());
    let liberar;
    const lectura = cache.buscar('anterior', () => new Promise(resolve => { liberar = resolve; }));
    await new Promise(resolve => setImmediate(resolve));
    await cache.mutar(async () => {});
    liberar({ id: 'viejo', scopes: 'lectura' });
    await lectura;
    assert.equal(await cache.buscar('anterior', async () => null), null);
});

test('durante una mutacion se autentica contra MySQL sin usar ni poblar la cache', async () => {
    const resultados = [];
    const cache = crearCacheAutenticacion(transporte(), { observar: r => resultados.push(r) });
    await cache.buscar('hash', async () => ({ id: 'tenant', scopes: 'lectura' }));
    await cache.mutar(async () => {
        // Otro tenant sigue atendido (antes recibia 503) y la fila sale de MySQL.
        assert.deepEqual(await cache.buscar('otro', async () => ({ id: 'otro' })), { id: 'otro' });
        assert.deepEqual(await cache.buscar('hash', async () => ({ id: 'tenant', scopes: 'escribir' })),
            { id: 'tenant', scopes: 'escribir' });
    });
    assert.deepEqual(resultados, ['miss', 'bypass', 'bypass']);
    // Lo leído durante la mutación no quedó guardado en la generación nueva.
    assert.deepEqual(await cache.buscar('hash', async () => ({ id: 'nuevo' })), { id: 'nuevo' });
});

test('limite usa tenant como clave global y respeta Retry-After', async () => {
    let opciones;
    const limitar = crearLimitadorRedis({ eval: async (_, o) => { opciones = o; return [0, 2]; } },
        { porSegundo: 1, rafaga: 5 });
    await assert.rejects(limitar({ tenantId: 'a' }, {}, () => {}),
        e => e.status === 429 && e.encabezados['Retry-After'] === '2');
    assert.deepEqual(opciones.keys, ['pdc:limite:a']);
});

test('si Redis falla no hay fallback a un limite por instancia', async () => {
    let siguiente = false;
    const limitar = crearLimitadorRedis({ eval: async () => { throw new Error('caido'); } },
        { porSegundo: 1, rafaga: 5 });
    await assert.rejects(limitar({ tenantId: 'a' }, {}, () => { siguiente = true; }));
    assert.equal(siguiente, false);
});

test('autenticacion usa cache sin cambiar el aislamiento por tenant', async () => {
    let consultas = 0;
    const cache = crearCacheAutenticacion(transporte());
    const pool = { query: async () => { consultas++; return [[{ id: 'a', scopes: 'lectura' }]]; } };
    const autenticar = crearAutenticacion(pool, null, { cache });
    for (let i = 0; i < 2; i++) {
        const req = { get: () => 'Bearer clave-a' };
        await autenticar(req, {}, () => {});
        assert.equal(req.tenantId, 'a');
    }
    assert.equal(consultas, 1);
});

// --- Reconexión del cliente (crearRedis) -------------------------------------

const { EventEmitter } = require('node:events');
const { crearRedis } = require('../src/redis');

function clienteFalso({ incrFallidos = 0 } = {}) {
    const cliente = new EventEmitter();
    cliente.isReady = false;
    cliente.incrs = 0;
    cliente.connect = async () => {};
    cliente.destroy = () => {};
    cliente.withCommandOptions = () => ({
        async incr() {
            cliente.incrs++;
            if (cliente.incrs <= incrFallidos) throw new Error('LOADING Redis is loading the dataset in memory');
            return cliente.incrs;
        },
        async eval() { return 'ok'; }
    });
    return cliente;
}

function redisCon(cliente) {
    return crearRedis({ REDIS_URL: 'rediss://redis:6379', TLS_CA: __filename }, { crearCliente: () => cliente });
}

const listoEn = cliente => { cliente.isReady = true; cliente.emit('ready'); return new Promise(r => setImmediate(r)); };

test('sin conexion lista, cada uso falla con REDIS_UNAVAILABLE', async () => {
    const redis = redisCon(clienteFalso());
    await assert.rejects(redis.eval('script', {}), e => e.code === 'REDIS_UNAVAILABLE');
});

test('si Redis sigue cargando su AOF al reconectar, la API se recupera sola en el uso siguiente', async () => {
    const cliente = clienteFalso({ incrFallidos: 1 });
    const redis = redisCon(cliente);
    await listoEn(cliente); // el INCR del evento ready responde LOADING
    assert.equal(cliente.incrs, 1);
    // Antes quedaba en 503 para siempre; ahora reintenta la preparación.
    assert.equal(await redis.eval('script', {}), 'ok');
    assert.equal(cliente.incrs, 2);
    assert.equal(await redis.eval('script', {}), 'ok');
    assert.equal(cliente.incrs, 2, 'una vez preparado no vuelve a incrementar');
});

test('cada reconexion vuelve a invalidar la cache de permisos antes de atender', async () => {
    const cliente = clienteFalso();
    const redis = redisCon(cliente);
    await listoEn(cliente);
    assert.equal(await redis.eval('script', {}), 'ok');
    cliente.emit('reconnecting');
    await listoEn(cliente);
    assert.equal(await redis.eval('script', {}), 'ok');
    assert.equal(cliente.incrs, 2);
});
