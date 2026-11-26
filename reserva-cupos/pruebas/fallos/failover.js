// Failover del primario de MySQL: promueve la réplica. Lo usan la matriz de
// fallos (escenario mysql-primary) y `node scripts/sistema.js failover`.
//
// 1. Espera a que la réplica aplique todo lo que recibió: con replicación
//    semisincrónica AFTER_SYNC, lo confirmado ya está en su relay log, así
//    que no se pierde nada (RPO = 0).
// 2. La desconecta del primario y la habilita para escribir.
// 3. Le agrega el alias de red mysql-primary: la API, el worker, el relay y
//    el notificador se reconectan solos al nombre de siempre. Su certificado
//    también vale para ese nombre (scripts/preparar-seguridad.js).
//
// El primario viejo tiene que estar detenido antes (si no, habría dos
// primarios con el mismo nombre). Volver a la topología original requiere
// recrear el entorno: node scripts/sistema.js restaurar.
const { mysqlAsync, dockerAsync, contenedores, esperarHasta } = require("../comun");

const RED_INTERNA = "reserva-cupos-infra_interna";

async function promoverReplica(informar = () => {}) {
    const [replica] = contenedores("mysql-replica");
    if (!replica) throw new Error("mysql-replica no está en marcha");

    await esperarHasta(async () => (await mysqlAsync("mysql-replica", `
        SELECT GTID_SUBSET(RECEIVED_TRANSACTION_SET, @@GLOBAL.gtid_executed)
          FROM performance_schema.replication_connection_status`, { base: "" })).trim() === "1",
    { plazoMs: 30000, intervaloMs: 200, descripcion: "que la réplica aplique todo lo recibido" });
    informar("La réplica aplicó todas las transacciones que había recibido (GTID_SUBSET)");

    await mysqlAsync("mysql-replica", `
        STOP REPLICA;
        RESET REPLICA ALL;
        SET PERSIST super_read_only = OFF;
        SET PERSIST read_only = OFF;`, { base: "" });
    informar("Réplica promovida: sin canal de replicación y con escritura habilitada");

    await dockerAsync(["network", "disconnect", RED_INTERNA, replica], { directo: true });
    await dockerAsync(["network", "connect", "--alias", "mysql-primary", "--alias", "mysql-replica", RED_INTERNA, replica],
        { directo: true });
    informar("La réplica responde ahora como mysql-primary: los componentes se reconectan solos");
}

module.exports = { promoverReplica };
