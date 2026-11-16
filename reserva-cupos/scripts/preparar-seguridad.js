// Genera, en seguridad/local/ (excluido de Git), todo lo secreto que el
// entorno necesita y que no puede estar en el repositorio:
//
//   - una autoridad certificante (CA) local, solo para desarrollo;
//   - un certificado por servicio, firmado por esa CA, con el nombre del
//     servicio en compose como SAN (más localhost para las pruebas desde
//     el equipo);
//   - las identidades de Aula (usuarios.json, solo hashes) y sus
//     contraseñas aleatorias (accesos-locales.txt);
//   - la clave del operador de la plataforma (admin.key) y su hash
//     (admin.sha256, lo único que recibe la API).
//
// Es repetible: no reemplaza nada que ya exista. Para regenerar todo,
// borrar seguridad/local/ y volver a ejecutarlo.
//
// Uso (desde la raíz del repositorio o desde reserva-cupos):
//   node reserva-cupos/scripts/preparar-seguridad.js

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { randomBytes, createHash } = require("node:crypto");
const { hashPassword } = require("../clientes/aula/src/seguridad");

const DIRECTORIO = path.resolve(__dirname, "../seguridad/local");
const DIAS = "365";

// Servicio → nombres del certificado. La réplica también se presenta como
// mysql-primary: al promoverla (pruebas/fallos/failover.js) recibe ese
// alias de red y los clientes verifican la identidad contra ese nombre.
const CERTIFICADOS = {
    prometheus: ["prometheus", "localhost"],
    grafana: ["grafana", "localhost"],
    traefik: ["traefik", "localhost"],
    api: ["api", "localhost"],
    worker: ["worker", "localhost"],
    relay: ["relay", "localhost"],
    notificador: ["notificador", "localhost"],
    aula: ["aula", "localhost"],
    "mysql-primary": ["mysql-primary", "localhost"],
    "mysql-replica": ["mysql-replica", "mysql-primary", "localhost"],
    "aula-db": ["aula-db", "localhost"],
    rabbitmq: ["rabbitmq", "localhost"]
};

const USUARIOS_AULA = [
    { usuario: "admin", rol: "administrador", participante: null },
    { usuario: "alumno1", rol: "alumno", participante: "alumno-1" },
    { usuario: "alumno2", rol: "alumno", participante: "alumno-2" }
];

function buscarOpenssl() {
    const candidatos = [
        process.env.OPENSSL,
        "openssl",
        "C:/Program Files/Git/usr/bin/openssl.exe",
        "C:/Program Files/Git/mingw64/bin/openssl.exe"
    ].filter(Boolean);

    const encontrado = candidatos.find(candidato => {
        try {
            execFileSync(candidato, ["version"], { stdio: "ignore" });
            return true;
        } catch (_) {
            return false;
        }
    });

    if (!encontrado) {
        throw new Error("Se necesita OpenSSL. En Windows sirve el que trae Git; también se puede indicar con OPENSSL=<ruta>.");
    }

    return encontrado;
}

const existe = nombre => fs.existsSync(path.join(DIRECTORIO, nombre));

function crearCa(openssl) {
    if (existe("ca.crt")) return false;

    execFileSync(openssl, [
        "req", "-x509", "-newkey", "rsa:3072", "-nodes", "-sha256", "-days", DIAS,
        "-keyout", "ca.key", "-out", "ca.crt",
        "-subj", "/CN=Reserva de cupos - CA de desarrollo local",
        "-addext", "basicConstraints=critical,CA:TRUE",
        "-addext", "keyUsage=critical,keyCertSign,cRLSign"
    ], { cwd: DIRECTORIO, stdio: "pipe" });

    return true;
}

function crearCertificado(openssl, servicio, nombres) {
    if (existe(`${servicio}.crt`)) return false;

    const extensiones = path.join(DIRECTORIO, `${servicio}.ext`);
    const san = [...nombres.map(nombre => `DNS:${nombre}`), "IP:127.0.0.1"].join(",");

    fs.writeFileSync(extensiones, [
        `subjectAltName=${san}`,
        "basicConstraints=critical,CA:FALSE",
        "keyUsage=critical,digitalSignature,keyEncipherment",
        "extendedKeyUsage=serverAuth"
    ].join("\n") + "\n");

    try {
        execFileSync(openssl, [
            "req", "-new", "-newkey", "rsa:2048", "-nodes",
            "-keyout", `${servicio}.key`, "-out", `${servicio}.csr`, "-subj", `/CN=${servicio}`
        ], { cwd: DIRECTORIO, stdio: "pipe" });

        execFileSync(openssl, [
            "x509", "-req", "-in", `${servicio}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key",
            "-CAcreateserial", "-sha256", "-days", DIAS,
            "-extfile", extensiones, "-out", `${servicio}.crt`
        ], { cwd: DIRECTORIO, stdio: "pipe" });
    } finally {
        fs.rmSync(extensiones, { force: true });
        fs.rmSync(path.join(DIRECTORIO, `${servicio}.csr`), { force: true });
    }

    return true;
}

async function crearIdentidades() {
    if (existe("usuarios.json")) return false;

    const usuarios = [];
    const accesos = [];

    for (const persona of USUARIOS_AULA) {
        const password = randomBytes(18).toString("base64url");
        usuarios.push({ ...persona, activo: true, passwordHash: await hashPassword(password) });
        accesos.push(`${persona.usuario}: ${password}`);
    }

    const clave = `rc_admin_${randomBytes(32).toString("hex")}`;

    fs.writeFileSync(path.join(DIRECTORIO, "usuarios.json"), JSON.stringify(usuarios, null, 2) + "\n");
    fs.writeFileSync(path.join(DIRECTORIO, "admin.key"), clave + "\n", { mode: 0o600 });
    fs.writeFileSync(path.join(DIRECTORIO, "admin.sha256"), createHash("sha256").update(clave).digest("hex") + "\n");
    fs.writeFileSync(path.join(DIRECTORIO, "accesos-locales.txt"), [
        "Credenciales SOLO para desarrollo local. No subir ni incluir en evidencias.",
        "",
        "Aula (https://localhost:3001):",
        ...accesos,
        "",
        `Operador de la plataforma (Authorization: Bearer ...): ${clave}`,
        ""
    ].join("\n"), { mode: 0o600 });

    return true;
}

async function main() {
    fs.mkdirSync(DIRECTORIO, { recursive: true });

    const openssl = buscarOpenssl();
    const creados = [];

    if (crearCa(openssl)) creados.push("CA");

    for (const [servicio, nombres] of Object.entries(CERTIFICADOS)) {
        if (crearCertificado(openssl, servicio, nombres)) creados.push(servicio);
    }

    if (await crearIdentidades()) creados.push("usuarios de Aula y clave del operador");

    // Los contenedores corren con usuarios sin privilegios (node, mysql,
    // rabbitmq) y necesitan leer los certificados y claves que se les
    // montan. La clave de la CA y las credenciales en texto no se montan
    // en ningún contenedor y quedan solo para el dueño.
    for (const nombre of fs.readdirSync(DIRECTORIO)) {
        const privado = ["ca.key", "admin.key", "accesos-locales.txt"].includes(nombre);
        fs.chmodSync(path.join(DIRECTORIO, nombre), privado ? 0o600 : 0o644);
    }

    console.log(creados.length
        ? `Generado en ${DIRECTORIO}: ${creados.join(", ")}.`
        : `Nada que generar: ${DIRECTORIO} ya estaba completo.`);
    console.log(`Credenciales de desarrollo: ${path.join(DIRECTORIO, "accesos-locales.txt")}`);
}

main().catch(error => {
    console.error("No se pudo preparar la seguridad local:", error.message);
    process.exitCode = 1;
});
