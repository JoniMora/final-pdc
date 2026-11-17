const test = require('node:test');
const assert = require('node:assert/strict');
const { planReintento } = require('../src/reintento');
test('solo los intentos HTTP consumen el presupuesto de reintentos', () => {
    assert.deepEqual(planReintento(0), { agotado: false, cola: 'webhooks.espera.10s', intento: 1 });
    assert.deepEqual(planReintento(1), { agotado: false, cola: 'webhooks.espera.1m', intento: 2 });
    assert.deepEqual(planReintento(2), { agotado: false, cola: 'webhooks.espera.5m', intento: 3 });
    assert.deepEqual(planReintento(3), { agotado: true });
});
test('circuito abierto difiere incluso al final del presupuesto, sin descartar', () => {
    for (const intento of [0, 1, 2, 3]) {
        assert.deepEqual(planReintento(intento, false), { agotado: false, cola: 'webhooks.espera.10s', intento });
    }
});
