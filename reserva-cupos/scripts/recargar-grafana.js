// Recarga la provision y verifica los paneles usando la API oficial de Grafana.
// Credenciales solo en variables temporales: nunca se guardan ni se imprimen.
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

const raiz = path.resolve(__dirname, "..");
const archivo = path.join(raiz, "Infraestructura/grafana/dashboards/reserva-cupos.json");
const local = JSON.parse(fs.readFileSync(archivo, "utf8"));
const ca = fs.readFileSync(path.join(raiz, "seguridad/local/ca.crt"));

function pedir(metodo, ruta, usuario, password) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: "localhost",
            port: 3002,
            path: ruta,
            method: metodo,
            ca,
            rejectUnauthorized: true,
            auth: `${usuario}:${password}`,
            headers: { Accept: "application/json", "Cache-Control": "no-cache" }
        }, res => {
            let texto = "";
            res.setEncoding("utf8");
            res.on("data", parte => { texto += parte; });
            res.on("error", reject);
            res.on("end", () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    const ayuda = res.statusCode === 401
                        ? "Revisar usuario y contrasena de Grafana."
                        : res.statusCode === 403
                            ? "Se necesita el administrador del servidor Grafana."
                            : "Revisar los logs de provision de Grafana.";
                    reject(new Error(`Grafana respondio HTTP ${res.statusCode}. ${ayuda}`));
                    return;
                }
                try { resolve(texto ? JSON.parse(texto) : {}); }
                catch { reject(new Error("Grafana no devolvio JSON valido")); }
            });
        });
        req.on("error", reject);
        req.setTimeout(30000, () => req.destroy(new Error("Timeout consultando Grafana")));
        req.end();
    });
}

async function main() {
    const usuario = process.env.PDC_GRAFANA_USUARIO;
    const password = process.env.PDC_GRAFANA_PASSWORD;
    if (!usuario || !password) {
        throw new Error("Faltan credenciales temporales PDC_GRAFANA_USUARIO y PDC_GRAFANA_PASSWORD");
    }
    const respuesta = await pedir("POST", "/api/admin/provisioning/dashboards/reload", usuario, password);
    console.log("Recarga de provision:", respuesta.message || "OK");
    const esperados = local.panels.map(panel => panel.id);
    let paneles = [];
    for (let intento = 0; intento < 10; intento++) {
        const guardado = await pedir("GET", `/api/dashboards/uid/${encodeURIComponent(local.uid)}?verificar=${Date.now()}`, usuario, password);
        paneles = guardado.dashboard?.panels || [];
        if (esperados.every(id => paneles.some(panel => panel.id === id))) {
            console.table(paneles.map(panel => ({ id: panel.id, titulo: panel.title })));
            console.log("OK: Grafana guardo todos los paneles del archivo local, incluido Traefik.");
            console.log("Abrir: https://localhost:3002/d/reserva-cupos-e6?viewPanel=panel-8");
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error(`La recarga no actualizo todos los paneles. Local: ${esperados.join(", ")}; Grafana: ${paneles.map(p => p.id).join(", ")}`);
}

main().catch(error => {
    console.error("FALLO:", error.message);
    process.exitCode = 1;
});
