const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const yaml = require("js-yaml");
const { DIRECTORIO, crearValidadorDeMensajes, ejemplosDeMensajes } = require("../src/contrato");
const { compararMensajes } = require("../src/compatibilidad");

const asyncapi = yaml.load(fs.readFileSync(path.join(DIRECTORIO, "asyncapi.yaml"), "utf8"));

// Copia del contrato actual con una modificación en asyncapi.yaml.
function variante(modificar) {
    const directorio = fs.mkdtempSync(path.join(os.tmpdir(), "contrato-"));
    const documento = structuredClone(asyncapi);

    modificar(documento);
    fs.copyFileSync(path.join(DIRECTORIO, "openapi.yaml"), path.join(directorio, "openapi.yaml"));
    fs.writeFileSync(path.join(directorio, "asyncapi.yaml"), yaml.dump(documento));
    return directorio;
}

test("cada ejemplo de asyncapi.yaml cumple el esquema de su mensaje", () => {
    const validar = crearValidadorDeMensajes();

    for (const ejemplo of ejemplosDeMensajes()) {
        assert.doesNotThrow(() => validar(ejemplo.esquema, ejemplo.payload), `${ejemplo.mensaje} ${ejemplo.nombre}`);
    }
});

test("los ejemplos cubren cada mensaje y cada una de sus propiedades", () => {
    const ejemplos = ejemplosDeMensajes();

    for (const [mensaje, definicion] of Object.entries(asyncapi.components.messages)) {
        const esquema = asyncapi.components.schemas[definicion.payload.$ref.split("/").pop()];
        const usadas = new Set(ejemplos.filter(e => e.mensaje === mensaje).flatMap(e => Object.keys(e.payload)));

        for (const propiedad of Object.keys(esquema.properties)) {
            assert.ok(usadas.has(propiedad), `ningún ejemplo de ${mensaje} usa ${propiedad}`);
        }
    }
});

test("el contrato es compatible consigo mismo", () => {
    assert.deepEqual(compararMensajes(DIRECTORIO, DIRECTORIO).incompatibles, []);
});

test("un campo obligatorio nuevo rompe a los mensajes que siguen en las colas", () => {
    const nuevo = variante(doc => {
        doc.components.schemas.ComandoReservar.properties.prioridad = { type: "integer" };
        doc.components.schemas.ComandoReservar.required.push("prioridad");
    });

    const { incompatibles } = compararMensajes(DIRECTORIO, nuevo);
    assert.ok(incompatibles.some(p => /versión nueva rechaza un mensaje de la anterior: ComandoReservar/.test(p)), incompatibles.join("\n"));
});

test("un campo opcional nuevo rompe a los consumidores que todavía no se actualizaron", () => {
    const nuevo = variante(doc => {
        doc.components.schemas.ComandoCancelar.properties.motivo = { type: "string" };
        doc.components.messages.ComandoCancelar.examples[0].payload.motivo = "pedido del alumno";
    });

    const { incompatibles } = compararMensajes(DIRECTORIO, nuevo);
    assert.ok(incompatibles.some(p => /versión anterior rechaza un mensaje de la nueva/.test(p)), incompatibles.join("\n"));
});

test("quitar un mensaje es incompatible y agregar uno solo se informa", () => {
    const sinCancelar = variante(doc => {
        delete doc.components.messages.ComandoCancelar;
        delete doc.channels.comandos.messages.cancelar;
    });

    assert.ok(compararMensajes(DIRECTORIO, sinCancelar).incompatibles.some(p => /Se quitó el mensaje ComandoCancelar/.test(p)));

    const resultado = compararMensajes(sinCancelar, DIRECTORIO);
    assert.deepEqual(resultado.incompatibles, []);
    assert.deepEqual(resultado.nuevos, ["ComandoCancelar"]);
});
