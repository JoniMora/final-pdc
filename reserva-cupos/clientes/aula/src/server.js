const express = require("express");
const { Pool } = require("pg");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { crearClienteApi, ErrorDeContrato } = require("./api");
const { secretoDesdeHex, verificarFirma, aplicarReserva, aplicarEvento } = require("./webhooks");

const { crearSeguridad, puedeVer } = require('./seguridad');
const { crearRecuperacion } = require('./recuperacion');
const fs = require('node:fs');
const https = require('node:https');
const app = express();
app.disable("x-powered-by");

// La API se alcanza por el gateway: Aula no conoce sus instancias.
const API_URL = process.env.API_URL || "http://traefik";
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

// Lee PGHOST, PGUSER, PGPASSWORD y PGDATABASE del entorno.
const pool = new Pool({
    connectionTimeoutMillis: 2000,
    query_timeout: 3000,
    max: 5,
    ...(process.env.PGSSLROOTCERT ? {ssl:{ca:fs.readFileSync(process.env.PGSSLROOTCERT),rejectUnauthorized:true}} : {})
});

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
        const aplicado = await aplicarEvento(pool, evento);
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

const seguridad = crearSeguridad({
    archivo: process.env.USUARIOS_ARCHIVO || '/seguridad/usuarios.json',
    secure: process.env.COOKIE_SECURE !== 'false'
});
seguridad.montar(app);
app.use(['/materias','/inscripciones','/estado','/reconciliacion'], seguridad.exigirTransporte, seguridad.autenticar);
const recuperacion = crearRecuperacion({ pool, api });
recuperacion.iniciar();
app.get('/reconciliacion', (req,res)=>res.json(recuperacion.estado));
app.post('/reconciliacion', seguridad.administrador, async(req,res)=>res.json(await recuperacion.sincronizar()));

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

    console.error("[AULA] API:", error.message);
    res.status(503).json({ error: "No se pudo obtener respuesta de la API" });
}

// Guarda en la base propia una inscripción que la API devolvió. Si la base
// no responde, el webhook o la reconciliación la completan después.
async function proyectar(reserva) {
    try {
        await aplicarReserva(pool, reserva);
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
    const [base, servicio] = await Promise.allSettled([
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
        contrato: `openapi.yaml ${api.contrato.version}`,
        postgresql: base.status === "fulfilled" ? "conectado" : "no disponible",
        recuperacion: recuperacion.estado,
        api: servicio.status === "fulfilled" ? `conectada (instancia ${servicio.value.instancia})` : "no disponible"
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

        try {
            await recuperacion.actualizarCatalogo();
            res.set('X-Aula-Modo','contingencia').json([...recuperacion.catalogo.values()]);
        } catch (fallo) { errorDeApi(res,fallo); }
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
        await pool.query(
            `INSERT INTO materias (id, actividad_id, nombre, cupo, version)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (actividad_id) DO NOTHING`,
            [randomUUID(), actividad.id, actividad.nombre, actividad.capacidad, actividad.version]
        );
    } catch (error) {
        // La actividad ya existe en el servicio; la reconciliación con
        // el feed de cambios se incorpora en la Entrega 5.
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
            const resultado = await pool.query(
                `SELECT alumno FROM inscripciones
                  WHERE actividad_id = $1 AND estado = 'confirmada'
                  ORDER BY alumno`,
                [req.params.actividadId]
            );
            locales = resultado.rows.map(fila => fila.alumno);
        } catch (_) {
            // La base de Aula no está disponible: se informa solo la API.
        }

        if (inscriptos.status !== 200) return reenviar(res,inscriptos);
        const propios = inscriptos.cuerpo.datos.filter(r=>puedeVer(req.usuario,r));
        res.json({
            ...actividad.cuerpo,
            inscriptos: propios,
            siguiente_cursor: inscriptos.cuerpo.siguiente_cursor,
            inscriptos_locales: req.usuario.rol === 'administrador' ? locales
                : locales?.filter(alumno=>alumno===req.usuario.participante) ?? null
        });
    } catch (error) {
        errorDeApi(res, error);
    }
});

// Solicita la inscripción. El navegador genera la Idempotency-Key y la
// reutiliza si reintenta, así un reintento no duplica la reserva.
app.post("/materias/:actividadId/inscripciones", async (req, res) => {
    const alumno = req.usuario.rol === 'alumno' ? req.usuario.participante : req.body?.alumno;
    if (req.usuario.rol === 'alumno' && req.body?.alumno && req.body.alumno !== alumno) {
        return res.status(403).json({error:'No puede inscribir a otra persona'});
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

app.get("/inscripciones/:reservaId", async (req, res) => {
    try {
        const r = await api.llamar('consultarReserva',{parametros:{id:req.params.reservaId}});
        if (r.status===200 && !puedeVer(req.usuario,r.cuerpo)) return res.status(404).json({error:'Inscripción no encontrada'});
        reenviar(res,r);
    } catch (error) {
        errorDeApi(res, error);
    }
});

// Cancela la inscripción; el resultado llega por webhook o consultando.
app.post("/inscripciones/:reservaId/cancelacion", async (req, res) => {
    try {
        const previa = await api.llamar('consultarReserva',{parametros:{id:req.params.reservaId}});
        if(previa.status!==200) return reenviar(res,previa);
        if(!puedeVer(req.usuario,previa.cuerpo)) return res.status(404).json({error:'Inscripción no encontrada'});
        reenviar(res, await api.llamar("cancelarReserva", {
            parametros: { id: req.params.reservaId }
        }));
    } catch (error) {
        errorDeApi(res, error);
    }
});

app.use((error, req, res, next) => {
    res.status(error.type === "entity.too.large" ? 413 : 400).json({
        error: "JSON invalido o demasiado grande"
    });
});

const servidor = process.env.TLS_CERT
    ? https.createServer({cert:fs.readFileSync(process.env.TLS_CERT),key:fs.readFileSync(process.env.TLS_KEY),minVersion:'TLSv1.2'},app)
    : require('node:http').createServer(app);
servidor.listen(PORT, "0.0.0.0", () => {
    console.log(`[AULA] Pagina disponible en puerto ${PORT} · contrato openapi.yaml ${api.contrato.version}`);
});
