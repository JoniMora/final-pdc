const express = require("express");
const { Pool } = require("pg");
const { randomUUID } = require("node:crypto");
const path = require("node:path");

const app = express();
const API_URL = process.env.API_URL || "http://api:3000";
const PORT = Number(process.env.PORT || 3001);

// Lee PGHOST, PGUSER, PGPASSWORD y PGDATABASE del entorno.
const pool = new Pool({
    connectionTimeoutMillis: 2000,
    query_timeout: 3000,
    max: 5
});

pool.on("error", error => {
    console.error("[AULA] PostgreSQL:", error.message);
});

app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(__dirname, "../public")));

// Comprueba que la aplicación está funcionando.
app.get("/health", (req, res) => {
    res.json({ servicio: "aula", estado: "ok" });
});

// Comprueba las conexiones sin detener la página si alguna falla.
app.get("/estado", async (req, res) => {
    const [base, api] = await Promise.allSettled([
        pool.query("SELECT 1 FROM comprobaciones LIMIT 1"),

        fetch(`${API_URL}/health`, {
            signal: AbortSignal.timeout(3000)
        }).then(response => {
            if (!response.ok) {
                throw new Error("API no disponible");
            }

            return response.json();
        })
    ]);

    res.json({
        aula: "ok",
        postgresql:
            base.status === "fulfilled" ? "conectado" : "no disponible",
        api:
            api.status === "fulfilled" ? "conectada" : "no disponible"
    });
});

// Lee los últimos diez registros de la base propia de Aula.
app.get("/pruebas/base", async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, texto, creado_en
       FROM comprobaciones
       ORDER BY creado_en DESC, id DESC
       LIMIT 10`
        );

        res.json(result.rows);
    } catch (error) {
        console.error("[AULA] Consulta:", error.message);

        res.status(503).json({
            error: "La base de Aula no esta disponible"
        });
    }
});

// Guarda un dato real en PostgreSQL.
app.post("/pruebas/base", async (req, res) => {
    try {
        const result = await pool.query(
            `INSERT INTO comprobaciones (id, texto)
       VALUES ($1, $2)
       RETURNING id, texto, creado_en`,
            [randomUUID(), "Prueba guardada desde Aula"]
        );

        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error("[AULA] Escritura:", error.message);

        res.status(503).json({
            error: "No se pudo guardar en la base de Aula"
        });
    }
});

// Se comunica con la API por HTTP, sin acceder a MySQL.
app.post("/pruebas/mensajes", async (req, res) => {
    try {
        const response = await fetch(`${API_URL}/pruebas/mensajes`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                texto: req.body?.texto
            }),
            signal: AbortSignal.timeout(7000)
        });

        res.status(response.status).json(await response.json());
    } catch (error) {
        console.error("[AULA] API:", error.message);

        res.status(503).json({
            error: "No se pudo obtener respuesta de la API"
        });
    }
});

app.use((error, req, res, next) => {
    res.status(error.type === "entity.too.large" ? 413 : 400).json({
        error: "JSON invalido o demasiado grande"
    });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`[AULA] Pagina disponible en puerto ${PORT}`);
});