const { Registry, Counter, Histogram, Gauge } = require("prom-client");

function crearMetricas(servicio) {
    const registro = new Registry();

    registro.setDefaultLabels({ servicio });

    const solicitudes = new Counter({
        name: "pdc_http_solicitudes_total",
        help: "Cantidad de solicitudes HTTP terminadas",
        labelNames: ["metodo", "ruta", "estado"],
        registers: [registro]
    });

    const duracion = new Histogram({
        name: "pdc_http_duracion_segundos",
        help: "Tiempo de respuesta HTTP en segundos",
        labelNames: ["metodo", "ruta", "estado"],
        buckets: [
            0.005, 0.01, 0.025, 0.05, 0.1,
            0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120
        ],
        registers: [registro]
    });

    const eventos = new Counter({
        name: "pdc_eventos_total",
        help: "Cantidad de eventos de negocio procesados",
        labelNames: ["tipo", "resultado"],
        registers: [registro]
    });

    return { registro, solicitudes, duracion, eventos };
}

function crearMetricasCircuitos(registro) {
    return {
        estado: new Gauge({ name: 'pdc_webhook_circuito_estado',
            help: 'Estado por tenant: 0 cerrado, 1 abierto, 2 semiabierto',
            labelNames: ['tenant'], registers: [registro] }),
        transiciones: new Counter({ name: 'pdc_webhook_circuito_transiciones_total',
            help: 'Transiciones del circuito por tenant y estado',
            labelNames: ['tenant', 'estado'], registers: [registro] }),
        demora: new Histogram({ name: 'pdc_webhook_demora_segundos',
            help: 'Demora desde ocurrido_en hasta entrega HTTP exitosa',
            buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600], registers: [registro] })
    };
}

// Cuántas admisiones comparte cada commit de la API. Explica la curva de
// 1/2/4 instancias: el agrupamiento es por proceso, así que con la misma
// carga más instancias forman lotes más chicos y pagan más commits
// semisincrónicos.
function crearMetricaLoteAdmision(registro) {
    return new Histogram({
        name: "pdc_admision_lote_tamano",
        help: "Admisiones confirmadas en cada transacción de lote",
        buckets: [1, 2, 5, 10, 20, 30, 40, 50],
        registers: [registro]
    });
}

module.exports = { crearMetricas, crearMetricasCircuitos, crearMetricaLoteAdmision };
