// Operación del entorno local con un solo comando por acción. Funciona igual
// en macOS, Linux y Windows (PowerShell, terminal de IntelliJ): solo
// necesita Node.js 22, Docker y OpenSSL (en Windows, el que trae Git).
//
// Uso, desde reserva-cupos:
//   node scripts/sistema.js demo [--particiones 4]   todo lo siguiente en un comando, listo para la demo
//   node scripts/sistema.js preparar     certificados, identidades, clave del operador y de Grafana
//   node scripts/sistema.js levantar     compose up + réplica configurada y cifrada + admin de Grafana
//   node scripts/sistema.js estado       contenedores y replicación
//   node scripts/sistema.js tenant <nombre> [--limite <por_segundo>/<rafaga>] [--scopes a,b]
//   node scripts/sistema.js seguridad    pruebas de acceso, cifrado y Aula (evidencias)
//   node scripts/sistema.js fallos [escenario...]   matriz de fallos (evidencias)
//   node scripts/sistema.js failover     promueve la réplica si se cae el primario
//   node scripts/sistema.js restaurar [--confirmar]   vuelve a primario + réplica (BORRA los datos)
//   node scripts/sistema.js detener      detiene sin borrar datos
//
// "levantar" no borra volúmenes. Esta entrega cambia los scripts iniciales
// de MySQL y PostgreSQL: quien viene de la Entrega 4 tiene que empezar con
// volúmenes nuevos (docker compose down -v).

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const RAIZ = path.resolve(__dirname, "..");

function compose(args, opciones = {}) {
    return execFileSync("docker", ["compose", ...args], {
        cwd: RAIZ,
        encoding: "utf8",
        stdio: opciones.capturar ? ["pipe", "pipe", "pipe"] : "inherit",
        ...opciones
    });
}

function mysqlReplica(sql) {
    return compose(["exec", "-T", "mysql-replica", "sh", "-c", 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -B 2>/dev/null'],
        { capturar: true, input: sql });
}

function nodo(script, args = []) {
    execFileSync(process.execPath, [path.join(RAIZ, script), ...args], { cwd: RAIZ, stdio: "inherit" });
}

const esperar = ms => new Promise(resolve => setTimeout(resolve, ms));

// La réplica se configura una vez por instalación. Si ya tiene canal, no
// se toca: conserva su posición GTID.
async function configurarReplica() {
    if (mysqlReplica("SHOW REPLICA STATUS").trim()) {
        console.log("Réplica: ya estaba configurada.");
    } else {
        compose(["exec", "-T", "mysql-replica", "sh", "-c",
            'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" 2>/dev/null < /configurar-replica.sql']);
        console.log("Réplica: canal configurado con TLS.");
    }

    for (let i = 0; i < 30; i++) {
        const estado = mysqlReplica(
            "SELECT SERVICE_STATE FROM performance_schema.replication_connection_status " +
            "UNION ALL SELECT SERVICE_STATE FROM performance_schema.replication_applier_status"
        ).trim().split("\n");

        if (estado.length === 2 && estado.every(valor => valor === "ON")) {
            console.log("Réplica: conectada al primario por TLS y aplicando.");
            return;
        }

        await esperar(1000);
    }

    throw new Error("La réplica no quedó conectada en 30 s (ver: docker compose logs mysql-replica)");
}

// Después del failover (pruebas/fallos/matriz.js mysql-primary) la réplica
// tiene el alias mysql-primary. Levantar de nuevo arrancaría el primario
// viejo con el mismo nombre: dos primarios. Se exige recrear el entorno.
function exigirTopologiaOriginal() {
    const replica = compose(["ps", "-a", "-q", "mysql-replica"], { capturar: true }).trim();

    if (!replica) return;

    const redes = execFileSync("docker", ["inspect", "-f", "{{json .NetworkSettings.Networks}}", replica], { encoding: "utf8" });
    const promovida = Object.values(JSON.parse(redes)).some(red => (red.Aliases || []).includes("mysql-primary"));

    if (promovida) {
        throw new Error("La réplica fue promovida a primario (failover). Para volver a la topología inicial: " +
            "node scripts/sistema.js restaurar (borra los datos del entorno)");
    }
}

// Grafana toma la contraseña generada solo al crear el admin en un volumen
// nuevo. En un volumen anterior (con admin/admin de fábrica) se fija acá,
// así que siempre coincide con seguridad/local/grafana-admin.txt.
function sincronizarGrafana() {
    const password = fs.readFileSync(path.join(RAIZ, "seguridad/local/grafana-admin.txt"), "utf8").trim();

    compose(["exec", "-T", "grafana", "grafana", "cli", "admin", "reset-admin-password", "--password-from-stdin"],
        { capturar: true, input: password });
    console.log("Grafana: contraseña del admin tomada de seguridad/local/grafana-admin.txt.");
}

async function levantar() {
    exigirTopologiaOriginal();
    compose(["up", "--build", "-d", "--wait", "--wait-timeout", "600"]);
    await configurarReplica();
    sincronizarGrafana();
    console.log("Entorno listo: API https://localhost:3000 · Aula https://localhost:3001 · " +
        "panel de Traefik https://localhost:8080/dashboard/ · Prometheus https://localhost:9090 · " +
        "Grafana https://localhost:3002 (credenciales en seguridad/local/accesos-locales.txt)");
}

function estado() {
    compose(["ps", "-a"]);
    process.stdout.write(mysqlReplica(
        "SELECT CONCAT('Réplica: IO ', c.SERVICE_STATE, ' · SQL ', a.SERVICE_STATE) " +
        "FROM performance_schema.replication_connection_status c, performance_schema.replication_applier_status a"
    ) || "Réplica: sin configurar\n");
}

async function tenant(args) {
    const { crearTenant } = require("../pruebas/comun");
    const nombre = args.find(arg => !arg.startsWith("--"));
    const opcion = clave => args[args.indexOf(clave) + 1];

    if (!nombre) throw new Error("Uso: tenant <nombre> [--limite <por_segundo>/<rafaga>] [--scopes a,b]");

    const extra = {};

    if (args.includes("--limite")) {
        const [porSegundo, rafaga] = opcion("--limite").split("/").map(Number);
        extra.limite = { por_segundo: porSegundo, rafaga };
    }

    if (args.includes("--scopes")) extra.scopes = opcion("--scopes").split(",");
    if (args.includes("--webhook")) extra.webhook_url = opcion("--webhook");

    const creado = await crearTenant(nombre, extra);

    // Solo la clave en la salida estándar: los scripts la capturan así.
    console.error(`Tenant ${creado.nombre} (${creado.id}) · permisos ${creado.scopes.join(", ")}`);
    if (creado.webhook_secreto) console.error(`Secreto del webhook (se muestra una sola vez): ${creado.webhook_secreto}`);
    console.log(creado.clave_api);
}

// --- Un comando para la demo (issue #52) -----------------------------------
//
// Desde volúmenes vacíos o sobre una instalación existente: genera lo que
// falte en seguridad/local/, levanta todo (con 1 o 4 particiones de
// comandos), configura la réplica y Grafana, crea el tenant de la demo y
// comprueba que cada parte responda. No borra volúmenes.

function opcion(args, nombre, porDefecto) {
    const i = args.indexOf(nombre);
    return i >= 0 ? args[i + 1] : porDefecto;
}

async function comprobarListo(particiones) {
    const { pedir } = require("../pruebas/comun");
    const esperarQue = async (descripcion, condicion, plazoMs = 90000) => {
        const inicio = Date.now();
        for (;;) {
            const resultado = await condicion().catch(() => null);
            if (resultado) return console.log(`OK: ${descripcion}${resultado === true ? "" : ` (${resultado})`}`);
            if (Date.now() - inicio > plazoMs) throw new Error(`No se cumplió: ${descripcion}`);
            await esperar(2000);
        }
    };

    await esperarQue("la API responde por Traefik y ve MySQL", async () => {
        const r = await pedir("https://localhost:3000/health", { timeoutMs: 5000 });
        return r.status === 200 && r.datos.mysql === "conectado";
    });
    await esperarQue("Aula responde", async () => (await pedir("https://localhost:3001/health", { timeoutMs: 5000 })).status === 200);
    await esperarQue("replicación semisincrónica activa", async () => {
        const fila = compose(["exec", "-T", "mysql-primary", "sh", "-c",
            'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -B -e "SHOW GLOBAL STATUS LIKE \'Rpl_semi_sync_source_status\'" 2>/dev/null'],
        { capturar: true }).trim();
        return fila.endsWith("ON");
    });
    await esperarQue(`${particiones} partición(es) de comandos enlazada(s)`, async () => {
        const enlaces = compose(["exec", "-T", "rabbitmq", "rabbitmqctl", "-q", "list_bindings", "source_name", "destination_name"],
            { capturar: true }).split("\n").filter(l => l.startsWith("reservas.comandos\t"));
        return enlaces.length === particiones;
    });
    await esperarQue("Prometheus recolecta todos sus destinos", async () => {
        const r = await pedir("https://localhost:9090/api/v1/targets?state=active", { timeoutMs: 5000 });
        const destinos = r.datos.data.activeTargets;
        return destinos.length > 0 && destinos.every(d => d.health === "up") ? `${destinos.length} destinos` : null;
    }, 120000);
}

// Tenant con límite alto para la demo de carga. La clave queda en
// seguridad/local/tenant-demo.key (fuera de Git); si ya existe y sigue
// autenticando (los volúmenes son los mismos), se reutiliza.
async function tenantDemo() {
    const { api, crearTenant } = require("../pruebas/comun");
    const archivo = path.join(RAIZ, "seguridad/local/tenant-demo.key");

    if (fs.existsSync(archivo)) {
        const clave = fs.readFileSync(archivo, "utf8").trim();
        if ((await api(clave)("/v1/cambios?limite=1")).status === 200) {
            return console.log("OK: tenant de la demo (ya existía)");
        }
    }

    const creado = await crearTenant("Demostración", { limite: { por_segundo: 1000, rafaga: 1000 } });
    fs.writeFileSync(archivo, creado.clave_api + "\n", { mode: 0o600 });
    console.log("OK: tenant de la demo creado");
}

async function demo(args) {
    const particiones = Number(opcion(args, "--particiones", "1"));
    if (![1, 4].includes(particiones)) throw new Error("--particiones admite 1 o 4");

    nodo("scripts/preparar-seguridad.js");
    exigirTopologiaOriginal();

    // Con una partición se retiran los workers de las particiones 1 a 3 que
    // hayan quedado de una corrida con cuatro (--remove-orphans).
    const archivos = particiones === 4 ? ["-f", "docker-compose.yml", "-f", "docker-compose.particiones.yml"] : [];
    compose([...archivos, "up", "--build", "-d", "--remove-orphans", "--wait", "--wait-timeout", "600"]);
    await configurarReplica();
    sincronizarGrafana();
    await comprobarListo(particiones);
    await tenantDemo();

    console.log([
        "",
        "Listo para la demo:",
        "  API (por Traefik)  https://localhost:3000",
        "  Aula               https://localhost:3001",
        "  Traefik            https://localhost:8080/dashboard/",
        "  RabbitMQ           https://localhost:15672",
        "  Prometheus         https://localhost:9090",
        "  Grafana            https://localhost:3002",
        "Credenciales: seguridad/local/accesos-locales.txt · clave del tenant de la demo: seguridad/local/tenant-demo.key",
        "Confiar en seguridad/local/ca.crt en el navegador para evitar advertencias."
    ].join("\n"));
}

// --- Failover y restauración (issue #61) -------------------------------------
//
// failover: el primario de MySQL se cayó (o se quiere conmutar): lo deja
// detenido, promueve la réplica (pruebas/fallos/failover.js) y mide cuándo
// la API vuelve a aceptar escrituras. Es manual a propósito: con dos nodos,
// decidir solo que el primario murió puede terminar en dos primarios.

function estadoContenedor(servicio) {
    const [id] = compose(["ps", "-a", "-q", servicio], { capturar: true }).trim().split("\n").filter(Boolean);
    if (!id) return null;
    const [estado, fin] = execFileSync("docker", ["inspect", "-f", "{{.State.Status}}|{{.State.FinishedAt}}", id],
        { encoding: "utf8" }).trim().split("|");
    return { id, estado, fin: new Date(fin) };
}

async function failover() {
    const { api, claveAula } = require("../pruebas/comun");
    const { promoverReplica } = require("../pruebas/fallos/failover");

    exigirTopologiaOriginal();

    const primario = estadoContenedor("mysql-primary");
    if (primario?.estado === "running") {
        console.log("El primario sigue en marcha: se detiene para que no queden dos primarios.");
    }
    // También si ya estaba caído: detenido a mano, Docker no lo reinicia.
    compose(["stop", "mysql-primary"], { capturar: true });
    const caida = estadoContenedor("mysql-primary").fin;

    const inicio = Date.now();
    await promoverReplica(texto => console.log(`OK: ${texto}`));

    // Sonda: una escritura real por la API, con la clave del tenant de la demo.
    const archivo = path.join(RAIZ, "seguridad/local/tenant-demo.key");
    const clave = fs.existsSync(archivo) ? fs.readFileSync(archivo, "utf8").trim() : claveAula();
    const cliente = api(clave);
    for (;;) {
        const r = await cliente("/v1/actividades", {
            metodo: "POST", cuerpo: { nombre: "Sonda de failover", capacidad: 1 }, timeoutMs: 10000
        }).catch(() => null);
        if (r?.status === 201) break;
        if (Date.now() - inicio > 120000) throw new Error("La API no volvió a aceptar escrituras en 2 minutos");
        await esperar(250);
    }

    const segundos = ms => `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
    console.log(`OK: la API vuelve a escribir, ${segundos(Date.now() - inicio)} después de iniciar el failover` +
        (caida.getTime() > 0 ? ` (${segundos(Date.now() - caida.getTime())} desde la caída del primario: RTO)` : ""));
    console.log("El primario viejo queda detenido. La réplica promovida trabaja sin réplica.");
    console.log("Para volver a primario + réplica: node scripts/sistema.js restaurar (borra los datos del entorno).");
}

// restaurar: vuelve a la topología original recreando el entorno. Borra
// los volúmenes (reservas, materias de Aula, colas y métricas); los
// certificados y credenciales de seguridad/local/ se conservan.
async function restaurar(args) {
    if (!args.includes("--confirmar")) {
        const readline = require("node:readline/promises");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const respuesta = await rl.question(
            "Esto BORRA todos los datos del entorno (reservas, materias de Aula, colas y métricas).\n" +
            "Escribí 'restaurar' para seguir: ");
        rl.close();
        if (respuesta.trim() !== "restaurar") return console.log("Cancelado: no se borró nada.");
    }

    compose(["-f", "docker-compose.yml", "-f", "docker-compose.particiones.yml", "down", "-v", "--remove-orphans"]);
    await demo(args.filter(arg => arg !== "--confirmar"));
}

async function main() {
    const [accion = "estado", ...args] = process.argv.slice(2);

    switch (accion) {
        case "demo":
            return demo(args);
        case "preparar":
            return nodo("scripts/preparar-seguridad.js");
        case "levantar":
            return levantar();
        case "replica":
            return configurarReplica();
        case "comprobar-topologia":
            return exigirTopologiaOriginal();
        case "grafana":
            return sincronizarGrafana();
        case "estado":
            return estado();
        case "tenant":
            return tenant(args);
        case "seguridad":
            nodo("pruebas/seguridad/api.js");
            nodo("pruebas/seguridad/aula.js");
            return nodo("pruebas/seguridad/cifrado.js");
        case "fallos":
            return nodo("pruebas/fallos/matriz.js", args);
        case "failover":
            return failover();
        case "restaurar":
            return restaurar(args);
        case "detener":
            return compose(["stop"]);
        default:
            throw new Error("Acciones: demo, preparar, levantar, estado, tenant, seguridad, fallos, failover, restaurar, detener");
    }
}

main().catch(error => {
    console.error("No se completó la acción:", error.message);
    process.exitCode = 1;
});
