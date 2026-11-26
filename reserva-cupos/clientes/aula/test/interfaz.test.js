const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const publico = path.join(__dirname, "../public");

async function esperar(condicion) {
    for (let i = 0; i < 100; i++) {
        if (condicion()) return;
        await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail("La interfaz no alcanzó el estado esperado");
}

async function pantalla(t, rol = "alumno") {
    const dom = new JSDOM(
        fs.readFileSync(path.join(publico, "index.html"), "utf8"),
        {
            url: "https://aula.test/",
            runScripts: "outside-only",
            pretendToBeVisual: true,
        },
    );
    t.after(() => dom.window.close());
    const estado = {
        caida: false,
        fallar: false,
        reservas: [],
        llamadas: [],
        temporizador: null,
    };
    const materias = [
        {
            actividad_id: "a1",
            nombre: "Distribuidos <script>prueba</script>",
            cupo: 10,
            cupos_disponibles: 3,
            estado: "abierta",
        },
        {
            actividad_id: "a2",
            nombre: "Redes",
            cupo: 2,
            cupos_disponibles: 0,
            estado: "abierta",
        },
    ];
    const w = dom.window;
    w.setTimeout = (callback) => {
        estado.temporizador = callback;
        return 1;
    };
    w.confirm = () => true;
    w.HTMLElement.prototype.scrollIntoView = () => {};
    w.fetch = async (ruta, opciones = {}) => {
        estado.llamadas.push({ ruta, ...opciones });
        let datos;
        if (ruta === "/auth/me")
            datos = {
                usuario: { usuario: "prueba", participante: "alumno-1", rol },
                csrf: "token-csrf",
            };
        else if (ruta === "/estado")
            datos = {
                postgresql: estado.caida ? "no disponible" : "conectado",
                api: "conectada",
                recuperacion: estado.caida ? "degradado" : "normal",
            };
        else if (ruta === "/reconciliacion")
            datos = {
                modo: estado.caida ? "degradado" : "normal",
                ultima_sincronizacion: new Date().toISOString(),
            };
        else if (ruta === "/materias" && opciones.method === "POST")
            datos = { id: "nueva" };
        else if (ruta === "/materias") {
            if (estado.fallar) throw Error("Failed to fetch");
            datos = materias;
        } else if (ruta === "/inscripciones") datos = estado.reservas;
        else if (ruta.endsWith("/inscripciones")) {
            if (estado.fallarSolicitud) throw Error("Failed to fetch");
            datos = {
                id: "r1",
                actividad_id: "a1",
                materia: materias[0].nombre,
                estado: "pendiente",
            };
            estado.reservas = [datos];
        } else if (ruta.endsWith("/cancelacion")) {
            estado.reservas[0].estado = "cancelada";
            datos = estado.reservas[0];
        } else if (ruta === "/materias/a1")
            datos = {
                inscriptos: [{ id: "r1", participante: "alumno-1" }],
                siguiente_cursor: null,
            };
        else throw Error("Ruta de prueba inesperada: " + ruta);
        return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => structuredClone(datos),
        };
    };
    w.eval(fs.readFileSync(path.join(publico, "aula.js"), "utf8"));
    await esperar(
        () =>
            !w.document.querySelector("#actualizar").disabled &&
            w.document
                .querySelector("#actualizado")
                .textContent.startsWith("Actualizado"),
    );
    return {
        w,
        estado,
        materias,
        $: (s) => w.document.querySelector(s),
        refrescar: async () => {
            await estado.temporizador();
        },
    };
}

test("alumno: cupos, protección de texto, solicitud pendiente, actualización y cancelación", async (t) => {
    const { w, $, estado, refrescar } = await pantalla(t);
    assert.equal($("#alumno").hidden, false);
    assert.equal($("#administrador").hidden, true);
    assert.match($("#materias").textContent, /3 de 10 cupos libres/);
    assert.match($("#materias h3").textContent, /<script>/);
    assert.equal($("#materias script"), null);
    const botones = w.document.querySelectorAll("#materias button");
    assert.equal(botones[0].disabled, false);
    assert.equal(botones[1].disabled, true);
    botones[0].click();
    await esperar(() => $("#inscripciones").textContent.includes("Pendiente"));
    const solicitud = estado.llamadas.find(
        (x) => x.ruta === "/materias/a1/inscripciones",
    );
    assert.equal(solicitud.headers["X-CSRF-Token"], "token-csrf");
    assert.ok(solicitud.headers["Idempotency-Key"]);
    assert.equal(solicitud.body, "{}");
    assert.equal($("#materias button").disabled, true);
    await esperar(() => !$("#actualizar").disabled);
    estado.reservas[0].estado = "confirmada";
    await refrescar();
    assert.match($("#inscripciones").textContent, /Confirmada/);
    assert.match($("#mensaje").textContent, /Tenés tu lugar/);
    $("#inscripciones button").click();
    await esperar(() => $("#inscripciones").textContent.includes("Cancelada"));
    assert.equal($("#materias button").disabled, false);
});

test("contingencia en alumno y administrador; recuperación y datos obsoletos", async (t) => {
    for (const rol of ["alumno", "administrador"]) {
        const { $, estado, refrescar } = await pantalla(t, rol);
        estado.caida = true;
        await refrescar();
        assert.equal($("#contingencia").hidden, false);
        assert.match(
            $("#contingencia").textContent,
            /las inscripciones\s+siguen funcionando/,
        );
        if (rol === "administrador")
            assert.equal($("#base-estado").textContent, "En contingencia");
        estado.caida = false;
        await refrescar();
        assert.equal($("#contingencia").hidden, true);
        estado.fallar = true;
        await refrescar();
        assert.equal($("#error").hidden, false);
        if (rol === "alumno")
            assert.equal($("#materias button").disabled, true);
    }
});

test("administrador: indicadores, crear, inscriptos y reconciliar con CSRF", async (t) => {
    const { w, $, estado } = await pantalla(t, "administrador");
    assert.equal($("#alumno").hidden, true);
    assert.equal($("#administrador").hidden, false);
    assert.equal($("#base-estado").textContent, "Conectada");
    assert.equal($("#reconciliacion-estado").textContent, "Al día");
    assert.match($("#tabla-materias").textContent, /7 de 10/);
    $("#nombre").value = "Materia nueva";
    $("#cupo").value = "7";
    $("#crear").dispatchEvent(
        new w.Event("submit", { bubbles: true, cancelable: true }),
    );
    await esperar(() => $("#mensaje").textContent.includes("ya está creada"));
    assert.equal(
        estado.llamadas.find(
            (x) => x.ruta === "/materias" && x.method === "POST",
        ).headers["X-CSRF-Token"],
        "token-csrf",
    );
    await esperar(() => !$("#actualizar").disabled);
    $("#tabla-materias button").click();
    await esperar(() =>
        $("#lista-inscriptos").textContent.includes("alumno-1"),
    );
    assert.equal($("#detalle").hidden, false);
    $("#reconciliar").click();
    await esperar(() =>
        $("#resultado-reconciliacion").textContent.includes("están al día"),
    );
    assert.equal(
        estado.llamadas.find(
            (x) => x.ruta === "/reconciliacion" && x.method === "POST",
        ).headers["X-CSRF-Token"],
        "token-csrf",
    );
});

test("un reintento tras un fallo de red conserva la clave y el mensaje de error", async (t) => {
    const { $, estado } = await pantalla(t);
    estado.fallarSolicitud = true;
    $("#materias button").click();
    await esperar(() => !$("#error").hidden && !$("#actualizar").disabled);
    assert.match($("#error").textContent, /Reintentá/);
    const primera = estado.llamadas.find(
        (x) => x.ruta.endsWith("/inscripciones") && x.method === "POST",
    );
    estado.fallarSolicitud = false;
    $("#materias button").click();
    await esperar(() => $("#inscripciones").textContent.includes("Pendiente"));
    const solicitudes = estado.llamadas.filter(
        (x) => x.ruta.endsWith("/inscripciones") && x.method === "POST",
    );
    assert.equal(solicitudes.length, 2);
    assert.equal(
        solicitudes[1].headers["Idempotency-Key"],
        primera.headers["Idempotency-Key"],
    );
});

test("login separado: error comprensible y sin volcar la respuesta del servidor", async (t) => {
    const dom = new JSDOM(
        fs.readFileSync(path.join(publico, "login.html"), "utf8"),
        {
            url: "https://aula.test/login.html",
            runScripts: "outside-only",
        },
    );
    t.after(() => dom.window.close());
    const w = dom.window;
    let enviado;
    w.fetch = async (ruta, opciones) => {
        if (ruta === "/auth/login") enviado = JSON.parse(opciones.body);
        return { ok: false, status: 401 };
    };
    w.eval(fs.readFileSync(path.join(publico, "acceso.js"), "utf8"));
    await new Promise((resolve) => setImmediate(resolve));
    w.document.querySelector("#usuario").value = "alumno1";
    w.document.querySelector("#password").value = "solo-prueba";
    w.document
        .querySelector("#login")
        .dispatchEvent(
            new w.Event("submit", { bubbles: true, cancelable: true }),
        );
    await esperar(() => !w.document.querySelector("#error-login").hidden);
    assert.equal(enviado.usuario, "alumno1");
    assert.match(
        w.document.querySelector("#error-login").textContent,
        /no son correctos/,
    );
    assert.equal(w.document.querySelector("pre"), null);
    assert.equal(w.document.querySelector("button").disabled, false);
});
