// Fixture HTTPS solo del perfil pruebas-e6. No se publica en el host.
const fs = require('node:fs');
const https = require('node:https');
const { createHmac, timingSafeEqual } = require('node:crypto');
let fallar = true;
const secretos = new Map();
let intentos = 0;
const entregas = new Set();
https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }, (req, res) => {
    let cuerpo = '';
    req.on('data', b => { cuerpo += b; if (cuerpo.length > 65536) req.destroy(); });
    req.on('end', () => {
        try {
            if (req.url === '/control') {
                if (req.headers.authorization !== `Bearer ${process.env.CONTROL_TOKEN}`) return res.writeHead(401).end();
                if (req.method === 'POST') {
                    const datos = JSON.parse(cuerpo);
                    if (datos.secreto) {
                        if (!/^[a-f0-9]{64}$/i.test(datos.secreto)) return res.writeHead(400).end();
                        secretos.set(datos.clave || 'default', Buffer.from(datos.secreto, 'hex'));
                    }
                    fallar = Boolean(datos.fallar);
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ fallar, intentos, entregas: [...entregas] }));
            }
            const ruta = /^\/webhook(?:\/([a-z0-9_-]+))?$/.exec(req.url);
            if (!ruta || req.method !== 'POST') return res.writeHead(404).end();
            const secreto = secretos.get(ruta[1] || 'default');
            const m = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(req.headers['x-firma'] || '');
            if (!m || !secreto || Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return res.writeHead(401).end();
            const firma = createHmac('sha256', secreto).update(`${m[1]}.${cuerpo}`).digest();
            if (!timingSafeEqual(firma, Buffer.from(m[2], 'hex'))) return res.writeHead(401).end();
            intentos++;
            if (fallar) return res.writeHead(503).end();
            entregas.add(req.headers['x-webhook-id']);
            res.writeHead(204).end();
        } catch (_) { res.writeHead(400).end(); }
    });
}).listen(3443, '0.0.0.0');
