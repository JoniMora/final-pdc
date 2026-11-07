const express = require("express");
const { pool, enTransaccion } = require("./db");
const { problemas } = require("./problemas");
const {
    uuidv7,
    esUuid,
    sha256,
    jsonCanonico,
    validarMetadata,
    aJson,
    actividadJson,
    reservaJson,
    registrarCambio
} = require("./modelo");

const ACTIVIDAD = "id, nombre, capacidad, cupos_disponibles, estado, version, metadata, creado_en";
const RESERVA = "id, actividad_id, participante_id, estado, version, metadata, creado_en";
const ESTADOS_RESERVA = ["pendiente", "confirmada", "rechazada", "cancelada", "fallida"];
const CLAVE_IDEMPOTENCIA = /^[\x21-\x7e]{1,128}$/;

const rutas = express.Router();

// El tenant se deriva siempre de la clave, nunca de la ruta ni del cuerpo.
async function autenticar(req, res, next) {
    const [esquema, clave] = (req.get("authorization") || "").split(" ");

    if (esquema !== "Bearer" || !clave) {
        throw problemas.noAutenticado();
    }

    const [filas] = await pool.query(
        "SELECT id FROM tenants WHERE api_key_hash = ? AND activo = TRUE",
        [sha256(clave)]
    );

    if (filas.length === 0) {
        throw problemas.noAutenticado();
    }

    req.tenantId = filas[0].id;
    next();
}

function entero(valor, porDefecto, minimo, maximo, nombre) {
    if (valor === undefined) return porDefecto;

    const numero = Number(valor);

    if (!Number.isInteger(numero) || numero < minimo || numero > maximo) {
        throw problemas.solicitudInvalida(`${nombre} debe ser un entero entre ${minimo} y ${maximo}`);
    }

    return numero;
}

async function leerActividad(ejecutor, tenantId, id) {
    if (!esUuid(id)) return null;

    const [filas] = await ejecutor.query(
        `SELECT ${ACTIVIDAD} FROM actividades WHERE id = ? AND tenant_id = ?`,
        [id, tenantId]
    );

    return filas[0] ? actividadJson(filas[0]) : null;
}

async function leerReservaPorClave(tenantId, clave) {
    const [filas] = await pool.query(
        `SELECT ${RESERVA}, request_hash FROM reservas
          WHERE tenant_id = ? AND idempotency_key = ?`,
        [tenantId, clave]
    );

    return filas[0];
}

// Repetición de una solicitud ya admitida: misma clave y mismo cuerpo
// devuelven la misma reserva; otro cuerpo es un error del cliente.
function responderRepeticion(res, fila, hash) {
    if (!fila.request_hash.equals(hash)) {
        throw problemas.claveReutilizada();
    }

    const reserva = reservaJson(fila);

    res.status(200).location(`/v1/reservas/${reserva.id}`);
    if (reserva.estado === "pendiente") res.set("Retry-After", "1");
    res.json(reserva);
}

rutas.use(autenticar);

rutas.post("/actividades", async (req, res) => {
    const { nombre, capacidad } = req.body ?? {};
    const metadata = validarMetadata(req.body?.metadata);

    if (typeof nombre !== "string" || nombre.trim() === "" || nombre.length > 200) {
        throw problemas.solicitudInvalida("nombre debe tener entre 1 y 200 caracteres");
    }

    if (!Number.isInteger(capacidad) || capacidad < 1 || capacidad > 100000) {
        throw problemas.solicitudInvalida("capacidad debe ser un entero entre 1 y 100000");
    }

    const ahora = new Date();
    const actividad = {
        id: uuidv7(),
        nombre: nombre.trim(),
        capacidad,
        cupos_disponibles: capacidad,
        estado: "abierta",
        version: 1,
        metadata,
        creado_en: ahora.toISOString()
    };

    await enTransaccion(async conexion => {
        await conexion.query(
            `INSERT INTO actividades
                 (id, tenant_id, nombre, capacidad, cupos_disponibles, metadata, creado_en)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [actividad.id, req.tenantId, actividad.nombre, capacidad, capacidad, aJson(metadata), ahora]
        );

        await registrarCambio(conexion, req.tenantId, "actividad", actividad, "actividad.creada");
    });

    res.status(201).location(`/v1/actividades/${actividad.id}`).json(actividad);
});

rutas.get("/actividades/:id", async (req, res) => {
    const actividad = await leerActividad(pool, req.tenantId, req.params.id);

    if (!actividad) throw problemas.noEncontrado();

    res.json(actividad);
});

// Abre o cierra la admisión. El contador de cupos no se toca acá:
// api_app no tiene privilegio de UPDATE sobre esa columna.
rutas.patch("/actividades/:id", async (req, res) => {
    const estado = req.body?.estado;

    if (!["abierta", "cerrada"].includes(estado)) {
        throw problemas.solicitudInvalida("estado debe ser abierta o cerrada");
    }

    if (!esUuid(req.params.id)) throw problemas.noEncontrado();

    const actividad = await enTransaccion(async conexion => {
        const [resultado] = await conexion.query(
            `UPDATE actividades SET estado = ?, version = version + 1
              WHERE id = ? AND tenant_id = ? AND estado <> ?`,
            [estado, req.params.id, req.tenantId, estado]
        );

        const actual = await leerActividad(conexion, req.tenantId, req.params.id);

        if (actual && resultado.affectedRows === 1) {
            await registrarCambio(conexion, req.tenantId, "actividad", actual, "actividad.actualizada");
        }

        return actual;
    });

    if (!actividad) throw problemas.noEncontrado();

    res.json(actividad);
});

// Admisión: registra la reserva pendiente y su comando en una sola
// transacción y responde 202. La decisión la toma el worker.
rutas.post("/actividades/:id/reservas", async (req, res) => {
    const clave = req.get("idempotency-key");

    if (!clave || !CLAVE_IDEMPOTENCIA.test(clave)) {
        throw problemas.solicitudInvalida("Idempotency-Key es obligatoria (1 a 128 caracteres ASCII visibles)");
    }

    const participante = req.body?.participante;
    const metadata = validarMetadata(req.body?.metadata);

    if (typeof participante !== "string" || participante === "" || participante.length > 128) {
        throw problemas.solicitudInvalida("participante debe tener entre 1 y 128 caracteres");
    }

    const hash = sha256(jsonCanonico({ actividad_id: req.params.id, participante, metadata }));

    const previa = await leerReservaPorClave(req.tenantId, clave);
    if (previa) return responderRepeticion(res, previa, hash);

    const actividad = await leerActividad(pool, req.tenantId, req.params.id);

    if (!actividad) throw problemas.noEncontrado();

    // Si la actividad se cierra después de esta lectura, el UPDATE
    // condicional del worker vuelve a comprobar el estado y la rechaza.
    if (actividad.estado !== "abierta") throw problemas.actividadCerrada();

    const ahora = new Date();
    const reserva = {
        id: uuidv7(),
        actividad_id: actividad.id,
        participante,
        estado: "pendiente",
        version: 1,
        metadata,
        creado_en: ahora.toISOString()
    };

    try {
        await enTransaccion(async conexion => {
            await conexion.query(
                `INSERT INTO reservas
                     (id, tenant_id, actividad_id, participante_id,
                      idempotency_key, request_hash, metadata, creado_en)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [reserva.id, req.tenantId, actividad.id, participante, clave, hash, aJson(metadata), ahora]
            );

            await registrarCambio(conexion, req.tenantId, "reserva", reserva, "reserva.solicitada", {
                comando: true
            });
        });
    } catch (error) {
        if (error.code === "ER_DUP_ENTRY") {
            // Dos solicitudes simultáneas con la misma clave: el índice
            // único deja pasar una sola y la otra devuelve su resultado.
            // Se busca primero por clave porque, si también repiten el
            // participante, InnoDB puede informar cualquiera de los dos índices.
            const ganadora = await leerReservaPorClave(req.tenantId, clave);
            if (ganadora) return responderRepeticion(res, ganadora, hash);

            if (error.message.includes("uq_participante_activo")) {
                throw problemas.reservaActiva();
            }
        }

        throw error;
    }

    res.status(202)
        .location(`/v1/reservas/${reserva.id}`)
        .set("Retry-After", "1")
        .json(reserva);
});

rutas.get("/reservas/:id", async (req, res) => {
    if (!esUuid(req.params.id)) throw problemas.noEncontrado();

    const [filas] = await pool.query(
        `SELECT ${RESERVA} FROM reservas WHERE id = ? AND tenant_id = ?`,
        [req.params.id, req.tenantId]
    );

    if (filas.length === 0) throw problemas.noEncontrado();

    const reserva = reservaJson(filas[0]);

    if (reserva.estado === "pendiente") res.set("Retry-After", "1");
    res.json(reserva);
});

// Listado paginado por cursor. Los UUIDv7 están ordenados por tiempo,
// así que el cursor es el último identificador entregado.
rutas.get("/actividades/:id/reservas", async (req, res) => {
    const { estado, cursor } = req.query;
    const limite = entero(req.query.limite, 50, 1, 100, "limite");

    if (estado !== undefined && !ESTADOS_RESERVA.includes(estado)) {
        throw problemas.solicitudInvalida(`estado debe ser uno de: ${ESTADOS_RESERVA.join(", ")}`);
    }

    let desdeId = null;

    if (cursor !== undefined) {
        desdeId = Buffer.from(String(cursor), "base64url").toString("utf8");
        if (!esUuid(desdeId)) throw problemas.solicitudInvalida("cursor inválido");
    }

    const actividad = await leerActividad(pool, req.tenantId, req.params.id);

    if (!actividad) throw problemas.noEncontrado();

    const condiciones = ["tenant_id = ?", "actividad_id = ?"];
    const valores = [req.tenantId, actividad.id];

    if (estado) {
        condiciones.push("estado = ?");
        valores.push(estado);
    }

    if (desdeId) {
        condiciones.push("id > ?");
        valores.push(desdeId);
    }

    const [filas] = await pool.query(
        `SELECT ${RESERVA} FROM reservas
          WHERE ${condiciones.join(" AND ")}
          ORDER BY id
          LIMIT ?`,
        [...valores, limite + 1]
    );

    const datos = filas.slice(0, limite).map(reservaJson);
    const hayMas = filas.length > limite;

    res.json({
        datos,
        siguiente_cursor: hayMas
            ? Buffer.from(datos[datos.length - 1].id).toString("base64url")
            : null
    });
});

// Feed de cambios del tenant en orden de secuencia. Solo aparecen los
// cambios que el relay ya secuenció, así un lector nunca ve aparecer
// después una secuencia menor que la última que leyó.
rutas.get("/cambios", async (req, res) => {
    const desde = entero(req.query.desde, 0, 0, Number.MAX_SAFE_INTEGER, "desde");
    const limite = entero(req.query.limite, 100, 1, 500, "limite");

    const [filas] = await pool.query(
        `SELECT secuencia, tipo, snapshot, creado_en FROM cambios
          WHERE tenant_id = ? AND secuencia > ?
          ORDER BY secuencia
          LIMIT ?`,
        [req.tenantId, desde, limite]
    );

    const datos = filas.map(fila => ({
        secuencia: Number(fila.secuencia),
        tipo: fila.tipo,
        ocurrido_en: new Date(fila.creado_en).toISOString(),
        entidad: fila.snapshot
    }));

    res.json({
        datos,
        ultima_secuencia: datos.length ? datos[datos.length - 1].secuencia : desde
    });
});

module.exports = rutas;
