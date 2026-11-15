const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { enTransaccion } = require("../src/transaccion");

// Cliente de pg simulado: es un EventEmitter, como el real. Con caer, la
// conexión emite "error" en medio de la transacción (aula-db se detuvo).
function poolFalso({ caer = false } = {}) {
    const cliente = new EventEmitter();
    const registro = { sentencias: [], liberado: null };

    cliente.query = async sql => {
        registro.sentencias.push(sql);

        if (caer && sql === "UPDATE") {
            cliente.emit("error", new Error("Connection terminated unexpectedly"));
            throw new Error("Connection terminated unexpectedly");
        }

        return { rows: [] };
    };
    cliente.release = destruir => { registro.liberado = destruir; };

    return { registro, cliente, connect: async () => cliente };
}

test("confirma la transacción y devuelve la conexión al pool", async () => {
    const pool = poolFalso();

    assert.equal(await enTransaccion(pool, async cliente => {
        await cliente.query("UPDATE");
        return "listo";
    }), "listo");

    assert.deepEqual(pool.registro.sentencias, ["BEGIN", "UPDATE", "COMMIT"]);
    assert.equal(pool.registro.liberado, false);
});

test("si aula-db cae con la conexión tomada, falla la operación y no el proceso", async () => {
    const pool = poolFalso({ caer: true });

    await assert.rejects(enTransaccion(pool, cliente => cliente.query("UPDATE")), /Connection terminated/);

    assert.ok(pool.registro.sentencias.includes("ROLLBACK"));
    assert.equal(pool.registro.liberado, true);
    assert.equal(pool.cliente.listenerCount("error"), 0);
});
