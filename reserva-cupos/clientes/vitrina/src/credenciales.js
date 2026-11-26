const fs = require("node:fs");
const path = require("node:path");
const { secretoDesdeHex } = require("../../../compartido/src/firma-webhook");

// La clave y el secreto del webhook del tenant no están en docker-compose:
// `node scripts/sistema.js demo` crea el tenant con la API de
// administración y los escribe en seguridad/local/<cliente>/, que el
// contenedor monta en solo lectura. Se leen en cada uso: el cliente puede
// arrancar antes que el tenant exista, y si el entorno se recrea toma las
// credenciales nuevas sin reiniciarse.
function crearCredenciales(directorio) {
    const leer = nombre => {
        try {
            return fs.readFileSync(path.join(directorio, nombre), "utf8").trim() || null;
        } catch {
            return null;
        }
    };

    return {
        clave: () => leer("clave-api"),

        secreto: () => {
            try {
                return secretoDesdeHex(leer("webhook-secreto"));
            } catch {
                return null;
            }
        },

        // Datos públicos del tenant (id y nombre), para mostrarlos.
        tenant: () => {
            try {
                const { id, nombre } = JSON.parse(leer("tenant.json"));
                return { id, nombre };
            } catch {
                return null;
            }
        }
    };
}

module.exports = { crearCredenciales };
