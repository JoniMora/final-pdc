// Matriz de fallos (Entrega 5, issues E5-12, E5-13 y E5-14). Cada escenario
// detiene un componente con carga en curso, mide el efecto y el tiempo de
// recuperación y verifica las garantías por la API pública. Cada uno deja
// su evidencia en docs/entrega-5/evidencias/fallos/<escenario>.txt y la
// corrida completa, un resumen en fallos/resumen.md.
//
// Uso, desde reserva-cupos, con el entorno levantado (scripts/sistema.js
// levantar):
//   node pruebas/fallos/matriz.js                 todos, en el orden de abajo
//   node pruebas/fallos/matriz.js worker          uno o varios por nombre
//   node pruebas/fallos/matriz.js --sin-dlq ...   el escenario "tenant" no espera
//                                                 los ~6 min hasta la DLQ
//
// "mysql-primary" va al final: deja la réplica promovida como primario y
// sin réplica. Para volver a la topología inicial: docker compose down -v y
// node scripts/sistema.js levantar.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
    RAIZ, docker, dockerAsync, dockerDirecto, mysql, mysqlAsync, psql, contenedores, api, pedir, claveAula, crearTenant,
    sesionAula, aula, esperar, esperarHasta, Evidencia
} = require("../comun");
const {
    cronometro, segundos, detener, iniciar, esperarSaludable, esperarEntornoSano, colas, rafaga, resumenRafaga,
    listar, verificarInvariantes, resumenInvariantes
} = require("./arnes");

const DIRECTORIO = path.resolve(RAIZ, "../docs/entrega-5/evidencias/fallos");
const SIN_DLQ = process.argv.includes("--sin-dlq");

let tenantDeCarga = null;

// Un tenant propio con límite alto: la carga de las pruebas no se mezcla
// con los datos de Aula ni la frena el límite por defecto.
async function claveDeCarga() {
    tenantDeCarga ??= await crearTenant(`Matriz de fallos ${new Date().toISOString()}`, {
        limite: { por_segundo: 2000, rafaga: 2000 }
    });
    return tenantDeCarga.clave_api;
}

// --- Procesos y broker (E5-13) ----------------------------------------------

// Componente del camino asíncrono detenido a mitad de una ráfaga: la
// admisión no depende de él; las decisiones se demoran hasta que vuelve.
function escenarioAsincrono(servicio, { efecto, garantia }) {
    return async ({ ok, dato }) => {
        const clave = await claveDeCarga();
        let detenidoEn = null;

        const resultado = await rafaga({
            clave,
            capacidad: 10,
            solicitudes: 200,
            concurrencia: 40,
            durante: {
                tras: 40,
                accion: async () => {
                    await detener(servicio);
                    detenidoEn = cronometro();
                }
            }
        });

        dato(`Ráfaga de 200 solicitudes sobre 10 cupos; ${servicio} detenido tras 40 admisiones`);
        dato(resumenRafaga(resultado));
        assert.equal(resultado.admitidas.length, 200);
        ok(`Con ${servicio} detenido, la API siguió admitiendo: 200 de 200 solicitudes respondieron 202`);

        const pendientes = (await listar(api(clave), resultado.actividadId, "pendiente")).length;
        dato(`Pendientes con ${servicio} detenido: ${pendientes} (detenido hace ${segundos(detenidoEn())})`);

        const reloj = cronometro();
        await iniciar(servicio);
        const conteo = await verificarInvariantes({ clave, actividadId: resultado.actividadId, capacidad: 10, solicitudes: 200 });
        const recuperacion = reloj();

        dato(`Invariantes: ${resumenInvariantes(conteo)}`);
        dato(`Tiempo desde que ${servicio} vuelve hasta 0 pendientes: ${segundos(recuperacion)}`);
        ok(`Al volver ${servicio}, se decidieron todas sin pérdidas ni duplicados`);

        return { efecto: `${efecto} (${pendientes} pendientes)`, garantia, recuperacion: segundos(recuperacion) };
    };
}

async function escenarioNotificador({ ok, dato }) {
    const clave = claveAula();
    const resultado = await rafaga({
        clave,
        capacidad: 10,
        solicitudes: 100,
        concurrencia: 25,
        durante: { tras: 10, accion: () => detener("notificador") }
    });

    dato(`Ráfaga de 100 solicitudes del tenant Aula (con webhook); notificador detenido tras 10 admisiones`);
    dato(resumenRafaga(resultado));

    const conteo = await verificarInvariantes({ clave, actividadId: resultado.actividadId, capacidad: 10, solicitudes: 100 });
    dato(`Invariantes en el servicio: ${resumenInvariantes(conteo)}`);
    ok("Sin notificador, el servicio decidió todas las reservas: el webhook no está en el camino de la decisión");

    const enCola = colas()["webhooks.entregas"] || 0;
    dato(`Webhooks esperando en webhooks.entregas con el notificador detenido: ${enCola}`);
    assert.ok(enCola > 0);

    const reloj = cronometro();
    await iniciar("notificador");

    await esperarHasta(() => {
        const filas = psql(`SELECT estado, count(*) FROM inscripciones
                             WHERE actividad_id = '${resultado.actividadId}' GROUP BY estado ORDER BY estado;`);
        return filas.trim() === "confirmada|10\nrechazada|90";
    }, { plazoMs: 120000, descripcion: "que la proyección de Aula coincida con el servicio" });

    const recuperacion = reloj();
    dato(`La proyección de Aula llega a 10 confirmadas y 90 rechazadas ${segundos(recuperacion)} después de reiniciar el notificador`);
    ok("Al volver el notificador, entrega los webhooks pendientes (cola durable) y Aula coincide con el servicio");

    return {
        efecto: `Decisiones sin demora; ${enCola} webhooks esperan en la cola`,
        garantia: "Webhooks entregados al volver; proyección de Aula = servicio",
        recuperacion: segundos(recuperacion)
    };
}

async function escenarioApi({ ok, dato }) {
    const clave = await claveDeCarga();

    docker(["up", "-d", "--no-recreate", "--scale", "api=2", "api"]);
    await esperarHasta(async () => {
        const panel = await pedir("https://localhost:8080/api/http/services/api@docker");
        return Object.values(panel.datos?.serverStatus || {}).filter(e => e === "UP").length === 2;
    }, { plazoMs: 90000, descripcion: "dos instancias de la API UP en Traefik" });
    dato("API escalada a 2 instancias; Traefik las descubrió a las dos");

    const [victima] = contenedores("api");
    let caida = null;

    const resultado = await rafaga({
        clave,
        capacidad: 10,
        solicitudes: 300,
        concurrencia: 40,
        durante: {
            tras: 60,
            accion: async () => {
                await dockerAsync(["kill", victima], { directo: true });
                caida = cronometro();
            }
        }
    });

    dato(`Ráfaga de 300 solicitudes; una instancia de la API terminada con SIGKILL tras 60 admisiones`);
    dato(resumenRafaga(resultado));

    const conteo = await verificarInvariantes({ clave, actividadId: resultado.actividadId, capacidad: 10, solicitudes: 300 });
    dato(`Invariantes: ${resumenInvariantes(conteo)}`);
    ok("Con una instancia caída, Traefik dejó de enviarle tráfico y los reintentos con la misma Idempotency-Key no duplicaron reservas");

    const errores = Object.entries(resultado.errores).map(([codigo, n]) => `${codigo}×${n}`).join(", ");
    const peor = Math.max(...resultado.latencias) / 1000;
    dato(`Errores que vio el cliente antes de reintentar: ${errores || "ninguno"}; peor admisión: ${peor.toFixed(1)} s`);
    dato(`La ráfaga terminó ${segundos(caida())} después de la caída`);

    // Vuelve a una instancia y espera a que Traefik la tenga UP: el
    // escenario siguiente no puede empezar sin API.
    dockerDirecto(["start", victima]);
    docker(["up", "-d", "--no-recreate", "--scale", "api=1", "api"]);
    await esperarHasta(async () => {
        const panel = await pedir("https://localhost:8080/api/http/services/api@docker").catch(() => null);
        const estados = Object.values(panel?.datos?.serverStatus || {});
        return estados.length === 1 && estados[0] === "UP";
    }, { plazoMs: 120000, descripcion: "una instancia de la API UP en Traefik" });

    return {
        efecto: `Solicitudes en curso en la instancia caída: 502/504 (${errores || "ninguno"}); el resto, atendido por la otra`,
        garantia: "Sin reservas perdidas ni duplicadas (reintento idempotente)",
        recuperacion: `peor caso ${peor.toFixed(1)} s para un cliente`
    };
}

// --- Bases y tenant (E5-14) ---------------------------------------------------

function estadoSemisincrono() {
    return mysql("mysql-primary", "SHOW GLOBAL STATUS LIKE 'Rpl_semi_sync_source_status'", { base: "" }).trim().split("\t")[1];
}

async function escenarioReplica({ ok, dato }) {
    const clave = await claveDeCarga();
    assert.equal(estadoSemisincrono(), "ON");

    const resultado = await rafaga({
        clave,
        capacidad: 10,
        solicitudes: 150,
        concurrencia: 30,
        durante: { tras: 30, accion: () => detener("mysql-replica") }
    });

    dato("Ráfaga de 150 solicitudes; mysql-replica detenida tras 30 admisiones");
    dato(resumenRafaga(resultado));
    assert.equal(estadoSemisincrono(), "OFF");
    ok("Sin réplica, el primario degradó a asíncrono tras la espera semisíncrona (10 s) y siguió confirmando escrituras");

    const conteo = await verificarInvariantes({ clave, actividadId: resultado.actividadId, capacidad: 10, solicitudes: 150 });
    dato(`Invariantes: ${resumenInvariantes(conteo)}`);

    const reloj = cronometro();
    await iniciar("mysql-replica");
    await esperarSaludable("mysql-replica");
    await esperarHasta(() => estadoSemisincrono() === "ON", { plazoMs: 120000, descripcion: "semisíncrono de nuevo en ON" });

    const contar = servicio => mysql(servicio,
        `SELECT count(*) FROM reservas WHERE actividad_id = '${resultado.actividadId}'`).trim();
    await esperarHasta(() => contar("mysql-replica") === contar("mysql-primary"), {
        plazoMs: 60000, descripcion: "que la réplica tenga las mismas reservas"
    });
    const recuperacion = reloj();

    dato(`La réplica volvió, recuperó las ${contar("mysql-replica")} reservas escritas sin ella y el primario volvió a semisíncrono en ${segundos(recuperacion)}`);
    ok("Al volver la réplica, se pone al día por GTID y el primario retoma la confirmación semisíncrona");

    const maxima = Math.max(...resultado.latencias) / 1000;
    return {
        efecto: `Una espera de hasta ${maxima.toFixed(1)} s (timeout semisíncrono) y luego replicación asíncrona`,
        garantia: "Escrituras confirmadas; la réplica se pone al día al volver",
        recuperacion: segundos(recuperacion)
    };
}

// Escenario +1 (E5-5): 500 alumnos por Aula, 10 cupos y aula-db detenida a
// mitad de la ráfaga.
async function escenarioAulaDb({ ok, dato }) {
    const sesion = await sesionAula("admin");
    const admin = aula(sesion);
    const clave = claveAula();
    const nombre = `Escenario +1 ${new Date().toISOString()}`;

    const materia = await admin("/materias", { metodo: "POST", cuerpo: { nombre, cupo: 10 } });
    assert.equal(materia.status, 201);

    // Aula expone la inscripción en otra ruta: se adapta el cliente de la
    // ráfaga a /materias/{id}/inscripciones con la sesión del administrador.
    const clienteAula = (ruta, opciones) => {
        const inscripcion = /^\/v1\/actividades\/([^/]+)\/reservas$/.exec(ruta);

        if (!inscripcion) return api(clave)(ruta, opciones);

        return admin(`/materias/${inscripcion[1]}/inscripciones`, {
            ...opciones,
            cuerpo: { alumno: opciones.cuerpo.participante }
        });
    };

    let caidaEn = null;
    const resultado = await rafaga({
        cliente: clienteAula,
        crear: async () => materia.datos,
        capacidad: 10,
        solicitudes: 500,
        concurrencia: 100,
        durante: {
            tras: 150,
            accion: async () => {
                await detener("aula-db");
                caidaEn = cronometro();
            }
        }
    });

    dato(`500 alumnos se inscriben por Aula en "${nombre}" (10 cupos); aula-db detenida tras 150 admisiones`);
    dato(resumenRafaga(resultado));

    const conteo = await verificarInvariantes({
        clave, actividadId: materia.datos.id, capacidad: 10, solicitudes: 500
    });
    dato(`Invariantes en el servicio: ${resumenInvariantes(conteo)}`);
    ok("Con aula-db detenida, Aula siguió inscribiendo: 10 confirmadas, 490 rechazadas, 0 duplicadas, 0 cupos negativos");

    const catalogo = await admin("/materias");
    assert.equal(catalogo.encabezados["x-aula-modo"], "contingencia");
    ok("Durante la caída, el catálogo de Aula sale del feed de la API (modo contingencia)");

    dato(`aula-db estuvo detenida ${segundos(caidaEn())}`);
    const reloj = cronometro();
    await iniciar("aula-db");
    await esperarSaludable("aula-db");

    await esperarHasta(async () => {
        await admin("/reconciliacion", { metodo: "POST" });
        const filas = psql(`SELECT estado, count(*) FROM inscripciones
                             WHERE actividad_id = '${materia.datos.id}' GROUP BY estado ORDER BY estado;`);
        return filas.trim() === "confirmada|10\nrechazada|490";
    }, { plazoMs: 180000, intervaloMs: 2000, descripcion: "que aula-db coincida con el servicio" });

    const recuperacion = reloj();
    assert.equal(psql(`SELECT count(*) FROM materias WHERE actividad_id = '${materia.datos.id}';`).trim(), "1");
    dato(`aula-db coincide con el servicio (10 confirmadas, 490 rechazadas) ${segundos(recuperacion)} después de volver`);
    ok("Al volver aula-db, la reconciliación por feed deja la base de Aula igual al estado del servicio");

    return {
        efecto: "Aula en contingencia: catálogo desde el feed, inscripciones directo a la API",
        garantia: "10/490/0 duplicadas; aula-db = servicio tras reconciliar",
        recuperacion: segundos(recuperacion)
    };
}

// Servidor completo del tenant caído (Aula y aula-db): los webhooks agotan
// sus reintentos y van a la DLQ; al volver, Aula se reconstruye del feed.
async function escenarioTenant({ ok, dato }) {
    const clave = claveAula();
    const dlqAntes = colas()["webhooks.dlq"] || 0;

    await detener("aula");
    await detener("aula-db");
    const caida = cronometro();
    dato("Aula y aula-db detenidas (el servidor completo del tenant)");

    const resultado = await rafaga({ clave, capacidad: 5, solicitudes: 20, concurrencia: 10 });
    const conteo = await verificarInvariantes({ clave, actividadId: resultado.actividadId, capacidad: 5, solicitudes: 20 });
    dato(`Reservas del tenant Aula por otro canal mientras su servidor está caído: ${resumenInvariantes(conteo)}`);
    ok("El servicio sigue decidiendo las reservas del tenant aunque su servidor no responda");

    if (SIN_DLQ) {
        await esperarHasta(() => {
            const actual = colas();
            return (actual["webhooks.espera.10s"] || 0) + (actual["webhooks.espera.1m"] || 0) > 0;
        }, { plazoMs: 60000, descripcion: "webhooks en las colas de espera" });
        ok("Los webhooks fallidos esperan en las colas de reintento (--sin-dlq: no se espera la DLQ)");
    } else {
        await esperarHasta(() => (colas()["webhooks.dlq"] || 0) >= dlqAntes + 20, {
            plazoMs: 480000,
            intervaloMs: 5000,
            descripcion: "que los 20 webhooks agoten los reintentos (10 s, 1 min, 5 min)"
        });
        dato(`webhooks.dlq: ${dlqAntes} → ${colas()["webhooks.dlq"]} mensajes tras ${segundos(caida())}`);
        ok("Agotados los reintentos (10 s, 1 min, 5 min), los 20 webhooks quedan en webhooks.dlq");
    }

    const reloj = cronometro();
    await iniciar("aula-db");
    await iniciar("aula");
    await esperarSaludable("aula");

    await esperarHasta(() => {
        const filas = psql(`SELECT estado, count(*) FROM inscripciones
                             WHERE actividad_id = '${resultado.actividadId}' GROUP BY estado ORDER BY estado;`,
        { permitirFallo: true });
        return filas?.trim() === "confirmada|5\nrechazada|15";
    }, { plazoMs: 120000, intervaloMs: 2000, descripcion: "que Aula se reconstruya desde el feed" });

    const recuperacion = reloj();
    dato(`Aula reconstruyó las 20 inscripciones desde el feed ${segundos(recuperacion)} después de volver`);
    ok("Al volver, Aula se reconstruye desde /v1/cambios: la DLQ no implica pérdida");

    return {
        efecto: SIN_DLQ ? "Webhooks en reintento" : "Webhooks agotan reintentos y van a webhooks.dlq",
        garantia: "Aula reconstruida desde el feed; nada perdido",
        recuperacion: segundos(recuperacion)
    };
}

// --- Failover del primario (E5-12) --------------------------------------------

// Promueve la réplica: espera a que aplique todo lo recibido, corta la
// replicación, quita el solo lectura y le pasa el alias de red
// mysql-primary. Los clientes no cambian su configuración: el nombre que
// usan ahora resuelve a la réplica, cuyo certificado también es válido para
// ese nombre.
async function promoverReplica(dato) {
    const [replica] = contenedores("mysql-replica");
    const red = "reserva-cupos-infra_interna";

    await esperarHasta(async () => (await mysqlAsync("mysql-replica", `
        SELECT GTID_SUBSET(RECEIVED_TRANSACTION_SET, @@GLOBAL.gtid_executed)
          FROM performance_schema.replication_connection_status`, { base: "" })).trim() === "1",
    { plazoMs: 30000, intervaloMs: 200, descripcion: "que la réplica aplique todo lo recibido" });
    dato("La réplica aplicó todas las transacciones que había recibido (GTID_SUBSET)");

    await mysqlAsync("mysql-replica", `
        STOP REPLICA;
        RESET REPLICA ALL;
        SET PERSIST super_read_only = OFF;
        SET PERSIST read_only = OFF;`, { base: "" });

    await dockerAsync(["network", "disconnect", red, replica], { directo: true });
    await dockerAsync(["network", "connect", "--alias", "mysql-primary", "--alias", "mysql-replica", red, replica], { directo: true });
}

async function escenarioPrimario({ ok, dato }) {
    const clave = await claveDeCarga();
    const cliente = api(clave);
    assert.equal(estadoSemisincrono(), "ON");

    let actividadId = null;
    let caida = null;
    let rto = null;
    let promocion = null;
    const confirmadasAntes = [];

    // Sonda de escritura: mide desde la caída hasta la primera escritura
    // que la API vuelve a aceptar.
    async function sondear() {
        for (;;) {
            try {
                const respuesta = await cliente("/v1/actividades", {
                    metodo: "POST",
                    cuerpo: { nombre: "Sonda de failover", capacidad: 1 },
                    timeoutMs: 15000
                });
                if (respuesta.status === 201) return caida();
            } catch (_) {
                // La API no responde: sigue la sonda.
            }
            await esperar(250);
        }
    }

    const resultado = await rafaga({
        clave,
        capacidad: 50,
        solicitudes: 300,
        concurrencia: 20,
        durante: {
            tras: 60,
            accion: async () => {
                // Con algunas reservas ya confirmadas por el worker: así se
                // comprueba también que ninguna confirmación se pierde.
                const previas = await esperarHasta(async () => {
                    const confirmadas = await listar(cliente, actividadId, "confirmada");
                    return confirmadas.length >= 20 && confirmadas;
                }, { plazoMs: 60000, intervaloMs: 200, descripcion: "20 reservas confirmadas antes de la caída" });
                confirmadasAntes.push(...previas.map(r => r.id));

                // Caída abrupta, y aislamiento: el primario caído queda
                // detenido para que no vuelva como un segundo primario.
                await dockerAsync(["kill", "mysql-primary"]);
                caida = cronometro();
                await dockerAsync(["stop", "mysql-primary"]);
                dato(`mysql-primary terminado con SIGKILL con la ráfaga en curso (${confirmadasAntes.length} reservas ya confirmadas)`);

                const sonda = sondear();
                await promoverReplica(dato);
                promocion = caida();
                rto = await sonda;
            }
        },
        crear: async () => {
            const actividad = (await cliente("/v1/actividades", {
                metodo: "POST",
                cuerpo: { nombre: `Failover ${new Date().toISOString()}`, capacidad: 50 }
            })).datos;
            actividadId = actividad.id;
            return actividad;
        }
    });

    dato(`Ráfaga de 300 solicitudes sobre 50 cupos con 20 clientes que reintentan con la misma Idempotency-Key`);
    dato(resumenRafaga(resultado));
    dato(`Promoción completa a los ${segundos(promocion)} de la caída`);
    dato(`RTO (caída → primera escritura aceptada por la API): ${segundos(rto)}`);
    ok(`El sistema retomó la escritura sobre la réplica promovida (RTO ${segundos(rto)}), sin cambiar la configuración de ningún cliente`);

    const conteo = await verificarInvariantes({ clave, actividadId: resultado.actividadId, capacidad: 50, solicitudes: 300 });
    dato(`Invariantes después del failover: ${resumenInvariantes(conteo)}`);

    let perdidas = 0;
    for (const id of resultado.admitidas) {
        if ((await cliente(`/v1/reservas/${id}`)).status !== 200) perdidas++;
    }

    let desconfirmadas = 0;
    for (const id of confirmadasAntes) {
        if ((await cliente(`/v1/reservas/${id}`)).datos?.estado !== "confirmada") desconfirmadas++;
    }

    dato(`Reservas admitidas (202/200) que no están después del failover: ${perdidas} de ${resultado.admitidas.length}`);
    dato(`Reservas confirmadas antes de la caída que ya no lo están: ${desconfirmadas} de ${confirmadasAntes.length}`);
    assert.equal(perdidas, 0);
    assert.equal(desconfirmadas, 0);
    ok("RPO = 0: ninguna reserva admitida ni confirmada se perdió (replicación semisíncrona AFTER_SYNC)");

    return {
        efecto: `Escrituras rechazadas (503) hasta la promoción; ${Object.values(resultado.errores).reduce((a, b) => a + b, 0)} reintentos del cliente`,
        garantia: `RPO = 0 (${resultado.admitidas.length} admitidas, ${confirmadasAntes.length} confirmadas antes de la caída, ninguna perdida)`,
        recuperacion: `RTO ${segundos(rto)}`
    };
}

const ESCENARIOS = {
    worker: escenarioAsincrono("worker", {
        efecto: "Admisión con 202; decisiones en espera",
        garantia: "Comandos durables en RabbitMQ; 10 confirmadas, 0 duplicadas"
    }),
    relay: escenarioAsincrono("relay", {
        efecto: "Admisión con 202; los comandos quedan en el outbox",
        garantia: "Outbox transaccional; nada se pierde al volver"
    }),
    rabbitmq: escenarioAsincrono("rabbitmq", {
        efecto: "Admisión con 202; relay, worker y notificador se reinician hasta reconectar",
        garantia: "Outbox y colas durables; 10 confirmadas, 0 duplicadas"
    }),
    notificador: escenarioNotificador,
    api: escenarioApi,
    "mysql-replica": escenarioReplica,
    "aula-db": escenarioAulaDb,
    tenant: escenarioTenant,
    "mysql-primary": escenarioPrimario
};

const TITULOS = {
    worker: "Worker detenido con una ráfaga en curso",
    relay: "Relay detenido con una ráfaga en curso",
    rabbitmq: "RabbitMQ detenido con una ráfaga en curso",
    notificador: "Notificador detenido: webhooks pendientes",
    api: "Una instancia de la API cae (SIGKILL) con dos instancias",
    "mysql-replica": "Réplica de MySQL detenida: degradación a asíncrona",
    "aula-db": "Escenario +1: aula-db cae con 500 alumnos inscribiéndose",
    tenant: "Servidor completo del tenant caído (Aula y aula-db)",
    "mysql-primary": "Failover del primario de MySQL con medición de RTO y RPO"
};

async function main() {
    const pedidos = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
    const nombres = pedidos.length ? pedidos : Object.keys(ESCENARIOS);
    const desconocidos = nombres.filter(nombre => !ESCENARIOS[nombre]);

    if (desconocidos.length) throw new Error(`Escenarios desconocidos: ${desconocidos.join(", ")}. Hay: ${Object.keys(ESCENARIOS).join(", ")}`);

    const filas = [];
    let fallidos = 0;

    for (const nombre of nombres) {
        console.log(`\n=== ${TITULOS[nombre]} ===`);
        const evidencia = new Evidencia(`fallos/${nombre}.txt`, `Matriz de fallos · ${TITULOS[nombre]}`);

        try {
            await esperarEntornoSano();
            const fila = await ESCENARIOS[nombre](evidencia);
            evidencia.guardar();
            filas.push({ nombre, ...fila, resultado: "Aprobado" });
        } catch (error) {
            console.error(error);
            evidencia.guardar(error);
            filas.push({ nombre, efecto: "-", garantia: "-", recuperacion: "-", resultado: `Fallido: ${error.message}` });
            fallidos++;
        }
    }

    if (!pedidos.length) {
        fs.writeFileSync(path.join(DIRECTORIO, "resumen.md"), [
            "# Matriz de fallos — resumen",
            "",
            `Ejecución: ${new Date().toISOString()} · \`node pruebas/fallos/matriz.js${SIN_DLQ ? " --sin-dlq" : ""}\``,
            "",
            "| Componente | Efecto observado | Garantía verificada | Recuperación | Resultado | Detalle |",
            "|---|---|---|---|---|---|",
            ...filas.map(f => `| ${f.nombre} | ${f.efecto} | ${f.garantia} | ${f.recuperacion} | ${f.resultado} | [${f.nombre}.txt](${f.nombre}.txt) |`),
            ""
        ].join("\n"));
    }

    process.exitCode = fallidos ? 1 : 0;
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

