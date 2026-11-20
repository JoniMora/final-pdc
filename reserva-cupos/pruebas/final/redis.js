// Ejecutar contra Compose seguro actualizado. Restaura la cantidad de APIs.
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { api, crearTenant, esperar, esperarHasta, docker, ids, metricas, guardar } = require('./util-e6');
const informe = { inicio: new Date().toISOString(), aprobada: false, curva: [], comprobaciones: [] };
let originales;
function ok(texto) { console.log(`OK: ${texto}`); informe.comprobaciones.push(texto); }
async function escalar(n) {
    await docker(['up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', '--scale', `api=${n}`, 'api']);
    await esperarHasta(async () => {
        const vivos = await ids('api');
        if (vivos.length !== n) return false;
        const vistos = new Set();
        const { pedir, API } = require('../comun');
        for (let i = 0; i < n * 8; i++) {
            const r = await pedir(`${API}/health`, { timeoutMs: 5000 });
            if (r.status === 200) vistos.add(r.datos.instancia);
        }
        return vistos.size === n;
    }, { plazoMs: 60000, descripcion: `${n} APIs descubiertas en Traefik` });
    await esperar(1000);
}
async function consultasMysql() {
    let cantidad = 0;
    for (const id of await ids('api')) {
        const texto = await metricas('api', id);
        cantidad += texto.split('\n').filter(l => l.startsWith('pdc_eventos_total{') && l.includes('tipo="auth_mysql"'))
            .reduce((s, l) => s + Number(l.split(' ').at(-1)), 0);
    }
    return cantidad;
}
async function main() {
    originales = (await ids('api')).length;
    assert.ok(originales > 0, 'Iniciar entorno actualizado antes de probar');
    console.log('1/3 Midiendo la misma lectura autenticada con 1, 2 y 4 APIs...');
    for (const n of [1, 2, 4]) {
        await escalar(n);
        const tenant = await crearTenant(`Curva ${n} ${Date.now()}`, { limite: { por_segundo: 1000, rafaga: 1000 } });
        const cliente = api(tenant.clave_api);
        for (let i = 0; i < n * 3; i++) assert.equal((await cliente('/v1/cambios?limite=1')).status, 200);
        const antes = await consultasMysql();
        const duraciones = [];
        const instancias = new Set();
        const inicio = performance.now();
        await Promise.all(Array.from({ length: 200 }, async () => {
            const t = performance.now();
            const r = await cliente('/v1/cambios?limite=1');
            assert.equal(r.status, 200);
            duraciones.push(performance.now() - t);
            instancias.add(r.encabezados['x-instancia']);
        }));
        const ms = performance.now() - inicio;
        const despues = await consultasMysql();
        duraciones.sort((a, b) => a - b);
        informe.curva.push({ instancias: n, solicitudes: 200, endpoint: 'GET /v1/cambios?limite=1',
            conexionesHttpMaximas: 64, tiempoMs: ms, throughput: 200 / (ms / 1000),
            p95ClienteMs: duraciones[Math.ceil(duraciones.length * 0.95) - 1],
            instanciasObservadas: [...instancias], consultasAutenticacionMysql: despues - antes });
        assert.ok(despues - antes < 20, 'La cache no redujo consultas de autenticacion');
        assert.equal(instancias.size, n, 'La carga no recorrio todas las instancias');
        ok(`N=${n}: 200 lecturas; ${despues - antes} consultas de autenticacion a MySQL`);
    }
    console.log('2/3 Verificando limite global con cuatro instancias...');
    const limitado = await crearTenant(`Limite global ${Date.now()}`, { limite: { por_segundo: 1, rafaga: 5 } });
    const clienteLimitado = api(limitado.clave_api);
    const inicio = performance.now();
    const respuestas = await Promise.all(Array.from({ length: 40 }, () => clienteLimitado('/v1/cambios?limite=1')));
    const duracion = performance.now() - inicio;
    const admitidas = respuestas.filter(r => r.status === 200).length;
    assert.ok(respuestas.every(r => [200, 429].includes(r.status)));
    assert.ok(respuestas.filter(r => r.status === 429).every(r => Number(r.encabezados['retry-after']) >= 1));
    assert.ok(admitidas >= 5 && admitidas <= 5 + Math.ceil(duracion / 1000), 'El limite se multiplico por instancia');
    assert.ok(respuestas.some(r => r.status === 429));
    informe.limite = { instancias: 4, tasa: 1, rafaga: 5, enviadas: 40, admitidas,
        rechazadas: respuestas.length - admitidas, duracionMs: duracion };
    ok('El balde es global: no se multiplica por cuatro y responde Retry-After');

    console.log('3/3 Verificando invalidacion de claves y permisos...');
    const tenant = await crearTenant(`Rotacion cache ${Date.now()}`, { limite: { por_segundo: 1000, rafaga: 1000 } });
    const anterior = api(tenant.clave_api);
    for (let i = 0; i < 8; i++) assert.equal((await anterior('/v1/cambios?limite=1')).status, 200);
    const { claveOperador } = require('../comun');
    const operador = api(claveOperador());
    const rotacion = await operador(`/admin/v1/tenants/${tenant.id}/rotacion`, { metodo: 'POST' });
    assert.equal(rotacion.status, 200, `Rotacion: HTTP ${rotacion.status}; ${JSON.stringify(rotacion.datos)}`);
    for (let i = 0; i < 8; i++) assert.equal((await anterior('/v1/cambios?limite=1')).status, 401);
    const nuevo = api(rotacion.datos.clave_api);
    assert.equal((await nuevo('/v1/cambios?limite=1')).status, 200);
    // El contrato exige al menos un permiso: conservar lectura y retirar cambios:leer.
    const permisos = await operador(`/admin/v1/tenants/${tenant.id}`, {
        metodo: 'PATCH', cuerpo: { scopes: ['lectura'] }
    });
    assert.equal(permisos.status, 200, `Cambio de permisos: HTTP ${permisos.status}; ${JSON.stringify(permisos.datos)}`);
    for (let i = 0; i < 8; i++) assert.equal((await nuevo('/v1/cambios?limite=1')).status, 403);
    ok('La clave rotada deja de autenticar y los permisos nuevos se aplican en todas las APIs');
    informe.aprobada = true;
}
main().catch(e => { informe.error = e.message; process.exitCode = 1; console.error('FALLO:', e.message); })
    .finally(async () => {
        if (originales) try { await escalar(originales); }
        catch (e) { informe.restauracion = e.message; informe.aprobada = false; process.exitCode = 1; }
        guardar('redis-escalado.json', informe);
        console.log('Evidencia: docs/entrega-6/evidencias/redis-escalado.json');
    });
