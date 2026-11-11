const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const yaml = require("js-yaml");
const { rutas } = require("../src/rutas");

const contrato = yaml.load(fs.readFileSync(path.resolve(__dirname, "../../../contrato/openapi.yaml"), "utf8"));

// Cada ruta implementada tiene que estar documentada en el contrato, y
// cada operación del contrato tiene que estar implementada.
function rutasImplementadas() {
    return rutas.stack
        .filter(capa => capa.route)
        .flatMap(capa => Object.keys(capa.route.methods).map(metodo =>
            `${metodo.toUpperCase()} /v1${capa.route.path.replace(/:(\w+)/g, "{$1}")}`));
}

function rutasDelContrato() {
    return Object.entries(contrato.paths).flatMap(([ruta, item]) =>
        Object.keys(item)
            .filter(clave => ["get", "post", "put", "patch", "delete"].includes(clave))
            .map(metodo => `${metodo.toUpperCase()} ${ruta}`));
}

test("cada ruta de la API está en el contrato y viceversa", () => {
    assert.deepEqual(rutasImplementadas().sort(), rutasDelContrato().sort());
});
