const test = require("node:test");
const assert = require("node:assert/strict");
const { crearSalud, atenderSalud } = require("../src/salud");

const poolQue = consulta => ({ query: consulta });

test("informa MySQL y RabbitMQ conectados", async () => {
    const salud = crearSalud({ servicio: "worker", pool: poolQue(async () => [[{ 1: 1 }]]), rabbitmq: () => true });
    assert.deepEqual(await salud(), { servicio: "worker", estado: "ok", mysql: "conectado", rabbitmq: "conectado" });
});

test("con MySQL caído o RabbitMQ desconectado lo informa sin fallar", async () => {
    const salud = crearSalud({ servicio: "relay", pool: poolQue(async () => { throw new Error("ECONNREFUSED"); }), rabbitmq: () => false });
    assert.deepEqual(await salud(), { servicio: "relay", estado: "ok", mysql: "no disponible", rabbitmq: "no disponible" });
});

test("no se bloquea si MySQL no contesta", async () => {
    const salud = crearSalud({ servicio: "notificador", pool: poolQue(() => new Promise(() => {})), rabbitmq: () => true, plazoMs: 50 });
    const inicio = Date.now();
    assert.equal((await salud()).mysql, "no disponible");
    assert.ok(Date.now() - inicio < 1000);
});

test("los chequeos simultáneos comparten una sola consulta", async () => {
    let consultas = 0;
    const salud = crearSalud({ servicio: "worker", pool: poolQue(async () => { consultas++; await new Promise(r => setTimeout(r, 20)); }), rabbitmq: () => true });
    await Promise.all([salud(), salud(), salud()]);
    assert.equal(consultas, 1);
});

test("atenderSalud responde solo GET /health", async () => {
    const salud = async () => ({ servicio: "worker", estado: "ok" });
    const respuesta = () => ({ estado: null, cuerpo: null, writeHead(e) { this.estado = e; }, end(c) { this.cuerpo = c; } });
    const r1 = respuesta();
    assert.equal(await atenderSalud({ method: "GET", url: "/health" }, r1, salud), true);
    assert.equal(r1.estado, 200);
    assert.deepEqual(JSON.parse(r1.cuerpo), { servicio: "worker", estado: "ok" });
    assert.equal(await atenderSalud({ method: "GET", url: "/metrics" }, respuesta(), salud), false);
});
