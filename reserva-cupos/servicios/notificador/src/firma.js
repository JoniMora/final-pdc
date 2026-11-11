const crypto = require("node:crypto");

// Firma de un webhook según contrato/openapi.yaml (sección webhooks):
// v1 = HMAC-SHA256(secreto del tenant, "<t>.<cuerpo>"), en hexadecimal.
// La marca de tiempo firmada permite al receptor descartar reinyecciones.
function firmar(secreto, cuerpo, t = Math.floor(Date.now() / 1000)) {
    const v1 = crypto.createHmac("sha256", secreto).update(`${t}.${cuerpo}`).digest("hex");
    return `t=${t},v1=${v1}`;
}

module.exports = { firmar };
