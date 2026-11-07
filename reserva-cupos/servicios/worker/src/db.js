const mysql = require("mysql2/promise");

function crearPool(conexiones = 2) {
    return mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        connectionLimit: conexiones,
        connectTimeout: 3000,
        timezone: "Z"
    });
}

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
    "ER_OPTION_PREVENTS_STATEMENT",
    "ER_LOCK_WAIT_TIMEOUT",
    "ER_LOCK_DEADLOCK"
]);

// Infraestructura: reintentar más tarde. Cualquier otro error es de datos.
function esErrorDeInfraestructura(error) {
    return error.fatal === true || CODIGOS_INFRAESTRUCTURA.has(error.code);
}

async function enTransaccion(pool, fn, intentos = 3) {
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

module.exports = { crearPool, enTransaccion, esErrorDeInfraestructura };
