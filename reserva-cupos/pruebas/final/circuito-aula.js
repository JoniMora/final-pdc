const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { api, docker, sql, metricas, guardar, esperarHasta } = require('./util-e6');
const { claveAula, sesionAula, aula } = require('../comun');
const informe = { inicio: new Date().toISOString(), aprobada: false, eventos: [] };
let restaurarAula = false;
function evento(tipo) { informe.eventos.push({ tipo, instante: new Date().toISOString() }); console.log(tipo); }
async function logsNotificador() {
    const r = await docker(['logs', '--since', informe.inicio, '--no-color', 'notificador'], { timeout: 15000 });
    return r.stdout + '\n' + r.stderr;
}
async function main() {
    assert.equal(Number(await sql("SELECT COUNT(*) FROM reservas WHERE estado='pendiente'")), 0, 'Esperar drenaje de la prueba anterior');
    const clave = claveAula();
    const hash = crypto.createHash('sha256').update(clave).digest('hex');
    const tenant = await sql(`SELECT id FROM tenants WHERE api_key_hash=UNHEX('${hash}') AND activo=TRUE`);
    assert.match(tenant, /^[a-f0-9-]{36}$/);
    informe.tenant = tenant;
    const administrador = aula(await sesionAula('admin'));
    const materia = await administrador('/materias', { metodo: 'POST', cuerpo: { nombre: `Circuito Aula ${Date.now()}`, cupo: 20 } });
    assert.equal(materia.status, 201);
    informe.actividad = materia.datos.id;
    // Reinicio controlado para observar el ciclo completo desde cerrado.
    await docker(['restart', 'notificador']);
    await esperarHasta(async () => { try { await metricas('notificador'); return true; } catch (_) { return false; } },
        { plazoMs: 30000, descripcion: 'notificador preparado' });
    restaurarAula = true;
    evento('detener_aula');
    await docker(['stop', '-t', '3', 'aula']);
    const cliente = api(clave);
    async function reservar(i) {
        const r = await cliente(`/v1/actividades/${informe.actividad}/reservas`, {
            metodo: 'POST', cuerpo: { participante: `circuito-aula-${i}` },
            encabezados: { 'Idempotency-Key': `circuito-aula-${i}` }, timeoutMs: 60000
        });
        assert.equal(r.status, 202);
    }
    await Promise.all(Array.from({ length: 8 }, (_, i) => reservar(i)));
    await esperarHasta(async () => (await metricas('notificador')).split('\n').some(l =>
        l.startsWith('pdc_webhook_circuito_estado{') && l.includes(`tenant="${tenant}"`) && l.endsWith(' 1')),
    { plazoMs: 90000, descripcion: 'circuito abierto con Aula detenida' });
    evento('circuito_abierto');
    await Promise.all([reservar(8), reservar(9), reservar(10)]);
    await esperarHasta(async () => (await metricas('notificador')).split('\n').some(l =>
        l.startsWith('pdc_eventos_total{') && l.includes('resultado="diferido_circuito"') && Number(l.split(' ').at(-1)) > 0),
    { plazoMs: 30000, descripcion: 'mensajes diferidos por circuito' });
    evento('recuperar_aula');
    await docker(['up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', 'aula']);
    await esperarHasta(async () => Number(await sql(`SELECT COUNT(*) FROM reservas WHERE actividad_id='${informe.actividad}' AND estado='confirmada'`)) === 11,
        { plazoMs: 90000, descripcion: 'once reservas confirmadas' });
    const cambios = (await sql(`SELECT id FROM cambios WHERE tipo='reserva.confirmada' AND entidad_id IN (SELECT id FROM reservas WHERE actividad_id='${informe.actividad}')`))
        .split(/\r?\n/).filter(Boolean);
    assert.equal(cambios.length, 11);
    await esperarHasta(async () => {
        const logs = await logsNotificador();
        const lineas = logs.split('\n');
        return cambios.every(id => lineas.some(l => l.includes(`webhook-${id}:`) && l.includes('entregado a aula:3001 (204)')));
    }, { plazoMs: 180000, intervaloMs: 2000, descripcion: 'once webhooks entregados a Aula' });
    const logs = await logsNotificador();
    const transiciones = logs.split('\n').filter(l => l.includes('[notificador] circuito '))
        .map(l => JSON.parse(l.slice(l.indexOf('{')))).filter(e => e.tenant === tenant);
    const estados = transiciones.map(e => e.estado);
    assert.equal(estados[0], 'cerrado');
    const abierto = estados.indexOf('abierto'), semi = estados.indexOf('semiabierto', abierto + 1);
    assert.ok(abierto > 0 && semi > abierto && estados.indexOf('cerrado', semi + 1) > semi);
    informe.transiciones = transiciones;
    informe.entregasVerificadas = cambios.length;
    informe.confirmadas = 11;
    guardar('circuito-aula/notificador.txt', logs);
    guardar('circuito-aula/metricas.txt', await metricas('notificador'));
    const logsAula = await docker(['logs', '--since', informe.inicio, '--no-color', 'aula']);
    guardar('circuito-aula/aula.txt', logsAula.stdout + '\n' + logsAula.stderr);
    informe.aprobada = true;
    console.log('OK: Aula detenida y recuperada; ciclo completo y once webhooks entregados.');
}
main().catch(e => { informe.error = e.message; process.exitCode = 1; console.error('FALLO:', e.message); })
    .finally(async () => {
        if (restaurarAula) try { await docker(['up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', 'aula']); }
        catch (e) { informe.restauracion = e.message; informe.aprobada = false; process.exitCode = 1; }
        informe.fin = new Date().toISOString();
        guardar('circuito-aula/resultado.json', informe);
    });
