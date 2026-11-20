// Límite de tasa por tenant (Entrega 5, issue E5-4). Dos tenants con el
// mismo límite: SATURADO envía muchas más solicitudes de las que admite y
// VECINO envía pocas al mismo tiempo. Se espera que el saturado reciba 429
// con Retry-After y que el vecino no reciba ninguno: el límite es por
// tenant, no global.
//
// Uso (desde reserva-cupos), con dos tenants creados por el operador con
// límite 10/s y ráfaga 20 (lo hace el CI):
//   docker compose run --rm k6 run -e CLAVE_SATURADO=<clave> -e CLAVE_VECINO=<clave> /pruebas/carga/limite.js

import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const API_URL = __ENV.API_URL || "https://traefik";

const respuestas429 = new Counter("respuestas_429");
const reintentosTransporte = new Counter("reintentos_transporte");
const vecinoRechazado = new Counter("vecino_rechazado");

export const options = {
    scenarios: {
        saturado: {
            executor: "constant-vus",
            vus: 20,
            duration: "10s",
            exec: "saturado"
        },
        vecino: {
            executor: "constant-arrival-rate",
            rate: 2,
            timeUnit: "1s",
            duration: "10s",
            preAllocatedVUs: 2,
            exec: "vecino"
        }
    },
    thresholds: {
        // El saturado tiene que recibir 429 y el vecino ninguno.
        respuestas_429: ["count>0"],
        vecino_rechazado: ["count==0"],
        // Un 502/503/504 aislado del gateway se reintenta como haría un
        // cliente correcto, pero se cuenta: más de 5 en ~10.000 solicitudes
        // ya no es aislado y la prueba falla.
        reintentos_transporte: ["count<=5"],
        checks: ["rate==1"]
    }
};

// GET idempotente: ante un error de transporte del gateway (502, 503, 504 o
// sin respuesta) se reintenta hasta dos veces. En el CI apareció un 502
// aislado de Traefik, más o menos uno cada 10.000 solicitudes a 1.000 por
// segundo; no se reprodujo en local y su causa no quedó registrada. Lo que
// esta prueba mide es el aislamiento del límite entre tenants.
function feed(clave) {
    let respuesta;
    for (let intento = 0; intento < 3; intento++) {
        respuesta = http.get(`${API_URL}/v1/cambios?limite=1`, {
            headers: { Authorization: `Bearer ${clave}` }
        });
        if (![0, 502, 503, 504].includes(respuesta.status)) break;
        reintentosTransporte.add(1);
        console.warn(`reintento por HTTP ${respuesta.status} ${respuesta.error || ""}`);
    }
    return respuesta;
}

export function saturado() {
    const respuesta = feed(__ENV.CLAVE_SATURADO);

    if (respuesta.status === 429) respuestas429.add(1);

    if (respuesta.status !== 200 && respuesta.status !== 429) {
        console.warn(`saturado: HTTP ${respuesta.status} ${respuesta.error || ""} ${String(respuesta.body).slice(0, 160)}`);
    }

    check(respuesta, {
        "saturado: 200 o 429": r => r.status === 200 || r.status === 429,
        "429 trae Retry-After": r => r.status !== 429 || Number(r.headers["Retry-After"]) >= 1
    });
}

export function vecino() {
    const respuesta = feed(__ENV.CLAVE_VECINO);

    if (respuesta.status !== 200) {
        vecinoRechazado.add(1);
        console.warn(`vecino: HTTP ${respuesta.status} ${respuesta.error || ""} ${String(respuesta.body).slice(0, 160)}`);
    }

    check(respuesta, { "vecino: siempre 200": r => r.status === 200 });
}
