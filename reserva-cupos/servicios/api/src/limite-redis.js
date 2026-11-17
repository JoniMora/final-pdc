const { problemas } = require('./problemas');

// TIME del servidor y descuento atomico: el balde pertenece al tenant,
// no al proceso ni al numero de instancias de la API.
const TOKEN_BUCKET = `
local reloj = redis.call('TIME')
local ahora = tonumber(reloj[1]) * 1000 + tonumber(reloj[2]) / 1000
local tasa, rafaga = tonumber(ARGV[1]), tonumber(ARGV[2])
local datos = redis.call('HMGET', KEYS[1], 'fichas', 'ultimo', 'tasa', 'rafaga')
local fichas = rafaga
if datos[1] and tonumber(datos[3]) == tasa and tonumber(datos[4]) == rafaga then
  fichas = math.min(rafaga, tonumber(datos[1]) + math.max(0, ahora-tonumber(datos[2])) * tasa / 1000)
end
local aceptada, espera = 0, 0
if fichas >= 1 then aceptada = 1; fichas = fichas - 1
else espera = math.max(1, math.ceil((1-fichas)/tasa)) end
redis.call('HSET', KEYS[1], 'fichas', fichas, 'ultimo', ahora, 'tasa', tasa, 'rafaga', rafaga)
redis.call('PEXPIRE', KEYS[1], math.max(1000, math.ceil(rafaga/tasa*2000)))
return {aceptada, espera}
`;

function crearLimitadorRedis(redis, { porSegundo, rafaga, observar = () => {} }) {
    return async function limitar(req, res, next) {
        const limite = req.limite || { porSegundo, rafaga };
        if (!(limite.porSegundo > 0) || !(limite.rafaga >= 1)) throw new Error('Limite invalido');
        const [aceptada, espera] = await redis.eval(TOKEN_BUCKET, {
            keys: [`pdc:limite:${req.tenantId}`],
            arguments: [String(limite.porSegundo), String(limite.rafaga)]
        });
        observar(Number(aceptada) ? 'aceptada' : 'rechazada');
        if (!Number(aceptada)) throw problemas.demasiadasSolicitudes(Number(espera));
        next();
    };
}

module.exports = { TOKEN_BUCKET, crearLimitadorRedis };
