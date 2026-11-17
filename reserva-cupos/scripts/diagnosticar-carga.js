// Una sola terminal: observacion y carga simultaneas, con plazos y evidencia.
// No cambia pools, timeouts, replicas ni cantidad de workers.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { crearTenant } = require('../pruebas/comun');

const ejecutar = promisify(execFile);
const raiz = path.resolve(__dirname, '..');
const unaParticion = process.argv.includes('--una');
const compose = ['compose', '-f', 'docker-compose.yml',
    ...(unaParticion ? [] : ['-f', 'docker-compose.particiones.yml'])];
const corrida = new Date().toISOString().replace(/[:.]/g, '-');
const directorio = path.resolve(raiz, '../docs/entrega-6/evidencias', `diagnostico-${corrida}`);
const contenedor = `pdc-diagnostico-${Date.now()}`;
const duplicados = process.argv.includes('--duplicados');
const prueba = duplicados ? 'duplicados.js' : 'rafaga.js';
let clave = '';

function ocultar(texto) {
    return String(texto || '').replace(/rc_(?:admin_)?[a-f0-9]{64}/gi, '[CLAVE OCULTA]');
}

function guardar(nombre, contenido) {
    const normalizado = ocultar(contenido).replace(/[ \t]+$/gm, '').trimEnd() + '\n';
    fs.writeFileSync(path.join(directorio, nombre), normalizado, 'utf8');
}

async function docker(args, opciones = {}) {
    return ejecutar('docker', [...compose, ...args], {
        cwd: raiz, encoding: 'utf8', timeout: 15000,
        maxBuffer: 16 * 1024 * 1024, ...opciones
    });
}

async function sql(consulta) {
    // La clave root se expande dentro del contenedor, no se imprime.
    return docker(['exec', '-T', 'mysql-primary', 'sh', '-c',
        'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -B -e "$1"',
        'consulta', consulta]);
}

const esperas = `
SELECT PROCESSLIST_USER AS usuario, PROCESSLIST_STATE AS estado, COUNT(*) AS conexiones
FROM performance_schema.threads WHERE TYPE='FOREGROUND' AND PROCESSLIST_DB='reservas'
GROUP BY PROCESSLIST_USER, PROCESSLIST_STATE;
SELECT r.OBJECT_NAME AS tabla, r.INDEX_NAME AS indice,
r.LOCK_MODE AS solicitado, b.LOCK_MODE AS actual
FROM performance_schema.data_lock_waits w
JOIN performance_schema.data_locks r ON r.ENGINE=w.ENGINE AND r.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID
JOIN performance_schema.data_locks b ON b.ENGINE=w.ENGINE AND b.ENGINE_LOCK_ID=w.BLOCKING_ENGINE_LOCK_ID LIMIT 20;
SHOW GLOBAL STATUS LIKE 'Rpl_semi_sync_source%';`;

const acumulados = `SELECT LEFT(DIGEST_TEXT,180) AS consulta, COUNT_STAR AS ejecuciones,
SUM_TIMER_WAIT AS tiempo_ps, SUM_LOCK_TIME AS bloqueo_ps
FROM performance_schema.events_statements_summary_by_digest
WHERE SCHEMA_NAME='reservas' ORDER BY SUM_TIMER_WAIT DESC LIMIT 20;`;

async function main() {
    fs.mkdirSync(directorio, { recursive: true });
    console.log(`1/4 Verificando Docker y ${unaParticion ? 'un worker' : 'los cuatro workers'}...`);
    const { stdout: activos } = await docker(['ps', '--status', 'running', '--services']);
    const servicios = new Set(activos.trim().split(/\r?\n/));
    for (const servicio of ['api', 'relay', 'worker',
        ...(unaParticion ? [] : ['worker-p1', 'worker-p2', 'worker-p3'])]) {
        if (!servicios.has(servicio)) throw new Error(`No esta ejecutandose ${servicio}; no se inicia carga.`);
    }
    if (unaParticion && ['worker-p1', 'worker-p2', 'worker-p3'].some(s => servicios.has(s))) {
        throw new Error('Para N=1 deben estar detenidos los workers de las otras particiones.');
    }
    guardar('servicios.txt', activos);
    const tenant = await crearTenant(`Diagnostico automatico ${corrida}`, {
        limite: { por_segundo: 1000, rafaga: 1000 }
    });
    clave = tenant.clave_api;
    if (!/^rc_[a-f0-9]{64}$/i.test(clave || '')) throw new Error('El alta no devolvio una clave valida.');
    if (!/^[a-f0-9-]{36}$/i.test(tenant.id || '')) throw new Error('Identificador de tenant invalido.');
    guardar('antes.txt', (await sql(acumulados)).stdout);
    let terminado = false;
    let muestras = 0;
    console.log(`2/4 Ejecutando ${duplicados ? 'prueba de claves y participantes duplicados' : '500 solicitudes'} y tomando muestras (maximo 180 segundos)...`);
    // Primera muestra ANTES de arrancar k6, luego muestreo sin bloquear la carga.
    async function muestra() {
        try {
            const r = await sql(esperas);
            fs.appendFileSync(path.join(directorio, 'esperas.txt'),
                `\n${new Date().toISOString()}\n${ocultar(r.stdout)}`, 'utf8');
            muestras++;
        } catch (error) {
            fs.appendFileSync(path.join(directorio, 'esperas.txt'),
                `\nMuestra fallida: ${ocultar(error.stderr || error.message)}\n`, 'utf8');
        }
    }
    await muestra();
    const monitoreo = (async () => {
        while (!terminado) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            if (!terminado) await muestra();
        }
    })();
    let codigo = 0;
    try {
        const r = await docker(['run', '--rm', '--no-deps', '-T', '--name', contenedor,
            '-e', 'API_KEY', '-e', 'SOLICITUDES=500', '-e', 'CAPACIDAD=10',
            'k6', 'run', '--quiet', `/pruebas/carga/${prueba}`], {
            timeout: 180000, env: { ...process.env, API_KEY: clave }
        });
        guardar('k6.txt', r.stdout + '\n' + r.stderr);
    } catch (error) {
        codigo = typeof error.code === 'number' ? error.code : 1;
        guardar('k6.txt', (error.stdout || '') + '\n' + (error.stderr || '')
            + `\nCodigo: ${codigo}; timeout: ${Boolean(error.killed)}\n`);
    } finally {
        // Solo retira el contenedor creado por ESTA corrida si el plazo vencio.
        await ejecutar('docker', ['rm', '-f', contenedor], {
            cwd: raiz, timeout: 10000, encoding: 'utf8'
        }).catch(() => {});
        terminado = true;
        await monitoreo;
        clave = '';
    }
    console.log('3/4 Guardando tiempos y estado final de las reservas...');
    guardar('despues.txt', (await sql(acumulados)).stdout);
    guardar('reservas.txt', (await sql(`SELECT actividad_id, estado, COUNT(*) AS cantidad
FROM reservas.reservas WHERE tenant_id='${tenant.id}' GROUP BY actividad_id,estado;
SELECT id, capacidad, cupos_disponibles FROM reservas.actividades WHERE tenant_id='${tenant.id}';`)).stdout);
    guardar('resultado.txt', `Corrida: ${corrida}\nParticiones previstas: ${unaParticion ? 1 : 4}\nPrueba: ${prueba}\nTenant: ${tenant.id}\nMuestras: ${muestras}\nCodigo k6: ${codigo}\n`
        + 'El estado de la base es una instantanea; k6 conserva sus criterios originales.\n');
    console.log(`4/4 Terminado. Codigo k6: ${codigo}. Muestras: ${muestras}.`);
    console.log(`Archivos: ${directorio}`);
    process.exitCode = codigo === 0 ? 0 : 1;
}

main().catch(error => {
    const mensaje = ocultar(error.stderr || error.message);
    if (fs.existsSync(directorio)) guardar('error.txt', mensaje);
    console.error('No se completo el diagnostico:', mensaje);
    process.exitCode = 1;
});
