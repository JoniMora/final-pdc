// Prueba de contrato del lado proveedor del webhook: el notificador envía
// a un receptor que aplica las reglas de contrato/openapi.yaml (esquema
// EventoReserva y firma X-Firma). El receptor de Aula se prueba por
// separado contra las mismas reglas: ninguno depende del código del otro.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const { crearContratoHttp } = require("../../../compartido/src/contrato");
const { firmar } = require("../src/firma");
const { enviar } = require("../src/enviar");
const { crearLookup } = require("../src/destino");

const contrato = crearContratoHttp();
const SECRETO = crypto.randomBytes(32);

function receptor() {
    const recibidos = [];

    const servidor = http.createServer((req, res) => {
        let cuerpo = "";
        req.on("data", parte => { cuerpo += parte; });
        req.on("end", () => {
            const [, t, v1] = (req.headers["x-firma"] || "").match(/^t=(\d+),v1=([0-9a-f]{64})$/) || [];
            const esperada = t && crypto.createHmac("sha256", SECRETO).update(`${t}.${cuerpo}`).digest("hex");

            if (!v1 || v1 !== esperada || Math.abs(Date.now() / 1000 - Number(t)) > 300) {
                res.writeHead(401).end();
                return;
            }

            contrato.validarEsquema("EventoReserva", JSON.parse(cuerpo));
            recibidos.push({ id: req.headers["x-webhook-id"], evento: JSON.parse(cuerpo) });
            res.writeHead(204).end();
        });
    });

    return new Promise(resolve => servidor.listen(0, "127.0.0.1", () => resolve({ servidor, recibidos })));
}

const evento = {
    secuencia: 12,
    tipo: "reserva.confirmada",
    ocurrido_en: "2026-11-07T12:00:00.000Z",
    entidad: {
        id: "0193a4b2-7c1d-7e2f-8a3b-4c5d6e7f8091",
        actividad_id: "0193a4b2-7c1d-7e2f-8a3b-4c5d6e7f8092",
        participante: "alumno-7",
        estado: "confirmada",
        version: 2,
        metadata: null,
        creado_en: "2026-11-07T11:59:59.000Z"
    }
};

test("el webhook firmado cumple el contrato y el receptor lo acepta", async () => {
    const { servidor, recibidos } = await receptor();
    const url = new URL(`http://127.0.0.1:${servidor.address().port}/webhooks`);
    const cuerpo = JSON.stringify(evento);

    const estado = await enviar(url, cuerpo, {
        "Content-Type": "application/json",
        "X-Firma": firmar(SECRETO, cuerpo),
        "X-Webhook-Id": "12"
    }, { timeoutMs: 2000, lookup: crearLookup(new Set(["127.0.0.1"])) });

    servidor.close();
    assert.equal(estado, 204);
    assert.equal(recibidos.length, 1);
    assert.equal(recibidos[0].id, "12");
});

test("una firma vieja o con otro secreto se rechaza", async () => {
    const { servidor } = await receptor();
    const url = new URL(`http://127.0.0.1:${servidor.address().port}/webhooks`);
    const cuerpo = JSON.stringify(evento);
    const opciones = { timeoutMs: 2000, lookup: crearLookup(new Set(["127.0.0.1"])) };

    const vieja = await enviar(url, cuerpo, { "X-Firma": firmar(SECRETO, cuerpo, Math.floor(Date.now() / 1000) - 600) }, opciones);
    const ajena = await enviar(url, cuerpo, { "X-Firma": firmar(crypto.randomBytes(32), cuerpo) }, opciones);

    servidor.close();
    assert.equal(vieja, 401);
    assert.equal(ajena, 401);
});

test("la firma tiene el formato que define el contrato", () => {
    assert.match(firmar(SECRETO, "{}"), /^t=[0-9]+,v1=[0-9a-f]{64}$/);
});

test("el emisor reproduce el vector de prueba del contrato", () => {
    // Valores tomados de contrato/openapi.yaml, no del receptor de Aula. El
    // notificador recibe el secreto de MySQL como los 32 bytes.
    const vector = contrato.operacion("recibirCambioDeReserva")["x-vector-de-prueba"];

    assert.equal(firmar(Buffer.from(vector.secreto, "hex"), vector.cuerpo, vector.t), vector["X-Firma"]);
});

test("una respuesta que no termina de llegar a tiempo cuenta como falla", async () => {
    // El receptor envía las cabeceras y después un byte cada 50 ms: sin un
    // plazo total, la entrega quedaría retenida.
    const goteos = new Set();
    const servidor = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        const goteo = setInterval(() => res.write("."), 50);
        goteos.add(goteo);
        res.on("close", () => clearInterval(goteo));
    });

    await new Promise(resolve => servidor.listen(0, "127.0.0.1", resolve));
    const url = new URL(`http://127.0.0.1:${servidor.address().port}/webhooks`);
    const inicio = Date.now();

    await assert.rejects(
        enviar(url, "{}", {}, { timeoutMs: 300, lookup: crearLookup(new Set(["127.0.0.1"])) }),
        /Sin respuesta completa en 300 ms/
    );

    assert.ok(Date.now() - inicio < 2000);
    for (const goteo of goteos) clearInterval(goteo);
    servidor.closeAllConnections();
    servidor.close();
});
