const test = require("node:test");
const assert = require("node:assert/strict");
const { aplicarPagina, crearRecuperacion } = require("../src/recuperacion");

// Pool de PostgreSQL simulado que registra cada sentencia. Con fallar, la
// inserción de la inscripción falla a mitad de la transacción.
function poolFalso({ fallar = false, cursor = 0 } = {}) {
    const sentencias = [];
    const cliente = {
        query: async sql => {
            sentencias.push(sql);

            if (sql.startsWith("SELECT ultima_secuencia_feed")) return { rows: [{ ultima_secuencia_feed: cursor }] };
            if (fallar && sql.includes("INSERT INTO inscripciones")) throw new Error("disco no disponible");

            return { rowCount: 1 };
        },
        release: () => sentencias.push("RELEASE")
    };

    return { sentencias, connect: async () => cliente, query: cliente.query };
}

const reserva = {
    id: "019a0000-0000-7000-8000-000000000002",
    actividad_id: "019a0000-0000-7000-8000-000000000001",
    participante: "ana",
    estado: "confirmada",
    version: 2
};
const pagina = [{ secuencia: 7, tipo: "reserva.confirmada", entidad: reserva }];

test("el feed admite saltos de secuencia y confirma datos y punto de control juntos", async () => {
    const pool = poolFalso();

    assert.equal(await aplicarPagina(pool, pagina, 0, 7), true);
    assert.ok(pool.sentencias.some(sql => sql.includes("SET ultima_secuencia_feed = $1")));
    assert.equal(pool.sentencias.at(-2), "COMMIT");
});

test("si falla la aplicación, se revierte y el punto de control no avanza", async () => {
    const pool = poolFalso({ fallar: true });

    await assert.rejects(aplicarPagina(pool, pagina, 0, 7));
    assert.ok(pool.sentencias.includes("ROLLBACK"));
    assert.equal(pool.sentencias.some(sql => sql.includes("SET ultima_secuencia_feed = $1")), false);
});

test("si otro proceso ya movió el punto de control, la página no se aplica", async () => {
    const pool = poolFalso({ cursor: 3 });

    assert.equal(await aplicarPagina(pool, pagina, 0, 7), false);
    assert.equal(pool.sentencias.some(sql => sql.includes("INSERT INTO inscripciones")), false);
});

test("un feed fuera de orden o un punto de control inválido se rechazan", async () => {
    await assert.rejects(aplicarPagina(poolFalso(), [{ secuencia: 0 }], 0, 0));
    await assert.rejects(aplicarPagina(poolFalso(), [{ secuencia: 7 }], 0, 8));
});

test("sin PostgreSQL queda en modo degradado y el catálogo se arma desde la API", async () => {
    const api = {
        llamar: async () => ({
            status: 200,
            cuerpo: {
                datos: [{
                    secuencia: 3,
                    tipo: "actividad.creada",
                    entidad: {
                        id: "a1",
                        nombre: "Materia",
                        capacidad: 2,
                        version: 1,
                        creado_en: "2026-11-14T12:00:00.000Z",
                        metadata: { origen: "aula", tipo: "materia" }
                    }
                }],
                ultima_secuencia: 3
            }
        })
    };
    const recuperacion = crearRecuperacion({
        api,
        pool: { query: async () => { throw new Error("PostgreSQL detenido"); } }
    });

    await recuperacion.sincronizar();
    assert.equal(recuperacion.estado.modo, "degradado");

    await recuperacion.actualizarCatalogo();
    assert.equal(recuperacion.catalogo.get("a1").nombre, "Materia");
});

test("pedidos simultáneos del catálogo comparten una sola lectura del feed", async () => {
    let lecturas = 0;
    const api = {
        llamar: async () => {
            lecturas++;
            await new Promise(resolve => setTimeout(resolve, 20));
            return { status: 200, cuerpo: { datos: [], ultima_secuencia: 0 } };
        }
    };
    const recuperacion = crearRecuperacion({ api, pool: poolFalso() });

    await Promise.all([recuperacion.actualizarCatalogo(), recuperacion.actualizarCatalogo(), recuperacion.actualizarCatalogo()]);
    assert.equal(lecturas, 1);
});
