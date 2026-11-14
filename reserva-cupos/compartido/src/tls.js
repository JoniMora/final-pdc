// Conexiones cifradas con MySQL y RabbitMQ (Entrega 5). Todos los procesos
// las arman acá, así ninguno puede quedar con una configuración distinta.
//
// TLS_CA es la ruta del certificado de la autoridad local. Con esa variable
// el cliente exige TLS, verifica la cadena del servidor y que el nombre al
// que se conecta figure en el certificado. Sin ella la conexión es en texto
// plano: solo la usan las pruebas que corren fuera de Docker; el entorno de
// docker-compose.yml siempre la define y los servidores rechazan el texto
// plano.

const fs = require("node:fs");

function leerCa(ruta = process.env.TLS_CA) {
    return ruta ? fs.readFileSync(ruta) : null;
}

// Opciones de mysql2 (createPool o createConnection). verifyIdentity
// compara el nombre del host con el certificado del servidor.
function opcionesMysql({ ca = leerCa() } = {}) {
    if (!ca) return {};

    return { ssl: { ca, rejectUnauthorized: true, verifyIdentity: true } };
}

// Argumentos de amqplib.connect(url, opcionesDeSocket): AMQPS en el 5671,
// con la CA local y el nombre del broker como servername.
function conexionRabbit({ ca = leerCa(), heartbeat } = {}) {
    const hostname = process.env.RABBITMQ_HOST || "rabbitmq";
    const url = {
        protocol: ca ? "amqps" : "amqp",
        port: ca ? 5671 : 5672,
        hostname,
        username: process.env.RABBITMQ_USER,
        password: process.env.RABBITMQ_PASSWORD,
        ...(heartbeat ? { heartbeat } : {})
    };

    const socket = ca ? { ca: [ca], servername: hostname, rejectUnauthorized: true } : {};

    return [url, socket];
}

module.exports = { leerCa, opcionesMysql, conexionRabbit };
