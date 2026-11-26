"use strict";
(async () => {
    try {
        const r = await fetch("/auth/me", { cache: "no-store" });
        if (r.ok) {
            location.replace("/");
            return;
        }
    } catch (_) {
        /* Se puede reintentar desde el formulario. */
    }
    const formulario = document.querySelector("#login");
    formulario.addEventListener("submit", async (evento) => {
        evento.preventDefault();
        const boton = formulario.querySelector("button");
        const error = document.querySelector("#error-login");
        boton.disabled = true;
        boton.textContent = "Ingresando…";
        error.hidden = true;
        try {
            const r = await fetch("/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    usuario: formulario.elements
                        .namedItem("usuario")
                        .value.trim(),
                    password: formulario.elements.namedItem("password").value,
                }),
            });
            if (!r.ok) {
                const mensajes = {
                    401: "El usuario o la contraseña no son correctos.",
                    429: "Hubo demasiados intentos. Esperá antes de volver a ingresar.",
                    503: "No podemos iniciar sesión ahora. Intentá nuevamente en unos momentos.",
                };
                throw Error(
                    mensajes[r.status] ||
                        "No pudimos iniciar sesión. Intentá nuevamente.",
                );
            }
            formulario.elements.namedItem("password").value = "";
            location.replace("/");
        } catch (e) {
            error.textContent =
                e.message === "Failed to fetch"
                    ? "No pudimos conectar con Aula. Revisá tu conexión."
                    : e.message;
            error.hidden = false;
        } finally {
            boton.disabled = false;
            boton.textContent = "Ingresar →";
        }
    });
})();
