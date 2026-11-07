// Errores como Problem Details (RFC 9457).
class Problema extends Error {
    constructor(status, tipo, titulo, detalle, encabezados = {}) {
        super(detalle || titulo);
        this.status = status;
        this.tipo = tipo;
        this.titulo = titulo;
        this.detalle = detalle;
        this.encabezados = encabezados;
    }
}

function enviarProblema(res, problema) {
    res.status(problema.status)
        .set(problema.encabezados)
        .type("application/problem+json")
        .send(JSON.stringify({
            type: problema.tipo ? `urn:reserva-cupos:problema:${problema.tipo}` : "about:blank",
            title: problema.titulo,
            status: problema.status,
            ...(problema.detalle ? { detail: problema.detalle } : {})
        }));
}

const problemas = {
    solicitudInvalida: detalle =>
        new Problema(400, "solicitud-invalida", "Solicitud inválida", detalle),

    noAutenticado: () =>
        new Problema(401, "no-autenticado", "Clave de API ausente o inválida", null, {
            "WWW-Authenticate": 'Bearer realm="reserva-cupos"'
        }),

    // Un recurso de otro tenant responde igual que uno inexistente.
    noEncontrado: () =>
        new Problema(404, null, "Recurso no encontrado"),

    actividadCerrada: () =>
        new Problema(409, "actividad-cerrada", "La actividad no admite reservas"),

    reservaActiva: () =>
        new Problema(409, "reserva-activa", "El participante ya tiene una reserva activa en esta actividad"),

    claveReutilizada: () =>
        new Problema(422, "clave-reutilizada", "La Idempotency-Key ya se usó con otro cuerpo"),

    noDisponible: () =>
        new Problema(503, "no-disponible", "Servicio no disponible temporalmente", null, {
            "Retry-After": "5"
        })
};

module.exports = { Problema, enviarProblema, problemas };
