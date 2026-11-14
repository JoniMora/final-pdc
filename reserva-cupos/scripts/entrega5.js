// Comandos portables, sin cambiar políticas de PowerShell ni borrar volúmenes.
const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const raiz=path.resolve(__dirname,'..');
const compose=['compose','-f','docker-compose.yml','-f','docker-compose.seguridad.yml'];
function docker(args,op={}) {
    return execFileSync('docker',[...compose,...args],{cwd:raiz,encoding:'utf8',stdio:op.capturar?['pipe','pipe','pipe']:'inherit',...op});
}
function sql(servicio,consulta){return docker(['exec','-T',servicio,'mysql','-uroot','-proot_local_2026','-e',consulta]);}
function migrar(){
    docker(['exec','-T','aula-db','psql','-U','aula_admin','-d','aula','-v','ON_ERROR_STOP=1'],{
        stdio:['pipe','inherit','inherit'],input:fs.readFileSync(path.join(raiz,'Infraestructura/postgres/entrega5.sql'),'utf8')});
    const estado=docker(['exec','-T','mysql-replica','mysql','-uroot','-proot_local_2026','-N','-e','SHOW REPLICA STATUS'],{capturar:true});
    if(!estado.trim()) docker(['exec','-T','mysql-replica','sh','-c','mysql -uroot -proot_local_2026 < /configurar-replica.sql']);
    docker(['exec','-T','mysql-replica','sh','-c','mysql -uroot -proot_local_2026 < /activar-tls.sql']);
    sql('mysql-primary',"UPDATE reservas.tenants SET webhook_url='https://aula:3001/webhooks/reservas' WHERE id='01a1542d-7ee2-7d8b-b3b3-40474b8dec7e';");
    // Descarta la caché de la URL HTTP que pudo cargar durante la transición.
    docker(['restart','notificador']);
}
try {
    switch(process.argv[2] || 'estado'){
        case 'preparar':execFileSync(process.execPath,[path.join(__dirname,'preparar-seguridad.js')],{stdio:'inherit'});break;
        case 'levantar':docker(['up','--build','-d','--wait','--wait-timeout','180']);break;
        case 'migrar':migrar();break;
        case 'estado':docker(['ps','-a']);break;
        case 'pruebas':execFileSync(process.execPath,[path.join(raiz,'pruebas/seguridad/integracion.js')],{cwd:raiz,stdio:'inherit'});break;
        case 'detener':docker(['stop']);break;
        default:throw new Error('Acciones: preparar, levantar, migrar, estado, pruebas, detener');
    }
} catch(error){console.error('No se completó la acción:',error.message);process.exitCode=1;}
