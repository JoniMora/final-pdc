const { randomUUID } = require('node:crypto');
const { aplicarReserva } = require('./webhooks');

async function aplicarActividad(cliente, actividad) {
    if (actividad.metadata?.origen !== 'aula' || actividad.metadata?.tipo !== 'materia') return;
    await cliente.query(
        `INSERT INTO materias (id, actividad_id, nombre, cupo, version)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (actividad_id) DO UPDATE SET nombre=EXCLUDED.nombre,
             cupo=EXCLUDED.cupo, version=EXCLUDED.version
         WHERE materias.version < EXCLUDED.version`,
        [randomUUID(),actividad.id,actividad.nombre,actividad.capacidad,actividad.version]);
}
async function aplicarPagina(pool, datos, desde, ultima) {
    if (!Number.isSafeInteger(ultima) || ultima < desde || (datos.length && ultima !== datos.at(-1).secuencia)) {
        throw new Error('Punto de control inválido');
    }
    let previo = desde;
    for (const cambio of datos) {
        if (!Number.isSafeInteger(cambio.secuencia) || cambio.secuencia <= previo) throw new Error('Feed fuera de orden');
        previo = cambio.secuencia;
    }
    const cliente = await pool.connect();
    try {
        await cliente.query('BEGIN');
        const control = await cliente.query('SELECT ultima_secuencia_feed FROM punto_control WHERE id=1 FOR UPDATE');
        if (Number(control.rows[0].ultima_secuencia_feed) !== desde) { await cliente.query('ROLLBACK'); return false; }
        for (const cambio of datos) {
            if (cambio.tipo.startsWith('actividad.')) await aplicarActividad(cliente,cambio.entidad);
            else if (cambio.tipo.startsWith('reserva.')) await aplicarReserva(cliente,cambio.entidad);
        }
        await cliente.query('UPDATE punto_control SET ultima_secuencia_feed=$1, actualizado_en=CURRENT_TIMESTAMP WHERE id=1',[ultima]);
        await cliente.query('COMMIT');
        return true;
    } catch(error) { await cliente.query('ROLLBACK').catch(()=>{}); throw error; }
    finally { cliente.release(); }
}
function crearRecuperacion({ pool, api, intervaloMs=5000 }) {
    const catalogo=new Map();
    let cursorMemoria=0, ocupado=false, timer;
    const estado={ modo:'iniciando', ultima_secuencia_feed:0, ultimo_error:null };
    async function pagina(desde) {
        const r=await api.llamar('leerCambios',{query:{desde,limite:200}});
        if(r.status!==200) throw new Error(`Feed no disponible (${r.status})`);
        return r.cuerpo;
    }
    async function actualizarCatalogo() {
        for(let i=0;i<50;i++) {
            const p=await pagina(cursorMemoria);
            for(const c of p.datos) if(c.tipo.startsWith('actividad.') && c.entidad.metadata?.origen==='aula') {
                const a=c.entidad;
                if(!catalogo.has(a.id) || catalogo.get(a.id).version<a.version) {
                    catalogo.set(a.id,{id:a.id,actividad_id:a.id,nombre:a.nombre,cupo:a.capacidad,version:a.version,creado_en:a.creado_en});
                }
            }
            cursorMemoria=p.ultima_secuencia;
            if(p.datos.length<200) return;
        }
    }
    async function sincronizar() {
        if(ocupado) return estado;
        ocupado=true;
        try {
            await actualizarCatalogo();
            for(let i=0;i<50;i++) {
                const r=await pool.query('SELECT ultima_secuencia_feed FROM punto_control WHERE id=1');
                const desde=Number(r.rows[0].ultima_secuencia_feed);
                const p=await pagina(desde);
                if(p.datos.length) await aplicarPagina(pool,p.datos,desde,p.ultima_secuencia);
                estado.ultima_secuencia_feed=p.ultima_secuencia;
                if(p.datos.length<200) break;
            }
            estado.modo='normal'; estado.ultimo_error=null;
        } catch(error) {
            estado.modo='degradado'; estado.ultimo_error='No se pudo completar la reconciliación';
            console.error('[AULA] Reconciliación pendiente:',error.code || error.message);
        } finally { ocupado=false; }
        return estado;
    }
    async function ciclo() { await sincronizar(); timer=setTimeout(ciclo,intervaloMs); timer.unref(); }
    return { estado,sincronizar,actualizarCatalogo,catalogo,iniciar:ciclo,detener:()=>clearTimeout(timer) };
}
module.exports={crearRecuperacion,aplicarPagina,aplicarActividad};
