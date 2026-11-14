const { randomUUID } = require("node:crypto");
const { aplicarReserva } = require("./webhooks");

// Contingencia y reconciliación de Aula (Entrega 5).
//
// Los webhooks mantienen la proyección local al día, pero pueden perderse
// (aula-db caída, Aula detenida) o llegar fuera de orden. La garantía la da
// el feed GET /v1/cambios: un ciclo periódico lo lee desde su propio punto
// de control (punto_control.ultima_secuencia_feed, independiente del máximo
// recibido por webhook) y aplica cada instantánea solo si su versión es
// mayor que la guardada. Los datos y el cursor se confirman en la misma
// transacción: si algo falla, se repite desde el cursor anterior.
//
// Mientras aula-db no responde, el catálogo de materias se arma en memoria
// desde el mismo feed, y las inscripciones siguen yendo a la API.

const TAMANO_PAGINA = 200;
const MAX_PAGINAS_POR_CICLO = 50;

function esMateriaDeAula(actividad) {
    return actividad?.metadata?.origen === "aula" && actividad?.metadata?.tipo === "materia";
}

async function aplicarActividad(cliente, actividad) {
    if (!esMateriaDeAula(actividad)) return;

    await cliente.query(
        `INSERT INTO materias (id, actividad_id, nombre, cupo, version)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (actividad_id) DO UPDATE
            SET nombre = EXCLUDED.nombre,
                cupo = EXCLUDED.cupo,
                version = EXCLUDED.version
          WHERE materias.version < EXCLUDED.version`,
        [randomUUID(), actividad.id, actividad.nombre, actividad.capacidad, actividad.version]
    );
}

// Aplica una página del feed. La página tiene que ser creciente (no
// consecutiva: la secuencia es global y un tenant ve saltos legítimos) y
// terminar en `ultima`. Si otro proceso ya movió el cursor, no aplica nada.
async function aplicarPagina(pool, datos, desde, ultima) {
    if (!Number.isSafeInteger(ultima) || ultima < desde || (datos.length && ultima !== datos.at(-1).secuencia)) {
        throw new Error("Punto de control inválido");
    }

    let previo = desde;

    for (const cambio of datos) {
        if (!Number.isSafeInteger(cambio.secuencia) || cambio.secuencia <= previo) {
            throw new Error("Feed fuera de orden");
        }

        previo = cambio.secuencia;
    }

    const cliente = await pool.connect();

    try {
        await cliente.query("BEGIN");

        const control = await cliente.query(
            "SELECT ultima_secuencia_feed FROM punto_control WHERE id = 1 FOR UPDATE"
        );

        if (Number(control.rows[0].ultima_secuencia_feed) !== desde) {
            await cliente.query("ROLLBACK");
            return false;
        }

        for (const cambio of datos) {
            if (cambio.tipo.startsWith("actividad.")) await aplicarActividad(cliente, cambio.entidad);
            else if (cambio.tipo.startsWith("reserva.")) await aplicarReserva(cliente, cambio.entidad);
            // Un tipo desconocido se ignora, como fija el contrato.
        }

        await cliente.query(
            `UPDATE punto_control
                SET ultima_secuencia_feed = $1, actualizado_en = CURRENT_TIMESTAMP
              WHERE id = 1`,
            [ultima]
        );
        await cliente.query("COMMIT");
        return true;
    } catch (error) {
        await cliente.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        cliente.release();
    }
}

// Con aula-db disponible el ciclo es lento: los webhooks son el camino
// principal y el feed solo cubre lo que se haya perdido. Con aula-db caída
// o la reconciliación pendiente, se reintenta seguido.
function crearRecuperacion({ pool, api, intervaloNormalMs = 30000, intervaloDegradadoMs = 5000 }) {
    const catalogo = new Map();
    const estado = {
        modo: "iniciando",
        ultima_secuencia_feed: 0,
        ultima_sincronizacion: null,
        ultimo_error: null
    };

    let cursorCatalogo = 0;
    let catalogoEnCurso = null;
    let sincronizacionEnCurso = null;
    let temporizador = null;

    async function pagina(desde) {
        const respuesta = await api.llamar("leerCambios", { query: { desde, limite: TAMANO_PAGINA } });

        if (respuesta.status !== 200) throw new Error(`Feed no disponible (HTTP ${respuesta.status})`);

        return respuesta.cuerpo;
    }

    // Catálogo de contingencia: lee el feed desde donde quedó la última vez
    // y guarda la versión más nueva de cada materia de Aula.
    async function leerCatalogo() {
        for (let i = 0; i < MAX_PAGINAS_POR_CICLO; i++) {
            const { datos, ultima_secuencia } = await pagina(cursorCatalogo);

            for (const cambio of datos) {
                const actividad = cambio.entidad;

                if (!cambio.tipo.startsWith("actividad.") || !esMateriaDeAula(actividad)) continue;

                if ((catalogo.get(actividad.id)?.version ?? 0) < actividad.version) {
                    catalogo.set(actividad.id, {
                        id: actividad.id,
                        actividad_id: actividad.id,
                        nombre: actividad.nombre,
                        cupo: actividad.capacidad,
                        version: actividad.version,
                        creado_en: actividad.creado_en
                    });
                }
            }

            cursorCatalogo = ultima_secuencia;

            if (datos.length < TAMANO_PAGINA) return;
        }
    }

    // Varios pedidos simultáneos comparten la misma lectura.
    function actualizarCatalogo() {
        catalogoEnCurso ??= leerCatalogo().finally(() => {
            catalogoEnCurso = null;
        });

        return catalogoEnCurso;
    }

    async function reconciliar() {
        try {
            for (let i = 0; i < MAX_PAGINAS_POR_CICLO; i++) {
                const control = await pool.query("SELECT ultima_secuencia_feed FROM punto_control WHERE id = 1");
                const desde = Number(control.rows[0].ultima_secuencia_feed);
                const { datos, ultima_secuencia } = await pagina(desde);

                if (datos.length) await aplicarPagina(pool, datos, desde, ultima_secuencia);

                estado.ultima_secuencia_feed = ultima_secuencia;

                if (datos.length < TAMANO_PAGINA) break;
            }

            estado.modo = "normal";
            estado.ultimo_error = null;
        } catch (error) {
            estado.modo = "degradado";
            estado.ultimo_error = "No se pudo completar la reconciliación";
            console.error("[AULA] Reconciliación pendiente:", error.code || error.message);
        }

        estado.ultima_sincronizacion = new Date().toISOString();
        return estado;
    }

    function sincronizar() {
        sincronizacionEnCurso ??= reconciliar().finally(() => {
            sincronizacionEnCurso = null;
        });

        return sincronizacionEnCurso;
    }

    async function ciclo() {
        await sincronizar();

        temporizador = setTimeout(ciclo, estado.modo === "normal" ? intervaloNormalMs : intervaloDegradadoMs);
        temporizador.unref();
    }

    return {
        estado,
        catalogo,
        sincronizar,
        actualizarCatalogo,
        iniciar: ciclo,
        detener: () => clearTimeout(temporizador)
    };
}

module.exports = { crearRecuperacion, aplicarPagina, aplicarActividad };
