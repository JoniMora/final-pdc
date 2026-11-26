const crypto = require("node:crypto");
const { ErrorDeContrato } = require("../../../compartido/src/contrato");

// Lee el feed /v1/cambios desde el último punto de control, cada pocos
// segundos. Es lo que garantiza que la proyección quede completa aunque se
// pierdan webhooks (por ejemplo, con el cliente detenido).

const LIMITE = 500;
const PAGINAS_POR_CICLO = 20;

function describir(error) {
    if (error.status === 401) return "La clave del tenant no autentica: correr node scripts/sistema.js demo";
    if (error.status === 429) return "Límite de tasa del tenant: se reintenta";
    if (error.status === 503) return "La API no está disponible: se reintenta";
    if (error instanceof ErrorDeContrato) return `Respuesta fuera de contrato: ${error.message}`;
    return `La API no responde: ${error.cause?.code || error.message}`;
}

function crearSincronizacion({ api, proyeccion, claveActual, intervaloMs = 2000 }) {
    const estado = { sincronizado_en: null, error: null };
    let huella = null;
    let enCurso = null;
    let temporizador = null;
    let activo = false;

    async function leer() {
        const clave = claveActual();

        if (!clave) {
            estado.error = "Todavía no hay tenant: node scripts/sistema.js demo lo crea";
            return;
        }

        // Si cambió la clave (el entorno se recreó), es otro tenant.
        const actual = crypto.createHash("sha256").update(clave).digest("hex");
        if (actual !== huella) {
            proyeccion.reiniciar();
            huella = actual;
        }

        for (let pagina = 0; pagina < PAGINAS_POR_CICLO; pagina++) {
            const respuesta = await api.llamar("leerCambios", {
                query: { desde: proyeccion.secuencia(), limite: LIMITE }
            });

            if (respuesta.status !== 200) {
                throw Object.assign(new Error(`HTTP ${respuesta.status}`), { status: respuesta.status });
            }

            for (const cambio of respuesta.cuerpo.datos) proyeccion.aplicarCambio(cambio);
            proyeccion.avanzar(respuesta.cuerpo.ultima_secuencia);

            if (respuesta.cuerpo.datos.length < LIMITE) break;
        }

        estado.sincronizado_en = new Date().toISOString();
        estado.error = null;
    }

    // Una sola lectura a la vez: un webhook que pide sincronizar mientras
    // otra lectura está en curso espera esa misma.
    function sincronizar() {
        enCurso ??= leer()
            .catch(error => { estado.error = describir(error); })
            .finally(() => { enCurso = null; });
        return enCurso;
    }

    function iniciar() {
        activo = true;
        const ciclo = async () => {
            await sincronizar();
            if (activo) temporizador = setTimeout(ciclo, intervaloMs);
        };
        ciclo();
    }

    function detener() {
        activo = false;
        clearTimeout(temporizador);
    }

    return { sincronizar, iniciar, detener, estado };
}

module.exports = { crearSincronizacion, describir };
