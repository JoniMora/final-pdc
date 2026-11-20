// Reintentos de los webhooks (contrato: a los 10 s, 1 min y 5 min del fallo
// anterior; después, la DLQ).
const COLAS = ["webhooks.espera.10s", "webhooks.espera.1m", "webhooks.espera.5m"];
const ESPERAS_MS = [10000, 60000, 300000];

// Plazo total desde el primer fallo: la suma de las tres esperas (370 s) más
// un margen para los ciclos en que el circuito abierto difiere sin intentar.
// Sin este tope, un mensaje diferido sin consumir intentos podía tardar
// horas en llegar a la DLQ: con el circuito abierto, solo la prueba de cada
// semiapertura gasta un intento.
const PLAZO_MS = 400000;

// intento: reintentos HTTP ya hechos (cabecera x-intento).
// consumir: false cuando el circuito difiere el mensaje sin intentar HTTP.
// primerFallo: instante del primer fallo (cabecera x-primer-fallo), en ms.
//
// El plazo solo se puede comprobar cuando el mensaje vuelve de su espera:
// por eso un reintento nunca espera más allá del plazo (si la espera que le
// toca terminaría después, usa la más larga que termine antes). Así el
// mensaje llega a la DLQ a más tardar 10 s después de vencido el plazo.
function planReintento(intento, { consumir = true, primerFallo, ahora = Date.now(), plazoMs = PLAZO_MS } = {}) {
    if (!Number.isInteger(intento) || intento < 0) throw new Error("Cabecera de reintento inválida");

    const inicio = Number.isFinite(primerFallo) && primerFallo <= ahora ? primerFallo : ahora;
    const restante = inicio + plazoMs - ahora;

    if (restante <= 0) return { agotado: true, motivo: "plazo vencido" };
    if (!consumir) return { agotado: false, cola: COLAS[0], intento, primerFallo: inicio };
    if (intento >= COLAS.length) return { agotado: true, motivo: "sin más reintentos" };

    let espera = intento;
    while (espera > 0 && ESPERAS_MS[espera] > restante) espera--;

    return { agotado: false, cola: COLAS[espera], intento: intento + 1, primerFallo: inicio };
}

module.exports = { planReintento, PLAZO_MS };
