// Arnés de inyección de fallos (Entrega 5, issue E5-11). Utilidades comunes
// a los escenarios de pruebas/fallos/matriz.js:
//
//   - ráfaga de reservas que se comporta como un cliente correcto: ante un
//     error de red, un 5xx o un 429, reintenta con la misma Idempotency-Key;
//   - una acción (detener un componente) que se dispara a mitad de la ráfaga;
//   - verificación de las invariantes por la API pública: exactamente
//     `capacidad` confirmadas, el resto rechazadas, ninguna pendiente,
//     ningún participante con dos reservas activas y cupos coherentes;
//   - cronómetro y comandos de Docker.

const crypto = require("node:crypto");
const { docker, dockerAsync, dockerDirecto, api, esperar, esperarHasta } = require("../comun");

function cronometro() {
    const inicio = Date.now();
    return () => (Date.now() - inicio) / 1000;
}

const segundos = valor => `${valor.toFixed(1)} s`;

// --- Componentes -------------------------------------------------------------

function detener(servicio) {
    return dockerAsync(["stop", servicio]);
}

function iniciar(servicio) {
    return dockerAsync(["start", servicio]);
}

// Espera a que el contenedor quede healthy (o en marcha, si no tiene
// health check).
async function esperarSaludable(servicio, plazoMs = 180000) {
    await esperarHasta(() => {
        const [id] = docker(["ps", "-a", "-q", servicio]).trim().split("\n");
        const estado = dockerDirecto(["inspect", "-f",
            "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}", id]).trim();
        return estado.startsWith("running") && !/starting|unhealthy/.test(estado);
    }, { plazoMs, intervaloMs: 1000, descripcion: `que ${servicio} esté en marcha` });
}

function colas() {
    const salida = docker(["exec", "-T", "rabbitmq", "rabbitmqctl", "-q", "list_queues", "name", "messages"]);
    return Object.fromEntries(salida.trim().split("\n")
        .map(linea => linea.split(/\s+/))
        .filter(([nombre, mensajes]) => nombre && /^\d+$/.test(mensajes))
        .map(([nombre, mensajes]) => [nombre, Number(mensajes)]));
}

// --- Ráfaga ------------------------------------------------------------------

// Una solicitud de reserva con reintentos. Devuelve la reserva admitida
// (202 o 200 por repetición idempotente) o lanza si se agota el plazo.
async function reservarConReintentos(cliente, actividadId, participante, { plazoMs = 180000, registro }) {
    const clave = crypto.randomUUID();
    const inicio = Date.now();
    let intentos = 0;

    for (;;) {
        intentos++;
        let status;

        try {
            const respuesta = await cliente(`/v1/actividades/${actividadId}/reservas`, {
                metodo: "POST",
                cuerpo: { participante },
                encabezados: { "Idempotency-Key": clave },
                timeoutMs: 30000
            });

            status = respuesta.status;

            if (status === 202 || status === 200) {
                registro.latencias.push(Date.now() - inicio);
                registro.reintentos += intentos - 1;
                return respuesta.datos;
            }

            if (status !== 429 && status < 500) {
                throw new Error(`Respuesta definitiva inesperada: HTTP ${status} ${JSON.stringify(respuesta.datos)}`);
            }
        } catch (error) {
            if (error.message.startsWith("Respuesta definitiva")) throw error;
            status = error.code || error.message;
        }

        registro.errores[status] = (registro.errores[status] || 0) + 1;

        if (Date.now() - inicio > plazoMs) {
            throw new Error(`${participante}: sin admisión después de ${intentos} intentos (último: ${status})`);
        }

        await esperar(Math.min(2000, 200 * intentos));
    }
}

// Crea una actividad y lanza `solicitudes` reservas de participantes
// distintos, con `concurrencia` clientes en paralelo. Si se indica
// `durante`, ejecuta su acción una vez, cuando se admitieron `tras`
// solicitudes, sin frenar a los demás clientes.
async function rafaga({ clave, capacidad = 10, solicitudes = 200, concurrencia = 50, durante, cliente = api(clave), crear }) {
    const actividad = crear
        ? await crear()
        : (await cliente("/v1/actividades", {
            metodo: "POST",
            cuerpo: { nombre: `Fallos ${new Date().toISOString()}`, capacidad }
        })).datos;

    const registro = { latencias: [], reintentos: 0, errores: {}, admitidas: [] };
    let siguiente = 0;
    let accion = null;

    async function clienteVirtual() {
        while (siguiente < solicitudes) {
            const n = siguiente++;
            const reserva = await reservarConReintentos(cliente, actividad.id, `participante-${n}`, { registro });
            registro.admitidas.push(reserva.id);

            if (durante && !accion && registro.admitidas.length >= durante.tras) {
                accion = Promise.resolve().then(durante.accion);
            }
        }
    }

    const reloj = cronometro();
    await Promise.all(Array.from({ length: concurrencia }, clienteVirtual));
    if (accion) await accion;

    return { actividadId: actividad.id, duracion: reloj(), ...registro };
}

function resumenRafaga(resultado) {
    const ordenadas = [...resultado.latencias].sort((a, b) => a - b);
    const p = q => ordenadas[Math.min(ordenadas.length - 1, Math.floor(q * ordenadas.length))] / 1000;
    const errores = Object.entries(resultado.errores).map(([codigo, n]) => `${codigo}×${n}`).join(", ") || "ninguno";

    return `${resultado.admitidas.length} admitidas en ${segundos(resultado.duracion)} · ` +
        `latencia de admisión p50 ${p(0.5).toFixed(2)} s, p95 ${p(0.95).toFixed(2)} s, máx ${p(1).toFixed(2)} s · ` +
        `reintentos ${resultado.reintentos} (errores vistos: ${errores})`;
}

// --- Invariantes --------------------------------------------------------------

async function listar(cliente, actividadId, estado) {
    const reservas = [];
    let cursor = null;

    do {
        const ruta = `/v1/actividades/${actividadId}/reservas?limite=100` +
            (estado ? `&estado=${estado}` : "") + (cursor ? `&cursor=${cursor}` : "");
        const pagina = await cliente(ruta);

        if (pagina.status !== 200) throw new Error(`Listado: HTTP ${pagina.status}`);

        reservas.push(...pagina.datos.datos);
        cursor = pagina.datos.siguiente_cursor;
    } while (cursor);

    return reservas;
}

// Espera a que no queden pendientes y comprueba las invariantes. Devuelve
// los conteos y el tiempo que tardó en quedar sin pendientes.
async function verificarInvariantes({ clave, actividadId, capacidad, solicitudes, cliente = api(clave), plazoMs = 300000 }) {
    const reloj = cronometro();

    await esperarHasta(async () => (await listar(cliente, actividadId, "pendiente")).length === 0, {
        plazoMs,
        intervaloMs: 1000,
        descripcion: "que no queden reservas pendientes"
    });

    const espera = reloj();
    const reservas = await listar(cliente, actividadId);
    const confirmadas = reservas.filter(r => r.estado === "confirmada");
    const rechazadas = reservas.filter(r => r.estado === "rechazada");
    const activas = reservas.filter(r => ["pendiente", "confirmada"].includes(r.estado));
    const duplicadas = activas.length - new Set(activas.map(r => r.participante)).size;
    const actividad = (await cliente(`/v1/actividades/${actividadId}`)).datos;

    const conteo = {
        total: reservas.length,
        confirmadas: confirmadas.length,
        rechazadas: rechazadas.length,
        duplicadas,
        cupos: actividad.cupos_disponibles,
        espera
    };

    const errores = [];
    if (conteo.total !== solicitudes) errores.push(`${conteo.total} reservas en vez de ${solicitudes}`);
    if (conteo.confirmadas !== Math.min(capacidad, solicitudes)) errores.push(`${conteo.confirmadas} confirmadas`);
    if (conteo.confirmadas + conteo.rechazadas !== conteo.total) errores.push("estados distintos de confirmada/rechazada");
    if (duplicadas !== 0) errores.push(`${duplicadas} participantes con dos reservas activas`);
    if (conteo.cupos !== capacidad - conteo.confirmadas || conteo.cupos < 0) errores.push(`cupos_disponibles = ${conteo.cupos}`);

    if (errores.length) throw new Error(`Invariantes no cumplidas: ${errores.join("; ")}`);

    return conteo;
}

function resumenInvariantes(conteo) {
    return `${conteo.confirmadas} confirmadas, ${conteo.rechazadas} rechazadas, 0 pendientes, ` +
        `${conteo.duplicadas} duplicadas, cupos_disponibles = ${conteo.cupos}`;
}

module.exports = {
    cronometro,
    segundos,
    detener,
    iniciar,
    esperarSaludable,
    colas,
    rafaga,
    resumenRafaga,
    listar,
    verificarInvariantes,
    resumenInvariantes
};
