const mysql = require("mysql2/promise");
const amqp = require("amqplib");

const componente = process.env.COMPONENTE;

if (!["relay", "notificador"].includes(componente)) {
    throw new Error("COMPONENTE debe ser relay o notificador");
}

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionLimit: 2,
    connectTimeout: 3000
});

function salir(error) {
    console.error(
        `[${componente}] Error de RabbitMQ:`,
        error.message
    );

    process.exit(1);
}

async function iniciar() {
    const conexion = await amqp.connect({
        hostname: process.env.RABBITMQ_HOST,
        username: process.env.RABBITMQ_USER,
        password: process.env.RABBITMQ_PASSWORD,
        heartbeat: 10
    });

    conexion.on("error", salir);

    conexion.on("close", () => {
        salir(new Error("Conexion cerrada"));
    });

    const canal = await conexion.createChannel();

    canal.on("error", salir);

    canal.on("close", () => {
        salir(new Error("Canal cerrado"));
    });

    await canal.assertQueue("infraestructura.pruebas", {
        durable: true
    });

    // Cada componente consulta una tabla permitida para su usuario.
    const sql = componente === "relay"
        ? `SELECT COUNT(*) AS cantidad
       FROM cambios
       WHERE publicado_comando = FALSE
          OR publicado_webhook = FALSE`

        : `SELECT COUNT(*) AS cantidad
       FROM tenants
       WHERE activo = TRUE
         AND webhook_url IS NOT NULL`;

    async function comprobar() {
        try {
            const [filas] = await pool.query({
                sql,
                timeout: 3000
            });

            const cola = await canal.checkQueue(
                "infraestructura.pruebas"
            );

            console.log(`[${componente}]`, {
                mysql: "conectado",
                rabbitmq: "conectado",
                registros: filas[0].cantidad,
                mensajesEnEspera: cola.messageCount,
                verificadoEn: new Date().toISOString()
            });
        } catch (error) {
            console.error(
                `[${componente}] Comprobacion fallida:`,
                error.message
            );
        } finally {
            // Repetimos después de terminar, sin superponer consultas.
            setTimeout(comprobar, 10000);
        }
    }

    comprobar();
}

iniciar().catch(salir);