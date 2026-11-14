const {test}=require('node:test');
const assert=require('node:assert/strict');
const {aplicarPagina,crearRecuperacion}=require('../src/recuperacion');
function poolFalso(fallar=false){
    const sql=[];
    const cliente={query:async(q)=>{
        sql.push(q);
        if(q.startsWith('SELECT ultima')) return {rows:[{ultima_secuencia_feed:0}]};
        if(fallar && q.startsWith('INSERT INTO inscripciones')) throw new Error('disco no disponible');
        return {rowCount:1};
    },release:()=>sql.push('RELEASE')};
    return {sql,connect:async()=>cliente};
}
const reserva={id:'r1',actividad_id:'a1',participante:'ana',estado:'confirmada',version:2};
test('feed acepta saltos por tenant y confirma datos y checkpoint juntos',async()=>{
    const p=poolFalso();
    await aplicarPagina(p,[{secuencia:7,tipo:'reserva.confirmada',entidad:reserva}],0,7);
    assert.ok(p.sql.some(s=>s.includes('ultima_secuencia_feed=$1')));
    assert.equal(p.sql.at(-2),'COMMIT');
});
test('fallo de aplicación revierte y no avanza el checkpoint',async()=>{
    const p=poolFalso(true);
    await assert.rejects(aplicarPagina(p,[{secuencia:7,tipo:'reserva.confirmada',entidad:reserva}],0,7));
    assert.ok(p.sql.includes('ROLLBACK'));
    assert.equal(p.sql.some(s=>s.includes('ultima_secuencia_feed=$1')),false);
});
test('feed fuera de orden o checkpoint inválido se rechaza',async()=>{
    await assert.rejects(aplicarPagina(poolFalso(),[{secuencia:0}],0,0));
    await assert.rejects(aplicarPagina(poolFalso(),[{secuencia:7}],0,8));
});
test('sin PostgreSQL el catálogo se reconstruye desde la API',async()=>{
    const api={llamar:async()=>({status:200,cuerpo:{datos:[{secuencia:3,tipo:'actividad.creada',entidad:{id:'a1',nombre:'Materia',capacidad:2,version:1,metadata:{origen:'aula',tipo:'materia'}}}],ultima_secuencia:3}})};
    const recuperacion=crearRecuperacion({api,pool:{query:async()=>{throw new Error('PG caído');}}});
    await recuperacion.sincronizar();
    assert.equal(recuperacion.estado.modo,'degradado');
    assert.equal(recuperacion.catalogo.get('a1').nombre,'Materia');
});
