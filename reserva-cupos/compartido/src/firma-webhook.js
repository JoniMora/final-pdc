const crypto = require("node:crypto");

// Lado receptor de los webhooks (contrato/openapi.yaml, sección webhooks).
// Lo usan los clientes de referencia: Aula, Canchas y Eventos.
const VENTANA_S = 300;
const BYTES_SECRETO = 32;

class ErrorDeSecreto extends Error {}

// El servicio entrega el secreto en hexadecimal (64 caracteres); la clave
// del HMAC son los 32 bytes decodificados, no el texto.
function secretoDesdeHex(hex) {
    if (!/^[0-9a-fA-F]{64}$/.test(hex || "")) {
        throw new ErrorDeSecreto("El secreto del webhook tiene que tener 64 caracteres hexadecimales (32 bytes)");
    }

    return Buffer.from(hex, "hex");
}

// Verifica X-Firma: t=<unix>,v1=<hex>, donde v1 = HMAC-SHA256(secreto,
// "<t>.<cuerpo>"). La comparación es en tiempo constante y la marca de
// tiempo no puede tener más de 5 minutos (reinyección). Sin un secreto de
// 32 bytes no acepta nada: con una clave vacía cualquiera podría firmar.
function verificarFirma(cuerpo, encabezado, secreto, ahora = Date.now() / 1000) {
    if (!Buffer.isBuffer(secreto) || secreto.length !== BYTES_SECRETO) {
        return { valida: false, motivo: "Secreto del webhook no configurado" };
    }

    const partes = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(encabezado || "");

    if (!partes) return { valida: false, motivo: "X-Firma ausente o con otro formato" };

    const [, t, v1] = partes;

    if (Math.abs(ahora - Number(t)) > VENTANA_S) {
        return { valida: false, motivo: "Marca de tiempo fuera de la ventana de 5 minutos" };
    }

    const esperada = crypto.createHmac("sha256", secreto).update(`${t}.${cuerpo}`).digest();

    if (!crypto.timingSafeEqual(esperada, Buffer.from(v1, "hex"))) {
        return { valida: false, motivo: "Firma inválida" };
    }

    return { valida: true };
}

module.exports = { ErrorDeSecreto, secretoDesdeHex, verificarFirma, VENTANA_S };
