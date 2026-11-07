const { ErrorDeContrato } = require("../../../compartido/src/contrato");
const { ErrorDeDatos } = require("./modelo");

// Comando → esquema del contrato de mensajería (contrato/asyncapi.yaml).
const ESQUEMAS = {
    reservar: "ComandoReservar",
    cancelar: "ComandoCancelar"
};

const INTENTOS = 3;

// Decide qué hacer con un mensaje. No toca RabbitMQ: devuelve la acción
// (ack, dlq o reencolar) y main.js la ejecuta. Así se prueba sin broker.
//
// - Mensaje fuera de contrato o reserva inexistente: DLQ, sin reintentos.
// - Error de infraestructura (MySQL caído, deadlock): se reencola sin
//   consumir reintentos.
// - Otro error de datos: hasta INTENTOS intentos; agotados, un reservar
//   deja la reserva en estado fallida y un cancelar va a la DLQ.
async function procesar(contenido, { validar, acciones, marcarFallida, esErrorDeInfraestructura, esperar }) {
    let comando;

    try {
        comando = JSON.parse(contenido.toString("utf8"));
        const esquema = ESQUEMAS[comando?.comando];

        if (!esquema) throw new ErrorDeContrato(`El comando ${JSON.stringify(comando?.comando)}`);

        validar(esquema, comando);
    } catch (error) {
        return { accion: "dlq", motivo: error.message };
    }

    for (let intento = 1; ; intento++) {
        try {
            const resultado = await acciones[comando.comando](comando);
            return { accion: "ack", comando, resultado };
        } catch (error) {
            if (esErrorDeInfraestructura(error)) {
                return { accion: "reencolar", comando, motivo: error.code || error.message };
            }

            if (error instanceof ErrorDeDatos) {
                return { accion: "dlq", comando, motivo: error.message };
            }

            if (intento < INTENTOS) {
                await esperar(200 * intento);
                continue;
            }

            if (comando.comando !== "reservar") {
                return { accion: "dlq", comando, motivo: error.message };
            }

            try {
                const resultado = await marcarFallida(comando);
                return { accion: "ack", comando, resultado, motivo: error.message };
            } catch (otro) {
                if (esErrorDeInfraestructura(otro)) {
                    return { accion: "reencolar", comando, motivo: otro.code || otro.message };
                }

                return { accion: "dlq", comando, motivo: `${error.message}; no se pudo marcar fallida: ${otro.message}` };
            }
        }
    }
}

module.exports = { procesar, INTENTOS };
