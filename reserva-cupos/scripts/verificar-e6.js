// Un comando por requisito, sin copiar claves y sin borrar volumenes.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const raiz = path.resolve(__dirname, '..');
const evidencias = path.resolve(raiz, '../docs/entrega-6/evidencias');
const accion = process.argv[2] || 'local';
const informe = { accion, inicio: new Date().toISOString(), pasos: [], aprobada: false };
// Las evidencias no llevan rutas absolutas del equipo (ni el usuario local).
function relativo(texto) {
    return texto.split(path.resolve(raiz, '..') + path.sep).join('');
}
function ejecutar(nombre, programa, args, { timeout = 600000, cwd = raiz, env = process.env } = {}) {
    console.log(`>> ${nombre}`);
    try {
        const salida = execFileSync(programa, args, { cwd, env, encoding: 'utf8', timeout,
            maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        const texto = relativo(salida.replace(/[ \t]+$/gm, '').trimEnd() + '\n');
        fs.mkdirSync(path.join(evidencias, 'verificacion'), { recursive: true });
        fs.writeFileSync(path.join(evidencias, 'verificacion', `${nombre}.txt`), texto, 'utf8');
        const total = /# tests (\d+)/.exec(texto);
        informe.pasos.push({ nombre, aprobada: true, ...(total ? { pruebas: Number(total[1]) } : {}) });
        console.log(`OK: ${nombre}${total ? ` (${total[1]} pruebas)` : ''}`);
    } catch (e) {
        const texto = relativo(String(e.stdout || '') + '\n' + String(e.stderr || e.message));
        fs.mkdirSync(path.join(evidencias, 'verificacion'), { recursive: true });
        fs.writeFileSync(path.join(evidencias, 'verificacion', `${nombre}.txt`),
            texto.replace(/(?:rc_(?:admin_)?[a-f0-9]{64}|[a-f0-9]{64})/gi, '[SECRETO OCULTO]'), 'utf8');
        informe.pasos.push({ nombre, aprobada: false });
        throw new Error(`Fallo ${nombre}. Ver docs/entrega-6/evidencias/verificacion/${nombre}.txt`);
    }
}
const nodo = (nombre, archivo, args = [], opciones) => ejecutar(nombre, process.execPath, [archivo, ...args], opciones);
function dependencias() {
    const env = { ...process.env, npm_config_cache: path.join(raiz, 'seguridad/local/npm-cache') };
    for (const componente of ['compartido', 'servicios/api', 'servicios/worker', 'servicios/relay', 'servicios/notificador', 'clientes/aula']) {
        const opciones = { cwd: path.join(raiz, componente), env };
        const nombre = `dependencias-${componente.replaceAll('/', '-')}`;
        if (process.platform === 'win32') ejecutar(nombre, 'cmd.exe', ['/d', '/s', '/c', 'npm ci --ignore-scripts'], opciones);
        else ejecutar(nombre, 'npm', ['ci', '--ignore-scripts'], opciones);
    }
}
function local() {
    function pruebas(carpeta) {
        return fs.readdirSync(path.join(raiz, carpeta)).filter(n => n.endsWith('.test.js'))
            .map(n => path.join(carpeta, n));
    }
    for (const componente of ['compartido', 'servicios/api', 'servicios/worker', 'servicios/relay', 'servicios/notificador', 'clientes/aula']) {
        nodo(`unitarias-${componente.replaceAll('/', '-')}`, '--test', pruebas(`${componente}/test`));
    }
    nodo('unitarias-reportes', '--test', pruebas('pruebas/final/test'));
}
function levantar() {
    nodo('preparar', 'scripts/sistema.js', ['preparar']);
    nodo('topologia-original', 'scripts/sistema.js', ['comprobar-topologia']);
    ejecutar('levantar-cuatro-particiones', 'docker', ['compose', '-f', 'docker-compose.yml', '-f',
        'docker-compose.particiones.yml', 'up', '-d', '--build', '--wait', '--wait-timeout', '300']);
    nodo('replica', 'scripts/sistema.js', ['replica']);
    nodo('grafana', 'scripts/sistema.js', ['grafana']);
}
function circuito() { nodo('circuito', 'pruebas/final/circuito.js', [], { timeout: 420000 }); }
function redis() { nodo('redis', 'pruebas/final/redis.js', [], { timeout: 600000 }); }
function carga() {
    for (const escenario of ['caliente', 'multitenant', 'rampa']) {
        nodo(`carga-${escenario}`, 'pruebas/final/carga.js', [escenario], { timeout: 540000 });
    }
}
function fallos() { nodo('fallos', 'pruebas/final/fallos-carga.js', [], { timeout: 720000 }); }
try {
    if (accion === 'local') local();
    else if (accion === 'dependencias') dependencias();
    else if (accion === 'levantar') levantar();
    else if (accion === 'circuito') circuito();
    else if (accion === 'redis') redis();
    else if (accion === 'carga') carga();
    else if (accion === 'fallos') fallos();
    else if (accion === 'todo') {
        dependencias(); local(); levantar();
        nodo('recorrido', 'pruebas/final/recorrido.js');
        circuito(); redis(); carga(); fallos();
    } else throw new Error('Accion: dependencias | local | levantar | circuito | redis | carga | fallos | todo');
    informe.aprobada = true;
    console.log('Verificacion solicitada aprobada. Esto no publica ni certifica la entrega.');
} catch (e) { informe.error = e.message; process.exitCode = 1; console.error(e.message); }
finally {
    informe.fin = new Date().toISOString();
    fs.mkdirSync(evidencias, { recursive: true });
    fs.writeFileSync(path.join(evidencias, `verificacion-${accion}.json`), JSON.stringify(informe, null, 2) + '\n');
}
