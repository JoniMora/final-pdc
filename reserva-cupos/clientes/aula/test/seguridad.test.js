const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {crearSeguridad,hashPassword,verificarPassword,puedeVer}=require('../src/seguridad');

test('contraseñas: sal aleatoria, hash y rechazo de credencial incorrecta',async()=>{
    const a=await hashPassword('contraseña de prueba');
    const b=await hashPassword('contraseña de prueba');
    assert.notEqual(a,b);
    assert.equal(await verificarPassword('contraseña de prueba',a),true);
    assert.equal(await verificarPassword('incorrecta',a),false);
});

test('sesiones, CSRF y roles se comprueban por HTTP en el servidor',async t=>{
    let ahora=1000;
    const lista=[{usuario:'admin',rol:'administrador',passwordHash:await hashPassword('admin-test')},
        {usuario:'ana',rol:'alumno',participante:'ana',passwordHash:await hashPassword('alumna-test')}];
    const seguridad=crearSeguridad({secure:false,ttlMs:1000,reloj:()=>ahora,cargarUsuarios:async()=>lista});
    const app=express();app.use(express.json());seguridad.montar(app);
    app.use('/protegido',seguridad.autenticar);
    app.get('/protegido',(req,res)=>res.json(req.usuario));
    app.post('/protegido',seguridad.administrador,(req,res)=>res.json({ok:true}));
    const servidor=app.listen(0,'127.0.0.1');
    await new Promise(r=>servidor.once('listening',r));
    t.after(()=>new Promise(r=>servidor.close(r)));
    const base=`http://127.0.0.1:${servidor.address().port}`;
    const pedir=(ruta,op={})=>fetch(base+ruta,op);
    const login=async(usuario,password)=>{
        const r=await pedir('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({usuario,password})});
        return {r,cookie:r.headers.get('set-cookie')?.split(';')[0],data:await r.json()};
    };
    assert.equal((await pedir('/protegido')).status,401);
    assert.equal((await login('ana','mal')).r.status,401);
    const ana=await login('ana','alumna-test');
    assert.equal(ana.r.status,200);
    assert.match(ana.r.headers.get('set-cookie'),/HttpOnly/i);
    assert.match(ana.r.headers.get('set-cookie'),/SameSite=Strict/i);
    assert.equal(ana.data.usuario.passwordHash,undefined);
    assert.equal((await pedir('/protegido',{headers:{cookie:ana.cookie}})).status,200);
    assert.equal((await pedir('/protegido',{method:'POST',headers:{cookie:ana.cookie}})).status,403);
    assert.equal((await pedir('/protegido',{method:'POST',headers:{cookie:ana.cookie,'X-CSRF-Token':ana.data.csrf}})).status,403);
    const admin=await login('admin','admin-test');
    const headers={cookie:admin.cookie,'X-CSRF-Token':admin.data.csrf};
    assert.equal((await pedir('/protegido',{method:'POST',headers})).status,200);
    assert.equal((await pedir('/protegido',{method:'POST',headers:{...headers,origin:'https://sitio-ajeno.example'}})).status,403);
    assert.equal((await pedir('/auth/logout',{method:'POST',headers})).status,200);
    assert.equal((await pedir('/protegido',{headers})).status,401);
    ahora=2001;
    assert.equal((await pedir('/protegido',{headers:{cookie:ana.cookie}})).status,401);
});

test('autorización de reserva: un alumno solo ve su identidad; admin puede gestionar',()=>{
    assert.equal(puedeVer({rol:'alumno',participante:'ana'},{participante:'ana'}),true);
    assert.equal(puedeVer({rol:'alumno',participante:'ana'},{participante:'bea'}),false);
    assert.equal(puedeVer({rol:'administrador'},{participante:'bea'}),true);
});

test('limitación de intentos de login',async t=>{
    const app=express();app.use(express.json());
    crearSeguridad({secure:false,cargarUsuarios:async()=>[]}).montar(app);
    const servidor=app.listen(0,'127.0.0.1');await new Promise(r=>servidor.once('listening',r));
    t.after(()=>new Promise(r=>servidor.close(r)));
    const url=`http://127.0.0.1:${servidor.address().port}/auth/login`;
    for(let i=0;i<10;i++) assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"usuario":"nadie","password":"x"}'})).status,401);
    const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"usuario":"nadie","password":"x"}'});
    assert.equal(r.status,429);assert.equal(r.headers.get('retry-after'),'900');
});
