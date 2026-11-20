const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { api, crearTenant, esperarHasta, docker, ids, sql, guardar, metricas } = require('./util-e6');
const { pedir, API } = require('../comun');
const { resumir, grafico } = require('./estadistica');
const informe = { inicio: new Date().toISOString(), aprobada: false,
    parametros: { solicitudesPorCorrida: 100, capacidad: 10, repeticiones: 3,
        conexionesMaximas: 64, particiones: 4, timeoutClienteMs: 60000 }, corridas: [] };
let originales;
async function escalar(n) {
    await docker(['up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', '--scale', `api=${n}`, 'api']);
    await esperarHasta(async () => {
        const vistos = new Set();
        for (let i = 0; i < n * 8; i++) {
            const r = await pedir(`${API}/health`, { timeoutMs: 5000 });
            if (r.status === 200) vistos.add(r.datos.instancia);
        }
        return vistos.size === n;
    }, { plazoMs: 60000, descripcion: `descubrimiento de ${n} APIs` });
}
// Lotes de admisión de todas las APIs (histograma pdc_admision_lote_tamano,
// leído dentro de cada contenedor: el puerto de métricas no se publica).
// El agrupamiento es por proceso: con la misma carga, más instancias forman
// lotes más chicos y pagan más commits semisincrónicos.
async function lotes() {
    const total = { lotes: 0, admisiones: 0 };
    for (const id of await ids('api')) {
        const texto = await metricas('api', id);
        const valor = serie => Number(new RegExp(`^${serie}(?:\\{[^}]*\\})? (\\S+)$`, 'm').exec(texto)?.[1] || 0);
        total.lotes += valor('pdc_admision_lote_tamano_count');
        total.admisiones += valor('pdc_admision_lote_tamano_sum');
    }
    return total;
}
async function main() {
    originales = (await ids('api')).length;
    assert.ok(originales > 0, 'Iniciar el entorno antes de medir');
    for (const servicio of ['worker', 'worker-p1', 'worker-p2', 'worker-p3']) {
        assert.equal((await ids(servicio)).length, 1, `Se requiere un ${servicio} activo`);
    }
    assert.equal(Number(await sql("SELECT COUNT(*) FROM reservas WHERE estado='pendiente'")), 0, 'Esperar a que drene la corrida anterior');
    // Rotar el orden reduce el sesgo temporal; no elimina el ruido del host.
    const ordenes = [[1, 2, 4], [4, 1, 2], [2, 4, 1]];
    for (let repeticion = 0; repeticion < ordenes.length; repeticion++) {
        for (const n of ordenes[repeticion]) {
            console.log(`Corrida ${informe.corridas.length + 1}/9: ${n} API(s), repeticion ${repeticion + 1}...`);
            await escalar(n);
            const tenant = await crearTenant(`Curva POST ${n} ${Date.now()}`, { limite: { por_segundo: 1000, rafaga: 1000 } });
            const cliente = api(tenant.clave_api);
            // Calentar autenticación fuera de la ventana medida.
            for (let i = 0; i < n * 8; i++) assert.equal((await cliente('/v1/cambios?limite=1')).status, 200);
            const alta = await cliente('/v1/actividades', { metodo: 'POST', cuerpo: { nombre: 'Curva POST', capacidad: 10 } });
            assert.equal(alta.status, 201);
            const actividad = alta.datos.id, tiempos = [], instancias = new Set();
            const lotesAntes = await lotes();
            const inicio = performance.now();
            const respuestas = await Promise.allSettled(Array.from({ length: 100 }, async (_, i) => {
                const t = performance.now();
                const r = await cliente(`/v1/actividades/${actividad}/reservas`, {
                    metodo: 'POST', cuerpo: { participante: `curva-${i}` }, timeoutMs: 60000,
                    encabezados: { 'Idempotency-Key': `curva-${i}` }
                });
                tiempos.push(performance.now() - t);
                instancias.add(r.encabezados['x-instancia']);
                assert.equal(r.status, 202, `Admision HTTP ${r.status}`);
                assert.ok(r.encabezados.location, 'Falta Location');
            }));
            const duracionMs = performance.now() - inicio;
            const lotesDespues = await lotes();
            const errores = respuestas.filter(r => r.status === 'rejected');
            const corrida = { apis: n, repeticion: repeticion + 1, actividad, solicitudes: 100,
                duracionMs, errores: errores.map(e => e.reason.message), instanciasObservadas: [...instancias] };
            informe.corridas.push(corrida);
            assert.equal(errores.length, 0, 'La corrida tiene admisiones fallidas; no se usa para afirmar mejora');
            assert.equal(instancias.size, n, 'No se observaron todas las APIs durante la carga');
            tiempos.sort((a, b) => a - b);
            corrida.admisionesPorSegundo = 100 / (duracionMs / 1000);
            corrida.p95ClienteMs = tiempos[Math.ceil(tiempos.length * 0.95) - 1];
            corrida.lotes = lotesDespues.lotes - lotesAntes.lotes;
            corrida.admisionesEnLotes = lotesDespues.admisiones - lotesAntes.admisiones;
            assert.equal(corrida.admisionesEnLotes, 100, 'El histograma de lotes no contó las 100 admisiones');
            corrida.tamanoMedioLote = corrida.admisionesEnLotes / corrida.lotes;
            await esperarHasta(async () => Number(await sql(`SELECT COUNT(*) FROM reservas WHERE actividad_id='${actividad}' AND estado='pendiente'`)) === 0,
                { plazoMs: 180000, intervaloMs: 2000, descripcion: 'drenaje entre corridas' });
            const estados = await sql(`SELECT estado,COUNT(*) FROM reservas WHERE actividad_id='${actividad}' GROUP BY estado`);
            assert.match(estados, /confirmada\s+10(?:\r?\n|$)/);
            assert.match(estados, /rechazada\s+90(?:\r?\n|$)/);
            assert.equal(Number(await sql(`SELECT cupos_disponibles FROM actividades WHERE id='${actividad}'`)), 0);
            corrida.estados = estados;
            guardar('curva-admisiones/resultado.json', informe);
            console.log(`OK: ${corrida.admisionesPorSegundo.toFixed(2)} admisiones/s; p95 cliente ${corrida.p95ClienteMs.toFixed(0)} ms; ` +
                `${corrida.lotes} commits (lote medio ${corrida.tamanoMedioLote.toFixed(1)})`);
        }
    }
    informe.resumen = [1, 2, 4].map(n => {
        const casos = informe.corridas.filter(c => c.apis === n);
        return { apis: n, throughput: resumir(casos.map(c => c.admisionesPorSegundo)),
            p95: resumir(casos.map(c => c.p95ClienteMs)),
            commits: resumir(casos.map(c => c.lotes)),
            lote: resumir(casos.map(c => c.tamanoMedioLote)) };
    });
    const html = '<!doctype html><meta charset="utf-8"><title>Curva de admisiones E6</title>'
        + '<style>body{font:16px system-ui;max-width:1000px;margin:30px auto}svg{width:100%}</style>'
        + '<h1>Admisiones de reservas con 1, 2 y 4 APIs</h1>'
        + '<p>Tres corridas por configuracion; 100 POST por corrida, 64 conexiones maximas, cuatro workers constantes. Media y desvio muestral. Sin reintentos.</p>'
        + '<p>El tiempo del cliente incluye espera por conexion. El p95 de cada corrida no mezcla consultas de drenaje. La barra muestra media de esos p95, no el percentil de todas las corridas juntas.</p>'
        + grafico(informe.resumen, 'throughput', 'Admisiones/s: media +/- desvio')
        + grafico(informe.resumen, 'p95', 'p95 del cliente en ms: media +/- desvio')
        + grafico(informe.resumen, 'commits', 'Commits (lotes) para 100 admisiones: media +/- desvio')
        + grafico(informe.resumen, 'lote', 'Admisiones por commit: media +/- desvio')
        + '<p>Cada API agrupa sus admisiones en lotes de hasta 50 por commit, y cada commit espera la confirmacion semisincrona de la replica. El agrupamiento es por proceso: con la misma carga repartida entre mas instancias, cada una forma lotes mas chicos y el primario paga mas commits durables. Por eso agregar APIs no aumenta las admisiones por segundo: el cuello de botella es el commit del primario, no la CPU de la API.</p>'
        + '<p>La prueba caliente de 500 solicitudes se conserva por separado. Esta curva usa 100 por corrida; no debe presentarse como nueve rafagas de 500. Las APIs comparten primario, disco y Redis; no se exige ni se presupone mejora lineal.</p>';
    guardar('curva-admisiones/informe.html', html);
    informe.aprobada = true;
    console.log('OK: nueve corridas completas; JSON y HTML en evidencias/curva-admisiones/.');
}
main().catch(e => { informe.error = e.message; process.exitCode = 1; console.error('FALLO:', e.message); })
    .finally(async () => {
        if (originales) try { await escalar(originales); }
        catch (e) { informe.restauracion = e.message; informe.aprobada = false; process.exitCode = 1; }
        informe.fin = new Date().toISOString();
        guardar('curva-admisiones/resultado.json', informe);
    });
