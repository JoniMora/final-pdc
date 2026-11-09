// Prueba de contrato del lado consumidor del webhook: el receptor de Aula
// aplica las reglas de contrato/openapi.yaml. Los eventos se firman acá con
// la regla del contrato, no con el código del notificador.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { ErrorDeSecreto, secretoDesdeHex, verificarFirma } = require("../src/webhooks");
const { crearContratoHttp } = require("../../../compartido/src/contrato");

const SECRETO = crypto.randomBytes(32);
const contrato = crearContratoHttp();

const evento = JSON.stringify({
    secuencia: 31,
    tipo: "reserva.cancelada",
    ocurrido_en: "2026-11-07T12:00:00.000Z",
    entidad: {
        id: "0193a4b2-7c1d-7e2f-8a3b-4c5d6e7f8091",
        actividad_id: "0193a4b2-7c1d-7e2f-8a3b-4c5d6e7f8092",
        participante: "alumno-3",
        estado: "cancelada",
        version: 3,
        metadata: null,
        creado_en: "2026-11-07T11:00:00.000Z"
    }
});

function firmaSegunContrato(secreto, cuerpo, t) {
    return `t=${t},v1=${crypto.createHmac("sha256", secreto).update(`${t}.${cuerpo}`).digest("hex")}`;
}

const ahora = Math.floor(Date.now() / 1000);

test("un evento firmado según el contrato se acepta y cumple el esquema", () => {
    assert.deepEqual(verificarFirma(evento, firmaSegunContrato(SECRETO, evento, ahora), SECRETO), { valida: true });
    assert.ok(contrato.validarEsquema("EventoReserva", JSON.parse(evento)));
});

test("se rechazan la firma de otro secreto, el cuerpo alterado y la reinyección", () => {
    assert.equal(verificarFirma(evento, firmaSegunContrato(crypto.randomBytes(32), evento, ahora), SECRETO).valida, false);
    assert.equal(verificarFirma(evento.replace("alumno-3", "alumno-4"), firmaSegunContrato(SECRETO, evento, ahora), SECRETO).valida, false);
    assert.match(verificarFirma(evento, firmaSegunContrato(SECRETO, evento, ahora - 301), SECRETO).motivo, /ventana/);
    assert.equal(verificarFirma(evento, undefined, SECRETO).valida, false);
    assert.equal(verificarFirma(evento, "t=1,v1=xyz", SECRETO).valida, false);
});

test("el receptor acepta el vector de prueba del contrato", () => {
    // Valores tomados de contrato/openapi.yaml, no del notificador: el
    // secreto llega en hexadecimal y la clave son sus 32 bytes.
    const vector = contrato.operacion("recibirCambioDeReserva")["x-vector-de-prueba"];
    const secreto = secretoDesdeHex(vector.secreto);

    assert.deepEqual(verificarFirma(vector.cuerpo, vector["X-Firma"], secreto, vector.t), { valida: true });
    // Usar el texto hexadecimal como clave da otra firma.
    const conTexto = crypto.createHmac("sha256", vector.secreto).update(`${vector.t}.${vector.cuerpo}`).digest("hex");
    assert.notEqual(`t=${vector.t},v1=${conTexto}`, vector["X-Firma"]);
    assert.ok(contrato.validarEsquema("EventoReserva", JSON.parse(vector.cuerpo)));
});

test("sin un secreto de 32 bytes no se acepta ninguna firma", () => {
    const vacio = Buffer.alloc(0);

    assert.equal(verificarFirma(evento, firmaSegunContrato(vacio, evento, ahora), vacio).valida, false);
    assert.throws(() => secretoDesdeHex(undefined), ErrorDeSecreto);
    assert.throws(() => secretoDesdeHex(""), ErrorDeSecreto);
    assert.throws(() => secretoDesdeHex("abcd"), ErrorDeSecreto);
    assert.throws(() => secretoDesdeHex("z".repeat(64)), ErrorDeSecreto);
    assert.equal(secretoDesdeHex("ab".repeat(32)).length, 32);
});
