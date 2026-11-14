const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const raiz = path.resolve(__dirname, "../..");
const carpetaSeguridad = path.join(raiz, "seguridad/local");

const carpetaEvidencias = path.resolve(
    raiz,
    "../docs/entrega-6/evidencias"
);

const comprobaciones = [];
const sesiones = [];

let ca;

function registrar(texto) {
    console.log(`OK: ${texto}`);
    comprobaciones.push(`OK: ${texto}`);
}

// Lee los accesos locales sin imprimir las contraseñas.
function leerAccesos() {
    const archivo = path.join(
        carpetaSeguridad,
        "accesos-locales.txt"
    );

    const accesos = {};

    for (const linea of fs.readFileSync(archivo, "utf8").split(/\r?\n/)) {
        const coincidencia = /^(admin|alumno1|alumno2): (.+)$/.exec(linea);

        if (coincidencia) {
            accesos[coincidencia[1]] = coincidencia[2];
        }
    }

    assert.ok(accesos.admin, "Falta el acceso de admin");
    assert.ok(accesos.alumno1, "Falta el acceso de alumno1");

    return accesos;
}

// Todas las solicitudes verifican el certificado con nuestra CA.
function pedir(
    ruta,
    {
        metodo = "GET",
        cuerpo,
        sesion,
        claveIdempotencia
    } = {}
) {
    return new Promise((resolve, reject) => {
        const contenido = cuerpo === undefined
            ? null
            : JSON.stringify(cuerpo);

        const encabezados = {};

        if (contenido !== null) {
            encabezados["Content-Type"] = "application/json";
            encabezados["Content-Length"] = Buffer.byteLength(contenido);
        }

        if (sesion) {
            encabezados.Cookie = sesion.cookie;

            if (metodo !== "GET") {
                encabezados["X-CSRF-Token"] = sesion.csrf;
            }
        }

        if (claveIdempotencia) {
            encabezados["Idempotency-Key"] = claveIdempotencia;
        }

        const solicitud = https.request(
            {
                hostname: "localhost",
                port: 3001,
                path: ruta,
                method: metodo,
                ca,
                rejectUnauthorized: true,
                headers: encabezados
            },
            respuesta => {
                let texto = "";

                respuesta.on("data", fragmento => {
                    texto += fragmento;
                });

                respuesta.on("error", reject);

                respuesta.on("end", () => {
                    try {
                        resolve({
                            status: respuesta.statusCode,
                            headers: respuesta.headers,
                            datos: texto ? JSON.parse(texto) : null
                        });
                    } catch {
                        reject(new Error(
                            `Respuesta no JSON en ${ruta}, HTTP ${respuesta.statusCode}`
                        ));
                    }
                });
            }
        );

        solicitud.on("error", reject);

        solicitud.setTimeout(25000, () => {
            solicitud.destroy(new Error(`Timeout consultando ${ruta}`));
        });

        solicitud.end(contenido);
    });
}

async function iniciarSesion(usuario, password) {
    const respuesta = await pedir("/auth/login", {
        metodo: "POST",
        cuerpo: { usuario, password }
    });

    if (respuesta.status === 429) {
        throw new Error(
            "Se alcanzó el límite de login. Esperá el plazo indicado antes de repetir."
        );
    }

    assert.equal(
        respuesta.status,
        200,
        `No pudo iniciar sesión ${usuario}`
    );

    const cookie = respuesta.headers["set-cookie"]?.[0];

    assert.ok(cookie, "El login no devolvió cookie");
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Secure/i);

    const sesion = {
        cookie: cookie.split(";")[0],
        csrf: respuesta.datos.csrf
    };

    sesiones.push(sesion);

    return sesion;
}

function esperar(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// La admisión es inmediata respecto de la decisión:
// esperamos el estado definitivo consultando a Aula.
async function esperarEstado(id, esperado, sesion) {
    for (let intento = 0; intento < 50; intento++) {
        const respuesta = await pedir(`/inscripciones/${id}`, {
            sesion
        });

        assert.equal(
            respuesta.status,
            200,
            "No se pudo consultar la inscripción"
        );

        if (respuesta.datos.estado === esperado) {
            return respuesta.datos;
        }

        const segundos = Number(
            respuesta.headers["retry-after"] || 1
        );

        await esperar(Math.min(Math.max(segundos, 1), 5) * 1000);
    }

    throw new Error(
        `La reserva ${id} no llegó al estado ${esperado}`
    );
}

async function comprobarCupos(actividadId, esperados, sesion) {
    const respuesta = await pedir(`/materias/${actividadId}`, {
        sesion
    });

    assert.equal(respuesta.status, 200);
    assert.equal(respuesta.datos.cupos_disponibles, esperados);
}

async function solicitarInscripcion(actividadId, alumno, sesion) {
    const respuesta = await pedir(
        `/materias/${actividadId}/inscripciones`,
        {
            metodo: "POST",
            sesion,
            cuerpo: { alumno },
            claveIdempotencia: randomUUID()
        }
    );

    assert.equal(
        respuesta.status,
        202,
        `La inscripción no fue admitida: HTTP ${respuesta.status}`
    );

    assert.ok(
        respuesta.headers.location,
        "La admisión no devolvió Location"
    );

    return respuesta.datos.id;
}

async function ejecutar() {
    let aprobada = false;
    let motivo = "";

    try {
        ca = fs.readFileSync(
            path.join(carpetaSeguridad, "ca.crt")
        );

        const accesos = leerAccesos();

        const sinSesion = await pedir("/materias");
        assert.equal(sinSesion.status, 401);
        registrar("No se accede a materias sin sesión");

        const administrador = await iniciarSesion(
            "admin",
            accesos.admin
        );

        const alumno = await iniciarSesion(
            "alumno1",
            accesos.alumno1
        );

        registrar("Administrador y alumno se autentican por HTTPS");

        const prohibida = await pedir("/materias", {
            metodo: "POST",
            sesion: alumno,
            cuerpo: {
                nombre: "No debe crearse",
                cupo: 1
            }
        });

        assert.equal(prohibida.status, 403);
        registrar("El alumno no puede crear materias");

        const materia = await pedir("/materias", {
            metodo: "POST",
            sesion: administrador,
            cuerpo: {
                nombre: `Demo final ${Date.now()}`,
                cupo: 1
            }
        });

        assert.equal(materia.status, 201);

        const actividadId = materia.datos.id;

        await comprobarCupos(actividadId, 1, administrador);
        registrar("El administrador crea una materia de un cupo");

        const primera = await solicitarInscripcion(
            actividadId,
            "alumno-1",
            alumno
        );

        await esperarEstado(primera, "confirmada", alumno);
        await comprobarCupos(actividadId, 0, administrador);

        registrar("La primera reserva se confirma y consume el cupo");

        // El administrador puede gestionar otra inscripción del tenant.
        const segunda = await solicitarInscripcion(
            actividadId,
            "alumno-2",
            administrador
        );

        await esperarEstado(
            segunda,
            "rechazada",
            administrador
        );

        await comprobarCupos(actividadId, 0, administrador);

        registrar("La segunda reserva se rechaza sin sobreasignar");

        const cancelacion = await pedir(
            `/inscripciones/${primera}/cancelacion`,
            {
                metodo: "POST",
                sesion: alumno
            }
        );

        assert.equal(cancelacion.status, 202);

        await esperarEstado(primera, "cancelada", alumno);
        await comprobarCupos(actividadId, 1, administrador);

        registrar("El alumno cancela su reserva y se devuelve el cupo");

        const tercerIntento = await solicitarInscripcion(
            actividadId,
            "alumno-2",
            administrador
        );

        await esperarEstado(
            tercerIntento,
            "confirmada",
            administrador
        );

        await comprobarCupos(actividadId, 0, administrador);

        registrar("El lugar liberado puede asignarse a otro participante");

        aprobada = true;
    } catch (error) {
        motivo = error.message || error.code || error.name;
        console.error(`FALLO: ${motivo}`);
        process.exitCode = 1;
    } finally {
        // Intentamos cerrar las sesiones incluso si falla una comprobación.
        for (const sesion of sesiones) {
            try {
                const respuesta = await pedir("/auth/logout", {
                    metodo: "POST",
                    sesion
                });

                if (respuesta.status !== 200) {
                    console.error("Aviso: no pudo cerrarse una sesión de prueba");
                }
            } catch {
                console.error("Aviso: no pudo cerrarse una sesión de prueba");
            }
        }

        fs.mkdirSync(carpetaEvidencias, {
            recursive: true
        });

        const contenido = [
            `Fecha: ${new Date().toISOString()}`,
            `Resultado: ${aprobada ? "APROBADA" : "FALLIDA"}`,
            ...comprobaciones,
            ...(motivo ? [`Motivo: ${motivo}`] : []),
            ""
        ].join("\n");

        fs.writeFileSync(
            path.join(carpetaEvidencias, "01-recorrido.txt"),
            contenido,
            "utf8"
        );
    }

    if (aprobada) {
        console.log("Recorrido final aprobado.");
    }
}

ejecutar().catch(error => {
    console.error("No se pudo completar la prueba:", error.message);
    process.exitCode = 1;
});