const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const https=require('node:https');
const d=path.resolve(__dirname,'../../seguridad/local');
test('TLS real: CA correcta permite conexión y CA no confiable la rechaza', {skip:!fs.existsSync(path.join(d,'ca.crt'))},async t=>{
    const servidor=https.createServer({key:fs.readFileSync(path.join(d,'aula.key')),cert:fs.readFileSync(path.join(d,'aula.crt')),minVersion:'TLSv1.2'},(req,res)=>res.end('ok'));
    servidor.listen(0,'127.0.0.1');await new Promise(r=>servidor.once('listening',r));
    t.after(()=>new Promise(r=>servidor.close(r)));
    function pedir(ca,servername='localhost') {return new Promise((resolve,reject)=>{
        const req=https.get({host:'127.0.0.1',port:servidor.address().port,servername,ca,rejectUnauthorized:true},res=>{res.resume();res.on('end',()=>resolve(res.socket?.authorized !== false));});
        req.on('error',reject);
    });}
    const ca=fs.readFileSync(path.join(d,'ca.crt'));
    await pedir(ca);
    await assert.rejects(pedir(undefined));
    await assert.rejects(pedir(ca,'otro-host.example'));
});
