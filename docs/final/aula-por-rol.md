# Aula por rol — issue #62

## Comportamiento

- `/login.html` tiene el formulario de acceso; una sesión válida vuelve al portal.
- El alumno ve materias con cupos reales, Inscribirme y Mis inscripciones. Los estados se consultan cada cinco segundos, sin consultas superpuestas ni refrescos en pestañas ocultas. Una reserva pendiente o confirmada bloquea otra solicitud desde la tarjeta; el servicio conserva la decisión definitiva.
- El administrador ve los indicadores, crea materias, consulta ocupación e inscriptos confirmados (con paginación) y puede reconciliar.
- Ambos roles ven el aviso de contingencia cuando PostgreSQL no responde. El catálogo se reconstruye desde el feed y los cupos se consultan al servicio.
- `GET /inscripciones` toma el participante de la sesión y recorre todas las páginas de cada materia antes de filtrar. Una query con otro participante no cambia el alcance. No devuelve un resultado parcial si falla el servicio.
- Continúan las cookies, CSRF, roles, comprobación de propiedad y TLS existentes. Los textos de usuarios se insertan con `textContent`, no como HTML. El navegador no muestra JSON ni claves del tenant.
- JavaScript y CSS sin framework ni compilación. jsdom es solamente una dependencia de desarrollo para las pruebas de interacción.

## Validación

**Pruebas del componente.** `npm test --prefix reserva-cupos/clientes/aula`: 26 pruebas aprobadas y 5 de contrato omitidas sin Prism (en el CI corren contra el mock). Incluyen el backend real frente a una API simulada, control de propiedad, paginación, contingencia, CSRF y cinco pruebas del DOM. No son una prueba visual del navegador ni del entorno Docker. [Salida](ensayos/aula-por-rol-unitarias.txt).

**Ensayo sobre el entorno Docker** (26/11/2026, Windows con PowerShell). Desde `reserva-cupos`:

```powershell
docker compose -f docker-compose.yml -f docker-compose.particiones.yml up -d --build --no-deps --wait --wait-timeout 180 aula
node pruebas/final/recorrido.js
node pruebas/seguridad/aula.js
```

Aula quedó sana, el recorrido aprobó sus ocho comprobaciones y la suite de seguridad de Aula sus dieciséis, incluida la operación sin PostgreSQL y la reconciliación al volver. La suite se amplió para comprobar Mis inscripciones y los cupos durante la caída. Detiene `aula-db` brevemente y la vuelve a iniciar en su bloque de limpieza; no elimina volúmenes.

Los dos scripts escriben su registro en las evidencias de la Entrega 5 y la Entrega 6. Para no reemplazar las de esas entregas, los registros de este ensayo se guardaron en [ensayos/aula-por-rol](ensayos/aula-por-rol/) ([recorrido](ensayos/aula-por-rol/recorrido.txt) y [seguridad de Aula](ensayos/aula-por-rol/seguridad-aula.txt)).

La primera ejecución de la suite de seguridad cortó un socket HTTPS después de `docker stop`: el comando síncrono bloquea el proceso y un socket ocioso puede cerrarse sin que Node lo note. La prueba ahora pide una conexión nueva después de esos comandos, sin reintentar la solicitud ni desactivar TLS.

## Revisión visual

Las capturas muestran:

- [Alumno](ensayos/aula-por-rol/alumno.png): catálogo con cupos, botones deshabilitados, inscripciones confirmadas y canceladas; sin panel de administración ni JSON.
- [Administrador](ensayos/aula-por-rol/administrador.png): indicadores, creación, ocupación y acceso a inscriptos.
- [Contingencia](ensayos/aula-por-rol/contingencia.png): aviso visible con aula-db detenida. Desaparece solo al iniciar de nuevo la base.

La prueba del DOM comprueba el aviso en ambos roles y su desaparición, además de inscripción, cancelación, creación, listado y reconciliación.

**Sin ensayar a mano:** la vista en una ventana angosta o en el proyector y el listado de más de 100 inscriptos confirmados en la pantalla del administrador. La paginación de Mis inscripciones sí está cubierta por las pruebas del backend.

El ensayo paso a paso y la guía de defensa usan los nombres de estas pantallas.
