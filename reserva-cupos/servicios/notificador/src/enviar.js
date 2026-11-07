const http = require("node:http");
const https = require("node:https");

// POST del webhook. Devuelve el código de estado; rechaza ante un error de
// red, un destino no permitido o si no hay respuesta a tiempo.
function enviar(url, cuerpo, encabezados, { timeoutMs, lookup }) {
    const modulo = url.protocol === "https:" ? https : http;

    return new Promise((resolve, reject) => {
        const solicitud = modulo.request(url, {
            method: "POST",
            headers: { ...encabezados, "Content-Length": Buffer.byteLength(cuerpo) },
            lookup,
            timeout: timeoutMs
        }, respuesta => {
            respuesta.resume();
            respuesta.on("end", () => resolve(respuesta.statusCode));
            respuesta.on("error", reject);
        });

        solicitud.on("timeout", () => solicitud.destroy(new Error(`Sin respuesta en ${timeoutMs} ms`)));
        solicitud.on("error", reject);
        solicitud.end(cuerpo);
    });
}

module.exports = { enviar };
