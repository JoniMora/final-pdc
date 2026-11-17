import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';
import { salidaResumen } from './resumen.js';
export const handleSummary = salidaResumen;
const base = __ENV.API_URL || 'https://traefik';
const rampa = __ENV.RAMPA === '1';
const admitidas = new Counter('reservas_admitidas');
const estados = new Counter('admisiones_estado');
const latencia = new Trend('admision_ms', true);
export const options = {
    scenarios: rampa ? { rampa: { executor: 'ramping-arrival-rate', startRate: 0, timeUnit: '1s',
        preAllocatedVUs: 50, maxVUs: 250,
        stages: [5, 10, 20, 40, 80, 0].map(target => ({ target, duration: '5s' })) } }
        : { multi: { executor: 'shared-iterations', vus: 80, iterations: 400, maxDuration: '120s' } },
    setupTimeout: '60s', teardownTimeout: '210s',
    thresholds: { checks: ['rate==1'], reservas_admitidas: ['count>0'] },
    summaryTrendStats: ['avg', 'p(95)', 'max']
};
function opciones(clave) { return { headers: { Authorization: `Bearer ${clave}`, 'Content-Type': 'application/json' } }; }
export function setup() {
    const tenants = JSON.parse(__ENV.TENANTS_JSON || '[]');
    if (tenants.length < 2) exec.test.abort('Preparar al menos dos tenants con el runner de E6');
    const casos = [];
    for (const tenant of tenants) for (let i = 0; i < 2; i++) {
        const r = http.post(`${base}/v1/actividades`, JSON.stringify({ nombre: `E6 multi ${Date.now()} ${i}`, capacidad: 10 }), opciones(tenant.clave));
        if (r.status !== 201) exec.test.abort(`Crear actividad: HTTP ${r.status}`);
        casos.push({ clave: tenant.clave, id: r.json('id') });
    }
    return { casos, corrida: Date.now() };
}
export default function(datos) {
    const n = exec.scenario.iterationInTest;
    const caso = datos.casos[n % datos.casos.length];
    const o = opciones(caso.clave);
    o.headers['Idempotency-Key'] = `multi-${datos.corrida}-${n}`;
    const r = http.post(`${base}/v1/actividades/${caso.id}/reservas`,
        JSON.stringify({ participante: `multi-${n}` }), o);
    latencia.add(r.timings.duration);
    estados.add(1, { estado: String(r.status) });
    if (r.status === 202) admitidas.add(1);
    check(r, { 'respuesta de admision coherente': x => rampa
        ? [202, 429, 502, 503, 504].includes(x.status) : x.status === 202 });
}
export function teardown(datos) {
    const inicio = Date.now();
    for (;;) {
        let pendientes = 0;
        for (const caso of datos.casos) {
            const r = http.get(`${base}/v1/actividades/${caso.id}/reservas?estado=pendiente&limite=1`, opciones(caso.clave));
            if (r.status !== 200) throw Error(`Consultar pendientes: HTTP ${r.status}`);
            pendientes += r.json('datos').length;
        }
        if (!pendientes) break;
        if (Date.now() - inicio > 180000) throw Error('Hay decisiones pendientes despues de 180 segundos');
        sleep(1);
    }
    for (const caso of datos.casos) {
        const r = http.get(`${base}/v1/actividades/${caso.id}`, opciones(caso.clave));
        check(r, { 'cupos nunca negativos': x => x.status === 200 && x.json('cupos_disponibles') >= 0 });
    }
}
