const test = require("node:test");
const assert = require("node:assert/strict");
const { esDireccionInterna, validarUrl, crearLookup, ErrorDestino } = require("../src/destino");

test("las direcciones privadas, de loopback y link-local se reconocen como internas", () => {
    for (const ip of ["10.0.0.5", "172.18.0.3", "192.168.1.10", "127.0.0.1", "169.254.169.254", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
        assert.equal(esDireccionInterna(ip), true, ip);
    }

    for (const ip of ["8.8.8.8", "172.32.0.1", "200.45.10.3", "2800:3f0:4002::200e"]) {
        assert.equal(esDireccionInterna(ip), false, ip);
    }
});

test("se rechazan URLs con otro protocolo, credenciales o IP interna literal", () => {
    const permitidos = new Set();

    for (const url of ["ftp://ejemplo.com/x", "http://usuario:clave@ejemplo.com/", "http://127.0.0.1:3000/", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "no es una url"]) {
        assert.throws(() => validarUrl(url, permitidos), ErrorDestino, url);
    }

    assert.equal(validarUrl("https://tenant.ejemplo.com/webhooks", permitidos).hostname, "tenant.ejemplo.com");
});

test("una IPv4 interna escrita como IPv6 también se rechaza", () => {
    // El parser de URL normaliza [::ffff:127.0.0.1] a [::ffff:7f00:1], y
    // Node no consulta el DNS para una IP literal: la validación de la URL
    // es la única barrera.
    const permitidos = new Set();
    const internas = [
        "http://[::ffff:127.0.0.1]/",           // IPv4 mapeada
        "http://[::ffff:169.254.169.254]/",     // metadatos de una nube
        "http://[::ffff:a00:1]/",               // 10.0.0.1 en hexadecimal
        "http://[::127.0.0.1]/",                // IPv4 compatible
        "http://[64:ff9b::a9fe:a9fe]/",         // NAT64 de 169.254.169.254
        "http://[2002:ac12:3::1]/",             // 6to4 de 172.18.0.3
        "http://[fd12:3456::1]/",
        "http://[::]/"
    ];

    for (const url of internas) {
        assert.throws(() => validarUrl(url, permitidos), ErrorDestino, url);
    }

    for (const url of ["http://[::ffff:8.8.8.8]/", "http://[64:ff9b::808:808]/", "http://[2800:3f0:4002::200e]/"]) {
        assert.equal(validarUrl(url, permitidos).protocol, "http:", url);
    }
});

test("un nombre que resuelve a una IP interna se rechaza al conectar, salvo que esté permitido", async () => {
    const resolver = (host, opciones, callback) => callback(null, [{ address: "172.18.0.7", family: 4 }]);

    const rechazo = await new Promise(resolve => crearLookup(new Set(), resolver)("mysql-primary", { all: true }, resolve));
    assert.ok(rechazo instanceof ErrorDestino);

    const [error, direcciones] = await new Promise(resolve =>
        crearLookup(new Set(["aula"]), resolver)("aula", { all: true }, (e, d) => resolve([e, d])));
    assert.equal(error, null);
    assert.equal(direcciones[0].address, "172.18.0.7");
});
