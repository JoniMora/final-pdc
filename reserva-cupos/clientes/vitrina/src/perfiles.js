// Un mismo cliente liviano, dos organizaciones distintas: cada perfil fija
// el vocabulario, los colores y los datos de dominio que el cliente guarda
// en `metadata` (el servicio los almacena sin interpretarlos). Se elige con
// VITRINA_PERFIL.

const PERFILES = {
    canchas: {
        id: "canchas",
        nombre: "Canchas",
        titulo: "Turnos de fútbol 5",
        actividad: { singular: "turno", plural: "turnos" },
        participante: { singular: "jugador", plural: "jugadores", ejemplo: "Juan Pérez" },
        capacidad: { etiqueta: "Jugadores", porDefecto: 10 },
        campos: [
            { clave: "cancha", etiqueta: "Cancha", tipo: "opciones", opciones: ["Cancha 1", "Cancha 2", "Cancha 3"] },
            { clave: "fecha", etiqueta: "Fecha", tipo: "fecha" },
            { clave: "hora", etiqueta: "Hora", tipo: "hora" }
        ],
        colores: { acento: "#15803d", acentoOscuro: "#4ade80", suave: "#dcfce7", suaveOscuro: "#14532d" }
    },
    eventos: {
        id: "eventos",
        nombre: "Eventos",
        titulo: "Entradas para eventos",
        actividad: { singular: "evento", plural: "eventos" },
        participante: { singular: "asistente", plural: "asistentes", ejemplo: "ana@ejemplo.com" },
        capacidad: { etiqueta: "Lugares", porDefecto: 100 },
        campos: [
            { clave: "lugar", etiqueta: "Lugar", tipo: "texto" },
            { clave: "fecha", etiqueta: "Fecha", tipo: "fecha" },
            { clave: "hora", etiqueta: "Hora", tipo: "hora" }
        ],
        colores: { acento: "#6d28d9", acentoOscuro: "#a78bfa", suave: "#ede9fe", suaveOscuro: "#2e1065" }
    }
};

const FORMATOS = {
    texto: /^[^\u0000-\u001f]{1,80}$/,
    fecha: /^\d{4}-\d{2}-\d{2}$/,
    hora: /^\d{2}:\d{2}$/
};

function perfil(id = process.env.VITRINA_PERFIL) {
    const elegido = PERFILES[id];
    if (!elegido) {
        throw new Error(`VITRINA_PERFIL tiene que ser uno de: ${Object.keys(PERFILES).join(", ")}`);
    }
    return elegido;
}

// Arma la metadata de una actividad nueva con los campos del perfil. Solo
// se guardan los campos conocidos y con formato válido: el resto se
// descarta. `origen` y `tipo` identifican al cliente que la creó.
function metadataDeActividad(elegido, datos = {}) {
    const metadata = { origen: elegido.id, tipo: elegido.actividad.singular };

    for (const campo of elegido.campos) {
        const valor = typeof datos[campo.clave] === "string" ? datos[campo.clave].trim() : "";
        if (!valor) continue;

        const valido = campo.tipo === "opciones"
            ? campo.opciones.includes(valor)
            : FORMATOS[campo.tipo].test(valor);

        if (!valido) throw new Error(`${campo.etiqueta}: valor inválido`);
        metadata[campo.clave] = valor;
    }

    return metadata;
}

module.exports = { PERFILES, perfil, metadataDeActividad };
