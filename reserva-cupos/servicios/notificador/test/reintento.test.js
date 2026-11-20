const test = require('node:test');
const assert = require('node:assert/strict');
const { planReintento, PLAZO_MS } = require('../src/reintento');

const T0 = 1_795_000_000_000;

test('los intentos HTTP siguen el calendario del contrato: 10 s, 1 min, 5 min y DLQ', () => {
    assert.deepEqual(planReintento(0, { ahora: T0 }),
        { agotado: false, cola: 'webhooks.espera.10s', intento: 1, primerFallo: T0 });
    assert.deepEqual(planReintento(1, { primerFallo: T0, ahora: T0 + 10_000 }),
        { agotado: false, cola: 'webhooks.espera.1m', intento: 2, primerFallo: T0 });
    assert.deepEqual(planReintento(2, { primerFallo: T0, ahora: T0 + 70_000 }),
        { agotado: false, cola: 'webhooks.espera.5m', intento: 3, primerFallo: T0 });
    assert.equal(planReintento(3, { primerFallo: T0, ahora: T0 + 370_000 }).agotado, true);
});

test('el circuito abierto difiere sin consumir intentos mientras no venza el plazo', () => {
    for (const intento of [0, 1, 2, 3]) {
        assert.deepEqual(planReintento(intento, { consumir: false, primerFallo: T0, ahora: T0 + 60_000 }),
            { agotado: false, cola: 'webhooks.espera.10s', intento, primerFallo: T0 });
    }
});

test('vencido el plazo desde el primer fallo, el mensaje va a la DLQ aunque queden intentos', () => {
    assert.deepEqual(planReintento(0, { consumir: false, primerFallo: T0, ahora: T0 + PLAZO_MS }),
        { agotado: true, motivo: 'plazo vencido' });
    assert.equal(planReintento(1, { primerFallo: T0, ahora: T0 + PLAZO_MS + 1 }).agotado, true);
    // El plazo cubre el calendario completo del contrato (370 s) con margen.
    assert.ok(PLAZO_MS > 370_000 && PLAZO_MS < 480_000);
});

test('un mensaje diferido indefinidamente llega a la DLQ en el plazo, no en horas', () => {
    // Simula el peor caso anterior: cada 10 s el circuito sigue abierto.
    let ahora = T0, intento = 0, primerFallo, ciclos = 0, plan;
    do {
        plan = planReintento(intento, { consumir: false, primerFallo, ahora });
        if (!plan.agotado) { primerFallo = plan.primerFallo; intento = plan.intento; }
        ahora += 10_000;
        ciclos++;
    } while (!plan.agotado);
    assert.ok(ahora - T0 <= PLAZO_MS + 20_000, `tardó ${(ahora - T0) / 1000} s`);
    assert.equal(ciclos, PLAZO_MS / 10_000 + 1);
});

test('un reintento nunca espera mas alla del plazo: usa la espera mas larga que termine antes', () => {
    // Le tocaba la de 5 min, pero quedan 100 s: espera 1 min.
    assert.deepEqual(planReintento(2, { primerFallo: T0, ahora: T0 + 300_000 }),
        { agotado: false, cola: 'webhooks.espera.1m', intento: 3, primerFallo: T0 });
    // Quedan 30 s: espera 10 s.
    assert.equal(planReintento(2, { primerFallo: T0, ahora: T0 + 370_000 }).cola, 'webhooks.espera.10s');
    // Quedan 5 s: la mas corta (10 s) es el maximo atraso posible sobre el plazo.
    assert.equal(planReintento(1, { primerFallo: T0, ahora: T0 + 395_000 }).cola, 'webhooks.espera.10s');
});

test('con el circuito abriendose y cerrandose, ninguna entrega pasa el plazo por mas de 10 s', () => {
    // Peor caso: cada vez que vuelve, a veces se intenta (y falla) y a veces se difiere.
    const esperas = { 'webhooks.espera.10s': 10_000, 'webhooks.espera.1m': 60_000, 'webhooks.espera.5m': 300_000 };
    for (let semilla = 0; semilla < 50; semilla++) {
        let ahora = T0, intento = 0, primerFallo, plan, paso = 0;
        do {
            const consumir = (semilla + paso++) % 3 !== 0;
            plan = planReintento(intento, { consumir, primerFallo, ahora });
            if (plan.agotado) break;
            primerFallo = plan.primerFallo; intento = plan.intento;
            ahora += esperas[plan.cola];
        } while (true);
        assert.ok(ahora - T0 <= PLAZO_MS + 10_000, `semilla ${semilla}: ${(ahora - T0) / 1000} s`);
    }
});

test('una cabecera de primer fallo ausente, futura o inválida empieza a contar ahora', () => {
    for (const primerFallo of [undefined, NaN, T0 + 5_000]) {
        assert.equal(planReintento(0, { primerFallo, ahora: T0 }).primerFallo, T0);
    }
    assert.throws(() => planReintento(-1), /inválida/);
});
