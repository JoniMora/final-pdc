const { crearContratoHttp, ErrorDeContrato } = require("../../../compartido/src/contrato");

// Cliente de la API derivado del contrato: cada llamada se identifica por
// su operationId de contrato/openapi.yaml, que define el método y la ruta,
// y cada respuesta se valida contra el esquema declarado para su código.
// Aula no conoce la implementación de la API, solo su contrato.
function crearClienteApi({ baseUrl, clave, timeoutMs = 15000 }) {
    const contrato = crearContratoHttp();

    async function llamar(operationId, { parametros = {}, query, cuerpo, encabezados = {} } = {}) {
        const consulta = query ? `?${new URLSearchParams(query)}` : "";
        const respuesta = await fetch(`${baseUrl}${contrato.ruta(operationId, parametros)}${consulta}`, {
            method: contrato.metodo(operationId),
            headers: {
                Authorization: `Bearer ${clave}`,
                ...(cuerpo !== undefined ? { "Content-Type": "application/json" } : {}),
                ...encabezados
            },
            body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
            // Mayor que la espera de la réplica semisíncrona (10 s).
            signal: AbortSignal.timeout(timeoutMs)
        });

        const tipo = (respuesta.headers.get("content-type") || "application/json").split(";")[0];
        const texto = await respuesta.text();
        const datos = texto ? JSON.parse(texto) : null;

        // Una respuesta fuera de contrato es un error de integración:
        // se informa en lugar de procesar datos con otra forma.
        contrato.validarRespuesta(operationId, respuesta.status, datos, tipo);

        return {
            status: respuesta.status,
            location: respuesta.headers.get("location"),
            retryAfter: respuesta.headers.get("retry-after"),
            cuerpo: datos
        };
    }

    return { llamar, contrato };
}

module.exports = { crearClienteApi, ErrorDeContrato };
