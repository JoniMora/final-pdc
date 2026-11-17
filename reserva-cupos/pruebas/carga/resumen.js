// Exporta solo metricas: setup_data y options.env pueden contener claves.
export function resumenSeguro(data) {
    return { fecha: new Date().toISOString(), metricas: data.metrics,
        estado: data.state, escenarios: data.options?.scenarios };
}
export function salidaResumen(data) {
    return { stdout: `PDC_K6_JSON:${JSON.stringify(resumenSeguro(data))}\n` };
}
