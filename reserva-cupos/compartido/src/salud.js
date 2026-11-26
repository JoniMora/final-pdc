// /health de los procesos internos (worker, relay y notificador), en su
// servidor HTTPS de métricas: puerto 9464, solo en la red interna. Mismo
// formato que el /health de la API: { servicio, estado, mysql, rabbitmq }.
//
// Responde 200 aunque una dependencia no responda: informa cuál, sin
// bloquearse. Lo usan los healthchecks de Compose (el proceso está vivo y
// atiende) y quien diagnostica una caída (qué dependencia falta).
function crearSalud({ servicio, pool, rabbitmq, plazoMs = 1500 }) {
    let enCurso = null;

    // Los chequeos simultáneos comparten la misma consulta.
    function mysql() {
        if (enCurso) return enCurso;

        let temporizador;
        const plazo = new Promise((_, rechazar) => {
            temporizador = setTimeout(() => rechazar(new Error("plazo vencido")), plazoMs);
        });

        enCurso = Promise.race([pool.query({ sql: "SELECT 1", timeout: plazoMs }), plazo])
            .then(() => "conectado", () => "no disponible")
            .finally(() => {
                clearTimeout(temporizador);
                enCurso = null;
            });

        return enCurso;
    }

    return async function informe() {
        return {
            servicio,
            estado: "ok",
            mysql: await mysql(),
            rabbitmq: rabbitmq() ? "conectado" : "no disponible"
        };
    };
}

// Responde GET /health; devuelve false si la solicitud es para otra ruta.
async function atenderSalud(req, res, salud) {
    if (req.method !== "GET" || req.url !== "/health") return false;

    const cuerpo = JSON.stringify(await salud());
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(cuerpo);
    return true;
}

module.exports = { crearSalud, atenderSalud };
