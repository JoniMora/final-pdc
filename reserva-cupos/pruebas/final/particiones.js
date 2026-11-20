// Misma carga para N=1 y N=4. No inicia ni detiene servicios.
// Orden comprobado: orden de registro de comandos en outbox frente al de
// decisiones persistidas, para cada actividad y con la topología estable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { performance } = require('node:perf_hooks');
const { RAIZ, api, crearTenant, esperar } = require('../comun');

const ejecutar = promisify(execFile);
const n = Number(process.argv[2]);
if (![1, 4].includes(n)) {
    console.error('Uso: node reserva-cupos/pruebas/final/particiones.js 1 (o 4)');
    process.exit(1);
}
const actividades = 8;
const porActividad = 40;
const capacidad = 10;
const total = actividades * porActividad;
const argumentos = ['compose', '-f', 'docker-compose.yml',
    ...(n === 4 ? ['-f', 'docker-compose.particiones.yml'] : [])];
const carpeta = path.resolve(RAIZ, '../docs/entrega-6/evidencias');
const informe = { particiones: n, fecha: new Date().toISOString(), actividades,
    porActividad, capacidad, total, conexionesHttpMaximas: 64, comprobaciones: [], aprobada: false };
const { createHash } = require('node:crypto');
informe.codigoPrueba = createHash('sha256').update([
    __filename, path.resolve(RAIZ, 'servicios/api/src/server.js'),
    path.resolve(RAIZ, 'servicios/api/src/admisiones.js'),
    path.resolve(RAIZ, 'servicios/worker/src/main.js')
].map(archivo => fs.readFileSync(archivo, 'utf8')).join('\n')).digest('hex');

async function docker(args) {
    return ejecutar('docker', [...argumentos, ...args], {
        cwd: RAIZ, encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024
    });
}
async function sql(consulta) {
    const r = await docker(['exec', '-T', 'mysql-primary', 'sh', '-c',
        'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -B reservas -e "$1"', 'consulta', consulta]);
    return r.stdout.trim();
}
function ok(texto) {
    informe.comprobaciones.push(texto);
    console.log(`OK: ${texto}`);
}
function filas(texto) {
    return texto.trim().split(/\r?\n/).filter(Boolean).map(linea => linea.trim().split(/\s+/));
}

async function main() {
    console.log(`1/4 Verificando ${n} particion(es), enlaces y consumidores...`);
    const enlaces = filas((await docker(['exec', '-T', 'rabbitmq', 'rabbitmqctl', '-q',
        'list_bindings', 'source_name', 'destination_name', 'routing_key'])).stdout)
        .filter(f => f[0] === 'reservas.comandos');
    assert.deepEqual(enlaces.map(f => f[1]).sort(),
        Array.from({ length: n }, (_, i) => `reservas.comandos.${i}`).sort(), 'Enlaces incorrectos');
    assert.ok(enlaces.every(f => f[2] === '1'), 'Todos los enlaces deben tener peso 1');
    const colas = filas((await docker(['exec', '-T', 'rabbitmq', 'rabbitmqctl', '-q',
        'list_queues', 'name', 'messages', 'consumers'])).stdout);
    for (let i = 0; i < 4; i++) {
        const fila = colas.find(f => f[0] === `reservas.comandos.${i}`);
        if (i < n) assert.ok(fila, `Falta cola ${i}`);
        if (fila) {
            assert.equal(Number(fila[1]), 0, `Hay comandos anteriores en cola ${i}`);
            assert.equal(Number(fila[2]), i < n ? 1 : 0, `Consumidores inesperados en cola ${i}`);
        }
    }
    assert.equal(Number(await sql("SELECT COUNT(*) FROM reservas WHERE estado='pendiente'")), 0,
        'Terminar las reservas anteriores antes de comparar');
    ok('Topologia estable y un consumidor por particion, sin comandos anteriores');

    const tenant = await crearTenant(`E6 multi N${n} ${Date.now()}`, {
        limite: { por_segundo: 1000, rafaga: 1000 }
    });
    assert.match(tenant.id, /^[a-f0-9-]{36}$/i);
    const pedir = api(tenant.clave_api);
    const ids = [];
    for (let i = 0; i < actividades; i++) {
        const r = await pedir('/v1/actividades', { metodo: 'POST',
            cuerpo: { nombre: `Multi N${n} actividad ${i}`, capacidad } });
        assert.equal(r.status, 201, `Crear actividad: HTTP ${r.status}`);
        ids.push(r.datos.id);
    }
    console.log(`2/4 Admitiendo ${total} solicitudes sobre ${actividades} actividades...`);
    const inicio = performance.now();
    const duraciones = [];
    // Intercalado: todas las actividades compiten durante el mismo intervalo.
    const solicitudes = [];
    for (let vuelta = 0; vuelta < porActividad; vuelta++) {
        for (let actividad = 0; actividad < actividades; actividad++) {
            solicitudes.push((async () => {
                const desde = performance.now();
                const r = await pedir(`/v1/actividades/${ids[actividad]}/reservas`, {
                    metodo: 'POST', cuerpo: { participante: `participante-${vuelta}` },
                    encabezados: { 'Idempotency-Key': `multi-${actividad}-${vuelta}` }
                });
                duraciones.push(performance.now() - desde);
                assert.equal(r.status, 202, `Admision: HTTP ${r.status}`);
                assert.ok(r.encabezados.location, 'Falta Location');
            })());
        }
    }
    const respuestas = await Promise.allSettled(solicitudes);
    const fallo = respuestas.find(r => r.status === 'rejected');
    if (fallo) throw fallo.reason;
    informe.admisionMs = performance.now() - inicio;
    duraciones.sort((a, b) => a - b);
    informe.p95AdmisionClienteMs = duraciones[Math.ceil(duraciones.length * 0.95) - 1];
    ok(`${total} admisiones con HTTP 202 y Location`);

    console.log('3/4 Esperando decisiones y comprobando orden (hasta 180 segundos)...');
    const limite = performance.now() + 180000;
    while (true) {
        const [cantidad, pendientes] = (await sql(`SELECT COUNT(*), COALESCE(SUM(estado='pendiente'),0)
            FROM reservas WHERE tenant_id='${tenant.id}'`)).split(/\s+/).map(Number);
        if (cantidad === total && pendientes === 0) break;
        if (performance.now() >= limite) throw new Error('Quedaron decisiones pendientes despues de 180 segundos');
        await esperar(1000);
    }
    informe.tiempoTotalMs = performance.now() - inicio;
    informe.decisionesPorSegundo = total / (informe.tiempoTotalMs / 1000);
    const estados = filas(await sql(`SELECT actividad_id, estado, COUNT(*) FROM reservas
        WHERE tenant_id='${tenant.id}' GROUP BY actividad_id,estado`));
    for (const id of ids) {
        assert.equal(Number(estados.find(f => f[0] === id && f[1] === 'confirmada')?.[2]), capacidad);
        assert.equal(Number(estados.find(f => f[0] === id && f[1] === 'rechazada')?.[2]), porActividad - capacidad);
    }
    const cupos = filas(await sql(`SELECT id,cupos_disponibles FROM actividades WHERE tenant_id='${tenant.id}'`));
    assert.ok(cupos.length === actividades && cupos.every(f => Number(f[1]) === 0));
    ok('Cada actividad termina con 10 confirmadas, 30 rechazadas y cero cupos disponibles');
    const cambios = filas(await sql(`SELECT entidad_id,
        JSON_UNQUOTE(JSON_EXTRACT(snapshot,'$.actividad_id')), tipo FROM cambios
        WHERE tenant_id='${tenant.id}' AND tipo IN
        ('reserva.solicitada','reserva.confirmada','reserva.rechazada') ORDER BY id`));
    for (const id of ids) {
        const deActividad = cambios.filter(f => f[1] === id);
        const comandos = deActividad.filter(f => f[2] === 'reserva.solicitada').map(f => f[0]);
        const decisiones = deActividad.filter(f => f[2] !== 'reserva.solicitada');
        assert.equal(comandos.length, porActividad);
        assert.deepEqual(decisiones.map(f => f[0]), comandos, `Orden alterado en actividad ${id}`);
        assert.ok(decisiones.slice(0, capacidad).every(f => f[2] === 'reserva.confirmada'));
    }
    ok('Orden de decisiones coincide con el registro de comandos dentro de cada actividad');
    informe.aprobada = true;
    console.log(`4/4 Terminado N=${n}: ${informe.decisionesPorSegundo.toFixed(2)} decisiones/s; `
        + `p95 cliente ${informe.p95AdmisionClienteMs.toFixed(0)} ms.`);
    if (n === 4) {
        const anterior = path.join(carpeta, 'multi-particiones-n1.json');
        if (fs.existsSync(anterior)) {
            const base = JSON.parse(fs.readFileSync(anterior, 'utf8'));
            if (base.aprobada && base.total === total && base.actividades === actividades
                && base.codigoPrueba === informe.codigoPrueba && !process.env.CI) {
                informe.comparacion = { referencia: base.fecha,
                    factor: informe.decisionesPorSegundo / base.decisionesPorSegundo };
                informe.mejoraObservada = informe.comparacion.factor > 1;
                console.log(`Comparacion N4/N1: ${informe.comparacion.factor.toFixed(2)}x. `
                    + (informe.mejoraObservada ? 'Hay mejora observada.' : 'No se demostro mejora: investigar cuello de botella.'));
            } else {
                informe.comparacionPendiente = 'Repetir N=1 y N=4 con el mismo codigo y en el mismo entorno; no comparar con evidencia historica o de otro runner CI';
                console.log(informe.comparacionPendiente);
            }
        }
    }
}

main().catch(error => {
    informe.error = String(error.stderr || error.message).replace(/rc_(?:admin_)?[a-f0-9]{64}/gi, '[CLAVE OCULTA]');
    console.error('FALLO:', informe.error);
    process.exitCode = 1;
}).finally(() => {
    fs.mkdirSync(carpeta, { recursive: true });
    const archivo = path.join(carpeta, `multi-particiones-n${n}.json`);
    fs.writeFileSync(archivo, JSON.stringify(informe, null, 2) + '\n', 'utf8');
    console.log(`Evidencia: ${archivo}`);
});
