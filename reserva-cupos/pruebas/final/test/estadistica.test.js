const test = require('node:test');
const assert = require('node:assert/strict');
const { resumir } = require('../estadistica');
test('media y desvio muestral se calculan sobre corridas independientes', () => {
    const r = resumir([2, 4]);
    assert.equal(r.media, 3);
    assert.equal(r.desvio, Math.sqrt(2));
    assert.equal(resumir([5, 5, 5]).desvio, 0);
});
test('no inventa dispersion con una sola muestra o valores invalidos', () => {
    assert.throws(() => resumir([4]));
    assert.throws(() => resumir([4, NaN]));
});
