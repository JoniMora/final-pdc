const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { crearApp } = require("../src/server");
const { perfil, metadataDeActividad } = require("../src/perfiles");
const { crearProyeccion } = require("../src/proyeccion");
const { crearCredenciales } = require("../src/credenciales");
const { crearContratoHttp } = require("../../../compartido/src/contrato");

// La app real (rutas, firma, contrato) frente a una API simulada. Corre por
// HTTP: el transporte cifrado se prueba en pruebas/seguridad.

const SECRETO = crypto.randomBytes(32);
const ACTIVIDAD = "019a0000-0000-7000-8000-000000000001";
const AJENA = "019a0000-0000-7000-8000-0000000000ff";

const actividad = {
    id: ACTIVIDAD, nombre: "Turno 20 h", capacidad: 10, cupos_disponibles: 10, estado: "abierta",
    version: 1, metadata: { origen: "canchas", tipo: "turno" }, creado_en: new Date().toISOString()
};

function reserva(estado, version, participante = "jugador-1") {
    return {
        id: "019a0000-0000-7000-8000-000000000002", actividad_id: ACTIVIDAD, participante, estado,
        version, metadata: null, creado_en: new Date().toISOString()
    };
}

function firmar(cuerpo, secreto = SECRETO, t = Math.floor(Date.now() / 1000)) {
    return `t=${t},v1=${crypto.createHmac("sha256", secreto).update(`${t}.${cuerpo}`).digest("hex")}`;
}

async function levantar(t, respuestas = {}) {
    const directorio = fs.mkdtempSync(path.join(os.tmpdir(), "vitrina-"));
    fs.writeFileSync(path.join(directorio, "clave-api"), "rc_prueba\n");
    fs.writeFileSync(path.join(directorio, "webhook-secreto"), SECRETO.toString("hex"));
    fs.writeFileSync(path.join(directorio, "tenant.json"), JSON.stringify({ id: "t-1", nombre: "Canchas" }));

    const llamadas = [];
    const api = {
        contrato: crearContratoHttp(),
        llamar: async (operacion, opciones = {}) => {
            llamadas.push({ operacion, ...opciones });
            const respuesta = respuestas[operacion];
            return typeof respuesta === "function" ? respuesta(opciones) : respuesta;
        }
    };
    const proyeccion = crearProyeccion();
    const sincronizaciones = [];
    const app = crearApp({
        perfil: perfil("canchas"),
        api,
        credenciales: crearCredenciales(directorio),
        proyeccion,
        sincronizacion: { sincronizar: () => sincronizaciones.push(1), estado: { sincronizado_en: null, error: null } }
    });

    const servidor = app.listen(0);
    await new Promise(resolver => servidor.once("listening", resolver));
    t.after(() => {
        servidor.close();
        fs.rmSync(directorio, { recursive: true, force: true });
    });

    const base = `http://127.0.0.1:${servidor.address().port}`;
    const json = (metodo, ruta, cuerpo, encabezados = {}) => fetch(`${base}${ruta}`, {
        method: metodo,
        headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin", ...encabezados },
        body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo)
    });

    return { base, llamadas, proyeccion, sincronizaciones, json };
}

function webhook(base, evento, firma) {
    const cuerpo = JSON.stringify(evento);
    return fetch(`${base}/webhooks/reservas`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Firma": firma ?? firmar(cuerpo), "X-Webhook-Id": "42" },
        body: cuerpo
    });
}

const evento = (estado, version) => ({
    secuencia: 12, tipo: `reserva.${estado}`, ocurrido_en: new Date().toISOString(), entidad: reserva(estado, version)
});

test("un webhook firmado se aplica; uno repetido no cambia nada", async t => {
    const { base, proyeccion, sincronizaciones } = await levantar(t);
    proyeccion.aplicarActividad(actividad);

    assert.equal((await webhook(base, evento("confirmada", 2))).status, 204);
    assert.equal((await webhook(base, evento("confirmada", 2))).status, 204);

    const estado = await (await fetch(`${base}/api/estado`)).json();
    assert.equal(estado.actividades[0].conteo.confirmada, 1);
    assert.deepEqual(estado.webhooks.map(w => w.aplicado), [false, true]);
    assert.deepEqual(estado.recibidos, { validos: 2, rechazados: 0 });
    assert.equal(sincronizaciones.length, 0, "la actividad ya era conocida");
});

test("una firma inválida o con otro secreto se rechaza con 401 y queda a la vista", async t => {
    const { base } = await levantar(t);

    assert.equal((await webhook(base, evento("confirmada", 2), "t=1,v1=00")).status, 401);
    const cuerpo = JSON.stringify(evento("confirmada", 2));
    assert.equal((await webhook(base, evento("confirmada", 2), firmar(cuerpo, crypto.randomBytes(32)))).status, 401);

    const estado = await (await fetch(`${base}/api/estado`)).json();
    assert.equal(estado.actividades.length, 0);
    assert.deepEqual(estado.recibidos, { validos: 0, rechazados: 2 });
    assert.equal(estado.webhooks[0].motivo, "Firma inválida");
});

test("un webhook de una actividad desconocida pide leer el feed", async t => {
    const { base, sincronizaciones } = await levantar(t);
    assert.equal((await webhook(base, evento("rechazada", 2))).status, 204);
    assert.equal(sincronizaciones.length, 1);
});

test("un webhook fuera de contrato se rechaza con 400", async t => {
    const { base } = await levantar(t);
    const malo = { ...evento("confirmada", 2), tipo: "reserva.inventada" };
    assert.equal((await webhook(base, malo)).status, 400);
});

test("crea la actividad con la metadata de dominio del perfil", async t => {
    const { json, llamadas, proyeccion } = await levantar(t, { crearActividad: { status: 201, cuerpo: actividad } });

    const respuesta = await json("POST", "/api/actividades", {
        nombre: " Turno 20 h ", capacidad: 10,
        metadata: { cancha: "Cancha 2", fecha: "2026-11-22", hora: "20:00", otra: "se descarta" }
    });

    assert.equal(respuesta.status, 201);
    assert.deepEqual(llamadas[0].cuerpo, {
        nombre: "Turno 20 h", capacidad: 10,
        metadata: { origen: "canchas", tipo: "turno", cancha: "Cancha 2", fecha: "2026-11-22", hora: "20:00" }
    });
    assert.equal(proyeccion.listar().length, 1);
});

test("rechaza datos inválidos antes de llamar a la API", async t => {
    const { json, llamadas } = await levantar(t);
    assert.equal((await json("POST", "/api/actividades", { nombre: "", capacidad: 10 })).status, 400);
    assert.equal((await json("POST", "/api/actividades", { nombre: "A", capacidad: 0 })).status, 400);
    assert.equal((await json("POST", "/api/actividades", { nombre: "A", capacidad: 5, metadata: { cancha: "Cancha 9" } })).status, 400);
    assert.equal((await json("POST", `/api/actividades/${ACTIVIDAD}/reservas`, { participante: "x" })).status, 400, "sin clave de idempotencia");
    assert.equal(llamadas.length, 0);
});

test("las escrituras exigen JSON y el mismo origen", async t => {
    const { base, json, llamadas } = await levantar(t);

    const formulario = await fetch(`${base}/api/actividades`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "nombre=A&capacidad=1"
    });
    assert.equal(formulario.status, 403);
    assert.equal((await json("POST", "/api/actividades", { nombre: "A", capacidad: 1 }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await json("POST", "/api/actividades", { nombre: "A", capacidad: 1 }, { Origin: "https://otro.example" })).status, 403);
    assert.equal(llamadas.length, 0);
});

test("un recurso de otro tenant responde 404 y lo explica", async t => {
    const { json } = await levantar(t, {
        consultarActividad: {
            status: 404,
            cuerpo: { type: "urn:reserva-cupos:problema:no-encontrado", title: "No encontrado", status: 404 }
        }
    });

    const respuesta = await json("GET", `/api/actividades/${AJENA}`);
    assert.equal(respuesta.status, 404);
    assert.match((await respuesta.json()).mensaje, /otro tenant/);
});

test("reserva con la clave de idempotencia del navegador y pasa el 429 con Retry-After", async t => {
    let limite = false;
    const { json, llamadas } = await levantar(t, {
        solicitarReserva: () => limite
            ? { status: 429, retryAfter: "3", cuerpo: { type: "urn:x", title: "Demasiadas solicitudes", status: 429 } }
            : { status: 202, cuerpo: reserva("pendiente", 1) }
    });

    const admitida = await json("POST", `/api/actividades/${ACTIVIDAD}/reservas`, { participante: "jugador-1", clave: "abcdef123456" });
    assert.equal(admitida.status, 202);
    assert.equal(llamadas[0].encabezados["Idempotency-Key"], "canchas-abcdef123456");

    limite = true;
    const limitada = await json("POST", `/api/actividades/${ACTIVIDAD}/reservas`, { participante: "jugador-2", clave: "abcdef123457" });
    assert.equal(limitada.status, 429);
    assert.equal(limitada.headers.get("retry-after"), "3");
});

test("la página se sirve con una política de contenido estricta", async t => {
    const { base } = await levantar(t);
    const pagina = await fetch(`${base}/`);
    assert.equal(pagina.status, 200);
    assert.match(pagina.headers.get("content-security-policy"), /default-src 'self'/);
    assert.match(await (await fetch(`${base}/tema.css`)).text(), /--acento:#15803d/);
});

test("metadataDeActividad solo guarda campos conocidos y con formato válido", () => {
    const eventos = perfil("eventos");
    assert.deepEqual(metadataDeActividad(eventos, { lugar: " Teatro ", fecha: "2026-12-01", cancha: "x" }),
        { origen: "eventos", tipo: "evento", lugar: "Teatro", fecha: "2026-12-01" });
    assert.throws(() => metadataDeActividad(eventos, { hora: "25 h" }), /Hora/);
    assert.throws(() => perfil("otro"), /VITRINA_PERFIL/);
});
