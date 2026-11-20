const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { RAIZ, api, crearTenant, esperar, esperarHasta } = require('../comun');
const ejecutar = promisify(execFile);
const archivos = ['-f', 'docker-compose.yml', '-f', 'docker-compose.particiones.yml'];
function ocultar(s) { return String(s).replace(/(?:rc_(?:admin_)?[a-f0-9]{64}|[a-f0-9]{64})/gi, '[SECRETO OCULTO]'); }
async function docker(args, { extra = [], timeout = 180000, env = process.env } = {}) {
    try {
        return await ejecutar('docker', ['compose', ...archivos, ...extra, ...args], {
            cwd: RAIZ, timeout, encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024
        });
    } catch (e) {
        e.message = ocultar(e.stderr || e.message);
        throw e;
    }
}
async function directo(args, timeout = 30000) {
    return ejecutar('docker', args, { cwd: RAIZ, timeout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}
async function ids(servicio) {
    const r = await docker(['ps', '--status', 'running', '-q', servicio]);
    return r.stdout.trim().split(/\r?\n/).filter(Boolean);
}
async function sql(consulta) {
    return (await docker(['exec', '-T', 'mysql-primary', 'sh', '-c',
        'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -B reservas -e "$1"', 'consulta', consulta],
        { timeout: 15000 })).stdout.trim();
}
async function desdeApi(url, opciones = {}) {
    const script = `fetch(process.argv[1],JSON.parse(process.argv[2])).then(async r=>{const t=await r.text();if(!r.ok)throw Error('HTTP '+r.status);console.log(t);}).catch(e=>{console.error(e.message);process.exitCode=1;});`;
    // Por id: después de escalar, la instancia que queda puede no ser la 1
    // (`docker compose exec api` apunta siempre a la de índice 1).
    const [id] = await ids('api');
    return (await directo(['exec', id, 'node', '-e', script, url, JSON.stringify(opciones)], 15000)).stdout.trim();
}
async function metricas(servicio, id) {
    const script = "fetch('https://localhost:9464/metrics').then(r=>{if(!r.ok)throw Error('HTTP '+r.status);return r.text();}).then(console.log).catch(e=>{console.error(e.message);process.exitCode=1;});";
    return id ? (await directo(['exec', id, 'node', '-e', script])).stdout
        : (await docker(['exec', '-T', servicio, 'node', '-e', script])).stdout;
}
function guardar(nombre, datos) {
    const archivo = path.resolve(RAIZ, '../docs/entrega-6/evidencias', nombre);
    fs.mkdirSync(path.dirname(archivo), { recursive: true });
    fs.writeFileSync(archivo, typeof datos === 'string' ? ocultar(datos).trimEnd() + '\n'
        : JSON.stringify(datos, null, 2) + '\n', 'utf8');
    return archivo;
}
function graficoSeries(series, eventos = []) {
    const puntos = series.flatMap(s => s.values.map(([x, y]) => [Number(x), Number(y)]))
        .filter(p => p.every(Number.isFinite));
    if (!puntos.length) return '<p>Sin muestras de Prometheus. Pendiente de verificar scraping.</p>';
    const tiemposEventos = eventos.map(e => e.ms / 1000).filter(Number.isFinite);
    const minX = Math.min(...puntos.map(p => p[0]), ...tiemposEventos);
    const maxX = Math.max(minX + 1, ...puntos.map(p => p[0]), ...tiemposEventos);
    const maxY = Math.max(1, ...puntos.map(p => p[1]));
    const x = t => 50 + (t - minX) / (maxX - minX) * 850;
    const y = v => 290 - v / maxY * 240;
    const colores = ['#2463eb', '#079669', '#9333ea', '#c2410c'];
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 350" role="img" aria-label="Serie temporal y fallos">`
        + '<path d="M50 40V290H920" fill="none" stroke="#333"/>'
        + series.map((s, i) => `<polyline fill="none" stroke="${colores[i % 4]}" stroke-width="2" points="${s.values
            .filter(p => Number.isFinite(Number(p[1]))).map(([t, v]) => `${x(Number(t))},${y(Number(v))}`).join(' ')}"/>`).join('')
        + eventos.map(e => `<line x1="${x(e.ms / 1000)}" x2="${x(e.ms / 1000)}" y1="40" y2="290" stroke="#b91c1c" stroke-dasharray="5 4"/><text x="${x(e.ms / 1000)}" y="${20 + (eventos.indexOf(e) % 2) * 15}" font-size="10">${e.tipo.replace(/[<>&]/g, '')}</text>`).join('')
        + `<text x="50" y="325">${new Date(minX * 1000).toISOString()}</text><text x="650" y="325">${new Date(maxX * 1000).toISOString()}</text></svg>`;
}
module.exports = { RAIZ, api, crearTenant, esperar, esperarHasta, docker, directo, ids, sql,
    desdeApi, metricas, guardar, ocultar, graficoSeries };
