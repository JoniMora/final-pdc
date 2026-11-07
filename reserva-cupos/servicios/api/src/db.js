const mysql = require("mysql2/promise");

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    // Acota las conexiones de la API aunque lleguen cientos de solicitudes.
    connectionLimit: Number(process.env.DB_CONEXIONES || 10),
    connectTimeout: 3000,
    timezone: "Z"
});

// Errores de infraestructura: la base no está disponible.
const CODIGOS_INFRAESTRUCTURA = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
    "PROTOCOL_CONNECTION_LOST",
    "PROTOCOL_SEQUENCE_TIMEOUT",
    "ER_CON_COUNT_ERROR",
    "ER_SERVER_SHUTDOWN",
    "ER_OPTION_PREVENTS_STATEMENT"
]);

function esErrorDeInfraestructura(error) {
    return error.fatal === true || CODIGOS_INFRAESTRUCTURA.has(error.code);
}

// Ejecuta fn dentro de una transacción. Reintenta ante un deadlock,
// que InnoDB resuelve abortando una de las transacciones.
async function enTransaccion(fn, intentos = 3) {
    for (let intento = 1; ; intento++) {
        const conexion = await pool.getConnection();
        let rota = false;

        try {
            await conexion.beginTransaction();
            const resultado = await fn(conexion);
            await conexion.commit();
            return resultado;
        } catch (error) {
            rota = error.fatal === true;

            if (!rota) {
                await conexion.rollback().catch(() => {});
            }

            if (error.code === "ER_LOCK_DEADLOCK" && intento < intentos) {
                continue;
            }

            throw error;
        } finally {
            if (rota) conexion.destroy();
            else conexion.release();
        }
    }
}

module.exports = { pool, enTransaccion, esErrorDeInfraestructura };
