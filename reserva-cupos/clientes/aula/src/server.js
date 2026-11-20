const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const express = require("express");
const { Pool } = require("pg");
const { crearClienteApi, ErrorDeContrato } = require("./api");
const { secretoDesdeHex, verificarFirma, aplicarReserva, aplicarEvento } = require("./webhooks");
const { crearSeguridad, puedeVer } = require("./seguridad");
const { crearRecuperacion } = require("./recuperacion");
const { crearInterruptor, conBase } = require("./interruptor");
const { leerCa } = require("../../../compartido/src/tls");

const app = express();
app.disable("x-powered-by");

// La API se alcanza por el gateway: Aula no conoce sus instancias.
const API_URL = process.env.API_URL || "https://traefik";
const PORT = Number(process.env.PORT || 3001);

// Secreto del webhook, en hexadecimal como lo entrega el servicio. Sin él,
// el receptor no podría verificar ninguna firma: Aula no arranca.
let SECRETO_WEBHOOK;

try {
    SECRETO_WEBHOOK = secretoDesdeHex(process.env.WEBHOOK_SECRET);
} catch (error) {
    console.error(`[AULA] WEBHOOK_SECRET inválido: ${error.message}`);
    process.exit(1);
}

const api = crearClienteApi({ baseUrl: API_URL, clave: process.env.API_KEY });

// Lee PGHOST, PGUSER, PGPASSWORD y PGDATABASE del entorno. Con la CA
// local, la conexión es TLS y verifica que el certificado sea de aula-db.
const ca = leerCa();
const pool = new Pool({
    connectionTimeoutMillis: 2000,
    query_timeout: 3000,
    max: 5,
    ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {})
});

// Con aula-db caída, Aula no vuelve a intentar la base en cada pedido.
const interruptor = crearInterruptor();
const base = operacion => conBase(interruptor, operacion);

pool.on("error", error => {
    console.error("[AULA] PostgreSQL:", error.message);
});

// Receptor de webhooks (contrato/openapi.yaml, sección webhooks). Se
// registra antes del parser JSON: la firma se verifica sobre el cuerpo
// exacto recibido.
app.post("/webhooks/reservas", express.raw({ type: "application/json", limit: "64kb" }), async (req, res) => {
    const cuerpo = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const firma = verificarFirma(cuerpo, req.get("x-firma"), SECRETO_WEBHOOK);

    if (!firma.valida) {
        console.error(`[AULA] Webhook ${req.get("x-webhook-id") || "-"} rechazado: ${firma.motivo}`);
        return res.status(401).end();
    }

    let evento;

    try {
        evento = api.contrato.validarEsquema("EventoReserva", JSON.parse(cuerpo));
    } catch (error) {
        console.error(`[AULA] Webhook ${req.get("x-webhook-id")} fuera de contrato: ${error.message}`);
        return res.status(400).end();
    }

    try {
        const aplicado = await base(() => aplicarEvento(pool, evento));
        console.log(`[AULA] Webhook ${req.get("x-webhook-id")}: ${evento.tipo} v${evento.entidad.version}`
            + (aplicado ? " aplicado" : " repetido o atrasado, sin cambios"));
        res.status(204).end();
    } catch (error) {
        // Sin base no se puede aplicar: el notificador reintenta.
        console.error("[AULA] Webhook no aplicado, PostgreSQL:", error.message);
        res.status(503).end();
    }
});

app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(__dirname, "../public")));

// Login y sesiones de las personas. Sin TLS (pruebas fuera de Docker) la
// cookie no lleva Secure; el entorno de docker-compose.yml siempre usa TLS.
const TLS = Boolean(process.env.TLS_CERT);
const USUARIOS = process.env.USUARIOS_ARCHIVO || "/seguridad/usuarios.json";

if (!fs.existsSync(USUARIOS)) {
    console.error(`[AULA] No existe ${USUARIOS}: nadie puede iniciar sesión (ver scripts/preparar-seguridad.js)`);
}

const seguridad = crearSeguridad({ archivo: USUARIOS, secure: TLS });
seguridad.montar(app);

app.use(["/materias", "/inscripciones", "/estado", "/reconciliacion"], seguridad.exigirTransporte, seguridad.autenticar);

const recuperacion = crearRecuperacion({ pool, api, interruptor });
recuperacion.iniciar();

// Estado y disparo manual de la reconciliación: solo para el administrador.
app.get("/reconciliacion", seguridad.administrador, (req, res) => {
    res.json(recuperacion.estado);
});

app.post("/reconciliacion", seguridad.administrador, async (req, res) => {
    res.json(await recuperacion.sincronizar());
});

// Reenvía al navegador la respuesta de la API con sus cabeceras útiles.
function reenviar(res, respuesta) {
    if (respuesta.location) res.set("Location", respuesta.location);
    if (respuesta.retryAfter) res.set("Retry-After", respuesta.retryAfter);
    res.status(respuesta.status).json(respuesta.cuerpo);
}

function errorDeApi(res, error) {
    if (error instanceof ErrorDeContrato) {
        console.error("[AULA] La API respondió fuera de contrato:", error.message);
        return res.status(502).json({ error: "La API respondió fuera de contrato" });
    }

    console.error("[AULA] API:", error.message, error.cause?.code || error.cause?.message || "");
    res.status(503).json({ error: "No se pudo obtener respuesta de la API" });
}

// Guarda en la base propia una inscripción que la API devolvió. Si la base
// no responde, el webhook o la reconciliación la completan después.
async function proyectar(reserva) {
    try {
        await base(() => aplicarReserva(pool, reserva));
    } catch (error) {
        console.error("[AULA] Proyección local pendiente:", error.message);
    }
}

app.get("/health", (req, res) => {
    res.json({ servicio: "aula", estado: "ok" });
});

// Comprueba las conexiones sin detener la página si alguna falla. /health
// es operativo y no forma parte del contrato.
app.get("/estado", async (req, res) => {
    // (Antes el resultado se llamaba `base` y tapaba la función base() del
    // interruptor: la ruta fallaba siempre y respondía 400.)
    const [postgresql, servicio] = await Promise.allSettled([
        base(() => pool.query("SELECT 1 FROM materias LIMIT 1")),

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
        contrato: `openapi.yaml ${api.contrato.version}`,
        postgresql: postgresql.status === "fulfilled" ? "conectado" : "no disponible",
        recuperacion: recuperacion.estado.modo,
        api: servicio.status === "fulfilled" ? `conectada (instancia ${servicio.value.instancia})` : "no disponible"
    });
});

// Materias guardadas en la base propia de Aula.
app.get("/materias", async (req, res) => {
    try {
        const result = await base(() => pool.query(
            `SELECT id, actividad_id, nombre, cupo, creado_en
               FROM materias
              ORDER BY creado_en DESC
              LIMIT 20`
        ));

        res.json(result.rows);
    } catch (error) {
        console.error("[AULA] Consulta:", error.message);

        // Contingencia: el catálogo se arma desde el feed de la API.
        try {
            await recuperacion.actualizarCatalogo();
            const materias = [...recuperacion.catalogo.values()]
                .sort((a, b) => b.creado_en.localeCompare(a.creado_en))
                .slice(0, 20);

            res.set("X-Aula-Modo", "contingencia").json(materias);
        } catch (fallo) {
            errorDeApi(res, fallo);
        }
    }
});

// Crea la actividad en el servicio y la registra como materia local.
app.post("/materias", seguridad.administrador, async (req, res) => {
    let respuesta;

    try {
        respuesta = await api.llamar("crearActividad", {
            cuerpo: {
                nombre: req.body?.nombre,
                capacidad: Number(req.body?.cupo),
                metadata: { origen: "aula", tipo: "materia" }
            }
        });
    } catch (error) {
        return errorDeApi(res, error);
    }

    if (respuesta.status !== 201) {
        return reenviar(res, respuesta);
    }

    const actividad = respuesta.cuerpo;

    try {
        await base(() => pool.query(
            `INSERT INTO materias (id, actividad_id, nombre, cupo, version)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (actividad_id) DO NOTHING`,
            [randomUUID(), actividad.id, actividad.nombre, actividad.capacidad, actividad.version]
        ));
    } catch (error) {
        // La actividad ya existe en el servicio: la reconciliación por feed
        // la agrega a la base de Aula cuando vuelva a responder.
        console.error("[AULA] Escritura:", error.message);
    }

    res.status(201).json(actividad);
});

// Estado de la materia: inscriptos confirmados según la API y según la
// base de Aula, que se mantiene al día con los webhooks.
app.get("/materias/:actividadId", async (req, res) => {
    const parametros = { id: req.params.actividadId };

    try {
        const actividad = await api.llamar("consultarActividad", { parametros });

        if (actividad.status !== 200) {
            return reenviar(res, actividad);
        }

        const inscriptos = await api.llamar("listarReservas", {
            parametros,
            query: { estado: "confirmada", limite: 100 }
        });

        let locales = null;

        try {
            const resultado = await base(() => pool.query(
                `SELECT alumno FROM inscripciones
                  WHERE actividad_id = $1 AND estado = 'confirmada'
                  ORDER BY alumno`,
                [req.params.actividadId]
            ));
            locales = resultado.rows.map(fila => fila.alumno);
        } catch (_) {
            // La base de Aula no está disponible: se informa solo la API.
        }

        if (inscriptos.status !== 200) {
            return reenviar(res, inscriptos);
        }

        // Un alumno ve solo su propia inscripción. La lista conserva la
        // paginación de la API: no es una exportación completa.
        const esAdministrador = req.usuario.rol === "administrador";

        res.json({
            ...actividad.cuerpo,
            inscriptos: inscriptos.cuerpo.datos.filter(reserva => puedeVer(req.usuario, reserva)),
            siguiente_cursor: inscriptos.cuerpo.siguiente_cursor,
            inscriptos_locales: esAdministrador
                ? locales
                : locales?.filter(alumno => alumno === req.usuario.participante) ?? null
        });
    } catch (error) {
        errorDeApi(res, error);
    }
});

// Solicita la inscripción. El navegador genera la Idempotency-Key y la
// reutiliza si reintenta, así un reintento no duplica la reserva. Un alumno
// solo puede inscribirse a sí mismo: el participante sale de su sesión.
app.post("/materias/:actividadId/inscripciones", async (req, res) => {
    const esAlumno = req.usuario.rol === "alumno";
    const alumno = esAlumno ? req.usuario.participante : req.body?.alumno;

    if (esAlumno && req.body?.alumno && req.body.alumno !== alumno) {
        return res.status(403).json({ error: "No puede inscribir a otra persona" });
    }

    try {
        const respuesta = await api.llamar("solicitarReserva", {
            parametros: { id: req.params.actividadId },
            cuerpo: { participante: alumno },
            encabezados: {
                "Idempotency-Key": req.get("idempotency-key") || randomUUID()
            }
        });

        if (respuesta.status === 202 || respuesta.status === 200) {
            await proyectar(respuesta.cuerpo);
        }

        reenviar(res, respuesta);
    } catch (error) {
        errorDeApi(res, error);
    }
});

// Una reserva de otro alumno responde igual que una inexistente: 404.
app.get("/inscripciones/:reservaId", async (req, res) => {
    try {
        const respuesta = await api.llamar("consultarReserva", {
            parametros: { id: req.params.reservaId }
        });

        if (respuesta.status === 200 && !puedeVer(req.usuario, respuesta.cuerpo)) {
            return res.status(404).json({ error: "Inscripción no encontrada" });
        }

        reenviar(res, respuesta);
    } catch (error) {
        errorDeApi(res, error);
    }
});

// Cancela la inscripción; el resultado llega por webhook o consultando.
app.post("/inscripciones/:reservaId/cancelacion", async (req, res) => {
    try {
        const previa = await api.llamar("consultarReserva", {
            parametros: { id: req.params.reservaId }
        });

        if (previa.status !== 200) {
            return reenviar(res, previa);
        }

        if (!puedeVer(req.usuario, previa.cuerpo)) {
            return res.status(404).json({ error: "Inscripción no encontrada" });
        }

        reenviar(res, await api.llamar("cancelarReserva", {
            parametros: { id: req.params.reservaId }
        }));
    } catch (error) {
        errorDeApi(res, error);
    }
});

app.use((error, req, res, next) => {
    if (error.type === "entity.too.large" || error.type === "entity.parse.failed") {
        return res.status(error.type === "entity.too.large" ? 413 : 400).json({
            error: "JSON invalido o demasiado grande"
        });
    }

    // Cualquier otro error es de Aula: se registra y no se disfraza de 400.
    console.error("[AULA] Error inesperado:", error);
    res.status(500).json({ error: "Error interno de Aula" });
});

// Aula atiende por HTTPS al navegador y al notificador (webhooks).
const servidor = TLS
    ? https.createServer({
        cert: fs.readFileSync(process.env.TLS_CERT),
        key: fs.readFileSync(process.env.TLS_KEY),
        minVersion: "TLSv1.2"
    }, app)
    : http.createServer(app);

if (!TLS) {
    console.warn("[AULA] Sin TLS_CERT: atiende por HTTP, solo para pruebas fuera de Docker");
}

servidor.listen(PORT, "0.0.0.0", () => {
    console.log(`[AULA] Pagina disponible en puerto ${PORT} · contrato openapi.yaml ${api.contrato.version}`);
});
