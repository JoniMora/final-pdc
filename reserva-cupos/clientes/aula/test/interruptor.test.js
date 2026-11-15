const test = require("node:test");
const assert = require("node:assert/strict");
const { crearInterruptor, conBase } = require("../src/interruptor");

test("tras un fallo de la base, no se reintenta hasta que pasa la espera", async () => {
    let ahora = 0;
    let intentos = 0;
    const interruptor = crearInterruptor({ esperaMs: 5000, reloj: () => ahora });
    const caida = async () => {
        intentos++;
        throw new Error("getaddrinfo ENOTFOUND aula-db");
    };

    await assert.rejects(conBase(interruptor, caida), /ENOTFOUND/);
    await assert.rejects(conBase(interruptor, caida), /contingencia/);
    await assert.rejects(conBase(interruptor, caida), /contingencia/);
    assert.equal(intentos, 1);

    ahora = 5000;
    await assert.rejects(conBase(interruptor, caida), /ENOTFOUND/);
    assert.equal(intentos, 2);
});

test("la sonda de reconciliación cierra el interruptor cuando la base vuelve", async () => {
    const interruptor = crearInterruptor({ esperaMs: 60000, reloj: () => 0 });

    interruptor.fallo();
    assert.equal(interruptor.disponible(), false);

    interruptor.exito();
    assert.equal(await conBase(interruptor, async () => "ok"), "ok");
});
