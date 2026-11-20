// Bajar de 4 a 1 partición sin dejar comandos varados (issue #46).
//
// Con el entorno de cuatro particiones levantado (verificar-e6.js levantar):
//   1. detiene los workers de las particiones 1 a 3;
//   2. admite 40 reservas en 8 actividades: los comandos de las actividades
//      que caen en las particiones 1 a 3 quedan esperando en sus colas;
//   3. recrea el relay con una partición (el Compose base). Al arrancar,
//      configurar-colas desenlaza las colas 1 a 3 y reenvía sus comandos al
//      exchange, que ahora los manda a la partición 0;
//   4. exige que el worker de la partición 0 decida las 40 reservas y que
//      solo quede enlazada la cola 0.
//
// Deja el entorno con una partición (para `particiones.js 1`). Para volver a
// cuatro: verificar-e6.js levantar.
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { RAIZ, api, crearTenant, esperarHasta, docker, sql, guardar } = require('./util-e6');

const ejecutar = promisify(execFile);
const ACTIVIDADES = 8;
const POR_ACTIVIDAD = 5;
const TOTAL = ACTIVIDADES * POR_ACTIVIDAD;
const informe = { inicio: new Date().toISOString(), actividades: ACTIVIDADES, porActividad: POR_ACTIVIDAD,
    comprobaciones: [], aprobada: false };

function ok(texto) {
    informe.comprobaciones.push(texto);
    console.log(`OK: ${texto}`);
}

async function rabbit(...args) {
    const { stdout } = await docker(['exec', '-T', 'rabbitmq', 'rabbitmqctl', '-q', ...args]);
    return stdout.trim().split(/\r?\n/).filter(Boolean).map(linea => linea.trim().split(/\s+/));
}

async function mensajes() {
    const filas = await rabbit('list_queues', 'name', 'messages');
    return Object.fromEntries(filas.filter(([nombre]) => /^reservas\.comandos\.\d+$/.test(nombre))
        .map(([nombre, n]) => [nombre, Number(n)]));
}

async function enlaces() {
    return (await rabbit('list_bindings', 'source_name', 'destination_name'))
        .filter(([origen]) => origen === 'reservas.comandos').map(([, destino]) => destino).sort();
}

async function main() {
    assert.deepEqual(await enlaces(), ['reservas.comandos.0', 'reservas.comandos.1',
        'reservas.comandos.2', 'reservas.comandos.3'], 'Levantar antes el entorno de cuatro particiones');

    await docker(['stop', 'worker-p1', 'worker-p2', 'worker-p3']);
    ok('Workers de las particiones 1 a 3 detenidos');

    const tenant = await crearTenant(`Reducción de particiones ${Date.now()}`, { limite: { por_segundo: 1000, rafaga: 1000 } });
    const cliente = api(tenant.clave_api);
    const actividades = [];

    for (let a = 0; a < ACTIVIDADES; a++) {
        const alta = await cliente('/v1/actividades', { metodo: 'POST', cuerpo: { nombre: `Reducción ${a}`, capacidad: 10 } });
        assert.equal(alta.status, 201);
        actividades.push(alta.datos.id);

        for (let i = 0; i < POR_ACTIVIDAD; i++) {
            const r = await cliente(`/v1/actividades/${alta.datos.id}/reservas`, {
                metodo: 'POST', cuerpo: { participante: `p-${a}-${i}` },
                encabezados: { 'Idempotency-Key': `reduccion-${a}-${i}` }
            });
            assert.equal(r.status, 202);
        }
    }

    const lista = actividades.map(id => `'${id}'`).join(',');
    const pendientes = async () => Number(await sql(
        `SELECT COUNT(*) FROM reservas WHERE actividad_id IN (${lista}) AND estado = 'pendiente'`));

    // Lo de la partición 0 se decide; lo de 1 a 3 queda en sus colas.
    const antes = await esperarHasta(async () => {
        const colas = await mensajes();
        const varados = colas['reservas.comandos.1'] + colas['reservas.comandos.2'] + colas['reservas.comandos.3'];
        const quedan = await pendientes();
        return colas['reservas.comandos.0'] === 0 && varados > 0 && quedan === varados ? { colas, varados } : null;
    }, { plazoMs: 120000, intervaloMs: 1000, descripcion: 'comandos esperando en las particiones 1 a 3' });
    informe.antes = antes.colas;
    ok(`${antes.varados} de ${TOTAL} comandos esperan en las particiones 1 a 3 sin consumidor`);

    // El Compose base no fija COMANDOS_PARTICIONES: el relay arranca con 1.
    await ejecutar('docker', ['compose', '-f', 'docker-compose.yml', 'up', '-d', '--no-deps', '--wait', 'relay'],
        { cwd: RAIZ, encoding: 'utf8', timeout: 180000 });
    ok('Relay recreado con una partición');

    const registros = await esperarHasta(async () => {
        const { stdout } = await docker(['logs', '--since', '5m', 'relay']);
        const lineas = stdout.split(/\r?\n/).filter(l => l.includes('[colas]'));
        return lineas.some(l => l.includes('Topología de RabbitMQ configurada')) ? lineas : null;
    }, { plazoMs: 60000, descripcion: 'la configuración de colas del relay' });
    informe.relay = registros;

    const movidos = registros.map(l => /(\d+) comandos reenviados/.exec(l)).filter(Boolean)
        .reduce((total, m) => total + Number(m[1]), 0);
    assert.equal(movidos, antes.varados, 'El relay no reenvió todos los comandos varados');
    ok(`El relay desenlazó las colas 1 a 3 y reenvió ${movidos} comandos al exchange`);

    assert.deepEqual(await enlaces(), ['reservas.comandos.0']);
    ok('Solo queda enlazada reservas.comandos.0');

    await esperarHasta(async () => await pendientes() === 0,
        { plazoMs: 120000, intervaloMs: 1000, descripcion: 'que el worker de la partición 0 decida todo' });
    const confirmadas = Number(await sql(
        `SELECT COUNT(*) FROM reservas WHERE actividad_id IN (${lista}) AND estado = 'confirmada'`));
    assert.equal(confirmadas, TOTAL);
    informe.despues = await mensajes();
    assert.equal(informe.despues['reservas.comandos.1'] + informe.despues['reservas.comandos.2']
        + informe.despues['reservas.comandos.3'], 0);
    ok(`Las ${TOTAL} reservas quedaron confirmadas; ningún comando varado`);

    informe.aprobada = true;
}

main().catch(error => { informe.error = error.message; process.exitCode = 1; console.error('FALLO:', error.message); })
    .finally(() => {
        informe.fin = new Date().toISOString();
        guardar('particiones-reduccion.json', informe);
    });
