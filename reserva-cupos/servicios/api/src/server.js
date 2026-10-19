const express = require("express");
const { pool, esErrorDeInfraestructura } = require("./db");
const { Problema, enviarProblema, problemas } = require("./problemas");
const rutas = require("./rutas");

const PORT = Number(process.env.PORT || 3000);

const app = express();

app.disable("x-powered-by");

// metadata admite hasta 16 KB; el resto del cuerpo es chico.
app.use(express.json({ limit: "24kb" }));

// Salud del proceso. Informa la base sin fallar si no responde.
app.get("/health", async (req, res) => {
    let mysql = "conectado";

    try {
        await pool.query({ sql: "SELECT 1", timeout: 2000 });
    } catch (_) {
        mysql = "no disponible";
    }

    res.json({ servicio: "api", estado: "ok", mysql });
});

app.use("/v1", rutas);

app.use((req, res) => {
    enviarProblema(res, problemas.noEncontrado());
});

app.use((error, req, res, next) => {
    if (error instanceof Problema) {
        return enviarProblema(res, error);
    }

    if (error.type === "entity.too.large") {
        return enviarProblema(res, new Problema(413, null, "Cuerpo demasiado grande"));
    }

    if (error.type === "entity.parse.failed") {
        return enviarProblema(res, problemas.solicitudInvalida("JSON inválido"));
    }

    // La base no responde: lo admitido ya está guardado y el cliente
    // puede reintentar con la misma Idempotency-Key.
    if (esErrorDeInfraestructura(error)) {
        console.error("[API] MySQL no disponible:", error.code || error.message);
        return enviarProblema(res, problemas.noDisponible());
    }

    console.error("[API] Error inesperado:", error);
    enviarProblema(res, new Problema(500, null, "Error interno"));
});

const servidor = app.listen(PORT, "0.0.0.0", () => {
    console.log(`[API] Escuchando en puerto ${PORT}`);
});

servidor.on("error", error => {
    console.error("[API]", error.message);
    process.exit(1);
});
