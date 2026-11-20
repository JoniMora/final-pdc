// Suite de seguridad de la API (Entrega 5, issue E5-6), contra el entorno
// levantado. Cada comprobación es un intento de ataque o de abuso y su
// rechazo esperado:
//
//   - aislamiento entre tenants: el recurso de otro tenant responde 404;
//   - permisos: una clave sin el scope de la operación responde 403;
//   - administración: una clave de tenant no usa /admin (403) y rotar la
//     clave invalida la anterior;
//   - límite de tasa: un tenant saturado recibe 429 y otro no se entera;
//   - webhooks: firma inválida y reinyección fuera de la ventana → 401;
//   - SSRF: un webhook a una dirección interna o por HTTP va a la DLQ sin
//     que el notificador se conecte.
//
// Uso, desde reserva-cupos: node pruebas/seguridad/api.js
// Evidencia: docs/entrega-5/evidencias/seguridad-api.txt

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
    RAIZ, AULA, docker, api, pedir, claveOperador, crearTenant, esperarHasta, Evidencia, ejecutar
} = require("../comun");

function secretoWebhookAula() {
    const compose = fs.readFileSync(path.join(RAIZ, "docker-compose.yml"), "utf8");
    return Buffer.from(/WEBHOOK_SECRET: ([0-9a-f]{64})/.exec(compose)[1], "hex");
}

function firmar(secreto, cuerpo, t) {
    return `t=${t},v1=${crypto.createHmac("sha256", secreto).update(`${t}.${cuerpo}`).digest("hex")}`;
}

function mensajesEnDlq() {
    const salida = docker(["exec", "-T", "rabbitmq", "rabbitmqctl", "-q", "list_queues", "name", "messages"]);
    const fila = salida.split("\n").find(linea => linea.startsWith("webhooks.dlq"));
    return Number(fila?.split(/\s+/)[1] || 0);
}

async function prueba({ ok, dato }) {
    const operador = api(claveOperador());

    // --- Administración ------------------------------------------------
    const a = await crearTenant(`Seguridad A ${Date.now()}`);
    const b = await crearTenant(`Seguridad B ${Date.now()}`);
    const lector = await crearTenant(`Solo lectura ${Date.now()}`, { scopes: ["lectura", "cambios:leer"] });
    ok("El operador da de alta tenants con POST /admin/v1/tenants (201); la clave se muestra una sola vez");

    assert.equal((await pedir("https://localhost:3000/admin/v1/tenants/" + a.id)).status, 401);
    assert.equal((await api(a.clave_api)(`/admin/v1/tenants/${a.id}`)).status, 403);
    assert.equal((await api(a.clave_api)("/admin/v1/tenants", { metodo: "POST", cuerpo: { nombre: "intruso" } })).status, 403);
    ok("Sin clave /admin responde 401 y con una clave de tenant responde 403");

    const consultado = await operador(`/admin/v1/tenants/${a.id}`);
    assert.equal(consultado.status, 200);
    assert.equal(consultado.datos.clave_api, undefined);
    ok("La consulta del tenant no devuelve credenciales");

    // --- Aislamiento entre tenants ---------------------------------------
    const actividadA = await api(a.clave_api)("/v1/actividades", {
        metodo: "POST",
        cuerpo: { nombre: "Actividad de A", capacidad: 2 }
    });
    assert.equal(actividadA.status, 201);

    const reservaA = await api(a.clave_api)(`/v1/actividades/${actividadA.datos.id}/reservas`, {
        metodo: "POST",
        cuerpo: { participante: "ana" },
        encabezados: { "Idempotency-Key": crypto.randomUUID() }
    });
    assert.equal(reservaA.status, 202);

    assert.equal((await api(b.clave_api)(`/v1/actividades/${actividadA.datos.id}`)).status, 404);
    assert.equal((await api(b.clave_api)(`/v1/reservas/${reservaA.datos.id}`)).status, 404);
    assert.equal((await api(b.clave_api)(`/v1/reservas/${reservaA.datos.id}/cancelacion`, { metodo: "POST" })).status, 404);
    assert.equal((await api(b.clave_api)(`/v1/actividades/${actividadA.datos.id}/reservas`, {
        metodo: "POST",
        cuerpo: { participante: "intruso" },
        encabezados: { "Idempotency-Key": crypto.randomUUID() }
    })).status, 404);

    const feedB = await api(b.clave_api)("/v1/cambios?desde=0&limite=500");
    assert.equal(feedB.status, 200);
    assert.equal(feedB.datos.datos.some(cambio => cambio.entidad.id === actividadA.datos.id), false);
    ok("Otro tenant no ve ni opera la actividad, la reserva ni el feed de A: responde 404 como si no existieran");

    // --- Permisos (scopes) ------------------------------------------------
    const lectura = api(lector.clave_api);
    assert.deepEqual(lector.scopes, ["lectura", "cambios:leer"]);

    const crear = await lectura("/v1/actividades", { metodo: "POST", cuerpo: { nombre: "No", capacidad: 1 } });
    assert.equal(crear.status, 403);
    assert.equal(crear.datos.type, "urn:reserva-cupos:problema:permiso-insuficiente");

    const actividadLector = await operador(`/admin/v1/tenants/${lector.id}`, {
        metodo: "PATCH",
        cuerpo: { scopes: ["lectura", "cambios:leer", "actividades:escribir"] }
    });
    assert.equal(actividadLector.status, 200);

    const propia = await lectura("/v1/actividades", { metodo: "POST", cuerpo: { nombre: "Propia", capacidad: 1 } });
    assert.equal(propia.status, 201);
    assert.equal((await lectura(`/v1/actividades/${propia.datos.id}/reservas`, {
        metodo: "POST",
        cuerpo: { participante: "x" },
        encabezados: { "Idempotency-Key": crypto.randomUUID() }
    })).status, 403);
    assert.equal((await lectura(`/v1/actividades/${propia.datos.id}`)).status, 200);
    assert.equal((await lectura("/v1/cambios")).status, 200);
    ok("Una clave de solo lectura consulta pero no crea ni reserva (403 permiso-insuficiente); el operador cambia sus permisos con PATCH");

    // --- Rotación ---------------------------------------------------------
    const rotada = await operador(`/admin/v1/tenants/${b.id}/rotacion`, { metodo: "POST" });
    assert.equal(rotada.status, 200);
    assert.equal((await api(b.clave_api)("/v1/cambios")).status, 401);
    assert.equal((await api(rotada.datos.clave_api)("/v1/cambios")).status, 200);
    ok("Rotar la clave invalida la anterior en el momento (401) y la nueva autentica");

    const desactivado = await operador(`/admin/v1/tenants/${b.id}`, { metodo: "PATCH", cuerpo: { activo: false } });
    assert.equal(desactivado.status, 200);
    assert.equal((await api(rotada.datos.clave_api)("/v1/cambios")).status, 401);
    ok("Un tenant desactivado deja de autenticarse");

    // --- Límite de tasa ---------------------------------------------------
    const saturado = await crearTenant(`Saturado ${Date.now()}`, { limite: { por_segundo: 5, rafaga: 10 } });
    const vecino = await crearTenant(`Vecino ${Date.now()}`, { limite: { por_segundo: 5, rafaga: 10 } });

    const [rafaga, delVecino] = await Promise.all([
        Promise.all(Array.from({ length: 40 }, () => api(saturado.clave_api)("/v1/cambios"))),
        (async () => {
            const respuestas = [];
            for (let i = 0; i < 8; i++) respuestas.push(await api(vecino.clave_api)("/v1/cambios"));
            return respuestas;
        })()
    ]);

    const rechazadas = rafaga.filter(r => r.status === 429);
    assert.ok(rechazadas.length >= 25, `se esperaban al menos 25 respuestas 429, hubo ${rechazadas.length}`);
    assert.ok(rechazadas.every(r => Number(r.encabezados["retry-after"]) >= 1));
    assert.equal(rechazadas[0].datos.type, "urn:reserva-cupos:problema:limite-de-tasa");
    assert.ok(delVecino.every(r => r.status === 200));
    dato(`40 solicitudes simultáneas con límite 5/s y ráfaga 10: ${rafaga.length - rechazadas.length} atendidas, ${rechazadas.length} con 429 y Retry-After`);
    dato("8 solicitudes del vecino al mismo tiempo: todas 200");
    ok("Un tenant saturado recibe 429 con Retry-After y otro tenant no se ve afectado");

    // --- Webhooks: firma y reinyección -----------------------------------
    const evento = JSON.stringify({
        secuencia: 1,
        tipo: "reserva.confirmada",
        ocurrido_en: new Date().toISOString(),
        entidad: {
            id: crypto.randomUUID(),
            actividad_id: crypto.randomUUID(),
            participante: "falso",
            estado: "confirmada",
            version: 99,
            metadata: null,
            creado_en: new Date().toISOString()
        }
    });
    const ahora = Math.floor(Date.now() / 1000);
    const webhook = firma => pedir(`${AULA}/webhooks/reservas`, {
        metodo: "POST",
        cuerpo: JSON.parse(evento),
        encabezados: { "X-Firma": firma, "X-Webhook-Id": "prueba-seguridad" }
    });

    assert.equal((await webhook(firmar(Buffer.alloc(32, 7), evento, ahora))).status, 401);
    ok("Webhook firmado con otro secreto: Aula responde 401 y no lo aplica");

    assert.equal((await webhook(firmar(secretoWebhookAula(), evento, ahora - 600))).status, 401);
    ok("Webhook bien firmado pero de hace 10 minutos (reinyección): Aula responde 401");

    // --- SSRF -------------------------------------------------------------
    const dlqAntes = mensajesEnDlq();
    const destinos = [
        "https://169.254.169.254/latest/meta-data",
        "https://mysql-primary:3306/",
        "http://aula:3001/webhooks/reservas"
    ];

    for (const destino of destinos) {
        const tenant = await crearTenant(`SSRF ${Date.now()}`, { webhook_url: destino });
        assert.match(tenant.webhook_secreto, /^[0-9a-f]{64}$/);

        const actividad = await api(tenant.clave_api)("/v1/actividades", {
            metodo: "POST",
            cuerpo: { nombre: "SSRF", capacidad: 1 }
        });
        await api(tenant.clave_api)(`/v1/actividades/${actividad.datos.id}/reservas`, {
            metodo: "POST",
            cuerpo: { participante: "x" },
            encabezados: { "Idempotency-Key": crypto.randomUUID() }
        });
    }

    await esperarHasta(() => mensajesEnDlq() >= dlqAntes + destinos.length, {
        plazoMs: 60000,
        descripcion: "que los tres webhooks lleguen a webhooks.dlq"
    });

    const registros = docker(["logs", "--since", "2m", "notificador"]);
    assert.match(registros, /destino rechazado, a webhooks\.dlq: Dirección interna no permitida: 169\.254\.169\.254/);
    assert.match(registros, /destino rechazado, a webhooks\.dlq: mysql-primary resuelve a una dirección interna/);
    assert.match(registros, /destino rechazado, a webhooks\.dlq: Se requiere HTTPS/);
    ok("Webhooks a 169.254.169.254, a mysql-primary y por HTTP: el notificador no se conecta y los deriva a webhooks.dlq");
}

ejecutar(new Evidencia("seguridad-api.txt", "Suite de seguridad de la API (E5-6)"), prueba)
    .then(codigo => { process.exitCode = codigo; });
