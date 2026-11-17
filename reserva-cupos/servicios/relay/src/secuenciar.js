// Debe ejecutarse desde un unico relay secuenciador.
// La lectura consistente ve solo cambios confirmados. El UPDATE posterior
// se limita a esos IDs: no vuelve a recorrer el rango de secuencias NULL.
async function secuenciarConfirmados(pool, lote = 200) {
    if (!Number.isInteger(lote) || lote < 1 || lote > 1000) {
        throw new Error('Lote de secuenciacion invalido');
    }
    const conexion = await pool.getConnection();
    try {
        await conexion.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await conexion.beginTransaction();
        const [filas] = await conexion.query(
            'SELECT id FROM cambios WHERE secuencia IS NULL ORDER BY id LIMIT ?', [lote]
        );
        if (filas.length === 0) {
            await conexion.rollback();
            return 0;
        }
        const [[{ ultima }]] = await conexion.query(
            'SELECT COALESCE(MAX(secuencia), 0) AS ultima FROM cambios'
        );
        const parametros = [];
        const casos = filas.map((fila, indice) => {
            parametros.push(fila.id, (BigInt(ultima) + BigInt(indice + 1)).toString());
            return 'WHEN ? THEN ?';
        });
        parametros.push(filas.map(fila => fila.id));
        const [resultado] = await conexion.query(
            `UPDATE cambios SET secuencia = CASE id ${casos.join(' ')} END
             WHERE id IN (?) AND secuencia IS NULL`, parametros
        );
        if (resultado.affectedRows !== filas.length) {
            throw new Error('El lote cambio durante la secuenciacion; comprobar que haya un solo relay');
        }
        await conexion.commit();
        return filas.length;
    } catch (error) {
        await conexion.rollback().catch(() => {});
        throw error;
    } finally {
        conexion.release();
    }
}

module.exports = { secuenciarConfirmados };
