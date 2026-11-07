const net = require("node:net");
const dns = require("node:dns");

// Protección contra SSRF: el notificador hace POST a URLs que elige el
// tenant, así que no puede usarse para alcanzar la red interna del
// servicio. Se rechazan direcciones privadas, de loopback, link-local
// (incluido 169.254.169.254, los metadatos de una nube) y reservadas.
// En el entorno local, la lista de hosts permitidos habilita a Aula.

class ErrorDestino extends Error {}

const RANGOS_V4 = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16],
    ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]
];

function aEntero(ip) {
    return ip.split(".").reduce((total, octeto) => total * 256 + Number(octeto), 0);
}

// Compara los primeros `bits` bits. Se divide en lugar de usar & porque
// los operadores de bits de JS trabajan con enteros de 32 bits con signo.
function enRango(ip, [base, bits]) {
    const bloque = 2 ** (32 - bits);
    return Math.floor(aEntero(ip) / bloque) === Math.floor(aEntero(base) / bloque);
}

function esDireccionInterna(ip) {
    if (net.isIPv4(ip)) {
        return RANGOS_V4.some(rango => enRango(ip, rango));
    }

    if (net.isIPv6(ip)) {
        const minuscula = ip.toLowerCase();
        const mapeada = minuscula.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);

        if (mapeada) return esDireccionInterna(mapeada[1]);

        return minuscula === "::" || minuscula === "::1"
            || /^f[cd]/.test(minuscula)       // fc00::/7, direcciones únicas locales
            || /^fe[89ab]/.test(minuscula)    // fe80::/10, link-local
            || /^ff/.test(minuscula);         // multicast
    }

    return true;
}

// Valida la URL registrada antes de intentar la conexión.
function validarUrl(texto, permitidos) {
    let url;

    try {
        url = new URL(texto);
    } catch (_) {
        throw new ErrorDestino("La URL del webhook no es válida");
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new ErrorDestino(`Protocolo no permitido: ${url.protocol}`);
    }

    if (url.username || url.password) {
        throw new ErrorDestino("La URL no puede incluir credenciales");
    }

    const host = url.hostname.replace(/^\[|\]$/g, "");

    if (net.isIP(host) && !permitidos.has(host) && esDireccionInterna(host)) {
        throw new ErrorDestino(`Dirección interna no permitida: ${host}`);
    }

    return url;
}

// Resolución de nombres que valida cada dirección en el momento de
// conectar: así un nombre que cambia de IP entre la validación y la
// conexión (DNS rebinding) tampoco alcanza la red interna.
function crearLookup(permitidos, resolver = dns.lookup) {
    return (hostname, opciones, callback) => {
        resolver(hostname, { ...opciones, all: true }, (error, direcciones) => {
            if (error) return callback(error);

            if (!permitidos.has(hostname)) {
                const interna = direcciones.find(d => esDireccionInterna(d.address));

                if (interna) {
                    return callback(new ErrorDestino(`${hostname} resuelve a una dirección interna (${interna.address})`));
                }
            }

            if (opciones.all) return callback(null, direcciones);
            callback(null, direcciones[0].address, direcciones[0].family);
        });
    };
}

module.exports = { ErrorDestino, esDireccionInterna, validarUrl, crearLookup };
