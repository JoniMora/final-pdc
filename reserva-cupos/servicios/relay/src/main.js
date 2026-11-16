const fs = require("node:fs");
const https = require("node:https");
const mysql = require("mysql2/promise");
const amqp = require("amqplib");

const { crearValidadorDeMensajes } = require("../../../compartido/src/contrato");
const { opcionesMysql, conexionRabbit } = require("../../../compartido/src/tls");
const { crearMetricas } = require("../../../compartido/src/metricas");
const {
    COMANDOS,
    ESQUEMAS,
    comandoDesdeCambio,
    entregaDesdeCambio
} = require("./mensajes");

// Único proceso que secuencia el feed y publica el outbox.
const EXCHANGE = "reservas.comandos";
const EXCHANGE_WEBHOOKS = "webhooks.eventos";
const COLAS_COMANDOS = ["reservas.comandos.0"];

const INTERVALO_MS = Number(process.env.RELAY_INTERVALO_MS || 500);
const BARRIDO_MS = Number(process.env.RELAY_BARRIDO_MS || 30000);
const ANTIGUEDAD_BARRIDO_S = 30;
const LOTE = 200;

const validar = crearValidadorDeMensajes();
const metricas = crearMetricas("relay");
const informados = new Set();

function contar(tipo, resultado, cantidad = 1) {
    metricas.eventos.inc({ tipo, resultado }, cantidad);
}

function cumpleContrato(esquema, mensaje, cambioId) {
    try {
        validar(esquema, mensaje);
        return true;
    } catch (error) {
        if (!informados.has(cambioId)) {
            informados.add(cambioId);
            contar("validacion", "error");

            console.error(
                `[relay] Cambio ${cambioId} no publicado: ${error.message}`
            );
        }

        return false;
    }
}

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    ...opcionesMysql(),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionLimit: 2,
    connectTimeout: 3000,
    timezone: "Z"
});

let canal = null;

// Reconecta al broker sin detener el secuenciador.
async function conectarBroker() {
    try {
        const conexion = await amqp.connect(
            ...conexionRabbit({ heartbeat: 10 })
        );

        conexion.on("error", error => {
            console.error("[relay] RabbitMQ:", error.message);
        });

        conexion.on("close", () => {
            canal = null;
            console.error(
                "[relay] Conexión con RabbitMQ cerrada; reconectando"
            );
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
        contar("conexion_broker", "error");
        console.error("[relay] RabbitMQ no disponible:", error.message);
        setTimeout(conectarBroker, 2000);
    }
}

// Asigna secuencias a los cambios confirmados.
// El relay secuenciador sigue siendo de instancia única.
async function secuenciar() {
    const conexion = await pool.getConnection();

    try {
        await conexion.query(
            "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"
        );

        await conexion.beginTransaction();

        const [[{ ultima }]] = await conexion.query(
            "SELECT COALESCE(MAX(secuencia), 0) AS ultima FROM cambios"
        );

        const [resultado] = await conexion.query(
            `UPDATE cambios c
               JOIN (
                   SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS n
                     FROM cambios
                    WHERE secuencia IS NULL
                    ORDER BY id
                    LIMIT ?
               ) pendientes ON pendientes.id = c.id
                SET c.secuencia = ? + pendientes.n`,
            [LOTE, Number(ultima)]
        );

        await conexion.commit();

        contar("cambio", "secuenciado", resultado.affectedRows);

        return resultado.affectedRows;
    } catch (error) {
        await conexion.rollback().catch(() => {});
        throw error;
    } finally {
        conexion.release();
    }
}

function publicarComando(comando, messageId) {
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

// Publica comandos y los marca después del confirm de RabbitMQ.
async function publicar() {
    if (!canal) return 0;

    const [filas] = await pool.query(
        `SELECT id, tenant_id, entidad_id, tipo, snapshot
           FROM cambios
          WHERE publicado_comando = FALSE
            AND secuencia IS NOT NULL
          ORDER BY id
          LIMIT ?`,
        [LOTE]
    );

    for (const fila of filas) {
        if (!COMANDOS[fila.tipo] && !informados.has(fila.id)) {
            informados.add(fila.id);

            console.error(
                `[relay] Cambio ${fila.id} de tipo ${fila.tipo} sin comando asociado`
            );
        }
    }

    const publicables = filas
        .filter(fila => COMANDOS[fila.tipo])
        .map(fila => ({
            fila,
            comando: comandoDesdeCambio(fila)
        }))
        .filter(({ fila, comando }) =>
            cumpleContrato(
                ESQUEMAS[comando.comando],
                comando,
                fila.id
            )
        );

    if (publicables.length === 0) return 0;

    const enviado = canal;

    for (const { fila, comando } of publicables) {
        publicarComando(comando, `cambio-${fila.id}`);
    }

    await enviado.waitForConfirms();

    // Cuenta publicaciones confirmadas, no reservas decididas.
    contar("comando", "publicado", publicables.length);

    await pool.query(
        "UPDATE cambios SET publicado_comando = TRUE WHERE id IN (?)",
        [publicables.map(({ fila }) => fila.id)]
    );

    return publicables.length;
}

// Publica las entregas que consumirá el notificador.
async function publicarWebhooks() {
    if (!canal) return 0;

    const [filas] = await pool.query(
        `SELECT id, tenant_id, tipo, snapshot, secuencia, creado_en
           FROM cambios
          WHERE publicado_webhook = FALSE
            AND secuencia IS NOT NULL
          ORDER BY id
          LIMIT ?`,
        [LOTE]
    );

    const publicables = filas
        .map(fila => ({
            fila,
            entrega: entregaDesdeCambio(fila)
        }))
        .filter(({ fila, entrega }) =>
            cumpleContrato("EntregaWebhook", entrega, fila.id)
        );

    if (publicables.length === 0) return 0;

    const enviado = canal;

    for (const { fila, entrega } of publicables) {
        enviado.publish(
            EXCHANGE_WEBHOOKS,
            "entrega",
            Buffer.from(JSON.stringify(entrega)),
            {
                persistent: true,
                contentType: "application/json",
                messageId: `webhook-${fila.id}`,
                type: "entrega"
            }
        );
    }

    await enviado.waitForConfirms();

    // Publicado en RabbitMQ no significa entregado al receptor HTTP.
    contar("webhook", "publicado", publicables.length);

    await pool.query(
        "UPDATE cambios SET publicado_webhook = TRUE WHERE id IN (?)",
        [publicables.map(({ fila }) => fila.id)]
    );

    return publicables.length;
}

// Recupera comandos de reservas pendientes antiguas
// cuando no hay mensajes esperando en las colas.
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
    let enviados = 0;

    for (const fila of filas) {
        const comando = {
            comando: "reservar",
            tenant_id: fila.tenant_id,
            reserva_id: fila.id,
            actividad_id: fila.actividad_id
        };

        if (
            cumpleContrato(
                "ComandoReservar",
                comando,
                `barrido-${fila.id}`
            )
        ) {
            publicarComando(comando, `barrido-${fila.id}`);
            enviados++;
        }
    }

    await enviado.waitForConfirms();

    contar("comando", "republicado", enviados);

    return filas.length;
}

async function ciclo() {
    let lleno = false;

    try {
        const secuenciados = await secuenciar();
        const publicados = await publicar();
        const webhooks = await publicarWebhooks();

        if (secuenciados || publicados || webhooks) {
            console.log(
                `[relay] Secuenciados: ${secuenciados}` +
                ` · comandos publicados: ${publicados}` +
                ` · webhooks: ${webhooks}`
            );
        }

        lleno = secuenciados === LOTE
            || publicados === LOTE
            || webhooks === LOTE;
    } catch (error) {
        contar("ciclo", "error");
        console.error(
            "[relay] Ciclo fallido:",
            error.code || error.message
        );
    } finally {
        setTimeout(ciclo, lleno ? 0 : INTERVALO_MS);
    }
}

async function cicloBarredor() {
    try {
        const republicados = await barrer();

        if (republicados) {
            console.log(
                `[relay] Barredor: ${republicados} comandos republicados`
            );
        }
    } catch (error) {
        contar("barrido", "error");
        console.error(
            "[relay] Barrido fallido:",
            error.code || error.message
        );
    } finally {
        setTimeout(cicloBarredor, BARRIDO_MS);
    }
}

// Servidor de métricas HTTPS en la red interna de Docker.
const servidorMetricas = https.createServer({
    cert: fs.readFileSync(process.env.TLS_CERT),
    key: fs.readFileSync(process.env.TLS_KEY),
    minVersion: "TLSv1.2"
}, async (req, res) => {
    if (req.method !== "GET" || req.url !== "/metrics") {
        res.writeHead(404);
        res.end();
        return;
    }

    try {
        const contenido = await metricas.registro.metrics();

        res.writeHead(200, {
            "Content-Type": metricas.registro.contentType
        });

        res.end(contenido);
    } catch (error) {
        console.error(
            "[relay] Error al exportar métricas:",
            error.message
        );

        res.writeHead(500);
        res.end();
    }
});

servidorMetricas.on("error", error => {
    console.error("[relay] Servidor de métricas:", error.message);
    process.exit(1);
});

servidorMetricas.listen(9464, "0.0.0.0", () => {
    console.log(
        "[relay] Métricas disponibles en puerto interno 9464"
    );
});

conectarBroker();

console.log(`[relay] Procesando el outbox cada ${INTERVALO_MS} ms`);

ciclo();
setTimeout(cicloBarredor, BARRIDO_MS);
