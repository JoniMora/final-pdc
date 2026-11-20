const test = require("node:test");
const assert = require("node:assert/strict");
const { configurarParticiones } = require("../src/particiones");

test("sin configuración conserva una partición", () => {
    const resultado = configurarParticiones({});

    assert.equal(resultado.cantidad, 1);
    assert.equal(resultado.cola, "reservas.comandos.0");
});

test("cuatro particiones generan cuatro colas distintas", () => {
    const resultado = configurarParticiones({
        COMANDOS_PARTICIONES: "4",
        WORKER_PARTICION: "2"
    });

    assert.deepEqual(resultado.colas, [
        "reservas.comandos.0",
        "reservas.comandos.1",
        "reservas.comandos.2",
        "reservas.comandos.3"
    ]);

    assert.equal(resultado.cola, "reservas.comandos.2");
});

test("rechaza cantidades inválidas", () => {
    for (const cantidad of ["0", "-1", "1.5", "abc", "33", ""]) {
        assert.throws(() => configurarParticiones({
            COMANDOS_PARTICIONES: cantidad
        }));
    }
});

test("rechaza workers fuera de las particiones configuradas", () => {
    for (const indice of ["4", "-1", "abc", ""]) {
        assert.throws(() => configurarParticiones({
            COMANDOS_PARTICIONES: "4",
            WORKER_PARTICION: indice
        }));
    }
});