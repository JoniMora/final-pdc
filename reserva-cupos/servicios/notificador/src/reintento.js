const COLAS = ['webhooks.espera.10s', 'webhooks.espera.1m', 'webhooks.espera.5m'];
function planReintento(intento, consumir = true) {
    if (!Number.isInteger(intento) || intento < 0) throw new Error('Cabecera de reintento invalida');
    if (!consumir) return { agotado: false, cola: COLAS[0], intento };
    if (intento >= COLAS.length) return { agotado: true };
    return { agotado: false, cola: COLAS[intento], intento: intento + 1 };
}
module.exports = { planReintento };
