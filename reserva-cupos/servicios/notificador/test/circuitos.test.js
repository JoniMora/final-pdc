const test = require('node:test');
const assert = require('node:assert/strict');
const { crearCircuitos } = require('../src/circuitos');
const { crearMetricas, crearMetricasCircuitos } = require('../../../compartido/src/metricas');

test('cerrado -> abierto -> semiabierto -> cerrado; abierto no hace HTTP', async t => {
    let falla = true;
    let intentos = 0;
    const transiciones = [];
    const m = crearMetricas('notificador');
    const estados = crearMetricasCircuitos(m.registro);
    const c = crearCircuitos({ enviar: async () => { intentos++; return falla ? 503 : 204; },
        metricas: estados, resetTimeout: 30, volumeThreshold: 3,
        onTransicion: e => transiciones.push(e.estado) });
    t.after(() => c.cerrar());
    for (let i = 0; i < 3; i++) await assert.rejects(c.ejecutar('tenant-a'), /503/);
    await assert.rejects(c.ejecutar('tenant-a'), e => e.code === 'EOPENBREAKER');
    assert.equal(intentos, 3);
    assert.match(await m.registro.metrics(), /pdc_webhook_circuito_estado\{tenant="tenant-a",servicio="notificador"\} 1/);
    falla = false;
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(await c.ejecutar('tenant-a'), 204);
    assert.deepEqual(transiciones, ['cerrado', 'abierto', 'semiabierto', 'cerrado']);
});

test('un receptor caido no abre el circuito de otro tenant', async t => {
    const c = crearCircuitos({ enviar: async status => status, volumeThreshold: 1 });
    t.after(() => c.cerrar());
    await assert.rejects(c.ejecutar('a', 503));
    assert.equal(await c.ejecutar('b', 204), 204);
    await assert.rejects(c.ejecutar('a', 204), e => e.code === 'EOPENBREAKER');
});

test('una prueba semiabierta fallida vuelve a abrir', async t => {
    const estados = [];
    const c = crearCircuitos({ enviar: async () => 503, resetTimeout: 20, volumeThreshold: 1,
        onTransicion: e => estados.push(e.estado) });
    t.after(() => c.cerrar());
    await assert.rejects(c.ejecutar('a'));
    await new Promise(resolve => setTimeout(resolve, 40));
    await assert.rejects(c.ejecutar('a'));
    assert.deepEqual(estados.slice(0, 4), ['cerrado', 'abierto', 'semiabierto', 'abierto']);
});

test('semiabierto permite solo una prueba concurrente', async t => {
    let falla = true;
    let liberar;
    const c = crearCircuitos({ enviar: async () => {
        if (falla) return 503;
        await new Promise(resolve => { liberar = resolve; });
        return 204;
    }, resetTimeout: 20, volumeThreshold: 1 });
    t.after(() => c.cerrar());
    await assert.rejects(c.ejecutar('a'));
    falla = false;
    await new Promise(resolve => setTimeout(resolve, 40));
    const prueba = c.ejecutar('a');
    await assert.rejects(c.ejecutar('a'), e => e.code === 'EOPENBREAKER');
    liberar();
    assert.equal(await prueba, 204);
});

test('receptor HTTP real falla, circuito protege y se recupera', async t => {
    const http = require('node:http');
    const { enviar } = require('../src/enviar');
    let fallar = true;
    let recibidos = 0;
    const servidor = http.createServer((req, res) => {
        req.resume(); recibidos++; res.writeHead(fallar ? 503 : 204).end();
    });
    await new Promise(resolve => servidor.listen(0, '127.0.0.1', resolve));
    t.after(() => { servidor.closeAllConnections(); servidor.close(); });
    const transiciones = [];
    const c = crearCircuitos({ enviar: () => enviar(new URL(`http://127.0.0.1:${servidor.address().port}`),
        '{}', {}, { timeoutMs: 1000 }), resetTimeout: 30, volumeThreshold: 3,
        onTransicion: e => transiciones.push(e.estado) });
    t.after(() => c.cerrar());
    for (let i = 0; i < 3; i++) await assert.rejects(c.ejecutar('receptor-local'));
    await assert.rejects(c.ejecutar('receptor-local'), e => e.code === 'EOPENBREAKER');
    assert.equal(recibidos, 3);
    fallar = false;
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(await c.ejecutar('receptor-local'), 204);
    assert.deepEqual(transiciones, ['cerrado', 'abierto', 'semiabierto', 'cerrado']);
    t.diagnostic(JSON.stringify({ transiciones, solicitudesHTTPReales: recibidos,
        transporte: 'HTTP loopback solo de prueba, sin Docker' }));
});
