// Interruptor de la base de Aula. Después de un fallo de PostgreSQL, Aula
// pasa a contingencia durante `esperaMs` sin volver a intentar la base en
// cada pedido: cada intento con aula-db caída cuesta una resolución de
// nombre y un plazo de conexión, y cientos de intentos simultáneos (una
// ráfaga de inscripciones) llegan a demorar las llamadas a la API. Lo
// encontró la matriz de fallos en el CI (escenario +1). El ciclo de
// reconciliación hace de sonda: cuando vuelve a funcionar, cierra el
// interruptor.
function crearInterruptor({ esperaMs = 5000, reloj = Date.now } = {}) {
    let abiertoHasta = 0;

    return {
        disponible: () => reloj() >= abiertoHasta,
        fallo: () => {
            abiertoHasta = reloj() + esperaMs;
        },
        exito: () => {
            abiertoHasta = 0;
        }
    };
}

// Ejecuta una operación sobre la base si el interruptor lo permite. Con el
// interruptor abierto falla sin intentarlo; un fallo lo abre.
async function conBase(interruptor, operacion) {
    if (!interruptor.disponible()) throw new Error("aula-db en contingencia");

    try {
        return await operacion();
    } catch (error) {
        interruptor.fallo();
        throw error;
    }
}

module.exports = { crearInterruptor, conBase };
