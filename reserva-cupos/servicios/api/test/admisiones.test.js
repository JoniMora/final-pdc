const test = require('node:test');
const assert = require('node:assert/strict');
const { crearAdmisor, insertarAdmisiones } = require('../src/admisiones');

function baseDePrueba({ confirmar = async () => {} } = {}) {
    const filas = [];
    let transacciones = 0;
    async function transaccion(operacion) {
        transacciones++;
        const copia = filas.slice();
        const resultado = await operacion({
            insertar(valor) {
                if (copia.includes(valor)) throw new Error('duplicada');
                copia.push(valor);
                return valor;
            }
        });
        await confirmar();
        filas.splice(0, filas.length, ...copia);
        return resultado;
    }
    return { filas, transaccion, get transacciones() { return transacciones; } };
}

test('50 admisiones comparten un commit y todas quedan persistidas', async () => {
    const base = baseDePrueba();
    const admitir = crearAdmisor(base.transaccion);
    const resultados = await Promise.all(Array.from({ length: 50 }, (_, i) =>
        admitir(c => c.insertar(i))));
    assert.equal(base.transacciones, 1);
    assert.deepEqual(base.filas, resultados);
    assert.equal(base.filas.length, 50);
});

test('ninguna admision se resuelve antes de confirmar el lote', async () => {
    let liberar;
    const barrera = new Promise(resolve => { liberar = resolve; });
    const base = baseDePrueba({ confirmar: () => barrera });
    const admitir = crearAdmisor(base.transaccion, { maximo: 2 });
    let resueltas = 0;
    const solicitudes = [admitir(c => c.insertar(1)), admitir(c => c.insertar(2))];
    solicitudes.forEach(p => p.then(() => { resueltas++; }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(resueltas, 0);
    assert.deepEqual(base.filas, []);
    liberar();
    assert.deepEqual(await Promise.all(solicitudes), [1, 2]);
});

test('una duplicada revierte el lote y no pierde solicitudes validas', async () => {
    const base = baseDePrueba();
    const admitir = crearAdmisor(base.transaccion, { maximo: 3 });
    const resultados = await Promise.allSettled([
        admitir(c => c.insertar(1)), admitir(c => c.insertar(1)), admitir(c => c.insertar(2))
    ]);
    assert.deepEqual(resultados.map(r => r.status), ['fulfilled', 'rejected', 'fulfilled']);
    assert.match(resultados[1].reason.message, /duplicada/);
    assert.deepEqual(base.filas, [1, 2]);
});

test('si falla el commit nunca se informa una escritura no persistida', async () => {
    const base = baseDePrueba({ confirmar: async () => { throw new Error('sin base'); } });
    const admitir = crearAdmisor(base.transaccion, { maximo: 2 });
    const resultados = await Promise.allSettled([
        admitir(c => c.insertar(1)), admitir(c => c.insertar(2))
    ]);
    assert.ok(resultados.every(r => r.status === 'rejected'));
    assert.deepEqual(base.filas, []);
});

test('un lote incompleto termina sin esperar mas solicitudes', async () => {
    const base = baseDePrueba();
    const admitir = crearAdmisor(base.transaccion);
    assert.equal(await admitir(c => c.insertar(1)), 1);
    assert.deepEqual(base.filas, [1]);
});

test('varios lotes conservan todas las admisiones sin transacciones superpuestas', async () => {
    const base = baseDePrueba();
    const admitir = crearAdmisor(base.transaccion, { maximo: 10 });
    const resultados = await Promise.all(Array.from({ length: 101 }, (_, i) =>
        admitir(c => c.insertar(i))));
    assert.deepEqual(base.filas, resultados);
    assert.equal(base.transacciones, 11);
});

test('un lote SQL usa solo dos consultas y conserva tenant, idempotencia y outbox', async () => {
    const consultas = [];
    const conexion = { async query(sql, parametros) { consultas.push({ sql, parametros }); } };
    const datos = Array.from({ length: 50 }, (_, i) => ({
        tenantId: `tenant-${i % 2}`, clave: `idem-${i}`, hash: Buffer.alloc(32, i),
        reserva: { id: `reserva-${i}`, actividad_id: 'actividad', participante: `alumno-${i}`,
            version: 1, estado: 'pendiente', metadata: i ? { n: i } : null,
            creado_en: '2026-11-17T00:00:00.000Z' }
    }));
    await insertarAdmisiones(conexion, datos);
    assert.equal(consultas.length, 2);
    const filas = consultas[0].parametros[0];
    const cambios = consultas[1].parametros[0];
    assert.equal(filas.length, 50);
    assert.equal(cambios.length, 50);
    for (let i = 0; i < 50; i++) {
        assert.equal(filas[i][1], datos[i].tenantId);
        assert.equal(filas[i][4], datos[i].clave);
        assert.deepEqual(filas[i][5], datos[i].hash);
        assert.equal(cambios[i][0], datos[i].tenantId);
        assert.deepEqual(JSON.parse(cambios[i][5]), datos[i].reserva);
        assert.deepEqual(cambios[i].slice(6), [false, true]);
    }
});

test('si falla la escritura masiva revierte y recupera cada admision individual', async () => {
    const base = baseDePrueba();
    const admitir = crearAdmisor(base.transaccion, { maximo: 2,
        escribirLote: async conexion => {
            conexion.insertar('parcial');
            throw new Error('fallo de escritura masiva');
        }
    });
    assert.deepEqual(await Promise.all([
        admitir(c => c.insertar(1), {}), admitir(c => c.insertar(2), {})
    ]), [1, 2]);
    assert.deepEqual(base.filas, [1, 2]);
});
