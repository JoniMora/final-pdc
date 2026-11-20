// Reintentos de los webhooks (contrato: a los 10 s, 1 min y 5 min del fallo
// anterior; después, la DLQ).
const COLAS = ["webhooks.espera.10s", "webhooks.espera.1m", "webhooks.espera.5m"];

// Plazo total desde el primer fallo: la suma de las tres esperas (370 s) más
// un margen para los ciclos en que el circuito abierto difiere sin intentar.
// Sin este tope, un mensaje diferido sin consumir intentos podía tardar
// horas en llegar a la DLQ: con el circuito abierto, solo la prueba de cada
// semiapertura gasta un intento.
const PLAZO_MS = 400000;

// intento: reintentos HTTP ya hechos (cabecera x-intento).
// consumir: false cuando el circuito difiere el mensaje sin intentar HTTP.
// primerFallo: instante del primer fallo (cabecera x-primer-fallo), en ms.
function planReintento(intento, { consumir = true, primerFallo, ahora = Date.now(), plazoMs = PLAZO_MS } = {}) {
    if (!Number.isInteger(intento) || intento < 0) throw new Error("Cabecera de reintento inválida");

    const inicio = Number.isFinite(primerFallo) && primerFallo <= ahora ? primerFallo : ahora;

    if (ahora - inicio >= plazoMs) return { agotado: true, motivo: "plazo vencido" };
    if (!consumir) return { agotado: false, cola: COLAS[0], intento, primerFallo: inicio };
    if (intento >= COLAS.length) return { agotado: true, motivo: "sin más reintentos" };

    return { agotado: false, cola: COLAS[intento], intento: intento + 1, primerFallo: inicio };
}

module.exports = { planReintento, PLAZO_MS };
