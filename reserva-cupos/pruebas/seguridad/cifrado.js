// Cifrado en tránsito (Entrega 5, issues E5-8, E5-9 y E5-10), contra el
// entorno levantado. Para cada enlace se prueba lo positivo (la conexión
// con TLS verificado funciona y los componentes la usan) y lo negativo (el
// texto plano o un certificado no confiable se rechazan). Además captura
// tráfico entre Traefik y la API para mostrar que el contenido viaja
// cifrado, y comprueba que Traefik solo puede leer Docker.
//
// Uso, desde reserva-cupos: node pruebas/seguridad/cifrado.js
// Evidencias: docs/entrega-5/evidencias/cifrado.txt y captura-trafico.txt

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const tls = require("node:tls");
const { spawn } = require("node:child_process");
const {
    RAIZ, API, AULA, CA, docker, mysql, psql, contenedores, pedir, api, crearTenant, esperar, Evidencia, ejecutar
} = require("../comun");

// Handshake TLS directo, para ver qué certificado y protocolo negocia cada
// puerto publicado. Con ca: null se usan solo las CA públicas del sistema,
// como un cliente que no confía en la CA local.
function handshake(puerto, { ca = CA, servername = "localhost" } = {}) {
    return new Promise((resolve, reject) => {
        const socket = tls.connect({ host: "127.0.0.1", port: puerto, ca: ca ?? undefined, servername }, () => {
            const resultado = {
                protocolo: socket.getProtocol(),
                cifrado: socket.getCipher().name,
                certificado: socket.getPeerCertificate().subject.CN
            };
            socket.end();
            resolve(resultado);
        });
        socket.on("error", reject);
    });
}

// Un pedido HTTP en texto plano a un puerto TLS no tiene que obtener datos.
function textoPlano(puerto) {
    return new Promise(resolve => {
        const solicitud = http.get({ host: "127.0.0.1", port: puerto, path: "/health", timeout: 5000 }, respuesta => {
            respuesta.resume();
            resolve(`HTTP ${respuesta.statusCode}`);
        });
        solicitud.on("timeout", () => solicitud.destroy(new Error("timeout")));
        solicitud.on("error", error => resolve(error.code || error.message));
    });
}

function ejecutarEn(servicio, ...comando) {
    return docker(["exec", "-T", servicio, ...comando], { permitirFallo: true });
}

async function prueba({ ok, dato }) {
    // --- HTTPS publicado: API (Traefik), clientes de referencia y panel ------
    const publicados = [["API (Traefik)", 3000], ["Aula", 3001], ["Canchas", 3003], ["Eventos", 3004], ["Panel de Traefik", 8080]];
    for (const [nombre, puerto] of publicados) {
        const sesion = await handshake(puerto);
        dato(`${nombre} en ${puerto}: ${sesion.protocolo}, ${sesion.cifrado}, certificado CN=${sesion.certificado}`);
        await assert.rejects(handshake(puerto, { ca: null }), /self-signed|unable to verify|SELF_SIGNED|local issuer/i);
        await assert.rejects(handshake(puerto, { servername: "otro-nombre.ejemplo" }), /altnames|Hostname/i);
    }
    ok("API, Aula, Canchas, Eventos y panel: TLS 1.2+ verificado con la CA local; sin la CA o con otro nombre, el cliente rechaza la conexión");

    for (const [, puerto] of publicados) {
        const resultado = await textoPlano(puerto);
        dato(`HTTP sin TLS al puerto ${puerto}: ${resultado}`);
        assert.ok(!/HTTP 2\d\d/.test(resultado));
    }
    ok("Un pedido HTTP sin cifrar a los puertos publicados no obtiene respuesta válida");

    // Traefik → API: la API solo atiende HTTPS dentro de la red.
    const apiPlano = ejecutarEn("api", "node", "-e",
        "require('http').get('http://localhost:3000/health',r=>{console.log(r.statusCode);process.exit(0)}).on('error',e=>{console.log(e.code);process.exit(0)})");
    dato(`API por HTTP dentro de su contenedor: ${apiPlano.trim()}`);
    assert.doesNotMatch(apiPlano, /^200/);
    const salud = await pedir(`${API}/health`);
    assert.equal(salud.status, 200);
    ok("Traefik → API va por HTTPS (la API no atiende texto plano) y Traefik verifica el certificado \"api\"");

    // --- MySQL ------------------------------------------------------------
    const sesiones = mysql("mysql-primary", `
        SELECT t.PROCESSLIST_USER, s.ssl_version, s.ssl_cipher
          FROM sys.session_ssl_status s
          JOIN performance_schema.threads t ON t.THREAD_ID = s.thread_id
         WHERE t.PROCESSLIST_USER IN ('api_app', 'worker_app', 'relay_app', 'notificador_app', 'admin_app', 'replicador')
         ORDER BY 1;`, { base: "" }).trim().split("\n").map(linea => linea.split("\t"));

    const usuarios = new Set(sesiones.map(([usuario]) => usuario));
    for (const usuario of ["api_app", "worker_app", "relay_app", "notificador_app", "replicador"]) {
        assert.ok(usuarios.has(usuario), `sin conexiones de ${usuario}`);
    }
    for (const [usuario, version, cifrado] of sesiones) {
        assert.ok(version && cifrado, `conexión sin TLS de ${usuario}`);
    }
    const resumen = {};
    for (const [usuario, version, cifrado] of sesiones) resumen[`${usuario} ${version} ${cifrado}`] = (resumen[`${usuario} ${version} ${cifrado}`] || 0) + 1;
    for (const [linea, cantidad] of Object.entries(resumen)) dato(`MySQL primario: ${cantidad} conexión(es) de ${linea}`);
    ok("Todas las conexiones de los servicios y de la réplica al primario tienen Ssl_version y Ssl_cipher");

    const plano = docker(["exec", "-T", "mysql-primary", "sh", "-c",
        'mysql -h 127.0.0.1 --ssl-mode=DISABLED -uroot -p"$MYSQL_ROOT_PASSWORD" -e "SELECT 1" 2>&1'], { permitirFallo: true })
        ?? "rechazada";
    dato(`MySQL con --ssl-mode=DISABLED: ${plano.replace(/mysql: \[Warning\].*\n/, "").trim() || "rechazada"}`);
    assert.doesNotMatch(plano, /^1$/m);
    ok("MySQL rechaza una conexión por red sin TLS (require_secure_transport)");

    const verificado = docker(["exec", "-T", "mysql-primary", "sh", "-c",
        'mysql -h mysql-primary --ssl-mode=VERIFY_IDENTITY --ssl-ca=/tls/ca.crt -uroot -p"$MYSQL_ROOT_PASSWORD" -N -e "SHOW SESSION STATUS LIKE \'Ssl_cipher\'" 2>/dev/null']);
    assert.match(verificado, /Ssl_cipher\s+\S+/);
    ok("MySQL acepta una conexión TLS que verifica la CA y el nombre mysql-primary");

    const replica = mysql("mysql-replica", "SHOW REPLICA STATUS\\G", { base: "", nombres: true });
    for (const campo of ["Source_SSL_Allowed: Yes", "Source_SSL_Verify_Server_Cert: Yes", "Replica_IO_Running: Yes", "Replica_SQL_Running: Yes"]) {
        assert.ok(replica.includes(campo), campo);
    }
    ok("La replicación usa TLS y verifica el certificado del primario (SOURCE_SSL, VERIFY_SERVER_CERT)");

    // --- RabbitMQ -----------------------------------------------------------
    const conexiones = docker(["exec", "-T", "rabbitmq", "rabbitmqctl", "-q", "list_connections", "user", "ssl", "ssl_protocol"])
        .trim().split("\n").filter(linea => linea && !linea.startsWith("user")).map(linea => linea.split(/\s+/));
    assert.ok(conexiones.length >= 3, `se esperaban al menos 3 conexiones, hay ${conexiones.length}`);
    assert.ok(conexiones.every(([, ssl]) => ssl === "true"));
    dato(`RabbitMQ: ${conexiones.length} conexiones, todas ssl=true (${[...new Set(conexiones.map(c => c[2]))].join(", ")})`);
    ok("rabbitmqctl list_connections: ssl=true en todas las conexiones (relay, worker, notificador)");

    const listeners = docker(["exec", "-T", "rabbitmq", "rabbitmq-diagnostics", "-q", "listeners"]);
    assert.match(listeners, /5671/);
    assert.doesNotMatch(listeners, /port: 5672,/);
    const amqpPlano = ejecutarEn("relay", "node", "-e",
        "require('net').connect(5672,'rabbitmq').on('connect',()=>{console.log('abierto');process.exit(0)}).on('error',e=>{console.log(e.code);process.exit(0)})");
    dato(`AMQP sin TLS (rabbitmq:5672) desde el relay: ${amqpPlano.trim()}`);
    assert.doesNotMatch(amqpPlano, /abierto/);
    ok("RabbitMQ solo escucha AMQPS (5671): el puerto 5672 está cerrado");

    // --- PostgreSQL ---------------------------------------------------------
    const pgSesiones = psql(`SELECT a.usename, s.ssl, s.version
                               FROM pg_stat_ssl s JOIN pg_stat_activity a USING (pid)
                              WHERE a.usename = 'aula_app';`).trim().split("\n").filter(Boolean);
    assert.ok(pgSesiones.length > 0, "Aula no tiene conexiones abiertas");
    assert.ok(pgSesiones.every(linea => linea.split("|")[1] === "t"));
    dato(`PostgreSQL: ${pgSesiones.length} conexión(es) de aula_app, todas con ssl=t (${pgSesiones[0].split("|")[2]})`);
    ok("Aula → aula-db: todas las conexiones usan TLS");

    // La contraseña de aula_app se toma del entorno de Aula, no se repite acá.
    const clavePg = `PGPASSWORD=${docker(["exec", "-T", "aula", "printenv", "PGPASSWORD"]).trim()}`;
    const pgPlano = docker(["exec", "-T", "-e", clavePg, "aula-db", "psql",
        "postgresql://aula_app@aula-db/aula?sslmode=disable", "-c", "SELECT 1"], { permitirFallo: true });
    assert.equal(pgPlano, null);
    const pgVerificado = docker(["exec", "-T", "-e", clavePg, "aula-db", "psql",
        "postgresql://aula_app@aula-db/aula?sslmode=verify-full&sslrootcert=/tls/ca.crt", "-At", "-c",
        "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()"]);
    assert.equal(pgVerificado.trim(), "t");
    ok("PostgreSQL rechaza la conexión sin TLS (pg_hba) y acepta la verificada (sslmode=verify-full)");

    // --- Webhooks por HTTPS ------------------------------------------------------
    const entregados = docker(["logs", "--since", "30m", "notificador"]);
    assert.match(entregados, /entregado a aula:3001/);
    ok("El notificador entrega los webhooks a https://aula:3001 (una URL http:// va a la DLQ: ver seguridad-api.txt)");

    // --- Socket de Docker (E5-10) --------------------------------------------
    assert.equal(ejecutarEn("traefik", "test", "-e", "/var/run/docker.sock"), null);
    const lectura = ejecutarEn("traefik", "wget", "-q", "-O", "-", "http://socket-proxy:2375/containers/json");
    assert.ok(lectura && JSON.parse(lectura).length > 0);
    const escritura = docker(["exec", "-T", "traefik", "sh", "-c",
        "wget -q -O - --post-data='{}' --header='Content-Type: application/json' http://socket-proxy:2375/containers/create 2>&1; true"]);
    dato(`POST /containers/create a través del proxy: ${escritura.trim().split("\n").pop()}`);
    assert.match(escritura, /403/);
    const panel = await pedir("https://localhost:8080/api/http/services/api@docker");
    assert.equal(panel.status, 200);
    assert.ok(Object.values(panel.datos.serverStatus).includes("UP"));
    ok("Traefik no monta el socket de Docker: lee por el proxy (el descubrimiento sigue funcionando) y una escritura responde 403");

    await capturarTrafico({ ok, dato });
}

// Captura entre Traefik y la API mientras se crea una actividad con un
// nombre conocido. Si el tráfico estuviera en texto plano, el nombre
// aparecería en la captura.
async function capturarTrafico({ ok, dato }) {
    const [traefik] = contenedores("traefik");
    const marcador = `MARCADOR-${crypto.randomBytes(6).toString("hex")}`;
    const tenant = await crearTenant(`Captura ${Date.now()}`);

    const tcpdump = spawn("docker", [
        "run", "--rm", "--net", `container:${traefik}`, "nicolaka/netshoot:v0.13",
        "timeout", "20", "tcpdump", "-i", "any", "-nn", "-X", "-s", "0", "-c", "60", "tcp port 3000"
    ], { cwd: RAIZ });

    let salida = "";
    tcpdump.stdout.on("data", parte => { salida += parte; });
    tcpdump.stderr.on("data", parte => { salida += parte; });
    const fin = new Promise(resolve => tcpdump.on("close", resolve));

    await esperar(4000);

    for (let i = 0; i < 5; i++) {
        const creada = await api(tenant.clave_api)("/v1/actividades", {
            metodo: "POST",
            cuerpo: { nombre: marcador, capacidad: 1 }
        });
        assert.equal(creada.status, 201);
    }

    await fin;

    const paquetes = (salida.match(/ IP /g) || []).length;
    assert.ok(paquetes > 10, `la captura tiene ${paquetes} paquetes`);
    assert.equal(salida.includes(marcador), false);
    assert.equal(/Authorization|Bearer|application\/json/.test(salida), false);
    // 0x17 0x03 0x03: registro TLS 1.2/1.3 de datos de aplicación.
    assert.match(salida, /1703 03/);

    fs.writeFileSync(path.resolve(RAIZ, "../docs/entrega-5/evidencias/captura-trafico.txt"), [
        "Captura de tráfico Traefik → API (puerto 3000 de la API) con tcpdump",
        `Ejecución: ${new Date().toISOString()}`,
        `Se crearon 5 actividades con el nombre "${marcador}" por https://localhost:3000.`,
        `Paquetes capturados: ${paquetes}. El nombre, la clave (Bearer) y las cabeceras HTTP no aparecen:`,
        "el contenido viaja en registros TLS (0x17 0x03 0x03 = application data).",
        "",
        "Primeras líneas de la captura:",
        ...salida.split("\n").slice(0, 40),
        ""
    ].join("\n"));

    dato(`Captura Traefik → API: ${paquetes} paquetes; el texto "${marcador}" no aparece y sí registros TLS 0x17 0x03 0x03`);
    ok("Captura de tráfico: el contenido entre Traefik y la API viaja cifrado (captura-trafico.txt)");
}

ejecutar(new Evidencia("cifrado.txt", "Cifrado en tránsito y socket de Docker (E5-8, E5-9, E5-10)"), prueba)
    .then(codigo => { process.exitCode = codigo; });
