// Casos de concurrencia resueltos en la admisión, con solicitudes
// simultáneas sobre una misma actividad:
//
//   mismo_participante: REPETICIONES solicitudes del mismo participante
//                       con claves distintas → una 202, el resto 409.
//   misma_clave:        REPETICIONES reintentos con la misma
//                       Idempotency-Key y el mismo cuerpo → una 202,
//                       el resto 200 con la misma reserva.
//
// Uso (desde reserva-cupos):
//   docker compose run --rm k6 run -e API_KEY=<clave> /pruebas/carga/duplicados.js

import http from "k6/http";
import { check } from "k6";
import exec from "k6/execution";
import { Counter } from "k6/metrics";

const API_URL = __ENV.API_URL || "http://api:3000";
const API_KEY = __ENV.API_KEY;
const REPETICIONES = Number(__ENV.REPETICIONES || 20);

const respuestas = new Counter("respuestas");

// 409 es la respuesta esperada para el participante repetido.
http.setResponseCallback(http.expectedStatuses(200, 201, 202, 409));

export const options = {
    scenarios: {
        mismo_participante: {
            executor: "per-vu-iterations",
            vus: REPETICIONES,
            iterations: 1,
            exec: "mismoParticipante"
        },
        misma_clave: {
            executor: "per-vu-iterations",
            vus: REPETICIONES,
            iterations: 1,
            exec: "mismaClave"
        }
    },
    thresholds: {
        checks: ["rate==1"],
        "respuestas{caso:participante,status:202}": ["count==1"],
        "respuestas{caso:participante,status:409}": [`count==${REPETICIONES - 1}`],
        "respuestas{caso:clave,status:202}": ["count==1"],
        "respuestas{caso:clave,status:200}": [`count==${REPETICIONES - 1}`]
    }
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
        JSON.stringify({ nombre: `Duplicados ${new Date().toISOString()}`, capacidad: 10 }),
        opciones()
    );

    if (respuesta.status !== 201) {
        exec.test.abort(`No se pudo crear la actividad: HTTP ${respuesta.status} ${respuesta.body}`);
    }

    return { actividadId: respuesta.json("id"), corrida: Date.now() };
}

function solicitar(datos, participante, clave, caso) {
    const respuesta = http.post(
        `${API_URL}/v1/actividades/${datos.actividadId}/reservas`,
        JSON.stringify({ participante }),
        opciones({ "Idempotency-Key": clave })
    );

    respuestas.add(1, { caso, status: String(respuesta.status) });

    return respuesta;
}

export function mismoParticipante(datos) {
    const n = exec.scenario.iterationInTest;
    const respuesta = solicitar(datos, "alumno-repetido", `participante-${datos.corrida}-${n}`, "participante");

    check(respuesta, {
        "mismo participante: 202 o 409": r => r.status === 202 || r.status === 409
    });
}

export function mismaClave(datos) {
    const respuesta = solicitar(datos, "alumno-reintento", `clave-${datos.corrida}`, "clave");

    check(respuesta, {
        "misma clave: 202 o 200": r => r.status === 202 || r.status === 200
    });
}

// Debe haber exactamente dos reservas: una por caso.
export function teardown(datos) {
    const listado = http.get(
        `${API_URL}/v1/actividades/${datos.actividadId}/reservas?limite=100`,
        opciones()
    ).json("datos");

    const participantes = listado.map(reserva => reserva.participante).sort();

    console.log(`Reservas creadas: ${listado.length} (${participantes.join(", ")})`);

    check(null, {
        "exactamente 2 reservas en la actividad": () => listado.length === 2
    });
}
