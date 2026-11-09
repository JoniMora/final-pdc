const crypto = require("node:crypto");

// Reglas del receptor según contrato/openapi.yaml (sección webhooks).
const VENTANA_S = 300;
const BYTES_SECRETO = 32;

class ErrorDeSecreto extends Error {}

// El servicio entrega el secreto en hexadecimal (64 caracteres); la clave
// del HMAC son los 32 bytes decodificados, no el texto.
function secretoDesdeHex(hex) {
    if (!/^[0-9a-fA-F]{64}$/.test(hex || "")) {
        throw new ErrorDeSecreto("El secreto del webhook tiene que tener 64 caracteres hexadecimales (32 bytes)");
    }

    return Buffer.from(hex, "hex");
}

// Verifica X-Firma: t=<unix>,v1=<hex>, donde v1 = HMAC-SHA256(secreto,
// "<t>.<cuerpo>"). La comparación es en tiempo constante y la marca de
// tiempo no puede tener más de 5 minutos (reinyección). Sin un secreto de
// 32 bytes no acepta nada: con una clave vacía cualquiera podría firmar.
function verificarFirma(cuerpo, encabezado, secreto, ahora = Date.now() / 1000) {
    if (!Buffer.isBuffer(secreto) || secreto.length !== BYTES_SECRETO) {
        return { valida: false, motivo: "Secreto del webhook no configurado" };
    }

    const partes = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(encabezado || "");

    if (!partes) return { valida: false, motivo: "X-Firma ausente o con otro formato" };

    const [, t, v1] = partes;

    if (Math.abs(ahora - Number(t)) > VENTANA_S) {
        return { valida: false, motivo: "Marca de tiempo fuera de la ventana de 5 minutos" };
    }

    const esperada = crypto.createHmac("sha256", secreto).update(`${t}.${cuerpo}`).digest();

    if (!crypto.timingSafeEqual(esperada, Buffer.from(v1, "hex"))) {
        return { valida: false, motivo: "Firma inválida" };
    }

    return { valida: true };
}

// Proyección local: una inscripción se actualiza solo si la versión que
// llega es mayor. Así un evento repetido o atrasado no cambia nada.
async function aplicarReserva(cliente, reserva) {
    const resultado = await cliente.query(
        `INSERT INTO inscripciones (reserva_id, actividad_id, alumno, estado, version)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (reserva_id) DO UPDATE
            SET estado = EXCLUDED.estado,
                version = EXCLUDED.version,
                actualizado_en = CURRENT_TIMESTAMP
          WHERE inscripciones.version < EXCLUDED.version`,
        [reserva.id, reserva.actividad_id, reserva.participante, reserva.estado, reserva.version]
    );

    return resultado.rowCount === 1;
}

// Aplica un evento y avanza el registro de la última secuencia recibida.
// Los webhooks pueden llegar fuera de orden: la reconciliación por feed
// (Entrega 5) parte de un punto de control propio y aplica por versión.
async function aplicarEvento(pool, evento) {
    const cliente = await pool.connect();

    try {
        await cliente.query("BEGIN");
        const aplicado = await aplicarReserva(cliente, evento.entidad);
        await cliente.query(
            `UPDATE punto_control
                SET ultima_secuencia_webhook = GREATEST(ultima_secuencia_webhook, $1),
                    actualizado_en = CURRENT_TIMESTAMP
              WHERE id = 1`,
            [evento.secuencia]
        );
        await cliente.query("COMMIT");
        return aplicado;
    } catch (error) {
        await cliente.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        cliente.release();
    }
}

module.exports = { ErrorDeSecreto, secretoDesdeHex, verificarFirma, aplicarReserva, aplicarEvento, VENTANA_S };
