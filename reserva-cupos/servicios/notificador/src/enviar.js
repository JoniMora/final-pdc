const http = require("node:http");
const https = require("node:https");

// POST del webhook. Devuelve el código de estado; rechaza ante un error de
// red, un destino no permitido o si la respuesta no termina de llegar a
// tiempo. El plazo es total, desde la conexión hasta el último byte: un
// receptor que envía la respuesta de a poco no retiene la entrega.
function enviar(url, cuerpo, encabezados, { timeoutMs, lookup }) {
    const modulo = url.protocol === "https:" ? https : http;

    return new Promise((resolve, reject) => {
        const solicitud = modulo.request(url, {
            method: "POST",
            headers: { ...encabezados, "Content-Length": Buffer.byteLength(cuerpo) },
            lookup
        }, respuesta => {
            respuesta.resume();
            respuesta.on("end", () => {
                clearTimeout(plazo);
                resolve(respuesta.statusCode);
            });
            respuesta.on("error", error => {
                clearTimeout(plazo);
                reject(error);
            });
        });

        const plazo = setTimeout(() => {
            solicitud.destroy(new Error(`Sin respuesta completa en ${timeoutMs} ms`));
        }, timeoutMs);

        solicitud.on("error", error => {
            clearTimeout(plazo);
            reject(error);
        });
        solicitud.end(cuerpo);
    });
}

module.exports = { enviar };
