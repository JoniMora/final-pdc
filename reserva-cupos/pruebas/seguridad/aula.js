// Personas de Aula y contingencia (Entrega 5, issues E5-1 y E5-5), contra
// el entorno levantado: login, roles, CSRF, propiedad de las reservas,
// reconstrucción de la proyección desde el feed y operación con aula-db
// detenida.
//
// Crea una materia de prueba y detiene aula-db un momento; la vuelve a
// iniciar aunque una comprobación falle. No borra volúmenes.
//
// Uso, desde reserva-cupos: node pruebas/seguridad/aula.js
// Evidencia: docs/entrega-5/evidencias/seguridad-aula.txt

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { AULA, docker, psql, pedir, accesosAula, sesionAula, aula, esperarHasta, Evidencia, ejecutar } = require("../comun");

async function prueba({ ok }) {
    let aulaDbDetenida = false;

    try {
        assert.equal((await pedir(`${AULA}/materias`)).status, 401);
        ok("Sin sesión, las rutas de Aula responden 401");

        const incorrecta = await pedir(`${AULA}/auth/login`, {
            metodo: "POST",
            cuerpo: { usuario: "alumno1", password: `${accesosAula().alumno1}x` }
        });
        assert.equal(incorrecta.status, 401);
        ok("Contraseña incorrecta: 401 con el mismo mensaje que un usuario inexistente");

        const sesionAdmin = await sesionAula("admin");
        const sesionUno = await sesionAula("alumno1");
        const sesionDos = await sesionAula("alumno2");

        assert.match(sesionUno.cookieCompleta, /HttpOnly/i);
        assert.match(sesionUno.cookieCompleta, /Secure/i);
        assert.match(sesionUno.cookieCompleta, /SameSite=Strict/i);
        ok("La cookie de sesión es HttpOnly, Secure y SameSite=Strict");

        const admin = aula(sesionAdmin);
        const uno = aula(sesionUno);
        const dos = aula(sesionDos);
        const nombre = `Entrega 5 ${Date.now()}`;

        assert.equal((await uno("/materias", { metodo: "POST", cuerpo: { nombre, cupo: 2 } })).status, 403);
        assert.equal((await uno("/reconciliacion")).status, 403);
        ok("Un alumno no crea materias ni consulta la reconciliación: 403");

        const sinCsrf = await pedir(`${AULA}/materias`, {
            metodo: "POST",
            cuerpo: { nombre, cupo: 2 },
            encabezados: { Cookie: sesionAdmin.encabezados.Cookie }
        });
        assert.equal(sinCsrf.status, 403);
        ok("Una escritura sin token CSRF no modifica nada: 403");

        const materia = await admin("/materias", { metodo: "POST", cuerpo: { nombre, cupo: 2 } });
        assert.equal(materia.status, 201);
        const id = materia.datos.id;

        const inscribir = (cliente, alumno) => cliente(`/materias/${id}/inscripciones`, {
            metodo: "POST",
            cuerpo: alumno ? { alumno } : {},
            encabezados: { "Idempotency-Key": crypto.randomUUID() }
        });

        assert.equal((await inscribir(uno, "alumno-2")).status, 403);
        ok("Un alumno no puede inscribir a otro: 403");

        const propia = await inscribir(uno);
        assert.equal(propia.status, 202);
        assert.equal(propia.datos.participante, "alumno-1");

        await esperarHasta(async () => (await uno(`/inscripciones/${propia.datos.id}`)).datos?.estado === "confirmada",
            { descripcion: "la confirmación de la inscripción" });

        assert.equal((await dos(`/inscripciones/${propia.datos.id}`)).status, 404);
        assert.equal((await dos(`/inscripciones/${propia.datos.id}/cancelacion`, { metodo: "POST" })).status, 404);
        ok("Otro alumno no consulta ni cancela la inscripción ajena: 404");

        const propias = await uno('/inscripciones?participante=alumno-2');
        assert.equal(propias.status, 200);
        assert.ok(propias.datos.some(r => r.id === propia.datos.id && r.estado === 'confirmada'));
        assert.ok(propias.datos.every(r => r.participante === 'alumno-1'));
        const ajenas = await dos('/inscripciones');
        assert.equal(ajenas.status, 200);
        assert.ok(ajenas.datos.every(r => r.id !== propia.datos.id));
        ok("Mis inscripciones usa la sesión y no expone reservas ajenas ni acepta suplantación por query");

        const detalle = await dos(`/materias/${id}`);
        assert.equal(detalle.datos.inscriptos.length, 0);
        assert.deepEqual(detalle.datos.inscriptos_locales, []);
        ok("El detalle de la materia no muestra a otro alumno sus compañeros inscriptos");

        // Se borra la materia de la proyección local y se rebobina el punto de
        // control del feed: la reconciliación tiene que reconstruirla.
        psql(`DELETE FROM materias WHERE actividad_id = '${id}';
              UPDATE punto_control SET ultima_secuencia_feed = 0 WHERE id = 1;`);
        await esperarHasta(async () => {
            const resultado = await admin("/reconciliacion", { metodo: "POST" });
            return resultado.status === 200 && resultado.datos?.modo === "normal"
                && psql(`SELECT count(*) FROM materias WHERE actividad_id = '${id}';`).trim() === "1";
        }, { descripcion: "la materia reconstruida por el feed" });
        ok("La reconciliación por feed reconstruye la materia borrada de aula-db");

        docker(["stop", "aula-db"]);
        aulaDbDetenida = true;

        const catalogo = await dos("/materias");
        assert.equal(catalogo.status, 200);
        assert.equal(catalogo.encabezados["x-aula-modo"], "contingencia");
        assert.ok(catalogo.datos.some(m => m.actividad_id === id));
        ok("Con aula-db detenida, el catálogo sale del feed de la API (X-Aula-Modo: contingencia)");

        assert.equal((await dos("/auth/me")).status, 200);
        ok("Con aula-db detenida, la sesión sigue válida: las identidades no dependen de PostgreSQL");

        const durante = await inscribir(dos);
        assert.equal(durante.status, 202);
        await esperarHasta(async () => (await dos(`/inscripciones/${durante.datos.id}`)).datos?.estado === "confirmada",
            { descripcion: "la confirmación durante la caída" });
        ok("Con aula-db detenida, un alumno se inscribe y el servicio confirma la reserva");

        const propiasSinBase = await dos('/inscripciones');
        assert.equal(propiasSinBase.status, 200);
        assert.equal(propiasSinBase.encabezados['x-aula-modo'], 'contingencia');
        assert.ok(propiasSinBase.datos.some(r => r.id === durante.datos.id && r.estado === 'confirmada'));
        assert.ok(propiasSinBase.datos.every(r => r.participante === 'alumno-2'));
        const cuposSinBase = await dos('/materias');
        assert.equal(cuposSinBase.datos.find(m => m.actividad_id === id).cupos_disponibles, 0);
        ok("Sin aula-db, Mis inscripciones conserva la propiedad y el catálogo muestra los cupos reales");

        docker(["start", "aula-db"]);
        aulaDbDetenida = false;

        // Modo normal no implica que el relay ya haya secuenciado el cambio.
        // Esperar el efecto persistido evita la carrera entre confirmación y feed.
        await esperarHasta(async () => {
            const resultado = await admin("/reconciliacion", { metodo: "POST" });
            return resultado.status === 200 && resultado.datos?.modo === "normal"
                && psql(`SELECT estado FROM inscripciones WHERE reserva_id = '${durante.datos.id}';`).trim() === "confirmada";
        }, { descripcion: "la inscripción recuperada en PostgreSQL" });
        ok("Al volver aula-db, la reconciliación agrega la inscripción hecha durante la caída");

        assert.equal((await uno("/auth/logout", { metodo: "POST" })).status, 200);
        assert.equal((await uno("/auth/me")).status, 401);
        ok("Logout invalida la sesión en el servidor");
    } finally {
        if (aulaDbDetenida) docker(["start", "aula-db"]);
    }
}

ejecutar(new Evidencia("seguridad-aula.txt", "Personas de Aula, permisos y contingencia (E5-1, E5-5)"), prueba)
    .then(codigo => { process.exitCode = codigo; });
