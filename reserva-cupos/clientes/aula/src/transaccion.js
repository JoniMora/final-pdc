// Transacción sobre una conexión tomada del pool de PostgreSQL.
//
// Una conexión tomada con pool.connect() deja de estar cubierta por
// pool.on("error"): si aula-db cae mientras está en uso, la conexión emite
// "error" y, sin un manejador propio, el proceso de Aula termina (y con él,
// las sesiones abiertas). Lo encontró la matriz de fallos (escenario +1).
// Acá el error se registra, la operación falla con él y la conexión se
// descarta en lugar de volver al pool.
async function enTransaccion(pool, fn) {
    const cliente = await pool.connect();
    let rota = false;

    const alPerderConexion = error => {
        rota = true;
        console.error("[AULA] PostgreSQL, conexión perdida:", error.message);
    };

    cliente.on("error", alPerderConexion);

    try {
        await cliente.query("BEGIN");
        const resultado = await fn(cliente);
        await cliente.query("COMMIT");
        return resultado;
    } catch (error) {
        rota = true;
        await cliente.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        cliente.removeListener("error", alPerderConexion);
        // release(true) destruye la conexión: una que falló no se reutiliza.
        cliente.release(rota);
    }
}

module.exports = { enTransaccion };
