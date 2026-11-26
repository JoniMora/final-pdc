// Escenario +1 para la demo en vivo (issue #53): "apertura de una materia de
// 10 cupos con la base del cliente caída".
//
// 500 alumnos se inscriben por Aula a una materia de 10 cupos; a mitad de la
// ráfaga se detiene aula-db. Aula pasa a contingencia (catálogo desde el feed,
// inscripciones directo a la API) y, al volver la base, se reconcilia.
// Criterio del plan (Entrega 0): exactamente 10 confirmadas, 0 duplicadas,
// 0 cupos negativos, y al terminar la base de Aula coincide con el servicio.
//
// Uso, desde reserva-cupos, con el entorno listo (node scripts/sistema.js demo):
//   node pruebas/final/escenario-mas-uno.js             de corrido
//   node pruebas/final/escenario-mas-uno.js --pausas    espera Enter entre pasos (en vivo)
//
// Cada corrida deja su registro en docs/final/ensayos/<fecha>.txt.
const assert = require("node:assert/strict");
const readline = require("node:readline/promises");
const {
    api, pedir, claveAula, sesionAula, aula, psql, esperarHasta, Evidencia, API, AULA
} = require("../comun");
const { cronometro, segundos, detener, iniciar, esperarSaludable, rafaga, resumenRafaga,
    verificarInvariantes, resumenInvariantes } = require("../fallos/arnes");

const PAUSAS = process.argv.includes("--pausas");
const ALUMNOS = 500;
const CUPO = 10;
const CAIDA_TRAS = 150;

const fecha = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const registro = new Evidencia(`../../final/ensayos/${fecha}.txt`, "Ensayo del escenario +1: materia de 10 cupos con la base de Aula caída");

let paso = 0;
async function titulo(texto) {
    if (PAUSAS && paso > 0) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        await rl.question("\n[Enter para seguir] ");
        rl.close();
    }
    paso++;
    const linea = `\n=== ${paso}. ${texto}`;
    console.log(linea);
    registro.lineas.push(linea.trim());
}

async function main({ ok, dato }) {
    const clave = claveAula();
    const sesion = await sesionAula("admin");
    const admin = aula(sesion);

    await titulo("Todo sano");
    const [salud, saludAula, control] = await Promise.all([
        pedir(`${API}/health`), pedir(`${AULA}/health`), admin("/reconciliacion")
    ]);
    assert.equal(salud.status, 200);
    assert.equal(saludAula.status, 200);
    dato(`API: MySQL ${salud.datos.mysql} · Aula: modo ${control.datos.modo}`);
    ok("El servicio y Aula responden; Aula opera en modo normal con su propia base (aula-db)");

    await titulo(`El administrador abre una materia de ${CUPO} cupos`);
    const hora = new Date().toTimeString().slice(0, 8); // HH:MM:SS, hora local de 24 h
    const nombre = `Escenario +1 · ${hora}`;
    const materia = await admin("/materias", { metodo: "POST", cuerpo: { nombre, cupo: CUPO } });
    assert.equal(materia.status, 201);
    dato(`"${nombre}" (actividad ${materia.datos.id}) · verla en ${AULA}`);

    await titulo(`${ALUMNOS} alumnos se inscriben a la vez; a las ${CAIDA_TRAS} admisiones se cae aula-db`);
    // Aula inscribe en /materias/{id}/inscripciones; la ráfaga del arnés
    // reintenta como un cliente correcto (misma Idempotency-Key).
    let admitidas = 0;
    const clienteAula = async (ruta, opciones) => {
        const inscripcion = /^\/v1\/actividades\/([^/]+)\/reservas$/.exec(ruta);
        if (!inscripcion) return api(clave)(ruta, opciones);
        const r = await admin(`/materias/${inscripcion[1]}/inscripciones`, {
            ...opciones, cuerpo: { alumno: opciones.cuerpo.participante }
        });
        if (r.status === 202 || r.status === 200) admitidas++;
        return r;
    };
    const progreso = setInterval(() => process.stdout.write(`\r  admitidas: ${admitidas}/${ALUMNOS}   `), 500);
    let caida = null;
    let contingencia = null;
    const resultado = await rafaga({
        cliente: clienteAula,
        crear: async () => materia.datos,
        capacidad: CUPO,
        solicitudes: ALUMNOS,
        concurrencia: 100,
        durante: {
            tras: CAIDA_TRAS,
            accion: async () => {
                await detener("aula-db");
                caida = cronometro();
                process.stdout.write("\n  >>> aula-db detenida: Aula sigue inscribiendo contra la API\n");
                const catalogo = await admin("/materias");
                contingencia = catalogo.encabezados["x-aula-modo"];
            }
        }
    }).finally(() => clearInterval(progreso));
    process.stdout.write("\n");
    dato(resumenRafaga(resultado));
    assert.equal(contingencia, "contingencia");
    ok(`Con aula-db caída, Aula respondió en modo contingencia (X-Aula-Modo: ${contingencia}) y las ${ALUMNOS} inscripciones fueron admitidas`);

    await titulo("El servicio decidió: 10 confirmadas, el resto rechazadas");
    const conteo = await verificarInvariantes({ clave, actividadId: materia.datos.id, capacidad: CUPO, solicitudes: ALUMNOS });
    dato(`Servicio: ${resumenInvariantes(conteo)}`);
    assert.equal(conteo.duplicadas, 0);
    ok(`${CUPO} confirmadas, ${ALUMNOS - CUPO} rechazadas, 0 duplicadas, 0 cupos negativos`);

    await titulo("Vuelve aula-db y Aula se reconcilia desde el feed");
    dato(`aula-db estuvo detenida ${segundos(caida())}`);
    const reloj = cronometro();
    await iniciar("aula-db");
    await esperarSaludable("aula-db");
    const esperado = `confirmada|${CUPO}\nrechazada|${ALUMNOS - CUPO}`;
    await esperarHasta(async () => {
        await admin("/reconciliacion", { metodo: "POST" }).catch(() => null);
        const filas = psql(`SELECT estado, count(*) FROM inscripciones
                             WHERE actividad_id = '${materia.datos.id}' GROUP BY estado ORDER BY estado;`,
        { permitirFallo: true });
        return filas?.trim() === esperado;
    }, { plazoMs: 180000, intervaloMs: 2000, descripcion: "que aula-db coincida con el servicio" });
    dato(`aula-db: ${esperado.replace("\n", ", ").replace(/\|/g, " ")} · ${segundos(reloj())} después de volver`);
    ok("La base de Aula coincide con el servicio: el escenario +1 cumple el criterio del plan");
}

const { ejecutar } = require("../comun");
ejecutar(registro, main).then(codigo => { process.exitCode = codigo; });
