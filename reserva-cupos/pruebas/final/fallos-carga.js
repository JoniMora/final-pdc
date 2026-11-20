const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { RAIZ, crearTenant, docker, directo, ids, sql, esperar, esperarHasta,
    desdeApi, guardar, graficoSeries } = require('./util-e6');
const { leerResumen, htmlResumen } = require('./informe-carga');
const informe = { inicio: new Date().toISOString(), aprobada: false, eventos: [] };
let originales, apiDetenida, workerDetenido, actividad;
const contenedorK6 = `pdc-fallos-e6-${Date.now()}`;
function evento(tipo) { const e = { tipo, ms: Date.now() }; informe.eventos.push(e); console.log(`${new Date(e.ms).toISOString()} ${tipo}`); }
async function main() {
    originales = (await ids('api')).length;
    assert.ok(originales > 0);
    await docker(['up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', '--scale', 'api=4', 'api'],
        { extra: ['-f', 'docker-compose.fallos-e6.yml'] });
    await esperar(6000);
    assert.equal(Number(await sql("SELECT COUNT(*) FROM reservas WHERE estado='pendiente'")), 0, 'Drenar carga anterior primero');
    const colasAntes = (await docker(['exec', '-T', 'rabbitmq', 'rabbitmqctl', '-q', 'list_queues', 'name', 'messages'])).stdout;
    assert.ok(!/^reservas\.comandos\.\d+\s+[1-9]\d*/m.test(colasAntes), 'Drenar colas de comandos anteriores primero');
    const tenant = await crearTenant(`Fallos E6 ${Date.now()}`, { limite: { por_segundo: 1000, rafaga: 1000 } });
    informe.tenant = tenant.id;
    const inicio = Date.now();
    console.log('Rafaga con reintentos de la MISMA clave; se detendra una API y el worker de la actividad...');
    const proceso = spawn('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.particiones.yml',
        'run', '--rm', '--no-deps', '-T', '--name', contenedorK6, '-e', 'API_KEY', '-e', 'REINTENTOS=8', '-e', 'FALLOS=1',
        'k6', 'run', '--quiet', '/pruebas/carga/rafaga.js'], {
        cwd: RAIZ, env: { ...process.env, API_KEY: tenant.clave_api }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let salida = '', errores = '', lanzada = false, terminado = false, codigoFinal;
    const final = new Promise((resolve, reject) => {
        proceso.on('error', reject);
        proceso.on('close', codigo => { terminado = true; codigoFinal = codigo; resolve(codigo); });
    });
    final.catch(() => {}); // el error se recoge al esperar el proceso; no queda rechazo huérfano.
    const tomar = texto => {
        const m = /PDC_CARGA_INICIADA:([a-f0-9-]{36})/.exec(texto);
        if (m) { actividad = m[1]; lanzada = true; }
    };
    proceso.stdout.on('data', b => { salida += b; tomar(salida); });
    proceso.stderr.on('data', b => { errores += b; tomar(errores); });
    // Evita trabajos infinitos y limpia también el contenedor si se agota plazo.
    const timer = setTimeout(() => proceso.kill(), 480000);
    try {
        await esperarHasta(() => {
            if (terminado && !lanzada) throw new Error(`k6 termino antes de iniciar la rafaga (codigo ${codigoFinal}). Ver fallos-bajo-carga/k6.txt`);
            return lanzada;
        }, { plazoMs: 90000, intervaloMs: 100, descripcion: 'inicio real de la rafaga' });
        apiDetenida = (await ids('api'))[0];
        evento('detener_api');
        await directo(['stop', '-t', '1', apiDetenida]);
        await esperarHasta(async () => {
            const filas = (await docker(['exec', '-T', 'rabbitmq', 'rabbitmqctl', '-q', 'list_queues', 'name', 'messages'])).stdout;
            const m = /^reservas\.comandos\.(\d+)\s+([1-9]\d*)/m.exec(filas);
            if (!m) return false;
            workerDetenido = Number(m[1]) === 0 ? 'worker' : `worker-p${m[1]}`;
            return true;
        }, { plazoMs: 30000, intervaloMs: 500, descripcion: 'cola con comandos en procesamiento' });
        evento(`detener_${workerDetenido}`);
        await docker(['stop', '-t', '1', workerDetenido]);
        await esperar(3000);
        await docker(['start', workerDetenido]);
        evento(`recuperar_${workerDetenido}`);
        await directo(['start', apiDetenida]);
        evento('recuperar_api');
        const codigo = await final;
        guardar('fallos-bajo-carga/k6.txt', salida + '\n' + errores);
        assert.equal(codigo, 0, `k6 termino con codigo ${codigo}`);
        const resumen = leerResumen(salida);
        const estados = await sql(`SELECT estado,COUNT(*) FROM reservas WHERE actividad_id='${actividad}' GROUP BY estado`);
        informe.estados = estados;
        assert.match(estados, /confirmada\s+10(?:\r?\n|$)/);
        assert.match(estados, /rechazada\s+490(?:\r?\n|$)/);
        assert.ok(!/pendiente\s+[1-9]/.test(estados));
        const duplicadas = Number(await sql(`SELECT COUNT(*) FROM (
            SELECT participante_id FROM reservas WHERE actividad_id='${actividad}' GROUP BY participante_id HAVING COUNT(*)>1) d`));
        const negativos = Number(await sql(`SELECT COUNT(*) FROM actividades WHERE id='${actividad}' AND cupos_disponibles<0`));
        assert.equal(duplicadas, 0); assert.equal(negativos, 0);
        informe.invariantes = { confirmadas: 10, rechazadas: 490, duplicadas, cuposNegativos: negativos };
        const p = new URLSearchParams({ query: 'sum(rate(pdc_http_solicitudes_total{servicio="api",metodo="POST",estado=~"200|202"}[30s]))',
            start: String(inicio / 1000), end: String(Date.now() / 1000), step: '5' });
        const series = JSON.parse(await desdeApi(`https://prometheus:9090/api/v1/query_range?${p}`));
        assert.equal(series.status, 'success');
        assert.ok(series.data.result.some(s => s.values.length > 0), 'Sin muestras para graficar la falla');
        informe.prometheus = series.data.result;
        guardar('fallos-bajo-carga/informe.html', htmlResumen('E6: fallos bajo carga', resumen,
            '<h2>Admisiones/s y momentos de detencion y recuperacion</h2>' + graficoSeries(series.data.result, informe.eventos)));
        informe.aprobada = true;
        console.log('OK: 10 confirmadas, 490 rechazadas, cero duplicadas y cupos no negativos.');
    } finally {
        clearTimeout(timer);
        if (proceso.exitCode === null) proceso.kill();
        await directo(['rm', '-f', contenedorK6]).catch(() => {});
        guardar('fallos-bajo-carga/k6.txt', salida + '\n' + errores);
    }
}
main().catch(e => { informe.error = e.message; process.exitCode = 1; console.error('FALLO:', e.message); })
    .finally(async () => {
        try {
            if (apiDetenida) await directo(['start', apiDetenida]);
            if (workerDetenido) await docker(['start', workerDetenido]);
            if (originales) await docker(['up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', '--scale', `api=${originales}`, 'api']);
        } catch (e) { informe.restauracion = e.message; informe.aprobada = false; process.exitCode = 1; }
        guardar('fallos-bajo-carga/resultado.json', informe);
    });
