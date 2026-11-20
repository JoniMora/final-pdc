// Agrupa las admisiones de una ráfaga en una sola transacción para pagar un
// solo commit durable (semisincrónico con la réplica). Ninguna solicitud se
// responde antes de que su lote se confirme.
//
// Cada operación debe contener SOLO escrituras transaccionales: puede
// repetirse si el lote se revierte. No ejecutar aquí HTTP, RabbitMQ ni otros
// efectos externos.
//
// Si el lote falla por una solicitud (una clave duplicada, por ejemplo), se
// revierte y cada solicitud se repite sola para que cada una reciba su
// respuesta. Si falla la infraestructura (MySQL caído, conexión perdida), el
// lote entero se rechaza de inmediato: repetir una por una solo multiplicaría
// la espera, porque cada intento tardaría lo mismo en fallar.
function crearAdmisor(enTransaccion, {
    maximo = 50,
    esperaMs = 5,
    escribirLote,
    esErrorDeInfraestructura = () => false,
    observarLote = () => {}
} = {}) {
    if (!Number.isInteger(maximo) || maximo < 1 || !Number.isFinite(esperaMs) || esperaMs < 0) {
        throw new Error("Configuración de admisiones inválida");
    }

    const pendientes = [];
    let ejecutando = false;
    let temporizador;

    async function individual(entrada) {
        try {
            entrada.resolve(await enTransaccion(entrada.operacion));
            return null;
        } catch (error) {
            entrada.reject(error);
            return error;
        }
    }

    async function ejecutar() {
        if (ejecutando || pendientes.length === 0) return;

        clearTimeout(temporizador);
        temporizador = null;
        ejecutando = true;

        const lote = pendientes.splice(0, maximo);
        observarLote(lote.length);

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

            // enTransaccion solo retorna después del COMMIT.
            lote.forEach((entrada, i) => entrada.resolve(resultados[i]));
        } catch (errorLote) {
            if (esErrorDeInfraestructura(errorLote)) {
                // El cliente reintenta con la misma Idempotency-Key: si el
                // COMMIT llegó a confirmarse, recibe la reserva ya admitida.
                lote.forEach(entrada => entrada.reject(errorLote));
                return;
            }

            for (let i = 0; i < lote.length; i++) {
                const error = await individual(lote[i]);

                // La base se cayó a mitad de la recuperación: el resto del
                // lote falla igual, sin esperar un intento cada una.
                if (error && esErrorDeInfraestructura(error)) {
                    lote.slice(i + 1).forEach(entrada => entrada.reject(error));
                    return;
                }
            }
        } finally {
            ejecutando = false;
            if (pendientes.length) temporizador = setTimeout(ejecutar, 0);
        }
    }

    return function admitir(operacion, datos) {
        if (typeof operacion !== "function") return Promise.reject(new TypeError("Operación inválida"));

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

    // mysql2 expande `VALUES ?` escapando cada valor (incluidos los Buffer).
    // Las reservas y el outbox usan la MISMA conexión y transacción del lote.
    const reservas = admisiones.map(({ reserva, tenantId, clave, hash }) => [
        reserva.id, tenantId, reserva.actividad_id, reserva.participante,
        clave, hash, reserva.metadata === null ? null : JSON.stringify(reserva.metadata),
        new Date(reserva.creado_en)
    ]);

    await conexion.query(`INSERT INTO reservas
        (id, tenant_id, actividad_id, participante_id, idempotency_key, request_hash, metadata, creado_en)
        VALUES ?`, [reservas]);

    // Igual que registrarCambio(..., { comando: true }): el relay publica el
    // comando y el webhook de "solicitada" no se envía.
    const cambios = admisiones.map(({ reserva, tenantId }) => [
        tenantId, "reserva", reserva.id, "reserva.solicitada", reserva.version,
        JSON.stringify(reserva), false, true
    ]);

    await conexion.query(`INSERT INTO cambios
        (tenant_id, entidad, entidad_id, tipo, version, snapshot, publicado_comando, publicado_webhook)
        VALUES ?`, [cambios]);
}

module.exports = { crearAdmisor, insertarAdmisiones };
