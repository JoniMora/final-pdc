// Utilidades de las pruebas que corren contra el entorno levantado con
// docker-compose.yml (pruebas/seguridad y pruebas/fallos). Todo se hace
// como lo haría un cliente o un operador: por la API pública con TLS
// verificado contra la CA local, o con docker compose.

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { execFile, execFileSync, spawn } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const RAIZ = path.resolve(__dirname, "..");
const LOCAL = path.join(RAIZ, "seguridad/local");
const EVIDENCIAS = path.resolve(RAIZ, "../docs/entrega-5/evidencias");

const API = "https://localhost:3000";
const AULA = "https://localhost:3001";

function leerLocal(nombre) {
    return fs.readFileSync(path.join(LOCAL, nombre), "utf8");
}

const CA = (() => {
    try {
        return fs.readFileSync(path.join(LOCAL, "ca.crt"));
    } catch (_) {
        throw new Error("Falta seguridad/local/ca.crt: ejecutar antes node scripts/sistema.js preparar");
    }
})();

// Un agente con conexiones persistentes: una ráfaga de cientos de pedidos
// no abre cientos de handshakes TLS a la vez.
const agente = new https.Agent({ ca: CA, keepAlive: true, maxSockets: 64 });

// --- Docker ---------------------------------------------------------------

function docker(args, { entrada, permitirFallo = false } = {}) {
    try {
        return execFileSync("docker", ["compose", ...args], {
            cwd: RAIZ,
            encoding: "utf8",
            input: entrada,
            stdio: ["pipe", "pipe", "pipe"]
        });
    } catch (error) {
        if (permitirFallo) return null;
        throw new Error(`docker compose ${args.join(" ")}: ${(error.stderr || error.message).trim()}`);
    }
}

// Variante asíncrona: no bloquea a los clientes de una ráfaga en curso
// mientras Docker detiene o inicia un contenedor.
async function dockerAsync(args, { directo = false } = {}) {
    const { stdout } = await execFileAsync("docker", directo ? args : ["compose", ...args], { cwd: RAIZ });
    return stdout;
}

function dockerDirecto(args) {
    return execFileSync("docker", args, { cwd: RAIZ, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

// Consulta como root dentro del contenedor. La contraseña sale del entorno
// del propio contenedor (MYSQL_ROOT_PASSWORD): no se repite en los scripts.
// Por el socket local del contenedor, que no es tráfico de red.
// Con nombres: true conserva los nombres de columna (para \G).
function mysql(servicio, sql, { base = "reservas", permitirFallo = false, nombres = false } = {}) {
    return docker(["exec", "-T", servicio, "sh", "-c",
        `mysql -uroot -p"$MYSQL_ROOT_PASSWORD" ${nombres ? "" : "-N"} -B ${base} 2>/dev/null`], { entrada: sql, permitirFallo });
}

// Variante asíncrona de mysql(), para usar con una ráfaga en curso.
function mysqlAsync(servicio, sql, { base = "reservas" } = {}) {
    return new Promise((resolve, reject) => {
        const proceso = spawn("docker", ["compose", "exec", "-T", servicio, "sh", "-c",
            `mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -B ${base} 2>/dev/null`], { cwd: RAIZ });
        let salida = "";

        proceso.stdout.on("data", parte => { salida += parte; });
        proceso.on("error", reject);
        proceso.on("close", codigo => (codigo === 0
            ? resolve(salida)
            : reject(new Error(`mysql en ${servicio} terminó con código ${codigo}`))));
        proceso.stdin.end(sql);
    });
}

function psql(sql, { permitirFallo = false } = {}) {
    return docker(["exec", "-T", "aula-db", "psql", "-U", "aula_admin", "-d", "aula", "-At", "-v", "ON_ERROR_STOP=1"],
        { entrada: sql, permitirFallo });
}

function contenedores(servicio) {
    return docker(["ps", "-q", servicio]).trim().split("\n").filter(Boolean);
}

// --- HTTP ------------------------------------------------------------------

function pedir(url, { metodo = "GET", cuerpo, encabezados = {}, ca = CA, timeoutMs = 30000, conexionNueva = false } = {}) {
    return new Promise((resolve, reject) => {
        const datos = cuerpo === undefined ? null : JSON.stringify(cuerpo);
        const solicitud = https.request(url, {
            method: metodo,
            // Tras un comando síncrono largo, un socket libre puede haberse cerrado
            // sin que Node haya procesado aún el cierre. Se puede exigir uno nuevo,
            // conservando la verificación TLS y sin repetir solicitudes fallidas.
            ...(ca === CA && !conexionNueva ? { agent: agente } : { ca, agent: false }),
            headers: {
                ...(datos ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(datos) } : {}),
                ...encabezados
            }
        }, respuesta => {
            let texto = "";
            respuesta.setEncoding("utf8");
            respuesta.on("data", parte => { texto += parte; });
            respuesta.on("end", () => {
                let json = null;
                try { json = texto ? JSON.parse(texto) : null; } catch (_) { json = texto; }
                resolve({ status: respuesta.statusCode, encabezados: respuesta.headers, datos: json });
            });
        });

        solicitud.setTimeout(timeoutMs, () => solicitud.destroy(new Error(`Sin respuesta en ${timeoutMs} ms`)));
        solicitud.on("error", reject);
        solicitud.end(datos);
    });
}

function api(clave) {
    return (ruta, opciones = {}) => pedir(`${API}${ruta}`, {
        ...opciones,
        encabezados: { Authorization: `Bearer ${clave}`, ...opciones.encabezados }
    });
}

function claveOperador() {
    return leerLocal("admin.key").trim();
}

function claveAula() {
    const compose = fs.readFileSync(path.join(RAIZ, "docker-compose.yml"), "utf8");
    return /API_KEY: (rc_aula_[0-9a-f]+)/.exec(compose)[1];
}

async function crearTenant(nombre, extra = {}) {
    const respuesta = await api(claveOperador())("/admin/v1/tenants", {
        metodo: "POST",
        cuerpo: { nombre, ...extra }
    });

    if (respuesta.status !== 201) {
        throw new Error(`No se pudo crear el tenant ${nombre}: HTTP ${respuesta.status} ${JSON.stringify(respuesta.datos)}`);
    }

    return respuesta.datos;
}

// --- Aula ------------------------------------------------------------------

function accesosAula() {
    return Object.fromEntries(leerLocal("accesos-locales.txt")
        .split(/\r?\n/)
        .map(linea => /^(admin|alumno\d+): (\S+)$/.exec(linea))
        .filter(Boolean)
        .map(([, usuario, password]) => [usuario, password]));
}

async function sesionAula(usuario) {
    const respuesta = await pedir(`${AULA}/auth/login`, {
        metodo: "POST",
        cuerpo: { usuario, password: accesosAula()[usuario] }
    });

    if (respuesta.status !== 200) throw new Error(`Login de ${usuario}: HTTP ${respuesta.status}`);

    const cookie = respuesta.encabezados["set-cookie"][0];

    return {
        cookieCompleta: cookie,
        encabezados: { Cookie: cookie.split(";")[0], "X-CSRF-Token": respuesta.datos.csrf }
    };
}

function aula(sesion) {
    return (ruta, opciones = {}) => pedir(`${AULA}${ruta}`, {
        ...opciones,
        encabezados: { ...(sesion?.encabezados || {}), ...opciones.encabezados }
    });
}

// --- Tiempo y evidencia -----------------------------------------------------

const esperar = ms => new Promise(resolve => setTimeout(resolve, ms));

async function esperarHasta(condicion, { plazoMs = 120000, intervaloMs = 1000, descripcion = "la condición" } = {}) {
    const inicio = Date.now();

    for (;;) {
        const resultado = await condicion();
        if (resultado) return resultado;

        if (Date.now() - inicio > plazoMs) {
            throw new Error(`No se cumplió ${descripcion} en ${Math.round(plazoMs / 1000)} s`);
        }

        await esperar(intervaloMs);
    }
}

// Registro de una prueba: cada comprobación queda como una línea "OK:" y
// los datos medidos como "  ·". Al final se escribe en
// docs/entrega-5/evidencias/<archivo>, con el resultado, aunque falle.
class Evidencia {
    constructor(archivo, titulo) {
        this.archivo = path.join(EVIDENCIAS, archivo);
        this.lineas = [titulo, `Ejecución: ${new Date().toISOString()}`, ""];
        this.ok = this.ok.bind(this);
        this.dato = this.dato.bind(this);
    }

    ok(mensaje) {
        console.log(`OK: ${mensaje}`);
        this.lineas.push(`OK: ${mensaje}`);
    }

    dato(mensaje) {
        console.log(`  · ${mensaje}`);
        this.lineas.push(`  · ${mensaje}`);
    }

    guardar(error) {
        const resultado = error ? `FALLIDA: ${error.message}` : "APROBADA";
        fs.mkdirSync(path.dirname(this.archivo), { recursive: true });
        fs.writeFileSync(this.archivo, [...this.lineas, "", `Resultado: ${resultado}`, ""].join("\n"));
        console.log(`Resultado: ${resultado} → ${path.relative(path.resolve(RAIZ, ".."), this.archivo)}`);
    }
}

// Ejecuta una prueba y deja su evidencia. Devuelve el código de salida.
async function ejecutar(evidencia, prueba) {
    try {
        await prueba(evidencia);
        evidencia.guardar();
        return 0;
    } catch (error) {
        console.error(error);
        evidencia.guardar(error);
        return 1;
    }
}

module.exports = {
    RAIZ,
    API,
    AULA,
    CA,
    docker,
    dockerAsync,
    dockerDirecto,
    mysql,
    mysqlAsync,
    psql,
    contenedores,
    pedir,
    api,
    claveOperador,
    claveAula,
    crearTenant,
    accesosAula,
    sesionAula,
    aula,
    esperar,
    esperarHasta,
    Evidencia,
    ejecutar
};
