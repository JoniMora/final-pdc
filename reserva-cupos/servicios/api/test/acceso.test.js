const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const yaml = require("js-yaml");
const {
    crearAutenticacion,
    crearExigirPermisos,
    crearLimitador,
    crearAutenticacionAdministrador,
    exigirOperador,
    permisosDeOperacion
} = require("../src/acceso");
const { sha256 } = require("../src/modelo");

const contrato = yaml.load(fs.readFileSync(path.resolve(__dirname, "../../../contrato/openapi.yaml"), "utf8"));

function ejecutar(middleware, req) {
    return new Promise((resolve, reject) => {
        Promise.resolve()
            .then(() => middleware(req, {}, () => resolve("siguiente")))
            .catch(reject);
    });
}

test("cada operación de /v1 declara exactamente un permiso en el contrato", () => {
    for (const [ruta, item] of Object.entries(contrato.paths).filter(([ruta]) => ruta.startsWith("/v1"))) {
        for (const metodo of ["get", "post", "patch"].filter(m => item[m])) {
            const permisos = permisosDeOperacion(item[metodo], contrato.security);
            assert.equal(permisos.length, 1, `${metodo.toUpperCase()} ${ruta}`);
        }
    }
});

test("una clave sin el permiso que pide la operación recibe 403", async () => {
    const exigir = crearExigirPermisos(contrato);
    const operacion = contrato.paths["/v1/actividades/{id}/reservas"].post;

    const lectura = { openapi: { schema: operacion }, scopes: new Set(["lectura"]) };
    await assert.rejects(ejecutar(exigir, lectura), error => error.status === 403);

    const escritura = { openapi: { schema: operacion }, scopes: new Set(["reservas:escribir"]) };
    assert.equal(await ejecutar(exigir, escritura), "siguiente");
});

test("el límite de tasa responde 429 con Retry-After y se recupera con el tiempo", async () => {
    let ahora = 0;
    const limitar = crearLimitador({ porSegundo: 2, rafaga: 3, reloj: () => ahora });
    const req = { tenantId: "a", limite: null };

    for (let i = 0; i < 3; i++) assert.equal(await ejecutar(limitar, req), "siguiente");

    await assert.rejects(ejecutar(limitar, req), error =>
        error.status === 429 && error.encabezados["Retry-After"] === "1");

    ahora = 500;
    assert.equal(await ejecutar(limitar, req), "siguiente");
});

test("un tenant saturado no consume el cupo de otro", async () => {
    const limitar = crearLimitador({ porSegundo: 1, rafaga: 1, reloj: () => 0 });

    assert.equal(await ejecutar(limitar, { tenantId: "a", limite: null }), "siguiente");
    await assert.rejects(ejecutar(limitar, { tenantId: "a", limite: null }), error => error.status === 429);
    assert.equal(await ejecutar(limitar, { tenantId: "b", limite: null }), "siguiente");
});

test("con el balde agotado, la clave recibe 429 sin consultar la base", async () => {
    const limitar = crearLimitador({ porSegundo: 1, rafaga: 1, reloj: () => 0 });
    let consultas = 0;
    const pool = { query: async () => { consultas++; return [[{ id: "t", scopes: "lectura" }]]; } };
    const autenticar = crearAutenticacion(pool, limitar);
    const pedido = () => ({ get: () => "Bearer rc_saturado" });

    const primero = pedido();
    assert.equal(await ejecutar(autenticar, primero), "siguiente");
    assert.equal(await ejecutar(limitar, primero), "siguiente");
    assert.equal(consultas, 1);

    await assert.rejects(ejecutar(autenticar, pedido()), error => error.status === 429);
    assert.equal(consultas, 1);
});

test("el límite propio del tenant reemplaza al de la plataforma", async () => {
    const limitar = crearLimitador({ porSegundo: 1, rafaga: 1, reloj: () => 0 });
    const req = { tenantId: "aula", limite: { porSegundo: 100, rafaga: 5 } };

    for (let i = 0; i < 5; i++) assert.equal(await ejecutar(limitar, req), "siguiente");
    await assert.rejects(ejecutar(limitar, req), error => error.status === 429);
});

test("/admin: sin clave 401, clave de tenant 403, clave del operador pasa", async () => {
    const claveTenant = "rc_tenant";
    const pool = {
        query: async (sql, [hash]) => [hash.equals(sha256(claveTenant)) ? [{ 1: 1 }] : []]
    };
    const autenticar = crearAutenticacionAdministrador(pool, sha256("clave-del-operador"));
    const pedido = clave => ({ get: () => (clave ? `Bearer ${clave}` : undefined) });

    await assert.rejects(ejecutar(autenticar, pedido(null)), error => error.status === 401);
    await assert.rejects(ejecutar(autenticar, pedido("otra")), error => error.status === 401);

    const tenant = pedido(claveTenant);
    assert.equal(await ejecutar(autenticar, tenant), "siguiente");
    await assert.rejects(ejecutar(exigirOperador, tenant), error => error.status === 403);

    const operador = pedido("clave-del-operador");
    assert.equal(await ejecutar(autenticar, operador), "siguiente");
    assert.equal(await ejecutar(exigirOperador, operador), "siguiente");
});

test("sin hash del operador configurado, /admin no acepta ninguna clave", async () => {
    const autenticar = crearAutenticacionAdministrador({ query: async () => [[]] }, null);

    await assert.rejects(ejecutar(autenticar, { get: () => "Bearer cualquiera" }), error => error.status === 401);
});
