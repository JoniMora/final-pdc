// Seguridad de los componentes que agrega la Entrega 6: Redis, Prometheus,
// Grafana y los puertos de métricas. Complementa pruebas/seguridad/cifrado.js
// (Entrega 5) y deja docs/entrega-6/evidencias/seguridad-componentes.txt.
//
// Uso, desde reserva-cupos, con el entorno levantado:
//   node pruebas/final/seguridad-componentes.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { RAIZ, docker, dockerDirecto, pedir, crearTenant, api, Evidencia, ejecutar } = require("../comun");

// La salida va con las evidencias de la Entrega 6 (Evidencia parte de las de E5).
const evidencia = new Evidencia("../../entrega-6/evidencias/seguridad-componentes.txt",
    "Seguridad de los componentes de la Entrega 6 (Redis, Prometheus, Grafana, métricas)");

const LOCAL = path.join(RAIZ, "seguridad/local");

function redisCli(args) {
    return docker(["exec", "-T", "redis", "redis-cli", "-h", "redis", ...args], { permitirFallo: true });
}

// Publicación de un puerto del contenedor en el equipo: "127.0.0.1:9090" o nada.
function publicado(servicio, puerto) {
    const [id] = docker(["ps", "-q", servicio]).trim().split("\n");
    try {
        return dockerDirecto(["port", id, String(puerto)]).trim().split("\n").filter(Boolean);
    } catch {
        return []; // "No public port ... published"
    }
}

async function sinTls(url) {
    try {
        const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
        return `HTTP ${r.status}`;
    } catch (error) {
        return error.cause?.code || error.message;
    }
}

ejecutar(evidencia, async ({ ok, dato }) => {
    // --- Redis ---------------------------------------------------------------
    const plano = redisCli(["--no-auth-warning", "ping"]);
    assert.ok(!plano || !plano.includes("PONG"), "Redis respondió sin TLS");
    dato(`redis-cli sin TLS: ${(plano || "conexión rechazada").trim() || "conexión cerrada"}`);

    const sinClave = docker(["exec", "-T", "redis", "sh", "-c",
        "REDISCLI_AUTH= redis-cli --tls --cacert /tls/ca.crt -h redis ping"], { permitirFallo: true }) || "";
    assert.match(sinClave, /NOAUTH/);
    const conClave = redisCli(["--tls", "--cacert", "/tls/ca.crt", "--no-auth-warning", "ping"]);
    assert.equal(conClave.trim(), "PONG");
    dato(`Con TLS y sin contraseña: ${sinClave.trim()}; con TLS y contraseña: ${conClave.trim()}`);
    assert.deepEqual(publicado("redis", 6379), []);
    ok("Redis solo atiende TLS, exige contraseña y no publica puertos en el equipo");

    // La caché guarda id, permisos y límites; nunca la clave ni el secreto del webhook.
    const tenant = await crearTenant(`Seguridad E6 ${Date.now()}`, { webhook_url: "https://aula:3001/webhooks/reservas" });
    assert.equal((await api(tenant.clave_api)("/v1/cambios?limite=1")).status, 200);
    const claves = redisCli(["--tls", "--cacert", "/tls/ca.crt", "--no-auth-warning", "--scan", "--pattern", "pdc:auth:*:*"])
        .trim().split("\n").filter(Boolean);
    assert.ok(claves.length > 0, "la caché de autenticación está vacía");
    const valores = claves.map(clave => redisCli(["--tls", "--cacert", "/tls/ca.crt", "--no-auth-warning", "get", clave]));
    for (const valor of valores) {
        assert.ok(!valor.includes(tenant.clave_api) && !/rc_[a-f0-9]{64}/.test(valor), "la caché guarda una clave de API");
        assert.ok(!valor.includes(tenant.webhook_secreto), "la caché guarda el secreto del webhook");
        assert.ok(!/webhook_secret/.test(valor), "la caché guarda el secreto del webhook");
    }
    const campos = Object.keys(JSON.parse(valores.find(v => v.trim().startsWith("{")) || "{}"));
    dato(`${claves.length} entradas en la caché; campos guardados: ${campos.join(", ")}`);
    ok("La caché de autenticación no contiene claves de API ni secretos de webhook (la clave de cada entrada es el hash)");

    // --- Prometheus ----------------------------------------------------------
    assert.deepEqual(publicado("prometheus", 9090), ["127.0.0.1:9090"]);
    const promPlano = await sinTls("http://localhost:9090/-/healthy");
    assert.ok(!promPlano.startsWith("HTTP 2"), "Prometheus respondió por HTTP");
    const promTls = await pedir("https://localhost:9090/api/v1/targets?state=active");
    assert.equal(promTls.status, 200);
    const objetivos = promTls.datos.data.activeTargets;
    assert.ok(objetivos.every(o => o.scrapeUrl.startsWith("https://")), "un destino se recolecta sin TLS");
    const caidos = objetivos.filter(o => o.health !== "up").map(o => o.scrapeUrl);
    dato(`Prometheus: publicado en 127.0.0.1:9090; HTTP → ${promPlano}; ${objetivos.length} destinos, todos por HTTPS` +
        (caidos.length ? `; sin respuesta: ${caidos.join(", ")}` : ", todos up"));
    ok("Prometheus solo por HTTPS en 127.0.0.1 y recolecta cada destino por HTTPS");

    // --- Grafana -------------------------------------------------------------
    assert.deepEqual(publicado("grafana", 3000), ["127.0.0.1:3002"]);
    const graPlano = await sinTls("http://localhost:3002/api/health");
    assert.ok(!graPlano.startsWith("HTTP 2"), "Grafana respondió por HTTP");
    const basica = (usuario, clave) => ({ Authorization: `Basic ${Buffer.from(`${usuario}:${clave}`).toString("base64")}` });
    const fabrica = await pedir("https://localhost:3002/api/user", { encabezados: basica("admin", "admin") });
    assert.equal(fabrica.status, 401);
    const generada = fs.readFileSync(path.join(LOCAL, "grafana-admin.txt"), "utf8").trim();
    const propia = await pedir("https://localhost:3002/api/user", { encabezados: basica("admin", generada) });
    assert.equal(propia.status, 200);
    dato(`Grafana: publicado en 127.0.0.1:3002; HTTP → ${graPlano}; admin/admin → ${fabrica.status}; contraseña generada → ${propia.status}`);
    ok("Grafana solo por HTTPS en 127.0.0.1, sin la contraseña de fábrica");

    // --- Métricas de los servicios ------------------------------------------
    for (const servicio of ["api", "worker", "relay", "notificador"]) {
        assert.deepEqual(publicado(servicio, 9464), [], `${servicio} publica su puerto de métricas`);
    }
    const porGateway = await pedir("https://localhost:3000/metrics");
    assert.equal(porGateway.status, 404);
    dato(`Puerto 9464 sin publicar en api, worker, relay y notificador; GET https://localhost:3000/metrics → ${porGateway.status}`);
    ok("Las métricas de los servicios solo se leen desde la red interna (Prometheus), no por el gateway");
}).then(codigo => { process.exitCode = codigo; });
