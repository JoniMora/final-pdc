"use strict";

// Interfaz del cliente de referencia. Todo lo que viene del servicio se
// inserta como texto (textContent), nunca como HTML.

const $ = id => document.getElementById(id);

function h(etiqueta, atributos = {}, ...hijos) {
    const el = document.createElement(etiqueta);
    for (const [clave, valor] of Object.entries(atributos)) {
        if (valor === null || valor === undefined || valor === false) continue;
        if (clave === "clase") el.className = valor;
        else if (clave.startsWith("on")) el.addEventListener(clave.slice(2), valor);
        else el.setAttribute(clave, valor === true ? "" : valor);
    }
    for (const hijo of hijos.flat()) {
        if (hijo === null || hijo === undefined || hijo === false) continue;
        el.append(hijo instanceof Node ? hijo : String(hijo));
    }
    return el;
}

const ETIQUETAS = {
    confirmada: "Confirmadas",
    pendiente: "Pendientes",
    rechazada: "Rechazadas",
    cancelada: "Canceladas",
    fallida: "Fallidas"
};

let config = null;
let estado = null;
let firmaLista = "";
let firmaWebhooks = "";
let firmaDetalle = "";
let detalleId = null;
let pestana = "confirmada";

const capitalizar = texto => texto.charAt(0).toUpperCase() + texto.slice(1);
const esperar = ms => new Promise(resolver => setTimeout(resolver, ms));

async function pedir(url, { metodo = "GET", cuerpo } = {}) {
    const respuesta = await fetch(url, {
        method: metodo,
        headers: cuerpo !== undefined ? { "Content-Type": "application/json" } : {},
        body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined
    });
    const esJson = (respuesta.headers.get("content-type") || "").includes("json");
    const datos = esJson ? await respuesta.json() : null;

    if (!respuesta.ok) {
        throw Object.assign(new Error(datos?.mensaje || `HTTP ${respuesta.status}`), { status: respuesta.status });
    }
    return { status: respuesta.status, datos };
}

function tostada(texto, tipo = "info", ms = 4500) {
    const el = h("div", { clase: `tostada ${tipo}`, role: tipo === "error" ? "alert" : "status" }, texto);
    $("tostadas").append(el);
    setTimeout(() => el.remove(), ms);
}

// --- Formato -------------------------------------------------------------

const formatoFecha = new Intl.DateTimeFormat("es-AR", { weekday: "short", day: "2-digit", month: "2-digit" });

function textoMetadata(metadata) {
    if (!metadata) return "";
    return config.campos
        .map(campo => {
            const valor = metadata[campo.clave];
            if (typeof valor !== "string" || !valor) return null;
            if (campo.tipo === "fecha") {
                const fecha = new Date(`${valor}T00:00`);
                return Number.isNaN(fecha.getTime()) ? valor : formatoFecha.format(fecha);
            }
            return valor;
        })
        .filter(Boolean)
        .join(" · ");
}

function chip(estadoReserva, cantidad) {
    const texto = cantidad === undefined ? estadoReserva : `${cantidad} ${ETIQUETAS[estadoReserva].toLowerCase()}`;
    return h("span", { clase: `chip ${estadoReserva}` }, texto);
}

function barra(ocupados, capacidad, clase = "") {
    const relleno = h("span");
    relleno.style.width = `${capacidad ? Math.min(100, (ocupados / capacidad) * 100) : 0}%`;
    return h("div", { clase: `barra-progreso ${clase}` }, relleno);
}

function insignia(estadoActividad) {
    return h("span", { clase: `insignia ${estadoActividad}` }, estadoActividad === "abierta" ? "Abierta" : "Cerrada");
}

// --- Estado general ------------------------------------------------------

function pintarTenant() {
    const { tenant } = estado;
    const pastilla = $("sincronizacion");
    const aviso = $("aviso");

    if (!tenant.configurado) {
        pastilla.textContent = "Sin tenant";
        pastilla.className = "pastilla alerta";
        aviso.textContent = "Este cliente todavía no tiene tenant. Correr node scripts/sistema.js demo: crea el tenant y le pasa la clave.";
        aviso.classList.remove("oculto");
    } else if (tenant.error) {
        pastilla.textContent = "Sin sincronizar";
        pastilla.className = "pastilla alerta";
        aviso.textContent = tenant.error;
        aviso.classList.remove("oculto");
    } else {
        pastilla.textContent = "Sincronizado";
        pastilla.className = "pastilla ok";
        aviso.classList.add("oculto");
    }

    if (tenant.id) {
        $("tenant").textContent = `Tenant ${tenant.nombre} · ${tenant.id.slice(0, 8)}…`;
        $("tenant").title = tenant.id;
    }
}

function tarjeta(actividad) {
    const ocupados = actividad.capacidad - actividad.cupos_disponibles;
    const { conteo } = actividad;

    return h("button", { type: "button", clase: "tarjeta", onclick: () => abrirDetalle(actividad.id) },
        h("div", { clase: "tarjeta-cabecera" }, h("h3", {}, actividad.nombre), insignia(actividad.estado)),
        h("p", { clase: "sutil" }, textoMetadata(actividad.metadata) || " "),
        barra(ocupados, actividad.capacidad),
        h("p", { clase: "cupos" },
            h("strong", {}, `${ocupados} de ${actividad.capacidad}`), ` ${config.participante.plural}`,
            actividad.cupos_disponibles ? ` · quedan ${actividad.cupos_disponibles}` : " · completo"),
        h("div", { clase: "chips" },
            chip("confirmada", conteo.confirmada),
            conteo.pendiente ? chip("pendiente", conteo.pendiente) : null,
            conteo.rechazada ? chip("rechazada", conteo.rechazada) : null,
            conteo.cancelada ? chip("cancelada", conteo.cancelada) : null));
}

function pintarActividades() {
    const firma = JSON.stringify(estado.actividades);
    if (firma === firmaLista) return;
    firmaLista = firma;

    const contenedor = $("actividades");
    if (estado.actividades.length === 0) {
        contenedor.replaceChildren(h("div", { clase: "vacio" },
            h("p", {}, `Todavía no hay ${config.actividad.plural}.`),
            h("p", { clase: "sutil" }, `Creá el primero con "Nuevo ${config.actividad.singular}" o lanzá la ráfaga de k6 de la Parte 3 del ensayo.`)));
        return;
    }
    contenedor.replaceChildren(...estado.actividades.map(tarjeta));
}

function itemWebhook(webhook) {
    const hora = new Date(webhook.recibido_en).toLocaleTimeString("es-AR");

    if (!webhook.valido) {
        return h("li", { clase: "webhook invalido" },
            h("span", { clase: "hora" }, hora),
            h("span", { clase: "chip fallida" }, "rechazado"),
            h("span", { clase: "quien" }, webhook.motivo));
    }

    const actividad = estado.actividades.find(a => a.id === webhook.actividad_id);
    return h("li", { clase: "webhook" },
        h("span", { clase: "hora" }, hora),
        chip(webhook.tipo.replace("reserva.", "")),
        h("span", { clase: "quien" }, webhook.participante),
        h("span", { clase: "sutil donde" },
            `${actividad?.nombre || "…"} · secuencia ${webhook.secuencia}${webhook.aplicado ? "" : " · repetido, sin cambios"}`));
}

function pintarWebhooks() {
    const { validos, rechazados } = estado.recibidos;
    $("contador-webhooks").textContent = `${validos} válidos${rechazados ? ` · ${rechazados} rechazados` : ""}`;

    const firma = JSON.stringify(estado.webhooks.map(w => [w.recibido_en, w.webhook_id])) + firmaLista.length;
    if (firma === firmaWebhooks) return;
    firmaWebhooks = firma;

    $("webhooks").replaceChildren(...(estado.webhooks.length
        ? estado.webhooks.map(itemWebhook)
        : [h("li", { clase: "vacio sutil" }, "Todavía no llegó ninguno. Llegan cuando el servicio decide una reserva.")]));
}

async function actualizar() {
    try {
        estado = (await pedir("/api/estado")).datos;
        pintarTenant();
        pintarActividades();
        pintarWebhooks();
        if (detalleId) await refrescarDetalle();
    } catch {
        $("sincronizacion").textContent = "Cliente sin respuesta";
        $("sincronizacion").className = "pastilla alerta";
    }
}

// --- Detalle de una actividad --------------------------------------------

async function abrirDetalle(id) {
    detalleId = id;
    pestana = "confirmada";
    firmaDetalle = "";
    $("resultado-reserva").textContent = "";
    if (await refrescarDetalle()) {
        if (!$("dialogo-detalle").open) $("dialogo-detalle").showModal();
        $("participante").focus();
    }
}

async function refrescarDetalle() {
    try {
        const { datos } = await pedir(`/api/actividades/${detalleId}`);
        pintarDetalle(datos);
        return true;
    } catch (error) {
        tostada(error.message, "error", error.status === 404 ? 8000 : 4500);
        detalleId = null;
        $("dialogo-detalle").close();
        return false;
    }
}

// Se vuelve a pintar solo si algo cambió: así un clic en "Cancelar" no cae
// sobre un botón que se acaba de reemplazar.
function pintarDetalle(datos) {
    const firma = JSON.stringify(datos) + pestana;
    if (firma === firmaDetalle) return;
    firmaDetalle = firma;

    const { actividad, reservas } = datos;
    const ocupados = actividad.capacidad - actividad.cupos_disponibles;
    const { conteo } = actividad;

    $("detalle-nombre").replaceChildren(actividad.nombre, " ", insignia(actividad.estado));
    $("detalle-meta").textContent = textoMetadata(actividad.metadata);
    $("detalle-id").textContent = `id ${actividad.id}`;
    $("detalle-id").title = "Copiar el id";

    const cifra = (valor, texto, clase = "") => h("div", { clase: `cifra ${clase}` }, h("strong", {}, valor), h("span", {}, texto));
    $("detalle-cifras").replaceChildren(
        cifra(`${ocupados}/${actividad.capacidad}`, config.capacidad.etiqueta.toLowerCase()),
        cifra(actividad.cupos_disponibles, "disponibles"),
        cifra(conteo.pendiente, "pendientes", "pendiente"),
        cifra(conteo.rechazada, "rechazadas", "rechazada"));

    $("detalle-progreso").style.width = `${Math.min(100, (ocupados / actividad.capacidad) * 100)}%`;

    const abierta = actividad.estado === "abierta";
    $("boton-reservar").disabled = !abierta;
    $("participante").disabled = !abierta;
    $("boton-estado").textContent = abierta ? "Cerrar inscripción" : "Abrir inscripción";

    $("pestanas").replaceChildren(...Object.keys(ETIQUETAS)
        .filter(e => conteo[e] > 0 || e === "confirmada")
        .map(e => h("button", {
            type: "button",
            role: "tab",
            clase: `pestana${e === pestana ? " activa" : ""}`,
            "aria-selected": e === pestana ? "true" : "false",
            onclick: () => { pestana = e; refrescarDetalle(); }
        }, `${ETIQUETAS[e]} (${conteo[e]})`)));

    const filtradas = reservas.filter(r => r.estado === pestana);
    const visibles = filtradas.slice(0, 100);
    $("detalle-reservas").replaceChildren(
        ...visibles.map(reserva => h("li", { clase: "reserva" },
            h("span", { clase: "quien" }, reserva.participante),
            chip(reserva.estado),
            h("span", { clase: "sutil" }, new Date(reserva.creado_en).toLocaleTimeString("es-AR")),
            reserva.estado === "confirmada"
                ? h("button", { type: "button", clase: "boton enlace", onclick: () => cancelar(reserva) }, "Cancelar")
                : h("span"))),
        filtradas.length > visibles.length ? h("li", { clase: "sutil mas" }, `y ${filtradas.length - visibles.length} más`) : null,
        filtradas.length === 0 ? h("li", { clase: "sutil mas" }, "Ninguna.") : null);
}

// La clave de idempotencia se genera una vez por intento: los reintentos
// ante 429 o 503 la repiten y el servicio no duplica la reserva.
async function reservar(evento) {
    evento.preventDefault();
    const participante = $("participante").value.trim();
    if (!participante) return;

    const clave = crypto.randomUUID().replaceAll("-", "");
    const salida = $("resultado-reserva");
    $("boton-reservar").disabled = true;

    try {
        for (let intento = 0; ; intento++) {
            try {
                const { status, datos } = await pedir(`/api/actividades/${detalleId}/reservas`, {
                    metodo: "POST",
                    cuerpo: { participante, clave }
                });
                salida.textContent = status === 202
                    ? `Solicitud admitida (202): ${datos.participante} queda pendiente. La decisión llega por webhook.`
                    : `Ya estaba solicitada (200): ${datos.participante} está ${datos.estado}.`;
                $("participante").value = "";
                break;
            } catch (error) {
                if ((error.status === 429 || error.status === 503) && intento < 4) {
                    salida.textContent = `${error.message}. Reintentando con la misma clave…`;
                    await esperar(1000 * (intento + 1));
                    continue;
                }
                throw error;
            }
        }
    } catch (error) {
        salida.textContent = error.message;
    } finally {
        $("boton-reservar").disabled = false;
        refrescarDetalle();
    }
}

async function cancelar(reserva) {
    try {
        await pedir(`/api/reservas/${reserva.id}/cancelacion`, { metodo: "POST", cuerpo: {} });
        tostada(`Cancelación de ${reserva.participante} solicitada: se confirma por webhook.`);
    } catch (error) {
        tostada(error.message, "error");
    }
    refrescarDetalle();
}

async function cambiarEstado() {
    const actual = estado.actividades.find(a => a.id === detalleId);
    try {
        await pedir(`/api/actividades/${detalleId}`, {
            metodo: "PATCH",
            cuerpo: { estado: actual?.estado === "abierta" ? "cerrada" : "abierta" }
        });
    } catch (error) {
        tostada(error.message, "error");
    }
    actualizar();
}

// --- Alta ----------------------------------------------------------------

function armarCampos() {
    const hoy = new Date();
    const fecha = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}-${String(hoy.getDate()).padStart(2, "0")}`;
    const hora = `${String(Math.min(23, hoy.getHours() + 1)).padStart(2, "0")}:00`;

    $("campos").replaceChildren(...config.campos.map(campo => {
        let control;
        if (campo.tipo === "opciones") {
            control = h("select", { name: campo.clave }, ...campo.opciones.map(o => h("option", { value: o }, o)));
        } else {
            const tipos = { fecha: "date", hora: "time", texto: "text" };
            control = h("input", { name: campo.clave, type: tipos[campo.tipo], maxlength: campo.tipo === "texto" ? "80" : null });
            if (campo.tipo === "fecha") control.value = fecha;
            if (campo.tipo === "hora") control.value = hora;
        }
        return h("label", {}, campo.etiqueta, " ", control);
    }));
}

function abrirNueva() {
    const form = $("form-nueva");
    form.reset();
    armarCampos();
    form.elements.capacidad.value = config.capacidad.porDefecto;
    $("error-nueva").textContent = "";
    $("dialogo-nueva").showModal();
}

async function crear(evento) {
    evento.preventDefault();
    const form = $("form-nueva");
    const metadata = Object.fromEntries(config.campos.map(c => [c.clave, form.elements[c.clave].value]));

    try {
        const { datos } = await pedir("/api/actividades", {
            metodo: "POST",
            cuerpo: { nombre: form.elements.nombre.value, capacidad: Number(form.elements.capacidad.value), metadata }
        });
        $("dialogo-nueva").close();
        tostada(`${capitalizar(config.actividad.singular)} "${datos.nombre}" creado.`, "ok");
        await actualizar();
        abrirDetalle(datos.id);
    } catch (error) {
        $("error-nueva").textContent = error.message;
    }
}

async function buscar(evento) {
    evento.preventDefault();
    const id = $("buscar-id").value.trim();
    if (id) await abrirDetalle(id);
}

// --- Arranque ------------------------------------------------------------

async function iniciar() {
    config = (await pedir("/api/config")).datos;

    document.title = `${config.nombre} · ${config.titulo}`;
    $("nombre").textContent = config.nombre;
    $("titulo").textContent = config.titulo;
    $("logo").textContent = config.nombre.charAt(0);
    $("titulo-actividades").textContent = capitalizar(config.actividad.plural);
    $("nueva").textContent = `Nuevo ${config.actividad.singular}`;
    $("titulo-nueva").textContent = `Nuevo ${config.actividad.singular}`;
    $("etiqueta-capacidad").textContent = config.capacidad.etiqueta;
    $("participante").placeholder = `${capitalizar(config.participante.singular)}, por ejemplo ${config.participante.ejemplo}`;

    $("nueva").addEventListener("click", abrirNueva);
    $("form-nueva").addEventListener("submit", crear);
    $("form-reserva").addEventListener("submit", reservar);
    $("boton-estado").addEventListener("click", cambiarEstado);
    $("buscar").addEventListener("submit", buscar);
    $("detalle-id").addEventListener("click", () => navigator.clipboard?.writeText(detalleId).then(() => tostada("Id copiado.")));
    $("dialogo-detalle").addEventListener("close", () => { detalleId = null; });
    for (const boton of document.querySelectorAll("[data-cerrar]")) {
        boton.addEventListener("click", () => boton.closest("dialog").close());
    }

    const ciclo = async () => {
        await actualizar();
        setTimeout(ciclo, 1000);
    };
    ciclo();
}

iniciar().catch(error => tostada(`No se pudo iniciar: ${error.message}`, "error", 60000));
