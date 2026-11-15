const { Registry, Counter, Histogram } = require("prom-client");

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

module.exports = { crearMetricas };