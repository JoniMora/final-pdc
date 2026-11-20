const test = require('node:test');
const assert = require('node:assert/strict');
const { secuenciarConfirmados } = require('../src/secuenciar');

function entorno(filas, { falloCommit = false, afectadas = filas.length } = {}) {
    const operaciones = [];
    let actualizacion;
    const conexion = {
        async query(sql, parametros) {
            if (sql.startsWith('SELECT id')) return [filas];
            if (sql.startsWith('SELECT COALESCE')) return [[{ ultima: 40 }]];
            if (sql.startsWith('UPDATE')) {
                actualizacion = { sql, parametros };
                return [{ affectedRows: afectadas }];
            }
            return [{}];
        },
        async beginTransaction() { operaciones.push('inicio'); },
        async commit() {
            operaciones.push('commit');
            if (falloCommit) throw new Error('commit fallido');
        },
        async rollback() { operaciones.push('rollback'); },
        release() { operaciones.push('liberada'); }
    };
    return { pool: { async getConnection() { return conexion; } }, operaciones,
        get actualizacion() { return actualizacion; } };
}

test('sin cambios no emite UPDATE ni COMMIT', async () => {
    const e = entorno([]);
    assert.equal(await secuenciarConfirmados(e.pool), 0);
    assert.equal(e.actualizacion, undefined);
    assert.deepEqual(e.operaciones, ['inicio', 'rollback', 'liberada']);
});

test('secuencia solo IDs confirmados del lote, incluso con huecos', async () => {
    // El ID 12 no es visible al seleccionar: no debe incluirse por rango.
    const e = entorno([{ id: 11 }, { id: 13 }]);
    assert.equal(await secuenciarConfirmados(e.pool), 2);
    assert.deepEqual(e.actualizacion.parametros, [11, '41', 13, '42', [11, 13]]);
    assert.match(e.actualizacion.sql, /WHERE id IN \(\?\) AND secuencia IS NULL/);
    assert.deepEqual(e.operaciones, ['inicio', 'commit', 'liberada']);
});

test('un commit fallido no se informa como lote secuenciado', async () => {
    const e = entorno([{ id: 11 }], { falloCommit: true });
    await assert.rejects(secuenciarConfirmados(e.pool), /commit fallido/);
    assert.deepEqual(e.operaciones, ['inicio', 'commit', 'rollback', 'liberada']);
});

test('si el lote cambia se revierte, sin confirmar una secuencia parcial', async () => {
    const e = entorno([{ id: 11 }, { id: 13 }], { afectadas: 1 });
    await assert.rejects(secuenciarConfirmados(e.pool), /lote cambio/);
    assert.deepEqual(e.operaciones, ['inicio', 'rollback', 'liberada']);
});
