const test = require("node:test");
const assert = require("node:assert/strict");
const { uuidv7, esUuid, jsonCanonico, validarMetadata } = require("../src/modelo");

test("uuidv7 genera UUID versión 7 ordenados por tiempo", async () => {
    const primero = uuidv7();
    await new Promise(resolve => setTimeout(resolve, 2));
    const segundo = uuidv7();

    assert.ok(esUuid(primero));
    assert.equal(primero[14], "7");
    assert.ok(primero < segundo);
});

test("jsonCanonico no depende del orden de las claves", () => {
    assert.equal(
        jsonCanonico({ b: 1, a: { d: [1, 2], c: null } }),
        jsonCanonico({ a: { c: null, d: [1, 2] }, b: 1 })
    );
});

test("metadata acepta objetos de hasta 16 KB y rechaza el resto", () => {
    assert.equal(validarMetadata(undefined), null);
    assert.deepEqual(validarMetadata({ aula: "A1" }), { aula: "A1" });
    assert.throws(() => validarMetadata([1, 2]), /objeto JSON/);
    assert.throws(() => validarMetadata({ texto: "x".repeat(17 * 1024) }), /16 KB/);
});
