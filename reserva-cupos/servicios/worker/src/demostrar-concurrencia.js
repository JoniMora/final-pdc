// Demostración del caso de concurrencia: N transacciones simultáneas
// compiten por los cupos de una misma fila de actividades.
//
//   ingenua: lee el cupo, lo compara en la aplicación y escribe el
//            valor calculado (SELECT y después UPDATE).
//   atómica: una única sentencia condicional (la que usa el worker).
//
// Uso: node src/demostrar-concurrencia.js <actividad_id> [solicitudes] [pausa_ms]
//
// La actividad debe ser de prueba y no tener reservas: el script escribe
// el contador directamente y al final lo restablece a la capacidad.

const { crearPool } = require("./db");

const [actividadId, solicitudesArg = "50", pausaArg = "5"] = process.argv.slice(2);
const SOLICITUDES = Number(solicitudesArg);
const PAUSA_MS = Number(pausaArg);

function esperar(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function ronda(pool, capacidad, decidir) {
    await pool.query(
        "UPDATE actividades SET cupos_disponibles = ? WHERE id = ?",
        [capacidad, actividadId]
    );

    // Se abren todas las conexiones antes de largar, para que las
    // transacciones arranquen a la vez.
    const conexiones = await Promise.all(
        Array.from({ length: SOLICITUDES }, () => pool.getConnection())
    );

    const asignados = await Promise.all(conexiones.map(async conexion => {
        try {
            await conexion.beginTransaction();
            const asignado = await decidir(conexion);
            await conexion.commit();
            return asignado;
        } catch (error) {
            await conexion.rollback().catch(() => {});
            throw error;
        } finally {
            conexion.release();
        }
    }));

    const [[{ cupos }]] = await pool.query(
        "SELECT cupos_disponibles AS cupos FROM actividades WHERE id = ?",
        [actividadId]
    );

    return { asignados: asignados.filter(Boolean).length, cupos };
}

async function ingenua(conexion) {
    const [[{ cupos }]] = await conexion.query(
        "SELECT cupos_disponibles AS cupos FROM actividades WHERE id = ?",
        [actividadId]
    );

    if (cupos <= 0) return false;

    // Lógica de aplicación entre la lectura y la escritura.
    await esperar(PAUSA_MS);

    await conexion.query(
        "UPDATE actividades SET cupos_disponibles = ? WHERE id = ?",
        [cupos - 1, actividadId]
    );

    return true;
}

async function atomica(conexion) {
    const [resultado] = await conexion.query(
        `UPDATE actividades
            SET cupos_disponibles = cupos_disponibles - 1
          WHERE id = ? AND estado = 'abierta' AND cupos_disponibles > 0`,
        [actividadId]
    );

    return resultado.affectedRows === 1;
}

async function demostrar() {
    if (!actividadId || !Number.isInteger(SOLICITUDES) || SOLICITUDES < 2) {
        throw new Error("Uso: node src/demostrar-concurrencia.js <actividad_id> [solicitudes>=2] [pausa_ms]");
    }

    const pool = crearPool(SOLICITUDES);

    try {
        const [actividades] = await pool.query(
            "SELECT capacidad FROM actividades WHERE id = ?",
            [actividadId]
        );

        if (actividades.length === 0) {
            throw new Error("La actividad no existe");
        }

        const [[{ reservas }]] = await pool.query(
            "SELECT COUNT(*) AS reservas FROM reservas WHERE actividad_id = ?",
            [actividadId]
        );

        if (reservas > 0) {
            throw new Error("La actividad tiene reservas: usar una actividad de prueba vacía");
        }

        const { capacidad } = actividades[0];

        console.log(
            `Actividad ${actividadId}: capacidad ${capacidad}, ` +
            `${SOLICITUDES} transacciones simultáneas, pausa ingenua ${PAUSA_MS} ms\n`
        );

        const resultados = {
            ingenua: await ronda(pool, capacidad, ingenua),
            atomica: await ronda(pool, capacidad, atomica)
        };

        for (const [estrategia, { asignados, cupos }] of Object.entries(resultados)) {
            const exceso = Math.max(0, asignados - capacidad);

            console.log(
                `${estrategia.padEnd(8)} asignados=${String(asignados).padStart(3)} ` +
                `capacidad=${capacidad} cupos_finales=${cupos} ` +
                `sobreasignados=${exceso}`
            );
        }

        // Sin reservas, el contador correcto es la capacidad.
        await pool.query(
            "UPDATE actividades SET cupos_disponibles = capacidad WHERE id = ?",
            [actividadId]
        );

        const { asignados, cupos } = resultados.atomica;

        if (asignados !== capacidad || cupos !== 0) {
            throw new Error("La estrategia atómica no asignó exactamente la capacidad");
        }

        console.log("\nOK: la sentencia condicional asignó exactamente la capacidad.");
    } finally {
        await pool.end();
    }
}

demostrar().catch(error => {
    console.error("ERROR:", error.message);
    process.exitCode = 1;
});
