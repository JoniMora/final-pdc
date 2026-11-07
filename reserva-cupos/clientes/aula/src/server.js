const express = require("express");
const { Pool } = require("pg");
const { randomUUID } = require("node:crypto");
const path = require("node:path");

const app = express();
app.disable("x-powered-by");
const API_URL = process.env.API_URL || "http://api:3000";
const API_KEY = process.env.API_KEY;
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

// Canal síncrono con el servicio: HTTP y clave de API del tenant.
// Aula nunca accede a MySQL.
async function llamarApi(metodo, ruta, { cuerpo, encabezados = {} } = {}) {
    const response = await fetch(`${API_URL}${ruta}`, {
        method: metodo,
        headers: {
            Authorization: `Bearer ${API_KEY}`,
            ...(cuerpo ? { "Content-Type": "application/json" } : {}),
            ...encabezados
        },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
        // Mayor que la espera de la réplica semisíncrona (10 s).
        signal: AbortSignal.timeout(15000)
    });

    return {
        status: response.status,
        location: response.headers.get("location"),
        retryAfter: response.headers.get("retry-after"),
        cuerpo: await response.json()
    };
}

// Reenvía al navegador la respuesta de la API con sus cabeceras útiles.
function reenviar(res, respuesta) {
    if (respuesta.location) res.set("Location", respuesta.location);
    if (respuesta.retryAfter) res.set("Retry-After", respuesta.retryAfter);
    res.status(respuesta.status).json(respuesta.cuerpo);
}

function apiNoDisponible(res, error) {
    console.error("[AULA] API:", error.message);

    res.status(503).json({
        error: "No se pudo obtener respuesta de la API"
    });
}

app.get("/health", (req, res) => {
    res.json({ servicio: "aula", estado: "ok" });
});

// Comprueba las conexiones sin detener la página si alguna falla.
app.get("/estado", async (req, res) => {
    const [base, api] = await Promise.allSettled([
        pool.query("SELECT 1 FROM materias LIMIT 1"),

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

// Materias guardadas en la base propia de Aula.
app.get("/materias", async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, actividad_id, nombre, cupo, creado_en
               FROM materias
              ORDER BY creado_en DESC
              LIMIT 20`
        );

        res.json(result.rows);
    } catch (error) {
        console.error("[AULA] Consulta:", error.message);

        res.status(503).json({
            error: "La base de Aula no esta disponible"
        });
    }
});

// Crea la actividad en el servicio y la registra como materia local.
app.post("/materias", async (req, res) => {
    const nombre = req.body?.nombre;
    const cupo = Number(req.body?.cupo);

    let respuesta;

    try {
        respuesta = await llamarApi("POST", "/v1/actividades", {
            cuerpo: {
                nombre,
                capacidad: cupo,
                metadata: { origen: "aula", tipo: "materia" }
            }
        });
    } catch (error) {
        return apiNoDisponible(res, error);
    }

    if (respuesta.status !== 201) {
        return reenviar(res, respuesta);
    }

    const actividad = respuesta.cuerpo;

    try {
        await pool.query(
            `INSERT INTO materias (id, actividad_id, nombre, cupo)
             VALUES ($1, $2, $3, $4)`,
            [randomUUID(), actividad.id, actividad.nombre, actividad.capacidad]
        );
    } catch (error) {
        // La actividad ya existe en el servicio; la reconciliación con
        // el feed de cambios se incorpora en la Entrega 5.
        console.error("[AULA] Escritura:", error.message);
    }

    res.status(201).json(actividad);
});

// Estado de la materia e inscriptos confirmados, leídos de la API.
app.get("/materias/:actividadId", async (req, res) => {
    const ruta = `/v1/actividades/${encodeURIComponent(req.params.actividadId)}`;

    try {
        const actividad = await llamarApi("GET", ruta);

        if (actividad.status !== 200) {
            return reenviar(res, actividad);
        }

        const inscriptos = await llamarApi("GET", `${ruta}/reservas?estado=confirmada&limite=100`);

        res.json({
            ...actividad.cuerpo,
            inscriptos: inscriptos.cuerpo.datos
        });
    } catch (error) {
        apiNoDisponible(res, error);
    }
});

// Solicita la inscripción. El navegador genera la Idempotency-Key y la
// reutiliza si reintenta, así un reintento no duplica la reserva.
app.post("/materias/:actividadId/inscripciones", async (req, res) => {
    const ruta = `/v1/actividades/${encodeURIComponent(req.params.actividadId)}/reservas`;

    try {
        reenviar(res, await llamarApi("POST", ruta, {
            cuerpo: { participante: req.body?.alumno },
            encabezados: {
                "Idempotency-Key": req.get("idempotency-key") || randomUUID()
            }
        }));
    } catch (error) {
        apiNoDisponible(res, error);
    }
});

app.get("/inscripciones/:reservaId", async (req, res) => {
    try {
        reenviar(res, await llamarApi(
            "GET",
            `/v1/reservas/${encodeURIComponent(req.params.reservaId)}`
        ));
    } catch (error) {
        apiNoDisponible(res, error);
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
