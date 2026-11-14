const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const https=require('node:https');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {fork}=require('node:child_process');
const {hashPassword}=require('../src/seguridad');
const raiz=path.resolve(__dirname,'../../..');
const tls=path.join(raiz,'seguridad/local');

test('backend real Aula: login, propiedad de reservas, CSRF y rol (API simulada)',{skip:!fs.existsSync(path.join(tls,'ca.crt'))},async t=>{
    const actividad={id:'019a0000-0000-7000-8000-000000000001',nombre:'Prueba',capacidad:2,cupos_disponibles:1,estado:'abierta',version:1,metadata:{origen:'aula',tipo:'materia'},creado_en:new Date().toISOString()};
    const reserva={id:'019a0000-0000-7000-8000-000000000002',actividad_id:actividad.id,participante:'alumno-1',estado:'confirmada',version:2,metadata:null,creado_en:new Date().toISOString()};
    let cancelaciones=0;
    const mock=http.createServer((req,res)=>{
        res.setHeader('Content-Type','application/json');
        if(req.url.startsWith('/v1/cambios')) return res.end(JSON.stringify({datos:[],ultima_secuencia:0}));
        if(req.url.endsWith('/cancelacion')) {cancelaciones++;res.statusCode=202;return res.end(JSON.stringify(reserva));}
        if(req.url.startsWith('/v1/reservas/')) return res.end(JSON.stringify(reserva));
        if(req.url.includes('/reservas')) return res.end(JSON.stringify({datos:[reserva],siguiente_cursor:null}));
        if(req.url.startsWith('/v1/actividades/')) return res.end(JSON.stringify(actividad));
        res.end('{}');
    });
    await new Promise(r=>mock.listen(0,'127.0.0.1',r));
    t.after(()=>new Promise(r=>mock.close(r)));
    const carpeta=fs.mkdtempSync(path.join(os.tmpdir(),'aula-seguridad-'));
    const usuarios=[];
    for(const [usuario,rol,participante] of [['admin','administrador',null],['uno','alumno','alumno-1'],['dos','alumno','alumno-2']]) usuarios.push({usuario,rol,participante,passwordHash:await hashPassword('test-password')});
    const archivo=path.join(carpeta,'usuarios.json');fs.writeFileSync(archivo,JSON.stringify(usuarios));
    // Elegimos un puerto libre para el proceso real del backend.
    const temporal=http.createServer();await new Promise(r=>temporal.listen(0,'127.0.0.1',r));const puerto=temporal.address().port;await new Promise(r=>temporal.close(r));
    const hijo=fork(path.resolve(__dirname,'../src/server.js'),[],{silent:true,env:{...process.env,PORT:String(puerto),API_URL:`http://127.0.0.1:${mock.address().port}`,API_KEY:'prueba',WEBHOOK_SECRET:'a'.repeat(64),USUARIOS_ARCHIVO:archivo,COOKIE_SECURE:'true',PGHOST:'127.0.0.1',PGPORT:'1',PGDATABASE:'sin-base',PGUSER:'x',PGPASSWORD:'x',PGSSLROOTCERT:'',TLS_CERT:path.join(tls,'aula.crt'),TLS_KEY:path.join(tls,'aula.key')}});
    t.after(()=>{hijo.kill();fs.rmSync(archivo);fs.rmdirSync(carpeta);});
    await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('No inició el backend de Aula')),15000);
        hijo.stdout.on('data',b=>{if(b.toString().includes('Pagina disponible')){clearTimeout(timer);resolve();}});
        hijo.once('exit',code=>{clearTimeout(timer);reject(new Error('Backend terminó '+code));});
    });
    const ca=fs.readFileSync(path.join(tls,'ca.crt'));
    function pedir(ruta,{metodo='GET',cuerpo,cookie,csrf}={}){return new Promise((resolve,reject)=>{
        const datos=cuerpo?JSON.stringify(cuerpo):null;
        const req=https.request({hostname:'localhost',port:puerto,path:ruta,method:metodo,ca,headers:{...(datos?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(datos)}:{}),...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})}},res=>{let s='';res.on('data',b=>s+=b);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data:s?JSON.parse(s):null}));});req.on('error',reject);req.end(datos);
    });}
    async function login(usuario){const r=await pedir('/auth/login',{metodo:'POST',cuerpo:{usuario,password:'test-password'}});assert.equal(r.status,200);return{cookie:r.headers['set-cookie'][0].split(';')[0],csrf:r.data.csrf};}
    assert.equal((await pedir('/materias')).status,401);
    const uno=await login('uno'),dos=await login('dos');
    assert.equal((await pedir('/materias',{...uno,metodo:'POST',cuerpo:{nombre:'x',cupo:1}})).status,403);
    assert.equal((await pedir(`/materias/${actividad.id}/inscripciones`,{...uno,metodo:'POST',cuerpo:{alumno:'alumno-2'}})).status,403);
    assert.equal((await pedir('/inscripciones/'+reserva.id,uno)).status,200);
    assert.equal((await pedir('/inscripciones/'+reserva.id,dos)).status,404);
    assert.equal((await pedir('/inscripciones/'+reserva.id+'/cancelacion',{...dos,metodo:'POST'})).status,404);
    assert.equal(cancelaciones,0);
    const detalle=await pedir('/materias/'+actividad.id,dos);assert.equal(detalle.status,200);assert.deepEqual(detalle.data.inscriptos,[]);
    assert.equal((await pedir('/inscripciones/'+reserva.id+'/cancelacion',{...uno,metodo:'POST'})).status,202);
    assert.equal(cancelaciones,1);
});
