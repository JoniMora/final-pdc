const mysql = require("mysql2/promise");
const amqp = require("amqplib");

// Único proceso que lee el outbox (tabla cambios) y publica.
// Cumple tres funciones: secuenciador del feed, publicador de comandos
// y barredor de reservas pendientes.

const EXCHANGE = "reservas.comandos";
const COLAS_COMANDOS = ["reservas.comandos.0"];
const INTERVALO_MS = Number(process.env.RELAY_INTERVALO_MS || 500);
const BARRIDO_MS = Number(process.env.RELAY_BARRIDO_MS || 30000);
const ANTIGUEDAD_BARRIDO_S = 30;
const LOTE = 200;

// Tipo de cambio → comando que se envía al worker.
const COMANDOS = {
    "reserva.solicitada": "reservar"
};

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionLimit: 2,
    connectTimeout: 3000,
    timezone: "Z"
});

let canal = null;

// El broker puede caer sin detener al secuenciador: el canal se
// reconecta en segundo plano y el publicador espera mientras tanto.
async function conectarBroker() {
    try {
        const conexion = await amqp.connect({
            hostname: process.env.RABBITMQ_HOST,
            username: process.env.RABBITMQ_USER,
            password: process.env.RABBITMQ_PASSWORD,
            heartbeat: 10
        });

        conexion.on("error", error => {
            console.error("[relay] RabbitMQ:", error.message);
        });

        conexion.on("close", () => {
            canal = null;
            console.error("[relay] Conexión con RabbitMQ cerrada; reconectando");
            setTimeout(conectarBroker, 2000);
        });

        const nuevo = await conexion.createConfirmChannel();

        nuevo.on("error", error => {
            console.error("[relay] Canal:", error.message);
        });

        nuevo.on("close", () => {
            canal = null;
            conexion.close().catch(() => {});
        });

        canal = nuevo;
        console.log("[relay] Conectado a RabbitMQ");
    } catch (error) {
        console.error("[relay] RabbitMQ no disponible:", error.message);
        setTimeout(conectarBroker, 2000);
    }
}

// 1. Secuenciador: asigna números crecientes a los cambios confirmados
// que todavía no tienen secuencia. Es la única instancia que lo hace y
// lo hace en una sola transacción por lote, así la secuencia visible es
// densa y un lector nunca ve aparecer después una menor (el índice
// único sobre secuencia rechaza una segunda instancia por error).
async function secuenciar() {
    const conexion = await pool.getConnection();

    try {
        // READ COMMITTED: bloquea solo las filas que numera, sin bloqueos
        // de intervalo que frenen los INSERT de la API y del worker.
        await conexion.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
        await conexion.beginTransaction();

        const [[{ ultima }]] = await conexion.query(
            "SELECT COALESCE(MAX(secuencia), 0) AS ultima FROM cambios"
        );

        const [resultado] = await conexion.query(
            `UPDATE cambios c
               JOIN (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS n
                       FROM cambios
                      WHERE secuencia IS NULL
                      ORDER BY id
                      LIMIT ?) pendientes ON pendientes.id = c.id
                SET c.secuencia = ? + pendientes.n`,
            [LOTE, Number(ultima)]
        );

        await conexion.commit();
        return resultado.affectedRows;
    } catch (error) {
        await conexion.rollback().catch(() => {});
        throw error;
    } finally {
        conexion.release();
    }
}

function publicarComando(comando, messageId) {
    // La routing key es la actividad: el exchange de hash consistente
    // envía todos los comandos de una actividad a la misma partición.
    canal.publish(
        EXCHANGE,
        comando.actividad_id,
        Buffer.from(JSON.stringify(comando)),
        {
            persistent: true,
            contentType: "application/json",
            messageId,
            type: comando.comando
        }
    );
}

// 2. Publicador: envía los comandos secuenciados y los marca como
// publicados recién cuando RabbitMQ confirma. Si el proceso cae entre
// publicar y marcar, los vuelve a publicar: al-menos-una-vez.
async function publicar() {
    if (!canal) return 0;

    const [filas] = await pool.query(
        `SELECT id, tenant_id, entidad_id, tipo, snapshot
           FROM cambios
          WHERE publicado_comando = FALSE AND secuencia IS NOT NULL
          ORDER BY id
          LIMIT ?`,
        [LOTE]
    );

    const publicables = filas.filter(fila => COMANDOS[fila.tipo]);

    for (const fila of filas) {
        if (!COMANDOS[fila.tipo]) {
            console.error(`[relay] Cambio ${fila.id} de tipo ${fila.tipo} sin comando asociado`);
        }
    }

    if (publicables.length === 0) return 0;

    const enviado = canal;

    for (const fila of publicables) {
        publicarComando({
            comando: COMANDOS[fila.tipo],
            cambio_id: fila.id,
            tenant_id: fila.tenant_id,
            reserva_id: fila.entidad_id,
            actividad_id: fila.snapshot.actividad_id
        }, `cambio-${fila.id}`);
    }

    // Rechaza si RabbitMQ no confirma alguno: quedan sin marcar.
    await enviado.waitForConfirms();

    await pool.query(
        "UPDATE cambios SET publicado_comando = TRUE WHERE id IN (?)",
        [publicables.map(fila => fila.id)]
    );

    return publicables.length;
}

// 3. Barredor: si las colas de comandos están vacías y quedan reservas
// pendientes antiguas, su comando se perdió (por ejemplo, junto con el
// volumen del broker). Se republica; el worker es idempotente.
async function barrer() {
    if (!canal) return 0;

    for (const cola of COLAS_COMANDOS) {
        const estado = await canal.checkQueue(cola);
        if (estado.messageCount > 0) return 0;
    }

    const [filas] = await pool.query(
        `SELECT id, tenant_id, actividad_id
           FROM reservas
          WHERE estado = 'pendiente'
            AND creado_en < NOW(3) - INTERVAL ? SECOND
          ORDER BY creado_en
          LIMIT ?`,
        [ANTIGUEDAD_BARRIDO_S, LOTE]
    );

    if (filas.length === 0) return 0;

    const enviado = canal;

    for (const fila of filas) {
        publicarComando({
            comando: "reservar",
            tenant_id: fila.tenant_id,
            reserva_id: fila.id,
            actividad_id: fila.actividad_id
        }, `barrido-${fila.id}`);
    }

    await enviado.waitForConfirms();

    return filas.length;
}

async function ciclo() {
    let lleno = false;

    try {
        const secuenciados = await secuenciar();
        const publicados = await publicar();

        if (secuenciados || publicados) {
            console.log(`[relay] Secuenciados: ${secuenciados} · comandos publicados: ${publicados}`);
        }

        lleno = secuenciados === LOTE || publicados === LOTE;
    } catch (error) {
        // MySQL o RabbitMQ no disponibles: se reintenta en el próximo ciclo.
        console.error("[relay] Ciclo fallido:", error.code || error.message);
    } finally {
        // Con un lote completo hay más trabajo: se sigue sin esperar.
        setTimeout(ciclo, lleno ? 0 : INTERVALO_MS);
    }
}

async function cicloBarredor() {
    try {
        const republicados = await barrer();

        if (republicados) {
            console.log(`[relay] Barredor: ${republicados} comandos republicados`);
        }
    } catch (error) {
        console.error("[relay] Barrido fallido:", error.code || error.message);
    } finally {
        setTimeout(cicloBarredor, BARRIDO_MS);
    }
}

conectarBroker();

console.log(`[relay] Procesando el outbox cada ${INTERVALO_MS} ms`);

ciclo();
setTimeout(cicloBarredor, BARRIDO_MS);
