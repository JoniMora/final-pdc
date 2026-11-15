const express = require("express");
const { randomBytes } = require("node:crypto");
const { poolAdministracion } = require("./db");
const { problemas } = require("./problemas");
const { uuidv7, sha256 } = require("./modelo");

// Administración de tenants (contrato/openapi.yaml, /admin/v1). Reemplaza
// al script crear-tenant.sql: el operador da de alta tenants, cambia sus
// permisos, webhook y límite de tasa, y rota su clave. El validador del
// contrato ya comprobó la forma de cada cuerpo antes de llegar acá.

const TODOS_LOS_PERMISOS = ["actividades:escribir", "reservas:escribir", "lectura", "cambios:leer"];
const COLUMNAS = "id, nombre, activo, scopes, webhook_url, limite_por_segundo, limite_rafaga, creado_en";

const rutasAdmin = express.Router();

// 256 bits aleatorios. La base guarda solo el hash: la clave se muestra
// una única vez, en la respuesta que la genera.
function nuevaClave() {
    const clave = `rc_${randomBytes(32).toString("hex")}`;
    return { clave, hash: sha256(clave) };
}

function tenantJson(fila) {
    return {
        id: fila.id,
        nombre: fila.nombre,
        activo: Boolean(fila.activo),
        scopes: fila.scopes ? fila.scopes.split(",") : [],
        webhook_url: fila.webhook_url,
        limite: fila.limite_por_segundo
            ? { por_segundo: fila.limite_por_segundo, rafaga: fila.limite_rafaga }
            : null,
        creado_en: new Date(fila.creado_en).toISOString()
    };
}

async function leerTenant(id) {
    const [filas] = await poolAdministracion().query(
        `SELECT ${COLUMNAS} FROM tenants WHERE id = ?`,
        [id]
    );

    return filas[0] || null;
}

rutasAdmin.post("/tenants", async (req, res) => {
    const { scopes = TODOS_LOS_PERMISOS, webhook_url = null, limite = null } = req.body;
    const nombre = req.body.nombre.trim();

    if (nombre === "") throw problemas.solicitudInvalida("nombre no puede estar vacío");

    const id = uuidv7();
    const { clave, hash } = nuevaClave();
    const secreto = webhook_url ? randomBytes(32) : null;

    await poolAdministracion().query(
        `INSERT INTO tenants
             (id, nombre, api_key_hash, webhook_url, webhook_secret, scopes,
              limite_por_segundo, limite_rafaga)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, nombre, hash, webhook_url, secreto, scopes.join(","),
            limite?.por_segundo ?? null, limite?.rafaga ?? null]
    );

    res.status(201)
        .location(`/admin/v1/tenants/${id}`)
        .json({
            ...tenantJson(await leerTenant(id)),
            clave_api: clave,
            webhook_secreto: secreto ? secreto.toString("hex") : null
        });
});

rutasAdmin.get("/tenants/:id", async (req, res) => {
    const fila = await leerTenant(req.params.id);

    if (!fila) throw problemas.noEncontrado();

    res.json(tenantJson(fila));
});

// Cambia solo los campos presentes. Si el tenant registra un webhook y no
// tenía secreto, se propone uno nuevo con COALESCE: queda el que ya estaba
// o el propuesto, y se devuelve solo si fue este pedido el que lo guardó.
rutasAdmin.patch("/tenants/:id", async (req, res) => {
    const cambios = [];
    const valores = [];
    let secretoPropuesto = null;

    if ("scopes" in req.body) {
        cambios.push("scopes = ?");
        valores.push(req.body.scopes.join(","));
    }

    if ("activo" in req.body) {
        cambios.push("activo = ?");
        valores.push(req.body.activo);
    }

    if ("limite" in req.body) {
        cambios.push("limite_por_segundo = ?", "limite_rafaga = ?");
        valores.push(req.body.limite?.por_segundo ?? null, req.body.limite?.rafaga ?? null);
    }

    if ("webhook_url" in req.body) {
        if (req.body.webhook_url === null) {
            cambios.push("webhook_url = NULL", "webhook_secret = NULL");
        } else {
            secretoPropuesto = randomBytes(32);
            cambios.push("webhook_url = ?", "webhook_secret = COALESCE(webhook_secret, ?)");
            valores.push(req.body.webhook_url, secretoPropuesto);
        }
    }

    const [resultado] = await poolAdministracion().query(
        `UPDATE tenants SET ${cambios.join(", ")} WHERE id = ?`,
        [...valores, req.params.id]
    );

    if (resultado.affectedRows === 0) throw problemas.noEncontrado();

    const respuesta = tenantJson(await leerTenant(req.params.id));

    if (secretoPropuesto) {
        const [filas] = await poolAdministracion().query(
            "SELECT webhook_secret FROM tenants WHERE id = ?",
            [req.params.id]
        );

        if (filas[0]?.webhook_secret?.equals(secretoPropuesto)) {
            respuesta.webhook_secreto = secretoPropuesto.toString("hex");
        }
    }

    res.json(respuesta);
});

// La clave anterior deja de autenticar en el mismo UPDATE que guarda la
// nueva: la API busca el tenant por el hash de la clave en cada solicitud.
rutasAdmin.post("/tenants/:id/rotacion", async (req, res) => {
    const { clave, hash } = nuevaClave();

    const [resultado] = await poolAdministracion().query(
        "UPDATE tenants SET api_key_hash = ? WHERE id = ?",
        [hash, req.params.id]
    );

    if (resultado.affectedRows === 0) throw problemas.noEncontrado();

    res.json({ id: req.params.id, clave_api: clave });
});

module.exports = { rutasAdmin, TODOS_LOS_PERMISOS };
