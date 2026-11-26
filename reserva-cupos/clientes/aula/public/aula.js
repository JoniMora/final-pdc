"use strict";
const $ = (selector) => document.querySelector(selector);
let sesion;
let materias = [];
let inscripciones = [];
let refrescando = false;
let operando = false;
let errorAccion = null;
let detalle = null;
const etiquetas = {
    pendiente: "Pendiente",
    confirmada: "Confirmada",
    rechazada: "Rechazada",
    cancelada: "Cancelada",
    fallida: "No procesada",
};
const anteriores = new Map();
const claves = new Map();

function nodo(tag, clase, texto) {
    const elemento = document.createElement(tag);
    if (clase) elemento.className = clase;
    if (texto !== undefined) elemento.textContent = texto;
    return elemento;
}
function avisar(texto, error = false) {
    const destino = $(error ? "#error" : "#mensaje");
    destino.textContent = texto;
    destino.hidden = false;
}
function vacio(contenedor, texto) {
    contenedor.append(nodo("p", "vacio", texto));
}
async function pedir(ruta, { metodo = "GET", cuerpo, encabezados = {} } = {}) {
    const r = await fetch(ruta, {
        method: metodo,
        cache: "no-store",
        headers: {
            ...(cuerpo !== undefined
                ? { "Content-Type": "application/json" }
                : {}),
            ...(metodo !== "GET" ? { "X-CSRF-Token": sesion.csrf } : {}),
            ...encabezados,
        },
        body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
    });
    if (r.status === 401) {
        location.replace("/login.html");
        throw Error("Tu sesión terminó. Volvé a ingresar.");
    }
    if (r.headers.get("X-Aula-Modo") === "contingencia")
        $("#contingencia").hidden = false;
    const datos = await r.json();
    if (!r.ok) {
        const mensajes = {
            403: "No tenés permiso para realizar esta acción.",
            404: "No encontramos esta materia o inscripción. Actualizá la página.",
            409: "La solicitud no se pudo completar: ya tenés una inscripción activa o la materia está cerrada.",
            429: "Hay muchas solicitudes. Esperá unos segundos y volvé a intentar.",
            400: "Revisá los datos e intentá nuevamente.",
            503: "El servicio no está disponible ahora. Intentá nuevamente en unos momentos.",
        };
        throw Error(
            mensajes[r.status] ||
                "No pudimos completar la consulta. Intentá nuevamente.",
        );
    }
    return datos;
}
function activa(id) {
    return inscripciones.some(
        (r) =>
            r.actividad_id === id &&
            ["confirmada", "pendiente"].includes(r.estado),
    );
}
function pintarAlumno() {
    const lista = $("#materias");
    lista.replaceChildren();
    for (const materia of materias) {
        const tarjeta = nodo("article", "tarjeta materia");
        tarjeta.append(
            nodo("p", "ceja", "MATERIA"),
            nodo("h3", "", materia.nombre),
        );
        const cupos = nodo("p", "cupos");
        cupos.append(
            nodo("strong", "", String(materia.cupos_disponibles)),
            document.createTextNode(` de ${materia.cupo} cupos libres`),
        );
        const boton = nodo(
            "button",
            "primario",
            activa(materia.actividad_id)
                ? "Ya solicitaste tu lugar"
                : materia.cupos_disponibles === 0
                  ? "Sin cupos disponibles"
                  : materia.estado !== "abierta"
                    ? "Inscripciones cerradas"
                    : "Inscribirme",
        );
        boton.disabled =
            operando ||
            activa(materia.actividad_id) ||
            materia.cupos_disponibles <= 0 ||
            materia.estado !== "abierta";
        boton.addEventListener("click", () => inscribir(materia, boton));
        tarjeta.append(cupos, boton);
        lista.append(tarjeta);
    }
    if (!materias.length)
        vacio(
            lista,
            "Todavía no hay materias disponibles. Volvé a consultar más tarde.",
        );
    const propias = $("#inscripciones");
    propias.replaceChildren();
    for (const r of inscripciones) {
        const fila = nodo("article", "inscripcion");
        const texto = nodo("div");
        const explicaciones = {
            pendiente:
                "Estamos procesando tu solicitud. Todavía no tenés un lugar confirmado.",
            confirmada: `¡Listo! Tenés tu lugar en ${r.materia}.`,
            rechazada:
                "No quedaban cupos o la materia ya no admitía inscripciones.",
            cancelada: "Tu inscripción fue cancelada.",
            fallida:
                "No se pudo procesar la solicitud. Podés volver a intentarlo.",
        };
        texto.append(
            nodo("h3", "", r.materia),
            nodo(
                "p",
                "",
                explicaciones[r.estado] ||
                    "Consultando el estado de tu solicitud.",
            ),
        );
        const acciones = nodo("div", "acciones");
        acciones.append(
            nodo(
                "span",
                `estado ${r.estado}`,
                etiquetas[r.estado] || "En proceso",
            ),
        );
        if (["pendiente", "confirmada"].includes(r.estado)) {
            const cancelar = nodo("button", "texto", "Cancelar");
            cancelar.disabled = operando;
            cancelar.setAttribute(
                "aria-label",
                `Cancelar inscripción en ${r.materia}`,
            );
            cancelar.addEventListener("click", () =>
                cancelarInscripcion(r, cancelar),
            );
            acciones.append(cancelar);
        }
        fila.append(texto, acciones);
        propias.append(fila);
    }
    if (!inscripciones.length)
        vacio(
            propias,
            "Aún no tenés inscripciones. Elegí una materia para empezar.",
        );
}
function pintarAdministrador() {
    const tabla = $("#tabla-materias");
    tabla.replaceChildren();
    $("#cantidad-materias").textContent =
        `${materias.length} ${materias.length === 1 ? "materia" : "materias"}`;
    for (const materia of materias) {
        const fila = nodo("tr");
        const ocupados = materia.cupo - materia.cupos_disponibles;
        fila.append(nodo("td", "", materia.nombre));
        const ocupacion = nodo("td", "", `${ocupados} de ${materia.cupo}`);
        const progreso = nodo("progress");
        progreso.max = Math.max(1, materia.cupo);
        progreso.value = ocupados;
        progreso.setAttribute(
            "aria-label",
            `${ocupados} de ${materia.cupo} cupos ocupados`,
        );
        ocupacion.append(progreso);
        fila.append(
            ocupacion,
            nodo("td", "", String(materia.cupos_disponibles)),
        );
        const celda = nodo("td");
        const ver = nodo("button", "texto", "Ver inscriptos");
        ver.setAttribute("aria-label", `Ver inscriptos en ${materia.nombre}`);
        ver.addEventListener("click", () => cargarDetalle(materia));
        celda.append(ver);
        fila.append(celda);
        tabla.append(fila);
    }
    if (!materias.length) {
        const fila = nodo("tr");
        const celda = nodo(
            "td",
            "",
            "Todavía no hay materias. Creá la primera para comenzar.",
        );
        celda.colSpan = 4;
        fila.append(celda);
        tabla.append(fila);
    }
}
function pintarEstado(estado, reconciliacion) {
    $("#contingencia").hidden = estado.postgresql === "conectado";
    if (sesion.usuario.rol !== "administrador") return;
    for (const [selector, bien, texto] of [
        [
            "#base-estado",
            estado.postgresql === "conectado",
            estado.postgresql === "conectado" ? "Conectada" : "En contingencia",
        ],
        [
            "#api-estado",
            estado.api.startsWith("conectada"),
            estado.api.startsWith("conectada") ? "Disponible" : "No disponible",
        ],
        [
            "#reconciliacion-estado",
            reconciliacion?.modo === "normal",
            reconciliacion?.modo === "normal"
                ? "Al día"
                : reconciliacion?.modo === "iniciando"
                  ? "Iniciando"
                  : "Pendiente",
        ],
    ]) {
        $(selector).textContent = texto;
        $(selector).classList.toggle("alerta", !bien);
    }
    $("#ultima-reconciliacion").textContent =
        reconciliacion?.ultima_sincronizacion
            ? `Último intento: ${new Date(reconciliacion.ultima_sincronizacion).toLocaleTimeString("es-AR")}`
            : "Sin sincronización registrada";
}
async function actualizar() {
    if (refrescando || operando || !sesion) return;
    refrescando = true;
    $("#actualizar").disabled = true;
    try {
        const estado = await pedir("/estado");
        const recon =
            sesion.usuario.rol === "administrador"
                ? await pedir("/reconciliacion")
                : null;
        pintarEstado(estado, recon);
        const nuevasMaterias = await pedir("/materias");
        const nuevasInscripciones =
            sesion.usuario.rol === "alumno"
                ? await pedir("/inscripciones")
                : [];
        for (const r of nuevasInscripciones) {
            if (
                anteriores.get(r.id) === "pendiente" &&
                r.estado === "confirmada"
            )
                avisar(`¡Listo! Tenés tu lugar en ${r.materia}.`);
            if (
                anteriores.get(r.id) === "pendiente" &&
                r.estado === "rechazada"
            )
                avisar(
                    `No se pudo confirmar tu lugar en ${r.materia}. No quedaban cupos o las inscripciones estaban cerradas.`,
                );
            anteriores.set(r.id, r.estado);
        }
        materias = nuevasMaterias;
        inscripciones = nuevasInscripciones;
        if (sesion.usuario.rol === "alumno") pintarAlumno();
        else pintarAdministrador();
        if (!errorAccion) $("#error").hidden = true;
        $("#actualizado").textContent =
            `Actualizado ${new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}`;
    } catch (_) {
        $("#actualizado").textContent = "Actualización pendiente";
        avisar(
            "No pudimos actualizar la información. Los datos visibles pueden estar desactualizados. Volveremos a intentar automáticamente.",
            true,
        );
        // Sin datos recientes no se ofrecen nuevas inscripciones con cupos posiblemente viejos.
        $("#materias")
            .querySelectorAll("button")
            .forEach((b) => {
                b.disabled = true;
            });
    } finally {
        refrescando = false;
        $("#actualizar").disabled = false;
    }
}
async function accion(boton, operacion) {
    if (operando) return;
    while (refrescando) await new Promise((resolve) => setTimeout(resolve, 50));
    if (operando) return;
    operando = true;
    boton.disabled = true;
    errorAccion = null;
    $("#error").hidden = true;
    try {
        await operacion();
    } catch (e) {
        errorAccion =
            e.message === "Failed to fetch"
                ? "No pudimos conectar. Reintentá la misma solicitud para verificar su resultado."
                : e.message;
        avisar(errorAccion, true);
    } finally {
        operando = false;
        boton.disabled = false;
        await actualizar();
        if (errorAccion) avisar(errorAccion, true);
    }
}
async function inscribir(materia, boton) {
    await accion(boton, async () => {
        // Se conserva la clave si la red falla; un reintento no crea otra solicitud.
        if (!claves.has(materia.actividad_id))
            claves.set(materia.actividad_id, crypto.randomUUID());
        const r = await pedir(
            `/materias/${encodeURIComponent(materia.actividad_id)}/inscripciones`,
            {
                metodo: "POST",
                cuerpo: {},
                encabezados: {
                    "Idempotency-Key": claves.get(materia.actividad_id),
                },
            },
        );
        claves.delete(materia.actividad_id);
        anteriores.set(r.id, r.estado);
        avisar(
            r.estado === "confirmada"
                ? `¡Listo! Tenés tu lugar en ${materia.nombre}.`
                : "Recibimos tu solicitud. Esperá la confirmación de tu lugar.",
        );
    });
}
async function cancelarInscripcion(r, boton) {
    if (!confirm(`¿Querés cancelar tu inscripción en ${r.materia}?`)) return;
    await accion(boton, async () => {
        await pedir(`/inscripciones/${encodeURIComponent(r.id)}/cancelacion`, {
            metodo: "POST",
        });
        avisar(
            "Recibimos la cancelación. El estado se actualizará cuando termine de procesarse.",
        );
    });
}
async function cargarDetalle(materia, cursor) {
    const actual = cursor ? detalle : { materia, cursor: null, ids: new Set() };
    if (!cursor) {
        detalle = actual;
        $("#lista-inscriptos").replaceChildren();
        $("#detalle-titulo").textContent = `Inscriptos en ${materia.nombre}`;
        $("#detalle").hidden = false;
    }
    $("#mas-inscriptos").disabled = true;
    try {
        const r = await pedir(
            `/materias/${encodeURIComponent(materia.actividad_id)}${cursor ? "?cursor=" + encodeURIComponent(cursor) : ""}`,
        );
        if (detalle !== actual) return;
        for (const reserva of r.inscriptos) {
            if (!actual.ids.has(reserva.id)) {
                actual.ids.add(reserva.id);
                $("#lista-inscriptos").append(
                    nodo("li", "", reserva.participante),
                );
            }
        }
        if (!actual.ids.size)
            $("#lista-inscriptos").append(
                nodo("li", "", "Todavía no hay inscriptos confirmados."),
            );
        actual.cursor = r.siguiente_cursor;
        $("#mas-inscriptos").hidden = !actual.cursor;
        $("#detalle").scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (e) {
        avisar(e.message, true);
    } finally {
        $("#mas-inscriptos").disabled = false;
    }
}
(async () => {
    try {
        const r = await fetch("/auth/me", { cache: "no-store" });
        if (r.status === 401) {
            location.replace("/login.html");
            return;
        }
        if (!r.ok) throw Error();
        sesion = await r.json();
        const admin = sesion.usuario.rol === "administrador";
        $("#persona").textContent = sesion.usuario.usuario;
        $("#rol").textContent = admin ? "Administración" : "Portal del alumno";
        $("#titulo").textContent = admin
            ? "Una mirada a tu Aula."
            : "Tu próximo lugar empieza acá.";
        $("#subtitulo").textContent = admin
            ? "Gestioná las materias y acompañá cada inscripción."
            : "Elegí una materia, solicitá tu lugar y seguí su confirmación.";
        $("#administrador").hidden = !admin;
        $("#alumno").hidden = admin;
        $("#cargando").hidden = true;
        $("#aplicacion").hidden = false;
        $("#actualizar").addEventListener("click", actualizar);
        $("#salir").addEventListener("click", async () => {
            try {
                await pedir("/auth/logout", { metodo: "POST" });
                location.replace("/login.html");
            } catch (_) {
                avisar("No pudimos cerrar la sesión. Volvé a intentar.", true);
            }
        });
        $("#crear").addEventListener("submit", (e) => {
            e.preventDefault();
            const formulario = e.currentTarget;
            accion(formulario.querySelector("button"), async () => {
                const nombre = formulario.elements
                    .namedItem("nombre")
                    .value.trim();
                if (!nombre) throw Error("Ingresá el nombre de la materia.");
                await pedir("/materias", {
                    metodo: "POST",
                    cuerpo: {
                        nombre,
                        cupo: Number(
                            formulario.elements.namedItem("cupo").value,
                        ),
                    },
                });
                formulario.reset();
                avisar(`La materia ${nombre} ya está creada.`);
            });
        });
        $("#reconciliar").addEventListener("click", (e) =>
            accion(e.currentTarget, async () => {
                const r = await pedir("/reconciliacion", { metodo: "POST" });
                $("#resultado-reconciliacion").textContent =
                    r.modo === "normal"
                        ? "Los datos de Aula están al día."
                        : "La sincronización sigue pendiente. Aula volverá a intentarlo automáticamente.";
            }),
        );
        $("#cerrar-detalle").addEventListener("click", () => {
            detalle = null;
            $("#detalle").hidden = true;
        });
        $("#mas-inscriptos").addEventListener("click", () => {
            if (detalle?.cursor) cargarDetalle(detalle.materia, detalle.cursor);
        });
        await actualizar();
        async function ciclo() {
            if (!document.hidden) await actualizar();
            setTimeout(ciclo, 5000);
        }
        setTimeout(ciclo, 5000);
    } catch (_) {
        $("#cargando").textContent =
            "No pudimos abrir tu espacio. Recargá la página para volver a intentar.";
    }
})();
