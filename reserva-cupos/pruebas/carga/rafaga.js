// Flash crowd sobre una actividad: SOLICITUDES usuarios virtuales piden
// una reserva a la vez sobre una actividad de CAPACIDAD cupos.
//
// Uso (desde reserva-cupos):
//   docker compose run --rm k6 run -e API_KEY=<clave> /pruebas/carga/rafaga.js
//   ... -e ACTIVIDAD_ID=<id>   usa una actividad existente en lugar de crearla
//
// Criterio de aceptación: todas las admisiones responden 202 y, cuando no
// quedan pendientes, hay exactamente CAPACIDAD confirmadas, el resto
// rechazadas y cupos_disponibles = 0. Todo se verifica por la API pública.

import http from "k6/http";
import { check, sleep } from "k6";
import exec from "k6/execution";
import { Counter, Trend } from "k6/metrics";
import { salidaResumen } from './resumen.js';
export const handleSummary = salidaResumen;

const admisionesPorEstado = new Counter("admisiones_por_estado");
const duracionAdmision = new Trend("admision_duracion_ms", true);
const API_URL = __ENV.API_URL || "https://traefik";
const API_KEY = __ENV.API_KEY;
const SOLICITUDES = Number(__ENV.SOLICITUDES || 500);
const CAPACIDAD = Number(__ENV.CAPACIDAD || 10);
const REINTENTOS = Number(__ENV.REINTENTOS || 0);
const reintentos = new Counter('admision_reintentos');
const esperaDecisiones = new Trend('espera_decisiones_ms', true);
// Plazo funcional de drenaje; no representa un objetivo de latencia.
const PLAZO_DECISIONES_MS = 180000;

export const options = {
    scenarios: {
        rafaga: {
            // Un usuario virtual por solicitud, todos al mismo tiempo.
            executor: "per-vu-iterations",
            vus: SOLICITUDES,
            iterations: 1,
            maxDuration: REINTENTOS ? "180s" : "60s"
        }
    },
    thresholds: {
        checks: ["rate==1"]
    },
    setupTimeout: "60s",
    teardownTimeout: "210s",
    summaryTrendStats: ["min", "med", "avg", "p(95)", "max"]
};

function opciones(extra = {}) {
    return {
        headers: {
            Authorization: `Bearer ${API_KEY}`,
            "Content-Type": "application/json",
            ...extra
        }
    };
}

export function setup() {
    if (!API_KEY) {
        exec.test.abort("Falta API_KEY: ejecutar con -e API_KEY=<clave>");
    }

    // Para la demo: la ráfaga va a una actividad que ya existe (por ejemplo,
    // una materia recién creada en Aula, con la clave de Aula), vacía y con
    // CAPACIDAD cupos.
    if (__ENV.ACTIVIDAD_ID) {
        console.log(`Actividad ${__ENV.ACTIVIDAD_ID}: ${CAPACIDAD} cupos, ${SOLICITUDES} solicitudes simultáneas`);
        return { actividadId: __ENV.ACTIVIDAD_ID, corrida: Date.now() };
    }

    const respuesta = http.post(
        `${API_URL}/v1/actividades`,
        JSON.stringify({
            nombre: `Ráfaga ${new Date().toISOString()}`,
            capacidad: CAPACIDAD,
            metadata: { prueba: "rafaga" }
        }),
        opciones()
    );

    if (respuesta.status !== 201) {
        exec.test.abort(`No se pudo crear la actividad: HTTP ${respuesta.status} ${respuesta.body}`);
    }

    const actividadId = respuesta.json("id");

    console.log(`Actividad ${actividadId}: ${CAPACIDAD} cupos, ${SOLICITUDES} solicitudes simultáneas`);

    return { actividadId, corrida: Date.now() };
}

export default function (datos) {
    const n = exec.scenario.iterationInTest;

    // Clave de idempotencia y participante únicos por solicitud: así
    // todas llegan a competir por el cupo y ninguna la frena un índice único.
    let respuesta;
    if (__ENV.FALLOS && n === 0) console.log(`PDC_CARGA_INICIADA:${datos.actividadId}`);
    for (let intento = 0; ; intento++) {
        respuesta = http.post(
            `${API_URL}/v1/actividades/${datos.actividadId}/reservas`,
            JSON.stringify({ participante: `alumno-${n}` }),
            { ...opciones({ "Idempotency-Key": `rafaga-${datos.corrida}-${n}` }), timeout: '60s' }
        );
        // Como un cliente correcto: ante un error de red, 429 o cualquier 5xx,
        // reintenta con la misma Idempotency-Key (la admisión es idempotente).
        // Incluye el 500: si una API muere a mitad de una respuesta, Traefik
        // puede devolver su propio 500 en lugar de 502 o 504.
        const transitorio = respuesta.status === 0 || respuesta.status === 429 || respuesta.status >= 500;
        if (!transitorio || intento >= REINTENTOS) break;
        reintentos.add(1);
        sleep(Math.min(2, 0.25 * (intento + 1)));
    }
    admisionesPorEstado.add(1, {
        estado: String(respuesta.status)
    });

    duracionAdmision.add(respuesta.timings.duration);

    if (respuesta.status !== 202 && !(REINTENTOS > 0 && respuesta.status === 200)) {
        console.warn(
            `Admisión fallida: participante=alumno-${n}, ` +
            `HTTP=${respuesta.status}, ` +
            `duracion_ms=${respuesta.timings.duration.toFixed(1)}, ` +
            `error=${respuesta.error || "ninguno"}`
        );
    }
    check(respuesta, {
        "admisión responde 202": r => r.status === 202 || (REINTENTOS > 0 && r.status === 200),
        "admisión devuelve Location": r => Boolean(r.headers["Location"])
    });
}

function contar(datos, estado) {
    let total = 0;
    let cursor = null;

    do {
        const url =
            `${API_URL}/v1/actividades/${datos.actividadId}/reservas` +
            `?estado=${estado}&limite=100` +
            (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");

        const pagina = http.get(url, opciones());

        if (pagina.status !== 200) {
            const detalle = String(pagina.body || "")
                .split(API_KEY).join("[CLAVE OCULTA]")
                .slice(0, 800);

            throw new Error(
                `Falló el listado de reservas: HTTP ${pagina.status}, ` +
                `estado solicitado=${estado}. Respuesta: ${detalle}`
            );
        }

        let contenido;

        try {
            contenido = pagina.json();
        } catch {
            throw new Error(
                "El listado respondió HTTP 200 pero no devolvió JSON válido"
            );
        }

        if (!Array.isArray(contenido.datos)) {
            throw new Error(
                "El listado respondió HTTP 200 sin un arreglo datos"
            );
        }

        total += contenido.datos.length;
        cursor = contenido.siguiente_cursor;
    } while (cursor);

    return total;
}

// El procesamiento es asíncrono: se espera a que no queden pendientes.
export function teardown(datos) {
    const inicio = Date.now();
    let pendientes = contar(datos, "pendiente");

    while (pendientes > 0 && Date.now() - inicio < PLAZO_DECISIONES_MS) {
        sleep(1);
        pendientes = contar(datos, "pendiente");
    }

    const segundos = ((Date.now() - inicio) / 1000).toFixed(1);
    esperaDecisiones.add(Date.now() - inicio);
    const confirmadas = contar(datos, "confirmada");
    const rechazadas = contar(datos, "rechazada");
    const actividad = http.get(`${API_URL}/v1/actividades/${datos.actividadId}`, opciones()).json();

    console.log(
        `Resultado (tras ${segundos} s de espera; plazo ${PLAZO_DECISIONES_MS / 1000} s): ` +
        `confirmadas=${confirmadas} rechazadas=${rechazadas} pendientes=${pendientes} ` +
        `cupos_disponibles=${actividad.cupos_disponibles}`
    );

    check(null, {
        "0 pendientes": () => pendientes === 0,
        [`exactamente ${CAPACIDAD} confirmadas`]: () => confirmadas === CAPACIDAD,
        [`exactamente ${SOLICITUDES - CAPACIDAD} rechazadas`]: () => rechazadas === SOLICITUDES - CAPACIDAD,
        "cupos_disponibles = 0": () => actividad.cupos_disponibles === 0
    });
}
