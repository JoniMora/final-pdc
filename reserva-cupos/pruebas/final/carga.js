const assert = require('node:assert/strict');
const { crearTenant, docker, desdeApi, guardar, graficoSeries, sql, esperarHasta, esperar } = require('./util-e6');
const { leerResumen, htmlResumen } = require('./informe-carga');
const escenario = process.argv[2] || 'caliente';
if (!['caliente', 'multitenant', 'rampa'].includes(escenario)) {
    console.error('Escenario: caliente | multitenant | rampa'); process.exit(1);
}
const informe = { escenario, inicio: new Date().toISOString(), aprobada: false };
const extra = ['-f', 'docker-compose.pruebas-e6.yml'];
let restaurar = false;
async function control(cuerpo) {
    return JSON.parse(await desdeApi('https://receptor-pruebas:3443/control', {
        method: cuerpo ? 'POST' : 'GET', headers: { Authorization: 'Bearer e6_control_local', 'Content-Type': 'application/json' },
        ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {})
    }));
}
async function main() {
    restaurar = true;
    await docker(['up', '-d', '--build', '--no-deps', '--force-recreate', 'receptor-pruebas', 'notificador'], { extra });
    await esperarHasta(async () => { try { await control({ fallar: false }); return true; } catch (_) { return false; } },
        { plazoMs: 30000, descripcion: 'receptor HTTPS para medir demora de webhooks' });
    const tenants = [];
    for (let i = 0; i < (escenario === 'caliente' ? 1 : 4); i++) {
        const t = await crearTenant(`Carga ${escenario} ${i} ${Date.now()}`, {
            limite: { por_segundo: 1000, rafaga: 1000 }, webhook_url: `https://receptor-pruebas:3443/webhook/t${i}` });
        await control({ fallar: false, clave: `t${i}`, secreto: t.webhook_secreto });
        tenants.push({ id: t.id, clave: t.clave_api });
    }
    const env = { ...process.env, API_KEY: tenants[0].clave,
        TENANTS_JSON: JSON.stringify(tenants), RAMPA: escenario === 'rampa' ? '1' : '0' };
    console.log(`Ejecutando ${escenario}: guardar evidencia sin imprimir claves...`);
    const inicio = Date.now();
    let salida;
    try {
        const r = await docker(['run', '--rm', '--no-deps', '-T', '-e', 'API_KEY', '-e', 'TENANTS_JSON',
            '-e', 'RAMPA', 'k6', 'run', '--quiet', `/pruebas/carga/${escenario === 'caliente' ? 'rafaga.js' : 'multitenant.js'}`],
            { env, timeout: 420000 });
        salida = r.stdout;
        guardar(`carga-${escenario}/k6.txt`, r.stdout + '\n' + r.stderr);
    } catch (e) {
        guardar(`carga-${escenario}/k6.txt`, (e.stdout || '') + '\n' + (e.stderr || e.message));
        // Capturar antes de restaurar servicios: conserva la causa de esta corrida.
        try {
            const logs = await docker(['logs', '--since', informe.inicio, '--tail', '150', '--no-color',
                'api', 'redis', 'traefik', 'mysql-primary', 'mysql-replica', 'relay',
                'worker', 'worker-p1', 'worker-p2', 'worker-p3', 'notificador'], { timeout: 30000 });
            guardar(`carga-${escenario}/servicios.txt`, logs.stdout + '\n' + logs.stderr);
        } catch (diagnostico) { informe.errorDiagnostico = diagnostico.message; }
        throw e;
    }
    const resumen = leerResumen(salida);
    informe.k6 = resumen;
    const consulta = `SELECT tenant_id,actividad_id,estado,COUNT(*) AS cantidad FROM reservas
        WHERE tenant_id IN (${tenants.map(t => `'${t.id}'`).join(',')}) GROUP BY tenant_id,actividad_id,estado;`;
    informe.reservas = await sql(consulta);
    const filtroTenants = tenants.map(t => `'${t.id}'`).join(',');
    await esperarHasta(async () => {
        const cantidad = Number(await sql(`SELECT COUNT(*) FROM reservas WHERE tenant_id IN (${filtroTenants})`));
        return cantidad > 0 && (await control()).entregas.length === cantidad;
    }, { plazoMs: 180000, descripcion: 'webhooks entregados por cada reserva decidida' });
    informe.receptor = await control();
    await esperar(6000); // dejar que Prometheus capture la última entrega
    guardar(`carga-${escenario}/resumen.json`, resumen);
    let graficos = '';
    try {
        const consultas = [
            ['Admisiones HTTP 202 por segundo', 'sum(rate(pdc_http_solicitudes_total{servicio="api",metodo="POST",estado="202"}[30s]))'],
            ['p95 de admision en segundos', 'histogram_quantile(0.95,sum by(le)(rate(pdc_http_duracion_segundos_bucket{servicio="api",metodo="POST",ruta=~".*/reservas",estado="202"}[30s])))'],
            ['Mensajes por cola', 'sum by(queue)(rabbitmq_queue_messages)'],
            ['p95 de demora de webhook en segundos', 'histogram_quantile(0.95,sum by(le)(rate(pdc_webhook_demora_segundos_bucket[30s])))']
        ];
        for (const [titulo, consultaProm] of consultas) {
            const p = new URLSearchParams({ query: consultaProm, start: String(inicio / 1000), end: String(Date.now() / 1000), step: '5' });
            const respuesta = JSON.parse(await desdeApi(`https://prometheus:9090/api/v1/query_range?${p}`));
            assert.equal(respuesta.status, 'success');
            assert.ok(respuesta.data.result.some(s => s.values.length), `Sin muestras: ${titulo}`);
            informe[titulo] = respuesta.data.result;
            graficos += `<h2>${titulo}</h2>${graficoSeries(respuesta.data.result)}`;
        }
    } catch (e) { informe.graficosPendientes = e.message; }
    guardar(`carga-${escenario}/informe.html`, htmlResumen(`E6: ${escenario}`, resumen, graficos));
    if (informe.graficosPendientes) throw new Error(`Graficos pendientes: ${informe.graficosPendientes}`);
    informe.aprobada = true;
    console.log(`OK: ${escenario}. Reporte HTML y JSON en docs/entrega-6/evidencias/carga-${escenario}/`);
    if (informe.graficosPendientes) console.log('ATENCION: faltan datos de Prometheus para los graficos.');
}
main().catch(e => { informe.error = e.message; process.exitCode = 1; console.error('FALLO:', e.message); })
    .finally(async () => {
        if (restaurar) try {
            await docker(['up', '-d', '--no-deps', '--force-recreate', 'notificador']);
            await docker(['stop', 'receptor-pruebas'], { extra });
            await docker(['rm', '-f', 'receptor-pruebas'], { extra });
        } catch (e) { informe.restauracion = e.message; informe.aprobada = false; process.exitCode = 1; }
        guardar(`carga-${escenario}/resultado.json`, informe);
    });
