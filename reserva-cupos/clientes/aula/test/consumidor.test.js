// Prueba de contrato del lado consumidor: Aula usa la API solo a través de
// contrato/openapi.yaml. Se ejecuta contra un mock de Prism generado del
// mismo contrato, sin la API real:
//
//   docker run --rm -p 4010:4010 -v "$PWD/reserva-cupos/contrato:/contrato:ro" \
//     stoplight/prism:5 mock -d -m false -h 0.0.0.0 /contrato/openapi.yaml
//   PRISM_URL=http://localhost:4010 npm test
//
// Prism rechaza (422, cabecera sl-violations) cualquier solicitud que no
// cumpla el contrato, así que una respuesta 2xx prueba que la solicitud de
// Aula es válida; además, el cliente valida cada respuesta contra el
// esquema de su código.
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { crearClienteApi } = require("../src/api");

const PRISM_URL = process.env.PRISM_URL;
const opciones = { skip: PRISM_URL ? false : "PRISM_URL no definida: requiere el mock de Prism" };
const api = PRISM_URL && crearClienteApi({ baseUrl: PRISM_URL, clave: "clave-de-prueba", timeoutMs: 5000 });
const ID = "0193a4b2-7c1d-7e2f-8a3b-4c5d6e7f8091";

function aceptada(respuesta) {
    assert.ok(respuesta.status >= 200 && respuesta.status < 300, `HTTP ${respuesta.status}: ${JSON.stringify(respuesta.cuerpo)}`);
}

test("crear una materia usa crearActividad según el contrato", opciones, async () => {
    aceptada(await api.llamar("crearActividad", {
        cuerpo: { nombre: "Programación Distribuida", capacidad: 10, metadata: { origen: "aula", tipo: "materia" } }
    }));
});

test("consultar una materia y sus inscriptos", opciones, async () => {
    aceptada(await api.llamar("consultarActividad", { parametros: { id: ID } }));
    aceptada(await api.llamar("listarReservas", { parametros: { id: ID }, query: { estado: "confirmada", limite: 100 } }));
});

test("inscribirse con Idempotency-Key y consultar el resultado", opciones, async () => {
    aceptada(await api.llamar("solicitarReserva", {
        parametros: { id: ID },
        cuerpo: { participante: "alumno-1" },
        encabezados: { "Idempotency-Key": randomUUID() }
    }));
    aceptada(await api.llamar("consultarReserva", { parametros: { id: ID } }));
});

test("cancelar una inscripción", opciones, async () => {
    aceptada(await api.llamar("cancelarReserva", { parametros: { id: ID } }));
});

test("el mock rechaza una solicitud fuera de contrato antes de que llegue a una API real", opciones, async () => {
    // Sin Idempotency-Key: Prism responde 422 y detalla la violación.
    const respuesta = await fetch(`${PRISM_URL}${api.contrato.ruta("solicitarReserva", { id: ID })}`, {
        method: "POST",
        headers: { Authorization: "Bearer clave-de-prueba", "Content-Type": "application/json" },
        body: JSON.stringify({ participante: "alumno-1" })
    });

    assert.equal(respuesta.status, 422);
    assert.match(respuesta.headers.get("sl-violations"), /idempotency-key/);
});
