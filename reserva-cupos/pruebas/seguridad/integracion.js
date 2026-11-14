// Ejecutar sobre el compose seguro levantado. No borra volúmenes.
// Crea una materia de prueba y restaura PostgreSQL aunque una prueba falle.
const https=require('node:https');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const raiz=path.resolve(__dirname,'../..');
const dir=path.join(raiz,'seguridad/local');
const ca=fs.readFileSync(path.join(dir,'ca.crt'));
const accesos=Object.fromEntries(fs.readFileSync(path.join(dir,'accesos-locales.txt'),'utf8').split(/\r?\n/).filter(l=>/^(admin|alumno[12]): /.test(l)).map(l=>{const i=l.indexOf(': ');return[l.slice(0,i),l.slice(i+2)];}));
const evidencias=[];
function ok(m){console.log('OK: '+m);evidencias.push('OK: '+m);}
function docker(...args){return execFileSync('docker',['compose','-f','docker-compose.yml','-f','docker-compose.seguridad.yml',...args],{cwd:raiz,encoding:'utf8',stdio:['pipe','pipe','pipe']});}
function pedir(ruta,{metodo='GET',cuerpo,cookie,csrf,puerto=3001}={}){
    return new Promise((resolve,reject)=>{
        const datos=cuerpo===undefined?null:JSON.stringify(cuerpo);
        const req=https.request({hostname:'localhost',port:puerto,path:ruta,method:metodo,ca,rejectUnauthorized:true,
            headers:{...(datos?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(datos)}:{}),...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})}},res=>{
            let texto='';res.on('data',c=>texto+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data:texto?JSON.parse(texto):null}));
        });req.on('error',reject);req.setTimeout(25000,()=>req.destroy(new Error('Timeout')));req.end(datos);
    });
}
const esperar=ms=>new Promise(r=>setTimeout(r,ms));
async function hasta(fn){for(let i=0;i<50;i++){const r=await fn();if(r)return r;await esperar(2000);}throw new Error('La condición no se cumplió en 100 s');}
async function login(usuario){
    const r=await pedir('/auth/login',{metodo:'POST',cuerpo:{usuario,password:accesos[usuario]}});assert.equal(r.status,200);
    assert.match(r.headers['set-cookie'][0],/Secure/);assert.match(r.headers['set-cookie'][0],/HttpOnly/);
    return {cookie:r.headers['set-cookie'][0].split(';')[0],csrf:r.data.csrf};
}
async function main(){
    let pgDetenido=false,completa=false;
    try {
        assert.equal((await pedir('/materias')).status,401);ok('Sin sesión: 401');
        assert.equal((await pedir('/auth/login',{metodo:'POST',cuerpo:{usuario:'alumno1',password:'incorrecta'}})).status,401);ok('Contraseña inválida: 401');
        const admin=await login('admin'),alumno=await login('alumno1'),otro=await login('alumno2');
        const nombre='Entrega 5 '+Date.now();
        assert.equal((await pedir('/materias',{...alumno,metodo:'POST',cuerpo:{nombre,cupo:2}})).status,403);ok('Alumno no puede crear materias: 403');
        assert.equal((await pedir('/materias',{cookie:admin.cookie,metodo:'POST',cuerpo:{nombre,cupo:2}})).status,403);ok('Sin CSRF no se modifica estado: 403');
        const materia=await pedir('/materias',{...admin,metodo:'POST',cuerpo:{nombre,cupo:2}});assert.equal(materia.status,201);
        const id=materia.data.id;
        assert.equal((await pedir(`/materias/${id}/inscripciones`,{...alumno,metodo:'POST',cuerpo:{alumno:'alumno-2'}})).status,403);ok('No se puede suplantar alumno en el cuerpo: 403');
        const ins=await pedir(`/materias/${id}/inscripciones`,{...alumno,metodo:'POST',cuerpo:{alumno:'alumno-1'}});assert.equal(ins.status,202);
        const reserva=ins.data.id;
        await hasta(async()=>{const r=await pedir('/inscripciones/'+reserva,alumno);return r.data?.estado==='confirmada';});
        assert.equal((await pedir('/inscripciones/'+reserva,otro)).status,404);
        assert.equal((await pedir('/inscripciones/'+reserva+'/cancelacion',{...otro,metodo:'POST'})).status,404);ok('Otro alumno no puede consultar ni cancelar reserva ajena');
        const detalle=await pedir('/materias/'+id,otro);assert.equal(detalle.data.inscriptos.length,0);ok('Listado de alumno no revela inscripciones ajenas');
        // Retira la proyección local de esta actividad para verificar que el
        // feed realmente reconstruye, sin borrar datos de otras actividades.
        docker('exec','-T','aula-db','psql','-U','aula_admin','-d','aula','-v','ON_ERROR_STOP=1','-c',`DELETE FROM materias WHERE actividad_id='${id}'; UPDATE punto_control SET ultima_secuencia_feed=0 WHERE id=1;`);
        await pedir('/reconciliacion',{...admin,metodo:'POST'});
        await hasta(async()=>{const r=await pedir('/materias',admin);return r.data.some(m=>m.actividad_id===id);});ok('Feed reconstruye materia local perdida');
        docker('stop','aula-db');pgDetenido=true;
        const catalogo=await pedir('/materias',alumno);assert.equal(catalogo.status,200);assert.ok(catalogo.data.some(m=>m.actividad_id===id));ok('Catálogo disponible con PostgreSQL detenido');
        assert.equal((await pedir('/auth/me',alumno)).status,200);ok('Sesión sigue válida sin PostgreSQL');
        const ins2=await pedir(`/materias/${id}/inscripciones`,{...otro,metodo:'POST',cuerpo:{alumno:'alumno-2'}});assert.equal(ins2.status,202);
        await hasta(async()=>{const r=await pedir('/inscripciones/'+ins2.data.id,otro);return r.data?.estado==='confirmada';});ok('Se admite y decide reserva durante caída de PostgreSQL');
        docker('start','aula-db');pgDetenido=false;
        await hasta(async()=>{const r=await pedir('/reconciliacion',{...admin,metodo:'POST'});return r.data.modo==='normal';});
        const consulta=docker('exec','-T','aula-db','psql','-U','aula_admin','-d','aula','-At','-c',`SELECT estado FROM inscripciones WHERE reserva_id='${ins2.data.id}';`);assert.match(consulta,/confirmada/);ok('Reconciliación recupera inscripción de la caída');
        // TLS: prueba positiva y negativa a nivel de cada protocolo.
        const health=await pedir('/health',{puerto:3000});assert.equal(health.status,200);
        ok('HTTPS Aula y API validan CA e identidad (sin omitir verificación)');
        const ssl=docker('exec','-T','mysql-primary','mysql','-h','127.0.0.1','--ssl-mode=VERIFY_IDENTITY','--ssl-ca=/tls/ca.crt','-uroot','-proot_local_2026','-e',"SHOW SESSION STATUS LIKE 'Ssl_cipher';");assert.match(ssl,/Ssl_cipher\s+\S+/);ok('MySQL acepta conexión TLS verificada');
        assert.throws(()=>docker('exec','-T','mysql-primary','mysql','-h','127.0.0.1','--ssl-mode=DISABLED','-uroot','-proot_local_2026','-e','SELECT 1'));ok('MySQL rechaza conexión TCP sin TLS');
        const pgssl=docker('exec','-T','aula-db','psql','postgresql://aula_app:aula_local_2026@aula-db/aula?sslmode=verify-full&sslrootcert=/tls/ca.crt','-At','-c','SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid();');assert.match(pgssl,/t/);ok('PostgreSQL utiliza TLS verificado');
        assert.throws(()=>docker('exec','-T','aula-db','psql','postgresql://aula_app:aula_local_2026@aula-db/aula?sslmode=disable','-c','SELECT 1'));ok('PostgreSQL rechaza red sin TLS');
        const listeners=docker('exec','-T','rabbitmq','rabbitmq-diagnostics','listeners');assert.match(listeners,/5671/);assert.doesNotMatch(listeners,/port: 5672,/);ok('RabbitMQ solo expone AMQPS para mensajes');
        const replica=docker('exec','-T','mysql-replica','mysql','-uroot','-proot_local_2026','--vertical','-e','SHOW REPLICA STATUS');assert.match(replica,/Source_SSL_Allowed:\s+Yes/);assert.match(replica,/Source_SSL_Verify_Server_Cert:\s+Yes/);assert.match(replica,/Replica_IO_Running:\s+Yes/);assert.match(replica,/Replica_SQL_Running:\s+Yes/);ok('Replicación activa con TLS y verificación de certificado');
        assert.equal((await pedir('/auth/logout',{...alumno,metodo:'POST'})).status,200);
        assert.equal((await pedir('/auth/me',alumno)).status,401);ok('Logout invalida sesión');
        completa=true;
    } finally {
        if(pgDetenido) docker('start','aula-db');
        const salida=path.join(raiz,'../docs/entrega-5/evidencias');fs.mkdirSync(salida,{recursive:true});
        fs.writeFileSync(path.join(salida,'integracion.txt'),new Date().toISOString()+'\nResultado: '+(completa?'APROBADA':'INCOMPLETA O FALLIDA')+'\n'+evidencias.join('\n')+'\n');
    }
}
main().then(()=>console.log('Todas las pruebas de integración finalizaron correctamente.')).catch(e=>{console.error('FALLO:',e.message || e.code || e.name, e.errors?.map(x=>x.code+': '+x.address+':'+x.port).join('; ') || '');process.exitCode=1;});


