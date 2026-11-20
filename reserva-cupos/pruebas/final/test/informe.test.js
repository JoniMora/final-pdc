const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { leerResumen, htmlResumen } = require('../informe-carga');
test('reporte HTML escapa nombres y valores provenientes del resultado', () => {
    const html = htmlResumen('<script>alert(1)</script>', { metricas: {
        '<img src=x onerror=alert(1)>': { values: { dato: '<script>robar()</script>' } }
    } });
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
});
test('exportacion de k6 excluye setup_data y variables con credenciales', async () => {
    const { resumenSeguro } = await import(pathToFileURL(path.resolve(__dirname, '../../carga/resumen.js')).href);
    const resultado = resumenSeguro({ metrics: { checks: { values: { rate: 1 } } }, state: {},
        setup_data: { clave: 'secreto-del-tenant' }, options: { env: { API_KEY: 'otro-secreto' }, scenarios: {} } });
    assert.ok(!JSON.stringify(resultado).includes('secreto'));
    assert.equal(resultado.metricas.checks.values.rate, 1);
});
test('resumen requiere un resultado real, no acepta salida incompleta', () => {
    assert.throws(() => leerResumen('No termino la corrida'), /no produjo/);
    assert.deepEqual(leerResumen('PDC_K6_JSON:{"metricas":{}}\n'), { metricas: {} });
});
