const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { crearSeguridad, hashPassword, verificarPassword, puedeVer } = require("../src/seguridad");

// Levanta una app mínima con el módulo de seguridad montado y devuelve su
// URL. secure: false porque la prueba usa HTTP; el transporte se prueba en
// pruebas/seguridad.
async function levantar(t, opciones, configurar = () => {}) {
    const seguridad = crearSeguridad({ secure: false, ...opciones });
    const app = express();

    app.use(express.json());
    seguridad.montar(app);
    configurar(app, seguridad);

    const servidor = app.listen(0, "127.0.0.1");
    await new Promise(resolve => servidor.once("listening", resolve));
    t.after(() => new Promise(resolve => servidor.close(resolve)));

    return `http://127.0.0.1:${servidor.address().port}`;
}

async function login(base, usuario, password) {
    const respuesta = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usuario, password })
    });
    const datos = await respuesta.json();

    return {
        status: respuesta.status,
        setCookie: respuesta.headers.get("set-cookie"),
        cookie: respuesta.headers.get("set-cookie")?.split(";")[0],
        datos
    };
}

test("contraseñas: sal aleatoria, verificación y rechazo de una incorrecta", async () => {
    const a = await hashPassword("contraseña de prueba");
    const b = await hashPassword("contraseña de prueba");

    assert.notEqual(a, b);
    assert.equal(await verificarPassword("contraseña de prueba", a), true);
    assert.equal(await verificarPassword("incorrecta", a), false);
    assert.equal(await verificarPassword("contraseña de prueba", "md5$x$y"), false);
});

test("sesiones, CSRF, roles, logout y vencimiento se comprueban en el servidor", async t => {
    let ahora = 1000;
    const usuarios = [
        { usuario: "admin", rol: "administrador", passwordHash: await hashPassword("admin-prueba") },
        { usuario: "ana", rol: "alumno", participante: "ana", passwordHash: await hashPassword("ana-prueba") }
    ];

    const base = await levantar(t, { ttlMs: 1000, reloj: () => ahora, cargarUsuarios: async () => usuarios }, (app, seguridad) => {
        app.use("/protegido", seguridad.autenticar);
        app.get("/protegido", (req, res) => res.json(req.usuario));
        app.post("/protegido", seguridad.administrador, (req, res) => res.json({ ok: true }));
    });
    const pedir = (ruta, opciones = {}) => fetch(`${base}${ruta}`, opciones);

    assert.equal((await pedir("/protegido")).status, 401);
    assert.equal((await login(base, "ana", "mal")).status, 401);

    const ana = await login(base, "ana", "ana-prueba");
    assert.equal(ana.status, 200);
    assert.match(ana.setCookie, /HttpOnly/i);
    assert.match(ana.setCookie, /SameSite=Strict/i);
    assert.equal(ana.datos.usuario.passwordHash, undefined);

    assert.equal((await pedir("/protegido", { headers: { cookie: ana.cookie } })).status, 200);

    // Sin token CSRF, y con token pero sin rol de administrador: 403.
    assert.equal((await pedir("/protegido", { method: "POST", headers: { cookie: ana.cookie } })).status, 403);
    assert.equal((await pedir("/protegido", {
        method: "POST",
        headers: { cookie: ana.cookie, "X-CSRF-Token": ana.datos.csrf }
    })).status, 403);

    const admin = await login(base, "admin", "admin-prueba");
    const encabezados = { cookie: admin.cookie, "X-CSRF-Token": admin.datos.csrf };

    assert.equal((await pedir("/protegido", { method: "POST", headers: encabezados })).status, 200);
    assert.equal((await pedir("/protegido", {
        method: "POST",
        headers: { ...encabezados, origin: "https://sitio-ajeno.example" }
    })).status, 403);

    assert.equal((await pedir("/auth/logout", { method: "POST", headers: encabezados })).status, 200);
    assert.equal((await pedir("/protegido", { headers: encabezados })).status, 401);

    ahora = 2001;
    assert.equal((await pedir("/protegido", { headers: { cookie: ana.cookie } })).status, 401);
});

test("desactivar a una persona corta su sesión abierta", async t => {
    const usuarios = [{ usuario: "ana", rol: "alumno", participante: "ana", passwordHash: await hashPassword("ana-prueba") }];
    const base = await levantar(t, { cargarUsuarios: async () => usuarios }, (app, seguridad) => {
        app.get("/protegido", seguridad.autenticar, (req, res) => res.json(req.usuario));
    });

    const ana = await login(base, "ana", "ana-prueba");
    assert.equal((await fetch(`${base}/protegido`, { headers: { cookie: ana.cookie } })).status, 200);

    usuarios[0].activo = false;
    assert.equal((await fetch(`${base}/protegido`, { headers: { cookie: ana.cookie } })).status, 401);
});

test("autorización de reserva: un alumno solo ve la suya; el administrador, todas", () => {
    assert.equal(puedeVer({ rol: "alumno", participante: "ana" }, { participante: "ana" }), true);
    assert.equal(puedeVer({ rol: "alumno", participante: "ana" }, { participante: "bea" }), false);
    assert.equal(puedeVer({ rol: "administrador" }, { participante: "bea" }), true);
});

test("diez contraseñas incorrectas bloquean la IP con 429; los logins correctos no cuentan", async t => {
    const usuarios = [{ usuario: "ana", rol: "alumno", participante: "ana", passwordHash: await hashPassword("ana-prueba") }];
    const base = await levantar(t, { cargarUsuarios: async () => usuarios });

    // Muchos logins correctos seguidos (una demo, un aula detrás de NAT).
    for (let i = 0; i < 15; i++) assert.equal((await login(base, "ana", "ana-prueba")).status, 200);

    for (let i = 0; i < 10; i++) assert.equal((await login(base, "nadie", "x")).status, 401);

    const bloqueado = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usuario: "ana", password: "ana-prueba" })
    });

    assert.equal(bloqueado.status, 429);
    assert.equal(bloqueado.headers.get("retry-after"), "900");
});

test("HSTS no se envía en localhost (afectaría a otros servicios locales)", async t => {
    const seguridad = crearSeguridad({ secure: true, cargarUsuarios: async () => [] });
    const req = nombre => ({ secure: true, hostname: nombre });
    const encabezados = {};
    const res = { set: (nombre, valor) => { encabezados[nombre] = valor; } };

    seguridad.exigirTransporte(req("localhost"), res, () => {});
    assert.equal(encabezados["Strict-Transport-Security"], undefined);

    seguridad.exigirTransporte(req("aula.ejemplo.edu"), res, () => {});
    assert.equal(encabezados["Strict-Transport-Security"], "max-age=86400");
});
