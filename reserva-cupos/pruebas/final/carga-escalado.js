const { spawnSync } = require("node:child_process");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const raiz = path.resolve(__dirname, "../..");

const argumentosCompose = [
    "compose",
    "-f", "docker-compose.yml",
    "-f", "docker-compose.seguridad.yml"
];

const registros = [];
let claveApi = "";

function ocultarSecretos(texto) {
    return claveApi
        ? texto.replaceAll(claveApi, "[CLAVE OCULTA]")
        : texto;
}

function informar(texto) {
    console.log(texto);
    registros.push(texto);
}

function docker(argumentos, { mostrar = true, entorno = {} } = {}) {
    const resultado = spawnSync(
        "docker",
        [...argumentosCompose, ...argumentos],
        {
            cwd: raiz,
            encoding: "utf8",
            env: {
                ...process.env,
                ...entorno
            },
            timeout: 240000,
            maxBuffer: 32 * 1024 * 1024
        }
    );

    const salida = ocultarSecretos(
        (resultado.stdout || "") + (resultado.stderr || "")
    );

    if (mostrar && salida.trim()) {
        informar(salida.trim());
    }

    if (resultado.error) {
        throw new Error(
            `No pudo ejecutarse Docker: ${resultado.error.message}`
        );
    }

    if (resultado.status !== 0) {
        if (!mostrar) {
            const diagnostico = (
                (resultado.stdout || "") +
                (resultado.stderr || "")
            )
                .replace(/\brc_[a-f0-9]{64}\b/gi, "[CLAVE OCULTA]")
                .replace(/\b[a-f0-9]{64}\b/gi, "[SECRETO OCULTO]");

            console.error(
                diagnostico.trim() || "Docker no devolvió detalles."
            );
        }

        throw new Error(
            `Docker terminó con código ${resultado.status}. ` +
            (mostrar
                ? "Revisá la salida anterior."
                : "Falló una consulta de preparación.")
        );
    }

    return resultado.stdout || "";
}

function contenedores(servicio) {
    return docker(
        ["ps", "--status", "running", "-q", servicio],
        { mostrar: false }
    )
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
}

function escalar(apis, workers) {
    informar(`Configurando ${apis} API y ${workers} worker(s)...`);

    docker([
        "up",
        "-d",
        "--no-build",
        "--wait",
        "--wait-timeout", "180",
        "--scale", `api=${apis}`,
        "--scale", `worker=${workers}`,
        "api",
        "worker"
    ]);
}

function esperar(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function consultarGateway(ca) {
    return new Promise((resolve, reject) => {
        const solicitud = https.get(
            {
                hostname: "localhost",
                port: 3000,
                path: "/health",
                ca,
                rejectUnauthorized: true,
                agent: false
            },
            respuesta => {
                let texto = "";

                respuesta.on("data", fragmento => {
                    texto += fragmento;
                });

                respuesta.on("error", reject);

                respuesta.on("end", () => {
                    try {
                        assert.equal(respuesta.statusCode, 200);
                        resolve(JSON.parse(texto));
                    } catch (error) {
                        reject(error);
                    }
                });
            }
        );

        solicitud.on("error", reject);

        solicitud.setTimeout(5000, () => {
            solicitud.destroy(new Error("Timeout consultando Traefik"));
        });
    });
}

// Comprueba las instancias que realmente responden detrás del gateway.
async function comprobarBalanceo(ca) {
    const esperadas = new Set(
        contenedores("api").map(id => id.slice(0, 12))
    );

    assert.equal(esperadas.size, 3);

    const vistas = new Set();

    for (let intento = 0; intento < 90; intento++) {
        try {
            const respuesta = await consultarGateway(ca);

            assert.equal(
                respuesta.mysql,
                "conectado",
                "La API no tiene conexión con MySQL"
            );

            if (esperadas.has(respuesta.instancia)) {
                vistas.add(respuesta.instancia);
            }

            if (vistas.size === 3) {
                informar(
                    "OK: Traefik respondió desde las tres API: "
                    + [...vistas].join(", ")
                );

                return;
            }
        } catch {
            // Traefik puede estar actualizando los destinos.
        }

        await esperar(500);
    }

    throw new Error(
        `Traefik alcanzó ${vistas.size} de las tres API esperadas`
    );
}

function crearTenant() {
    const archivoSql = path.join(
        raiz,
        "Infraestructura/mysql/primary/crear-tenant.sql"
    );

    const contenido = fs.readFileSync(archivoSql, "utf8")
        .replace(/^\uFEFF/, "");

    const entrada = [
        `SET @nombre = 'Final ${Date.now()}';`,
        contenido,
        ""
    ].join("\n");

    const resultado = spawnSync(
        "docker",
        [
            ...argumentosCompose,
            "exec",
            "-T",
            "mysql-primary",
            "mysql",
            "-uroot",
            "-proot_local_2026",
            "-N",
            "-B",
            "reservas"
        ],
        {
            cwd: raiz,
            encoding: "utf8",
            input: entrada,
            timeout: 60000,
            maxBuffer: 1024 * 1024
        }
    );

    if (resultado.error) {
        throw new Error(
            `No pudo ejecutarse el alta: ${resultado.error.message}`
        );
    }

    if (resultado.status !== 0) {
        const diagnostico = (
            (resultado.stdout || "") +
            (resultado.stderr || "")
        )
            .replace(/\brc_[a-f0-9]{64}\b/gi, "[CLAVE OCULTA]")
            .replace(/\b[a-f0-9]{64}\b/gi, "[SECRETO OCULTO]");

        console.error(diagnostico);

        throw new Error(
            `El alta del tenant terminó con código ${resultado.status}`
        );
    }

    const encontrada = (resultado.stdout || "")
        .match(/\brc_[a-f0-9]{64}\b/i);

    assert.ok(
        encontrada,
        "El alta no devolvió una clave reconocible"
    );

    claveApi = encontrada[0];

    informar("OK: tenant de prueba creado; clave oculta");
}

function ejecutarRafaga(nombre) {
    informar(`INICIO: ${nombre}`);

    docker(
        [
            "run",
            "--rm",
            "--no-deps",
            "-T",
            "-e",
            "API_KEY",
            "-e",
            "SOLICITUDES=500",
            "-e",
            "CAPACIDAD=10",
            "k6",
            "run",
            "-q",
            "/pruebas/carga/rafaga.js"
        ],
        {
            entorno: {
                API_KEY: claveApi
            }
        }
    );

    informar(`OK: ${nombre}; controles de k6 aprobados`);
}

async function ejecutar() {
    let aprobada = false;
    let motivo = "";
    let restaurar = false;
    let originales;

    try {
        const ca = fs.readFileSync(
            path.join(raiz, "seguridad/local/ca.crt")
        );

        originales = {
            api: contenedores("api").length,
            worker: contenedores("worker").length
        };

        assert.ok(
            originales.api >= 1 && originales.worker >= 1,
            "Primero debe estar levantado el entorno seguro"
        );

        informar(
            `Configuración inicial: ${originales.api} API y `
            + `${originales.worker} worker(s)`
        );

        crearTenant();

        restaurar = true;

        escalar(1, 1);

        assert.equal(contenedores("api").length, 1);
        assert.equal(contenedores("worker").length, 1);

        ejecutarRafaga("Escenario base: 1 API y 1 worker");

        escalar(3, 2);

        assert.equal(contenedores("api").length, 3);
        assert.equal(contenedores("worker").length, 2);

        await comprobarBalanceo(ca);

        ejecutarRafaga("Escenario escalado: 3 API y 2 workers");

        aprobada = true;
    } catch (error) {
        motivo = error.message || error.code || error.name;
        informar(`FALLO: ${motivo}`);
        process.exitCode = 1;
    } finally {
        if (restaurar) {
            try {
                informar("Restaurando la configuración inicial");

                escalar(
                    originales.api,
                    originales.worker
                );

                assert.equal(
                    contenedores("api").length,
                    originales.api
                );

                assert.equal(
                    contenedores("worker").length,
                    originales.worker
                );

                informar("OK: configuración inicial restaurada");
            } catch (error) {
                aprobada = false;
                motivo += ` Restauración pendiente: ${error.message}`;
                informar(`FALLO: ${error.message}`);
                process.exitCode = 1;
            }
        }

        const carpetaEvidencias = path.resolve(
            raiz,
            "../docs/entrega-6/evidencias"
        );

        fs.mkdirSync(carpetaEvidencias, {
            recursive: true
        });

        fs.writeFileSync(
            path.join(carpetaEvidencias, "02-carga-escalado.txt"),
            [
                `Fecha: ${new Date().toISOString()}`,
                `Resultado: ${aprobada ? "APROBADA" : "FALLIDA"}`,
                ...registros,
                ...(motivo ? [`Motivo: ${motivo}`] : []),
                ""
            ].join("\n"),
            "utf8"
        );
    }

    if (aprobada) {
        console.log("Carga y escalado aprobados.");
    }
}

ejecutar().catch(error => {
    console.error("No se pudo completar la prueba:", error.message);
    process.exitCode = 1;
});