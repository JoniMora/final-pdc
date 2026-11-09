// Compatibilidad del contrato de mensajería (asyncapi.yaml) entre dos
// versiones. oasdiff cumple esta función para openapi.yaml; para AsyncAPI
// no hay una herramienta equivalente que compare los esquemas de los
// mensajes, así que se verifica con los ejemplos del contrato.
//
// Durante un despliegue conviven productores y consumidores de versiones
// distintas, y las colas guardan mensajes de la versión anterior. Un cambio
// es compatible solo si:
//
// - los consumidores de la versión nueva aceptan los mensajes de la anterior
//   (los ejemplos anteriores cumplen los esquemas nuevos), y
// - los consumidores de la versión anterior aceptan los mensajes de la nueva
//   (los ejemplos nuevos cumplen los esquemas anteriores).
//
// Un mensaje que desaparece es incompatible: puede haber mensajes de ese
// tipo en las colas. Un mensaje nuevo solo se informa: es compatible si sus
// consumidores se despliegan antes que sus productores.
//
// La verificación es tan buena como los ejemplos: la prueba del módulo
// compartido exige que cada propiedad de cada mensaje aparezca en alguno.
//
// Uso: node compartido/src/compatibilidad.js <directorio base> <directorio nuevo>

const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");
const { crearValidadorDeMensajes, ejemplosDeMensajes } = require("./contrato");

function cargar(directorio) {
    return yaml.load(fs.readFileSync(path.join(directorio, "asyncapi.yaml"), "utf8"));
}

// Esquema del payload de cada mensaje que define el contrato.
function esquemasDeMensajes(directorio) {
    return new Set(Object.values(cargar(directorio).components.messages)
        .map(mensaje => mensaje.payload.$ref.split("/").pop()));
}

function revisar(ejemplos, validar, esquemasDelOtro, problema) {
    return ejemplos
        .filter(ejemplo => esquemasDelOtro.has(ejemplo.esquema))
        .flatMap(ejemplo => {
            try {
                validar(ejemplo.esquema, ejemplo.payload);
                return [];
            } catch (error) {
                return [`${problema}: ${ejemplo.mensaje} (ejemplo ${ejemplo.nombre}). ${error.message}`];
            }
        });
}

function compararMensajes(directorioBase, directorioNuevo) {
    const base = ejemplosDeMensajes({ directorio: directorioBase });
    const nuevo = ejemplosDeMensajes({ directorio: directorioNuevo });
    const esquemasBase = esquemasDeMensajes(directorioBase);
    const esquemasNuevos = esquemasDeMensajes(directorioNuevo);

    const incompatibles = [
        ...[...esquemasBase]
            .filter(esquema => !esquemasNuevos.has(esquema))
            .map(esquema => `Se quitó el mensaje ${esquema}: puede haber mensajes de ese tipo en las colas`),
        ...revisar(base, crearValidadorDeMensajes({ directorio: directorioNuevo }), esquemasNuevos,
            "Un consumidor de la versión nueva rechaza un mensaje de la anterior"),
        ...revisar(nuevo, crearValidadorDeMensajes({ directorio: directorioBase }), esquemasBase,
            "Un consumidor de la versión anterior rechaza un mensaje de la nueva")
    ];

    const nuevos = [...esquemasNuevos].filter(esquema => !esquemasBase.has(esquema));

    return { incompatibles, nuevos, comparados: base.length + nuevo.length };
}

if (require.main === module) {
    const [directorioBase, directorioNuevo] = process.argv.slice(2);

    if (!directorioBase || !directorioNuevo) {
        console.error("Uso: node compatibilidad.js <directorio base> <directorio nuevo>");
        process.exit(2);
    }

    const { incompatibles, nuevos, comparados } = compararMensajes(directorioBase, directorioNuevo);

    console.log(`asyncapi.yaml ${cargar(directorioBase).info.version} → ${cargar(directorioNuevo).info.version}: ${comparados} ejemplos comparados en los dos sentidos`);

    for (const esquema of nuevos) {
        console.log(`Aviso: mensaje nuevo ${esquema}; desplegar sus consumidores antes que sus productores`);
    }

    if (incompatibles.length) {
        for (const problema of incompatibles) console.error(`Incompatible: ${problema}`);
        console.error(`${incompatibles.length} cambio(s) incompatible(s): requiere una versión mayor del contrato de mensajería`);
        process.exit(1);
    }

    console.log("Sin cambios incompatibles");
}

module.exports = { compararMensajes };
