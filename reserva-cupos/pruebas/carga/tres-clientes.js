// Tres clientes a la vez (issue #63): una ráfaga simultánea sobre una
// actividad de cada tenant (Canchas, Eventos y Aula). Muestra que el
// servicio es multi-tenant:
//
//   - cada tenant termina con exactamente CAPACIDAD confirmadas, aunque las
//     tres ráfagas compiten por la misma API, la misma cola y el mismo
//     MySQL;
//   - el límite de tasa es por tenant: Eventos (20 por segundo) recibe 429
//     y reintenta; Canchas y Aula no reciben ninguno;
//   - una actividad de un tenant no existe para otro (404).
//
// Uso (desde reserva-cupos; las claves las deja `sistema.js demo`):
//   docker compose run --rm k6 run \
//     -e CANCHAS="$(cat seguridad/local/canchas/clave-api)" \
//     -e EVENTOS="$(cat seguridad/local/eventos/clave-api)" \
//     -e AULA="$AULA" /pruebas/carga/tres-clientes.js
//
// Opciones: SOLICITUDES por tenant (200), CAPACIDAD (10), REINTENTOS (40).

import http from "k6/http";
import { check, sleep } from "k6";
import exec from "k6/execution";
import { Counter } from "k6/metrics";

const API_URL = __ENV.API_URL || "https://traefik";
const SOLICITUDES = Number(__ENV.SOLICITUDES || 200);
const CAPACIDAD = Number(__ENV.CAPACIDAD || 10);
const REINTENTOS = Number(__ENV.REINTENTOS || 40);
const PLAZO_DECISIONES_MS = 180000;

const hoy = new Date().toISOString().slice(0, 10);
const TENANTS = [
    {
        id: "canchas", clave: __ENV.CANCHAS, participante: "jugador",
        actividad: { nombre: "Turno de las 21 (ráfaga)", metadata: { origen: "canchas", tipo: "turno", cancha: "Cancha 1", fecha: hoy, hora: "21:00" } }
    },
    {
        id: "eventos", clave: __ENV.EVENTOS, participante: "asistente",
        actividad: { nombre: "Recital (ráfaga)", metadata: { origen: "eventos", tipo: "evento", lugar: "Estadio", fecha: hoy, hora: "21:00" } }
    },
    {
        id: "aula", clave: __ENV.AULA, participante: "alumno",
        actividad: { nombre: "Materia de la ráfaga", metadata: { origen: "aula", tipo: "materia" } }
    }
].filter(tenant => tenant.clave);

const admitidas = new Counter("admitidas");
const respuestas429 = new Counter("respuestas_429");
const reintentos = new Counter("reintentos");

// Un submétrico por tenant: el resumen los muestra por separado y los
// umbrales verifican que el límite de uno no frena a los otros.
const umbrales = { checks: ["rate==1"] };
for (const tenant of TENANTS) {
    umbrales[`admitidas{tenant:${tenant.id}}`] = [`count==${SOLICITUDES}`];
    umbrales[`respuestas_429{tenant:${tenant.id}}`] = [tenant.id === "eventos" ? "count>=0" : "count==0"];
    umbrales[`reintentos{tenant:${tenant.id}}`] = ["count>=0"];
}

export const options = {
    scenarios: {
        tres: {
            executor: "per-vu-iterations",
            vus: SOLICITUDES * Math.max(TENANTS.length, 1),
            iterations: 1,
            maxDuration: "180s"
        }
    },
    thresholds: umbrales,
    setupTimeout: "60s",
    teardownTimeout: "240s"
};

function opciones(clave, extra = {}) {
    return { headers: { Authorization: `Bearer ${clave}`, "Content-Type": "application/json", ...extra }, timeout: "60s" };
}

// Las lecturas también cuentan para el límite de tasa: ante 429, esperar.
function leer(url, clave) {
    for (let intento = 0; intento < 20; intento++) {
        const respuesta = http.get(url, opciones(clave));
        if (respuesta.status !== 429 && respuesta.status < 500) return respuesta;
        sleep(Number(respuesta.headers["Retry-After"]) || 1);
    }
    throw new Error(`Sin respuesta útil de ${url}`);
}

export function setup() {
    if (TENANTS.length < 2) {
        exec.test.abort("Hacen falta al menos dos claves: -e CANCHAS=... -e EVENTOS=... -e AULA=...");
    }

    const corrida = Date.now();
    const casos = TENANTS.map(tenant => {
        const respuesta = http.post(`${API_URL}/v1/actividades`,
            JSON.stringify({ ...tenant.actividad, capacidad: CAPACIDAD }), opciones(tenant.clave));
        if (respuesta.status !== 201) exec.test.abort(`${tenant.id}: no se pudo crear la actividad (HTTP ${respuesta.status})`);
        console.log(`${tenant.id}: "${tenant.actividad.nombre}" ${respuesta.json("id")}, ${CAPACIDAD} cupos, ${SOLICITUDES} solicitudes`);
        return { id: tenant.id, clave: tenant.clave, participante: tenant.participante, actividadId: respuesta.json("id") };
    });

    return { casos, corrida };
}

export default function (datos) {
    const n = exec.scenario.iterationInTest;
    const caso = datos.casos[n % datos.casos.length];
    const numero = Math.floor(n / datos.casos.length);
    const etiquetas = { tenant: caso.id };
    let respuesta;

    // Como un cliente correcto: ante 429, 5xx o un error de red, reintenta
    // con la misma Idempotency-Key, respetando Retry-After.
    for (let intento = 0; ; intento++) {
        respuesta = http.post(`${API_URL}/v1/actividades/${caso.actividadId}/reservas`,
            JSON.stringify({ participante: `${caso.participante}-${numero}` }),
            opciones(caso.clave, { "Idempotency-Key": `tres-${datos.corrida}-${n}` }));

        if (respuesta.status === 429) respuestas429.add(1, etiquetas);
        const transitorio = respuesta.status === 0 || respuesta.status === 429 || respuesta.status >= 500;
        if (!transitorio || intento >= REINTENTOS) break;

        reintentos.add(1, etiquetas);
        const espera = Number(respuesta.headers["Retry-After"]) || Math.min(2, 0.25 * (intento + 1));
        sleep(Math.min(espera, 3) * (0.5 + Math.random()));
    }

    if (respuesta.status === 202 || respuesta.status === 200) admitidas.add(1, etiquetas);
    check(respuesta, { "admisión 202 (o 200 al reintentar)": r => r.status === 202 || r.status === 200 });
}

function contar(caso, estado) {
    let total = 0;
    let cursor = null;
    do {
        const url = `${API_URL}/v1/actividades/${caso.actividadId}/reservas?estado=${estado}&limite=100` +
            (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
        const pagina = leer(url, caso.clave);
        if (pagina.status !== 200) throw new Error(`${caso.id}: listado HTTP ${pagina.status}`);
        total += pagina.json("datos").length;
        cursor = pagina.json("siguiente_cursor");
    } while (cursor);
    return total;
}

export function teardown(datos) {
    for (const caso of datos.casos) {
        const inicio = Date.now();
        let pendientes = contar(caso, "pendiente");
        while (pendientes > 0 && Date.now() - inicio < PLAZO_DECISIONES_MS) {
            sleep(1);
            pendientes = contar(caso, "pendiente");
        }

        const confirmadas = contar(caso, "confirmada");
        const rechazadas = contar(caso, "rechazada");
        const actividad = leer(`${API_URL}/v1/actividades/${caso.actividadId}`, caso.clave).json();

        console.log(`${caso.id}: confirmadas=${confirmadas} rechazadas=${rechazadas} pendientes=${pendientes} ` +
            `cupos_disponibles=${actividad.cupos_disponibles}`);

        check(null, {
            [`${caso.id}: 0 pendientes`]: () => pendientes === 0,
            [`${caso.id}: exactamente ${CAPACIDAD} confirmadas`]: () => confirmadas === CAPACIDAD,
            [`${caso.id}: exactamente ${SOLICITUDES - CAPACIDAD} rechazadas`]: () => rechazadas === SOLICITUDES - CAPACIDAD,
            [`${caso.id}: cupos_disponibles = 0`]: () => actividad.cupos_disponibles === 0
        });
    }

    // Aislamiento: la actividad de cada tenant, pedida con la clave del
    // siguiente, no existe.
    datos.casos.forEach((caso, i) => {
        const otro = datos.casos[(i + 1) % datos.casos.length];
        const respuesta = leer(`${API_URL}/v1/actividades/${caso.actividadId}`, otro.clave);
        console.log(`aislamiento: la actividad de ${caso.id} pedida con la clave de ${otro.id} → HTTP ${respuesta.status}`);
        check(respuesta, { [`aislamiento: ${otro.id} no ve la actividad de ${caso.id} (404)`]: r => r.status === 404 });
    });
}

// Resumen legible por tenant (sin claves: solo métricas).
export function handleSummary(data) {
    const valor = nombre => data.metrics[nombre]?.values?.count ?? 0;
    const lineas = ["", "Por tenant:"];
    for (const tenant of TENANTS) {
        lineas.push(`  ${tenant.id.padEnd(8)} admitidas=${valor(`admitidas{tenant:${tenant.id}}`)}` +
            `  respuestas 429=${valor(`respuestas_429{tenant:${tenant.id}}`)}` +
            `  reintentos=${valor(`reintentos{tenant:${tenant.id}}`)}`);
    }
    const checks = data.metrics.checks?.values || {};
    lineas.push(`Verificaciones: ${checks.passes ?? 0} de ${(checks.passes ?? 0) + (checks.fails ?? 0)}`, "");
    return { stdout: lineas.join("\n") };
}
