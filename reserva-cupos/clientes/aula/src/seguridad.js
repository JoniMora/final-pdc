const { randomBytes, createHash, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { readFile } = require('node:fs/promises');
const derivar = promisify(scrypt);
const digest = valor => createHash('sha256').update(valor).digest('hex');
const cookie = 'aula_sesion';

async function hashPassword(password, sal = randomBytes(16).toString('hex')) {
    const hash = await derivar(password, sal, 64, { N: 16384, r: 8, p: 1 });
    return `scrypt$${sal}$${hash.toString('hex')}`;
}
async function verificarPassword(password, guardado) {
    if (typeof password !== 'string' || password.length > 256) return false;
    const [algoritmo, sal, hash] = (guardado || '').split('$');
    if (algoritmo !== 'scrypt' || !/^[a-f0-9]{128}$/.test(hash || '')) return false;
    const calculado = await hashPassword(password, sal);
    return timingSafeEqual(Buffer.from(calculado), Buffer.from(guardado));
}
function mismoOrigen(req) {
    const origen = req.get('origin');
    if (!origen) return true; // Clientes no navegador: además necesitan cookie y CSRF.
    try { return new URL(origen).host === req.get('host'); } catch { return false; }
}
function puedeVer(usuario, reserva) {
    return usuario.rol === 'administrador' || reserva.participante === usuario.participante;
}
function crearSeguridad({ archivo, secure = true, ttlMs = 3600000, reloj = Date.now, cargarUsuarios } = {}) {
    const sesiones = new Map();
    const intentos = new Map();
    const usuarios = cargarUsuarios || (async () => JSON.parse(await readFile(archivo, 'utf8')));
    const limpiar = () => {
        const ahora = reloj();
        for (const [k,v] of sesiones) if (v.vence <= ahora) sesiones.delete(k);
        for (const [k,v] of intentos) if (v.vence <= ahora) intentos.delete(k);
    };
    const fallo = (res, status, error) => res.status(status).json({ error });
    function exigirTransporte(req,res,next) {
        if (secure && !req.secure) return fallo(res, 400, 'Se requiere HTTPS');
        res.set('Cache-Control', 'no-store');
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Referrer-Policy', 'same-origin');
        res.set('X-Frame-Options', 'DENY');
        if (secure) res.set('Strict-Transport-Security', 'max-age=86400');
        next();
    }
    async function login(req,res) {
        limpiar();
        if (!mismoOrigen(req)) return fallo(res,403,'Origen no permitido');
        const { usuario, password } = req.body || {};
        if (typeof usuario !== 'string' || usuario.length > 80 || typeof password !== 'string' || password.length > 256) {
            return fallo(res,400,'Credenciales inválidas');
        }
        const ip = req.ip;
        const contador = intentos.get(ip) || { cantidad: 0, vence: reloj()+900000 };
        if (contador.cantidad >= 10 || (!intentos.has(ip) && intentos.size >= 10000)) {
            res.set('Retry-After','900');
            return fallo(res,429,'Demasiados intentos; espere antes de reintentar');
        }
        contador.cantidad++; intentos.set(ip,contador);
        let lista;
        try { lista = await usuarios(); } catch { return fallo(res,503,'Identidades no disponibles'); }
        const persona = lista.find(u => u.usuario === usuario && u.activo !== false);
        // También se deriva una contraseña si el usuario no existe: error uniforme.
        const relleno = 'scrypt$00000000000000000000000000000000$'+'0'.repeat(128);
        const valida = await verificarPassword(password, persona?.passwordHash || relleno);
        if (!persona || !valida) return fallo(res,401,'Usuario o contraseña incorrectos');
        if (sesiones.size >= 10000) return fallo(res,503,'Límite de sesiones alcanzado');
        const anterior = leerToken(req);
        if (anterior) sesiones.delete(digest(anterior));
        const token = randomBytes(32).toString('hex');
        const sesion = { usuario: persona.usuario, csrf: randomBytes(32).toString('hex'), vence: reloj()+ttlMs };
        sesiones.set(digest(token),sesion);
        res.cookie(cookie,token,{ httpOnly:true,secure,sameSite:'strict',path:'/',maxAge:ttlMs });
        res.json({ usuario: publico(persona), csrf: sesion.csrf });
    }
    function leerToken(req) {
        const entrada = (req.headers.cookie || '').split(';').map(c=>c.trim()).find(c=>c.startsWith(cookie+'='));
        return entrada?.slice(cookie.length+1);
    }
    async function autenticar(req,res,next) {
        limpiar();
        const token = leerToken(req);
        const sesion = token && sesiones.get(digest(token));
        if (!sesion) return fallo(res,401,'Inicie sesión');
        let lista;
        try { lista = await usuarios(); } catch { return fallo(res,503,'Identidades no disponibles'); }
        const persona = lista.find(u=>u.usuario===sesion.usuario && u.activo!==false);
        if (!persona || !['administrador','alumno'].includes(persona.rol)) return fallo(res,401,'Sesión inválida');
        req.usuario = publico(persona); req.sesion=sesion; req.tokenSesion=token;
        if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
            if (!mismoOrigen(req) || req.get('x-csrf-token') !== sesion.csrf) return fallo(res,403,'Token CSRF u origen inválido');
        }
        next();
    }
    function administrador(req,res,next) {
        if (req.usuario.rol !== 'administrador') return fallo(res,403,'Se requiere rol administrador');
        next();
    }
    function montar(app) {
        app.post('/auth/login',exigirTransporte,login);
        app.get('/auth/me',exigirTransporte,autenticar,(req,res)=>res.json({usuario:req.usuario,csrf:req.sesion.csrf}));
        app.post('/auth/logout',exigirTransporte,autenticar,(req,res)=>{
            sesiones.delete(digest(req.tokenSesion));
            res.clearCookie(cookie,{httpOnly:true,secure,sameSite:'strict',path:'/'});
            res.json({estado:'sesión cerrada'});
        });
    }
    return { montar, autenticar, administrador, exigirTransporte };
}
function publico(u) { return { usuario:u.usuario,rol:u.rol,participante:u.participante || null }; }
module.exports = { crearSeguridad,hashPassword,verificarPassword,puedeVer,mismoOrigen };
