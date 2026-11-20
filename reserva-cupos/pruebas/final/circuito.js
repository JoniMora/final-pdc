const assert = require('node:assert/strict');
const { api, crearTenant, esperar, esperarHasta, docker, desdeApi, metricas, guardar } = require('./util-e6');
const extra = ['-f', 'docker-compose.pruebas-e6.yml'];
const informe = { inicio: new Date().toISOString(), aprobada: false, pasos: [] };
const control = async cuerpo => JSON.parse(await desdeApi('https://receptor-pruebas:3443/control', {
    method: cuerpo ? 'POST' : 'GET', headers: { Authorization: 'Bearer e6_control_local', 'Content-Type': 'application/json' },
    ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {})
}));
let restaurar = false;
async function main() {
    console.log('1/4 Iniciando receptor HTTPS de prueba y notificador...');
    restaurar = true;
    await docker(['up', '-d', '--build', '--no-deps', 'receptor-pruebas', 'notificador'], { extra });
    await esperarHasta(async () => { try { await control(); return true; } catch (_) { return false; } },
        { plazoMs: 30000, descripcion: 'receptor de prueba HTTPS' });
    const tenant = await crearTenant(`Circuito ${Date.now()}`, {
        webhook_url: 'https://receptor-pruebas:3443/webhook', limite: { por_segundo: 1000, rafaga: 1000 }
    });
    informe.tenant = tenant.id;
    await control({ fallar: true, secreto: tenant.webhook_secreto });
    const cliente = api(tenant.clave_api);
    const actividad = await cliente('/v1/actividades', { metodo: 'POST', cuerpo: { nombre: 'Circuito', capacidad: 20 } });
    assert.equal(actividad.status, 201);
    async function reservar(i) {
        const r = await cliente(`/v1/actividades/${actividad.datos.id}/reservas`, {
            metodo: 'POST', cuerpo: { participante: `circuito-${i}` }, encabezados: { 'Idempotency-Key': `circuito-${i}` }
        });
        assert.equal(r.status, 202);
    }
    console.log('2/4 Receptor falla: esperando apertura del circuito...');
    await Promise.all(Array.from({ length: 8 }, (_, i) => reservar(i)));
    await esperarHasta(async () => {
        const texto = await metricas('notificador');
        return texto.split('\n').some(l => l.startsWith('pdc_webhook_circuito_estado{')
            && l.includes(`tenant="${tenant.id}"`) && l.endsWith(' 1'));
    }, { plazoMs: 60000, descripcion: 'circuito abierto' });
    informe.pasos.push('abierto');
    await Promise.all([reservar(8), reservar(9), reservar(10)]);
    await esperarHasta(async () => (await metricas('notificador')).split('\n').some(l =>
        l.startsWith('pdc_eventos_total{') && l.includes('resultado="diferido_circuito"') && Number(l.split(' ').at(-1)) > 0),
        { plazoMs: 15000, descripcion: 'mensajes diferidos sin HTTP' });
    informe.pasos.push('mensajes diferidos sin intento HTTP');
    console.log('3/4 Recuperando receptor y esperando la prueba semiabierta...');
    await control({ fallar: false });
    await esperarHasta(async () => (await control()).entregas.length === 11,
        { plazoMs: 180000, descripcion: 'once webhooks entregados tras recuperacion' });
    const logs = (await docker(['logs', '--since', informe.inicio, '--no-color', 'notificador'])).stdout;
    const eventos = logs.split('\n').filter(l => l.includes('[notificador] circuito '))
        .map(l => JSON.parse(l.slice(l.indexOf('{')))).filter(e => e.tenant === tenant.id);
    informe.transiciones = eventos;
    const estados = eventos.map(e => e.estado);
    assert.equal(estados[0], 'cerrado');
    const abierto = estados.indexOf('abierto');
    const semi = estados.indexOf('semiabierto', abierto + 1);
    assert.ok(abierto > 0 && semi > abierto && estados.indexOf('cerrado', semi + 1) > semi);
    informe.receptor = await control();
    const texto = await metricas('notificador');
    guardar('circuito-metricas.txt', texto);
    informe.aprobada = true;
    console.log('4/4 OK: cerrado -> abierto -> semiabierto -> cerrado, 11 entregas recuperadas.');
}
main().catch(e => { informe.error = e.message; process.exitCode = 1; console.error('FALLO:', e.message); })
    .finally(async () => {
        if (restaurar) {
            try {
                await docker(['up', '-d', '--no-deps', '--force-recreate', 'notificador']);
                await docker(['stop', 'receptor-pruebas'], { extra });
                await docker(['rm', '-f', 'receptor-pruebas'], { extra });
            } catch (e) { informe.restauracion = e.message; informe.aprobada = false; process.exitCode = 1; }
        }
        guardar('circuito-recuperacion.json', informe);
    });
