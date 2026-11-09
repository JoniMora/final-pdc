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

// Los ocho grupos de 16 bits de una dirección IPv6, sin abreviaturas. Se
// trabaja sobre los números y no sobre el texto: el parser de URL escribe
// [::ffff:127.0.0.1] como [::ffff:7f00:1], y las dos formas son la misma
// dirección.
function gruposIPv6(ip) {
    let texto = ip.toLowerCase().split("%")[0];
    const ipv4 = texto.match(/(\d+\.\d+\.\d+\.\d+)$/);

    if (ipv4) {
        const [a, b, c, d] = ipv4[1].split(".").map(Number);
        texto = `${texto.slice(0, -ipv4[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    }

    const [izquierda, derecha] = texto.split("::");
    const antes = izquierda ? izquierda.split(":") : [];

    if (derecha === undefined) return antes.map(grupo => parseInt(grupo, 16));

    const despues = derecha ? derecha.split(":") : [];
    const ceros = Array(8 - antes.length - despues.length).fill("0");

    return [...antes, ...ceros, ...despues].map(grupo => parseInt(grupo, 16));
}

function ipv4DeGrupos(alto, bajo) {
    return `${alto >> 8}.${alto & 255}.${bajo >> 8}.${bajo & 255}`;
}

function esIPv6Interna(ip) {
    const g = gruposIPv6(ip);
    const ceros = (desde, hasta) => g.slice(desde, hasta).every(grupo => grupo === 0);

    // ::ffff:0:0/96 (IPv4 mapeada) y ::/96 (IPv4 compatible, que incluye
    // :: y ::1): valen las reglas de la IPv4 que llevan adentro.
    if (ceros(0, 5) && (g[5] === 0xffff || g[5] === 0)) return esDireccionInterna(ipv4DeGrupos(g[6], g[7]));

    // 64:ff9b::/96, NAT64: también traduce a una IPv4.
    if (g[0] === 0x64 && g[1] === 0xff9b && ceros(2, 6)) return esDireccionInterna(ipv4DeGrupos(g[6], g[7]));

    // 2002::/16, 6to4: la IPv4 va en los grupos 2 y 3.
    if (g[0] === 0x2002) return esDireccionInterna(ipv4DeGrupos(g[1], g[2]));

    return (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1)   // 64:ff9b:1::/48, NAT64 local
        || (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) // Teredo y documentación
        || (g[0] === 0x100 && ceros(1, 4))                     // 100::/64, descarte
        || (g[0] & 0xfe00) === 0xfc00                          // fc00::/7, direcciones únicas locales
        || (g[0] & 0xffc0) === 0xfe80                          // fe80::/10, link-local
        || (g[0] & 0xffc0) === 0xfec0                          // fec0::/10, site-local
        || (g[0] & 0xff00) === 0xff00;                         // ff00::/8, multicast
}

function esDireccionInterna(ip) {
    if (net.isIPv4(ip)) return RANGOS_V4.some(rango => enRango(ip, rango));
    if (net.isIPv6(ip)) return esIPv6Interna(ip);
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
