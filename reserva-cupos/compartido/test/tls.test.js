const { test } = require("node:test");
const assert = require("node:assert/strict");
const { opcionesMysql, conexionRabbit } = require("../src/tls");

const CA = Buffer.from("-----BEGIN CERTIFICATE-----\nprueba\n-----END CERTIFICATE-----\n");

test("con la CA, MySQL exige TLS y verifica la identidad del servidor", () => {
    assert.deepEqual(opcionesMysql({ ca: CA }), {
        ssl: { ca: CA, rejectUnauthorized: true, verifyIdentity: true }
    });
});

test("con la CA, RabbitMQ usa AMQPS en el 5671 y verifica el nombre del broker", () => {
    process.env.RABBITMQ_HOST = "rabbitmq";
    process.env.RABBITMQ_USER = "demo";
    process.env.RABBITMQ_PASSWORD = "clave";

    const [url, socket] = conexionRabbit({ ca: CA, heartbeat: 10 });

    assert.equal(url.protocol, "amqps");
    assert.equal(url.port, 5671);
    assert.equal(url.heartbeat, 10);
    assert.deepEqual(socket, { ca: [CA], servername: "rabbitmq", rejectUnauthorized: true });
});

test("sin la CA (pruebas fuera de Docker) la conexión es en texto plano", () => {
    assert.deepEqual(opcionesMysql({ ca: null }), {});

    const [url, socket] = conexionRabbit({ ca: null });

    assert.equal(url.protocol, "amqp");
    assert.equal(url.port, 5672);
    assert.deepEqual(socket, {});
});
