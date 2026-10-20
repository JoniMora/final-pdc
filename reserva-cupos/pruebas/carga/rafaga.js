// Flash crowd sobre una actividad: SOLICITUDES usuarios virtuales piden
// una reserva a la vez sobre una actividad de CAPACIDAD cupos.
//
// Uso (desde reserva-cupos):
//   docker compose run --rm k6 run -e API_KEY=<clave> /pruebas/carga/rafaga.js
//
// Criterio de aceptación: todas las admisiones responden 202 y, cuando no
// quedan pendientes, hay exactamente CAPACIDAD confirmadas, el resto
// rechazadas y cupos_disponibles = 0. Todo se verifica por la API pública.

import http from "k6/http";
import { check, sleep } from "k6";
import exec from "k6/execution";

const API_URL = __ENV.API_URL || "http://api:3000";
const API_KEY = __ENV.API_KEY;
const SOLICITUDES = Number(__ENV.SOLICITUDES || 500);
const CAPACIDAD = Number(__ENV.CAPACIDAD || 10);

export const options = {
    scenarios: {
        rafaga: {
            // Un usuario virtual por solicitud, todos al mismo tiempo.
            executor: "per-vu-iterations",
            vus: SOLICITUDES,
            iterations: 1,
            maxDuration: "60s"
        }
    },
    thresholds: {
        checks: ["rate==1"]
    },
    setupTimeout: "30s",
    teardownTimeout: "150s",
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
    const respuesta = http.post(
        `${API_URL}/v1/actividades/${datos.actividadId}/reservas`,
        JSON.stringify({ participante: `alumno-${n}` }),
        opciones({ "Idempotency-Key": `rafaga-${datos.corrida}-${n}` })
    );

    check(respuesta, {
        "admisión responde 202": r => r.status === 202,
        "admisión devuelve Location": r => Boolean(r.headers["Location"])
    });
}

function contar(datos, estado) {
    let total = 0;
    let cursor = null;

    do {
        const pagina = http.get(
            `${API_URL}/v1/actividades/${datos.actividadId}/reservas` +
            `?estado=${estado}&limite=100${cursor ? `&cursor=${cursor}` : ""}`,
            opciones()
        );

        total += pagina.json("datos").length;
        cursor = pagina.json("siguiente_cursor");
    } while (cursor);

    return total;
}

// El procesamiento es asíncrono: se espera a que no queden pendientes.
export function teardown(datos) {
    const inicio = Date.now();
    let pendientes = contar(datos, "pendiente");

    while (pendientes > 0 && Date.now() - inicio < 120000) {
        sleep(0.5);
        pendientes = contar(datos, "pendiente");
    }

    const segundos = ((Date.now() - inicio) / 1000).toFixed(1);
    const confirmadas = contar(datos, "confirmada");
    const rechazadas = contar(datos, "rechazada");
    const actividad = http.get(`${API_URL}/v1/actividades/${datos.actividadId}`, opciones()).json();

    console.log(
        `Resultado (sin pendientes tras ${segundos} s de espera): ` +
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
