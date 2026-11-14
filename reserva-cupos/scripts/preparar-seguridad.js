const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {randomBytes}=require('node:crypto');
const {hashPassword}=require('../clientes/aula/src/seguridad');
const raiz=path.resolve(__dirname,'..');
const dir=path.join(raiz,'seguridad','local');
const candidatos=[process.env.OPENSSL,'C:/Program Files/Git/mingw64/bin/openssl.exe','openssl','C:\\Program Files\\Git\\usr\\bin\\openssl.exe'].filter(Boolean);
const openssl=candidatos.find(p=>{try{execFileSync(p,['version'],{stdio:'ignore'});return true;}catch{return false;}});
if(!openssl) throw new Error('Se necesita OpenSSL. En Windows puede utilizarse el incluido con Git; también puede indicar OPENSSL.');
fs.mkdirSync(dir,{recursive:true});
function ejecutar(args){execFileSync(openssl,args,{cwd:dir,stdio:'pipe'});}
function certificado(nombre){
    if(fs.existsSync(path.join(dir,nombre+'.crt'))) return;
    ejecutar(['req','-new','-newkey','rsa:2048','-nodes','-keyout',nombre+'.key','-out',nombre+'.csr','-subj','/CN='+nombre]);
    fs.writeFileSync(path.join(dir,nombre+'.ext'),`subjectAltName=DNS:${nombre},DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n`);
    ejecutar(['x509','-req','-in',nombre+'.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial','-out',nombre+'.crt','-days','365','-sha256','-extfile',nombre+'.ext']);
    fs.unlinkSync(path.join(dir,nombre+'.csr'));fs.unlinkSync(path.join(dir,nombre+'.ext'));
}
async function main(){
    if(!fs.existsSync(path.join(dir,'ca.crt'))){
        ejecutar(['req','-x509','-newkey','rsa:3072','-nodes','-keyout','ca.key','-out','ca.crt','-days','365','-sha256','-subj','/CN=Reserva Cupos desarrollo local','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign']);
    }
    for(const nombre of ['traefik','api','aula','mysql-primary','mysql-replica','aula-db','rabbitmq']) certificado(nombre);
    if(!fs.existsSync(path.join(dir,'usuarios.json'))){
        const usuarios=[],accesos=[];
        for(const [usuario,rol,participante] of [['admin','administrador',null],['alumno1','alumno','alumno-1'],['alumno2','alumno','alumno-2']]){
            const password=randomBytes(18).toString('base64url');
            usuarios.push({usuario,rol,participante,activo:true,passwordHash:await hashPassword(password)});
            accesos.push(`${usuario}: ${password}`);
        }
        fs.writeFileSync(path.join(dir,'usuarios.json'),JSON.stringify(usuarios,null,2),{mode:0o600});
        fs.writeFileSync(path.join(dir,'accesos-locales.txt'),'Credenciales SOLO para desarrollo. No subir ni incluir en evidencias.\n'+accesos.join('\n')+'\n',{mode:0o600});
    }
    // Archivos montados a servicios sin root; el acceso del host se protege
    // con permisos del directorio. La clave CA nunca se monta en contenedores.
    for(const nombre of fs.readdirSync(dir)) if(nombre!=='ca.key' && !nombre.endsWith('.txt')) fs.chmodSync(path.join(dir,nombre),0o644);
    console.log('Certificados y usuarios locales preparados sin reemplazar los existentes.');
    console.log('Accesos: '+path.join(dir,'accesos-locales.txt'));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

