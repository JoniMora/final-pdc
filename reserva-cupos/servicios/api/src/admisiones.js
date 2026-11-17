// Amortiza el commit durable de una rafaga, sin responder antes de persistir.
// Cada operacion debe contener SOLO escrituras transaccionales: puede repetirse
// si el lote se revierte. No ejecutar aqui HTTP, RabbitMQ ni efectos externos.
function crearAdmisor(enTransaccion, { maximo = 50, esperaMs = 5, escribirLote } = {}) {
    if (!Number.isInteger(maximo) || maximo < 1 || !Number.isFinite(esperaMs) || esperaMs < 0) {
        throw new Error('Configuracion de admisiones invalida');
    }
    const pendientes = [];
    let ejecutando = false;
    let temporizador;

    async function ejecutar() {
        if (ejecutando || pendientes.length === 0) return;
        clearTimeout(temporizador);
        temporizador = null;
        ejecutando = true;
        const lote = pendientes.splice(0, maximo);
        try {
            const resultados = await enTransaccion(async conexion => {
                if (escribirLote) {
                    await escribirLote(conexion, lote.map(entrada => entrada.datos));
                    return lote.map(() => undefined);
                }
                const valores = [];
                for (const entrada of lote) valores.push(await entrada.operacion(conexion));
                return valores;
            });
            // enTransaccion solo retorna despues de COMMIT.
            lote.forEach((entrada, i) => entrada.resolve(resultados[i]));
        } catch (_) {
            // Una clave duplicada u otra solicitud invalida no debe rechazar
            // todo el lote. Tras el rollback, recuperar el comportamiento
            // original de cada solicitud, incluidas sus respuestas idempotentes.
            for (const entrada of lote) {
                try {
                    entrada.resolve(await enTransaccion(entrada.operacion));
                } catch (error) {
                    entrada.reject(error);
                }
            }
        } finally {
            ejecutando = false;
            if (pendientes.length) temporizador = setTimeout(ejecutar, 0);
        }
    }

    return function admitir(operacion, datos) {
        if (typeof operacion !== 'function') return Promise.reject(new TypeError('Operacion invalida'));
        return new Promise((resolve, reject) => {
            pendientes.push({ operacion, datos, resolve, reject });
            if (ejecutando) return;
            if (pendientes.length >= maximo) {
                void ejecutar();
            } else if (!temporizador) {
                temporizador = setTimeout(ejecutar, esperaMs);
            }
        });
    };
}

async function insertarAdmisiones(conexion, admisiones) {
    if (admisiones.length === 0) return;
    // mysql2 query expande VALUES ? con escaping de cada valor y Buffer.
    // Reserva y outbox usan la MISMA conexion y transaccion del lote.
    const reservas = admisiones.map(({ reserva, tenantId, clave, hash }) => [
        reserva.id, tenantId, reserva.actividad_id, reserva.participante,
        clave, hash, reserva.metadata === null ? null : JSON.stringify(reserva.metadata),
        new Date(reserva.creado_en)
    ]);
    await conexion.query(`INSERT INTO reservas
        (id, tenant_id, actividad_id, participante_id, idempotency_key, request_hash, metadata, creado_en)
        VALUES ?`, [reservas]);
    const cambios = admisiones.map(({ reserva, tenantId }) => [
        tenantId, 'reserva', reserva.id, 'reserva.solicitada', reserva.version,
        JSON.stringify(reserva), false, true
    ]);
    await conexion.query(`INSERT INTO cambios
        (tenant_id, entidad, entidad_id, tipo, version, snapshot, publicado_comando, publicado_webhook)
        VALUES ?`, [cambios]);
}

module.exports = { crearAdmisor, insertarAdmisiones };
