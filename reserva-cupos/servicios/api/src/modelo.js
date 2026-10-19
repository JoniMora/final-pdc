const { randomBytes, createHash } = require("node:crypto");
const { problemas } = require("./problemas");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const METADATA_MAXIMO = 16 * 1024;

// UUIDv7 (RFC 9562): los primeros 48 bits son el instante en milisegundos,
// así los identificadores quedan ordenados por tiempo de creación.
function uuidv7() {
    const bytes = randomBytes(16);
    const ms = BigInt(Date.now());

    for (let i = 0; i < 6; i++) {
        bytes[i] = Number((ms >> BigInt(40 - 8 * i)) & 0xffn);
    }

    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = bytes.toString("hex");

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function esUuid(valor) {
    return typeof valor === "string" && UUID.test(valor);
}

function sha256(texto) {
    return createHash("sha256").update(texto).digest();
}

// JSON con las claves ordenadas: el mismo cuerpo produce el mismo hash
// aunque el cliente cambie el orden de los campos al reintentar.
function jsonCanonico(valor) {
    if (Array.isArray(valor)) {
        return `[${valor.map(jsonCanonico).join(",")}]`;
    }

    if (valor && typeof valor === "object") {
        return `{${Object.keys(valor).sort()
            .map(clave => `${JSON.stringify(clave)}:${jsonCanonico(valor[clave])}`)
            .join(",")}}`;
    }

    return JSON.stringify(valor);
}

// metadata es opaca: solo se valida su tipo y su tamaño.
function validarMetadata(metadata) {
    if (metadata === undefined || metadata === null) return null;

    if (typeof metadata !== "object" || Array.isArray(metadata)) {
        throw problemas.solicitudInvalida("metadata debe ser un objeto JSON");
    }

    if (Buffer.byteLength(JSON.stringify(metadata)) > METADATA_MAXIMO) {
        throw problemas.solicitudInvalida("metadata no puede superar 16 KB");
    }

    return metadata;
}

function aJson(metadata) {
    return metadata === null ? null : JSON.stringify(metadata);
}

function actividadJson(fila) {
    return {
        id: fila.id,
        nombre: fila.nombre,
        capacidad: fila.capacidad,
        cupos_disponibles: fila.cupos_disponibles,
        estado: fila.estado,
        version: Number(fila.version),
        metadata: fila.metadata ?? null,
        creado_en: new Date(fila.creado_en).toISOString()
    };
}

function reservaJson(fila) {
    return {
        id: fila.id,
        actividad_id: fila.actividad_id,
        participante: fila.participante_id,
        estado: fila.estado,
        version: Number(fila.version),
        metadata: fila.metadata ?? null,
        creado_en: new Date(fila.creado_en).toISOString()
    };
}

// Cada cambio se escribe en la misma transacción que lo produce (outbox).
// Las marcas publicado_* indican qué falta publicar: un cambio que no
// genera comando nace con publicado_comando = TRUE, y uno que no genera
// webhook nace con publicado_webhook = TRUE.
async function registrarCambio(conexion, tenantId, entidad, snapshot, tipo, opciones = {}) {
    await conexion.query(
        `INSERT INTO cambios
             (tenant_id, entidad, entidad_id, tipo, version, snapshot,
              publicado_comando, publicado_webhook)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            tenantId,
            entidad,
            snapshot.id,
            tipo,
            snapshot.version,
            JSON.stringify(snapshot),
            !opciones.comando,
            !opciones.webhook
        ]
    );
}

module.exports = {
    uuidv7,
    esUuid,
    sha256,
    jsonCanonico,
    validarMetadata,
    aJson,
    actividadJson,
    reservaJson,
    registrarCambio
};
