const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fork } = require("node:child_process");
const { hashPassword } = require("../src/seguridad");

// El backend real de Aula, como proceso aparte, frente a una API simulada
// que responde según el contrato. Comprueba que los permisos se aplican en
// las rutas de verdad y no solo en el módulo de seguridad. Corre por HTTP
// (sin TLS_CERT): el transporte cifrado se prueba en pruebas/seguridad.

const actividad = {
    id: "019a0000-0000-7000-8000-000000000001",
    nombre: "Prueba",
    capacidad: 2,
    cupos_disponibles: 1,
    estado: "abierta",
    version: 1,
    metadata: { origen: "aula", tipo: "materia" },
    creado_en: new Date().toISOString()
};

const reserva = {
    id: "019a0000-0000-7000-8000-000000000002",
    actividad_id: actividad.id,
    participante: "alumno-1",
    estado: "confirmada",
    version: 2,
    metadata: null,
    creado_en: new Date().toISOString()
};

function apiSimulada() {
    const llamadas = { cancelaciones: 0, reservas: [] };

    const servidor = http.createServer((req, res) => {
        let cuerpo = "";

        req.on("data", parte => { cuerpo += parte; });
        req.on("end", () => {
            res.setHeader("Content-Type", "application/json");

            if (req.url.startsWith("/v1/cambios")) {
                return res.end(JSON.stringify({ datos: [], ultima_secuencia: 0 }));
            }

            if (req.url.endsWith("/cancelacion")) {
                llamadas.cancelaciones++;
                res.statusCode = 202;
                return res.end(JSON.stringify(reserva));
            }

            if (req.method === "POST" && req.url.endsWith("/reservas")) {
                llamadas.reservas.push(JSON.parse(cuerpo).participante);
                res.statusCode = 202;
                return res.end(JSON.stringify({ ...reserva, estado: "pendiente", version: 1 }));
            }

            if (req.url.startsWith("/v1/reservas/")) return res.end(JSON.stringify(reserva));
            if (req.url.includes("/reservas")) return res.end(JSON.stringify({ datos: [reserva], siguiente_cursor: null }));
            if (req.url.startsWith("/v1/actividades/")) return res.end(JSON.stringify(actividad));

            res.statusCode = 404;
            res.end(JSON.stringify({ type: "about:blank", title: "No encontrado", status: 404 }));
        });
    });

    return { servidor, llamadas };
}

async function puertoLibre() {
    const temporal = http.createServer();
    await new Promise(resolve => temporal.listen(0, "127.0.0.1", resolve));
    const { port } = temporal.address();
    await new Promise(resolve => temporal.close(resolve));
    return port;
}

test("backend real de Aula: login, roles, CSRF y propiedad de las reservas", async t => {
    const { servidor: api, llamadas } = apiSimulada();
    await new Promise(resolve => api.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise(resolve => api.close(resolve)));

    const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), "aula-rutas-"));
    t.after(() => fs.rmSync(carpeta, { recursive: true, force: true }));

    const usuarios = [];
    for (const [usuario, rol, participante] of [["admin", "administrador", null], ["uno", "alumno", "alumno-1"], ["dos", "alumno", "alumno-2"]]) {
        usuarios.push({ usuario, rol, participante, passwordHash: await hashPassword("clave-de-prueba") });
    }
    fs.writeFileSync(path.join(carpeta, "usuarios.json"), JSON.stringify(usuarios));

    const puerto = await puertoLibre();
    const aula = fork(path.resolve(__dirname, "../src/server.js"), [], {
        silent: true,
        env: {
            ...process.env,
            PORT: String(puerto),
            API_URL: `http://127.0.0.1:${api.address().port}`,
            API_KEY: "clave-de-prueba",
            WEBHOOK_SECRET: "a".repeat(64),
            USUARIOS_ARCHIVO: path.join(carpeta, "usuarios.json"),
            // Base inalcanzable: Aula funciona en modo contingencia.
            PGHOST: "127.0.0.1",
            PGPORT: "1",
            PGDATABASE: "aula",
            PGUSER: "aula",
            PGPASSWORD: "aula",
            TLS_CERT: "",
            TLS_CA: ""
        }
    });
    t.after(() => aula.kill());

    await new Promise((resolve, reject) => {
        const plazo = setTimeout(() => reject(new Error("Aula no arrancó")), 15000);
        aula.stdout.on("data", texto => {
            if (texto.toString().includes("Pagina disponible")) {
                clearTimeout(plazo);
                resolve();
            }
        });
        aula.once("exit", codigo => {
            clearTimeout(plazo);
            reject(new Error(`Aula terminó con código ${codigo}`));
        });
    });

    const base = `http://127.0.0.1:${puerto}`;

    async function pedir(ruta, { metodo = "GET", cuerpo, sesion } = {}) {
        const respuesta = await fetch(`${base}${ruta}`, {
            method: metodo,
            headers: {
                ...(cuerpo ? { "Content-Type": "application/json" } : {}),
                ...(sesion ? { Cookie: sesion.cookie, "X-CSRF-Token": sesion.csrf } : {})
            },
            body: cuerpo ? JSON.stringify(cuerpo) : undefined
        });
        const texto = await respuesta.text();

        return { status: respuesta.status, datos: texto ? JSON.parse(texto) : null };
    }

    async function login(usuario) {
        const respuesta = await fetch(`${base}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ usuario, password: "clave-de-prueba" })
        });

        assert.equal(respuesta.status, 200);

        return {
            cookie: respuesta.headers.get("set-cookie").split(";")[0],
            csrf: (await respuesta.json()).csrf
        };
    }

    assert.equal((await pedir("/materias")).status, 401);

    const admin = await login("admin");
    const uno = await login("uno");
    const dos = await login("dos");

    // Rol: un alumno no crea materias ni ve el estado de la reconciliación.
    assert.equal((await pedir("/materias", { metodo: "POST", cuerpo: { nombre: "x", cupo: 1 }, sesion: uno })).status, 403);
    assert.equal((await pedir("/reconciliacion", { sesion: uno })).status, 403);
    assert.equal((await pedir("/reconciliacion", { sesion: admin })).status, 200);

    // Suplantación: un alumno no inscribe a otro, y el participante sale de
    // la sesión aunque no lo envíe.
    const inscripcion = `/materias/${actividad.id}/inscripciones`;
    assert.equal((await pedir(inscripcion, { metodo: "POST", cuerpo: { alumno: "alumno-2" }, sesion: uno })).status, 403);
    assert.equal((await pedir(inscripcion, { metodo: "POST", cuerpo: {}, sesion: uno })).status, 202);
    assert.deepEqual(llamadas.reservas, ["alumno-1"]);

    // Propiedad: la reserva de alumno-1 no existe para alumno-2.
    assert.equal((await pedir(`/inscripciones/${reserva.id}`, { sesion: uno })).status, 200);
    assert.equal((await pedir(`/inscripciones/${reserva.id}`, { sesion: dos })).status, 404);
    assert.equal((await pedir(`/inscripciones/${reserva.id}/cancelacion`, { metodo: "POST", sesion: dos })).status, 404);
    assert.equal(llamadas.cancelaciones, 0);

    const detalle = await pedir(`/materias/${actividad.id}`, { sesion: dos });
    assert.equal(detalle.status, 200);
    assert.deepEqual(detalle.datos.inscriptos, []);

    assert.equal((await pedir(`/inscripciones/${reserva.id}/cancelacion`, { metodo: "POST", sesion: uno })).status, 202);
    assert.equal(llamadas.cancelaciones, 1);

    // Contingencia: sin PostgreSQL, el catálogo sale del feed (vacío acá).
    const catalogo = await pedir("/materias", { sesion: dos });
    assert.equal(catalogo.status, 200);

    // Estado de las conexiones (el panel de la página): informa PostgreSQL
    // caído y la API simulada sin /health, sin fallar.
    const estado = await pedir("/estado", { sesion: admin });
    assert.equal(estado.status, 200);
    assert.equal(estado.datos.postgresql, "no disponible");
    assert.equal(estado.datos.api, "no disponible");
    assert.equal(estado.datos.aula, "ok");
});
