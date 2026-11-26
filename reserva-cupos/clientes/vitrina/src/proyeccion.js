// Proyección en memoria de lo que el servicio sabe de este tenant. Canchas
// y Eventos no tienen base propia: la arman con el feed /v1/cambios (la
// garantía: completo y ordenado) y la mantienen al día con los webhooks (el
// camino rápido). Cada instantánea trae su versión: aplicar un cambio
// repetido o atrasado no altera nada. Si el contenedor se reinicia, se
// reconstruye leyendo el feed desde el principio.

const ESTADOS = ["pendiente", "confirmada", "rechazada", "cancelada", "fallida"];

function crearProyeccion({ maxWebhooks = 40 } = {}) {
    let actividades = new Map();
    let reservas = new Map();
    let porActividad = new Map();
    let secuencia = 0;
    let webhooks = [];
    let recibidos = { validos: 0, rechazados: 0 };

    function aplicarActividad(actividad) {
        const previa = actividades.get(actividad.id);
        if (previa && previa.version >= actividad.version) return false;
        actividades.set(actividad.id, actividad);
        return true;
    }

    function aplicarReserva(reserva) {
        const previa = reservas.get(reserva.id);
        if (previa && previa.version >= reserva.version) return false;
        reservas.set(reserva.id, reserva);

        if (!porActividad.has(reserva.actividad_id)) porActividad.set(reserva.actividad_id, new Set());
        porActividad.get(reserva.actividad_id).add(reserva.id);
        return true;
    }

    // El tipo de cambio es una enumeración extensible: los tipos que no se
    // conocen se ignoran.
    function aplicarCambio(cambio) {
        if (cambio.tipo.startsWith("actividad.")) return aplicarActividad(cambio.entidad);
        if (cambio.tipo.startsWith("reserva.")) return aplicarReserva(cambio.entidad);
        return false;
    }

    function avanzar(ultima) {
        secuencia = Math.max(secuencia, ultima);
    }

    function conteo(actividadId) {
        const resultado = Object.fromEntries(ESTADOS.map(estado => [estado, 0]));
        for (const id of porActividad.get(actividadId) || []) resultado[reservas.get(id).estado]++;
        return resultado;
    }

    // Los id son UUIDv7: ordenarlos es ordenar por creación.
    function listar() {
        return [...actividades.values()]
            .sort((a, b) => (a.id < b.id ? 1 : -1))
            .map(actividad => ({ ...actividad, conteo: conteo(actividad.id) }));
    }

    function detalle(actividadId) {
        const actividad = actividades.get(actividadId);
        if (!actividad) return null;

        const lista = [...(porActividad.get(actividadId) || [])]
            .map(id => reservas.get(id))
            .sort((a, b) => (a.id < b.id ? -1 : 1));

        return { actividad: { ...actividad, conteo: conteo(actividadId) }, reservas: lista };
    }

    function registrarWebhook(entrada) {
        recibidos[entrada.valido ? "validos" : "rechazados"]++;
        webhooks = [{ recibido_en: new Date().toISOString(), ...entrada }, ...webhooks].slice(0, maxWebhooks);
    }

    // Otra clave es otro tenant: lo anterior no le pertenece.
    function reiniciar() {
        actividades = new Map();
        reservas = new Map();
        porActividad = new Map();
        secuencia = 0;
        webhooks = [];
        recibidos = { validos: 0, rechazados: 0 };
    }

    return {
        aplicarActividad,
        aplicarReserva,
        aplicarCambio,
        avanzar,
        listar,
        detalle,
        registrarWebhook,
        reiniciar,
        conoce: actividadId => actividades.has(actividadId),
        secuencia: () => secuencia,
        webhooks: () => webhooks,
        recibidos: () => ({ ...recibidos })
    };
}

module.exports = { crearProyeccion, ESTADOS };
