// Validación contra los contratos del servicio (contrato/openapi.yaml y
// contrato/asyncapi.yaml). Ningún componente define a mano la forma de un
// mensaje o de una respuesta: la toma de estos documentos, que son la única
// fuente de verdad de las interfaces.

const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

// En el repositorio y en las imágenes la estructura es la misma:
// compartido/src → ../../contrato.
const DIRECTORIO = process.env.CONTRATO_DIR || path.resolve(__dirname, "../../contrato");

class ErrorDeContrato extends Error {
    constructor(contexto, errores = []) {
        const detalle = errores
            .map(e => `${e.instancePath || "/"} ${e.message}`)
            .join("; ");

        super(`${contexto} no cumple el contrato${detalle ? `: ${detalle}` : ""}`);
        this.name = "ErrorDeContrato";
        this.errores = errores;
    }
}

// El directorio se puede indicar para cargar otra versión del contrato
// (por ejemplo, la de main, al comparar la compatibilidad de los mensajes).
function cargar(archivo, directorio = DIRECTORIO) {
    return yaml.load(fs.readFileSync(path.join(directorio, archivo), "utf8"));
}

// Un solo motor de validación con los dos documentos registrados por su
// nombre de archivo, así funcionan las referencias entre ellos
// (asyncapi.yaml toma las entidades de openapi.yaml).
function crearAjv(directorio = DIRECTORIO) {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    ajv.addSchema(cargar("openapi.yaml", directorio), "openapi.yaml");
    ajv.addSchema(cargar("asyncapi.yaml", directorio), "asyncapi.yaml");
    return ajv;
}

function puntero(...partes) {
    return partes.map(p => String(p).replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
}

// Mensajes de RabbitMQ: valida contra components.schemas de asyncapi.yaml.
function crearValidadorDeMensajes({ directorio = DIRECTORIO } = {}) {
    const ajv = crearAjv(directorio);
    const compilados = new Map();

    return function validar(mensaje, datos) {
        if (!compilados.has(mensaje)) {
            const funcion = ajv.getSchema(`asyncapi.yaml#/${puntero("components", "schemas", mensaje)}`);

            if (!funcion) throw new Error(`El contrato de mensajería no define ${mensaje}`);
            compilados.set(mensaje, funcion);
        }

        const funcion = compilados.get(mensaje);

        if (!funcion(datos)) {
            throw new ErrorDeContrato(`El mensaje ${mensaje}`, funcion.errors);
        }

        return datos;
    };
}

// Ejemplos de cada mensaje de asyncapi.yaml (components.messages.*.examples),
// con el esquema de su payload. Representan mensajes reales de esa versión
// del contrato: se usan para verificar la compatibilidad entre versiones.
function ejemplosDeMensajes({ directorio = DIRECTORIO } = {}) {
    const documento = cargar("asyncapi.yaml", directorio);

    return Object.entries(documento.components.messages).flatMap(([mensaje, definicion]) => {
        const esquema = definicion.payload.$ref.split("/").pop();

        return (definicion.examples || []).map(ejemplo => ({
            mensaje,
            esquema,
            nombre: ejemplo.name,
            payload: ejemplo.payload
        }));
    });
}

// Interfaz HTTP: rutas, respuestas y esquemas de openapi.yaml, indexados
// por operationId (también los de la sección webhooks).
function crearContratoHttp({ directorio = DIRECTORIO } = {}) {
    const documento = cargar("openapi.yaml", directorio);
    const ajv = crearAjv(directorio);
    const operaciones = new Map();

    for (const [seccion, entradas] of [["paths", documento.paths], ["webhooks", documento.webhooks || {}]]) {
        for (const [ruta, item] of Object.entries(entradas)) {
            for (const [metodo, operacion] of Object.entries(item)) {
                if (operacion && operacion.operationId) {
                    operaciones.set(operacion.operationId, { seccion, ruta, metodo, operacion });
                }
            }
        }
    }

    function buscar(operationId) {
        const encontrada = operaciones.get(operationId);
        if (!encontrada) throw new Error(`El contrato no define la operación ${operationId}`);
        return encontrada;
    }

    // Arma la ruta a partir de la plantilla del contrato.
    function ruta(operationId, parametros = {}) {
        return buscar(operationId).ruta.replace(/\{(\w+)\}/g, (_, nombre) => {
            if (parametros[nombre] === undefined) {
                throw new Error(`Falta el parámetro ${nombre} de ${operationId}`);
            }

            return encodeURIComponent(parametros[nombre]);
        });
    }

    function metodo(operationId) {
        return buscar(operationId).metodo.toUpperCase();
    }

    // Valida el cuerpo de una respuesta contra el esquema que el contrato
    // declara para ese código de estado.
    function validarRespuesta(operationId, estado, cuerpo, tipo = "application/json") {
        const { seccion, ruta: plantilla, metodo: verbo, operacion } = buscar(operationId);
        const clave = operacion.responses[String(estado)] ? String(estado) : "default";
        const respuesta = operacion.responses[clave];

        if (!respuesta) {
            throw new ErrorDeContrato(`La respuesta ${estado} de ${operationId} (código no documentado)`);
        }

        const base = respuesta.$ref
            ? respuesta.$ref.replace(/^#\//, "")
            : puntero(seccion, plantilla, verbo, "responses", clave);
        const contenido = respuesta.$ref
            ? documento.components.responses[respuesta.$ref.split("/").pop()].content
            : respuesta.content;

        if (!contenido) return cuerpo;

        const medio = contenido[tipo] ? tipo : Object.keys(contenido)[0];
        const funcion = ajv.getSchema(`openapi.yaml#/${base}/${puntero("content", medio, "schema")}`);

        if (!funcion(cuerpo)) {
            throw new ErrorDeContrato(`La respuesta ${estado} de ${operationId}`, funcion.errors);
        }

        return cuerpo;
    }

    // Valida datos contra un esquema de components.schemas.
    function validarEsquema(nombre, datos) {
        const funcion = ajv.getSchema(`openapi.yaml#/${puntero("components", "schemas", nombre)}`);

        if (!funcion) throw new Error(`El contrato no define el esquema ${nombre}`);

        if (!funcion(datos)) {
            throw new ErrorDeContrato(`El dato ${nombre}`, funcion.errors);
        }

        return datos;
    }

    // Definición completa de una operación, con sus extensiones (por
    // ejemplo, el vector de prueba de la firma del webhook).
    function operacion(operationId) {
        return buscar(operationId).operacion;
    }

    return {
        version: documento.info.version,
        ruta,
        metodo,
        operacion,
        validarRespuesta,
        validarEsquema
    };
}

module.exports = {
    DIRECTORIO,
    ErrorDeContrato,
    crearValidadorDeMensajes,
    ejemplosDeMensajes,
    crearContratoHttp
};
