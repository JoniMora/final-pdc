# Aula por rol — issue #62

## Comportamiento

- `/login.html` tiene el formulario de acceso; una sesión válida vuelve al portal.
- El alumno ve materias con cupos reales, Inscribirme y Mis inscripciones. Los estados se consultan cada cinco segundos, sin consultas superpuestas ni refrescos en pestañas ocultas. Una reserva pendiente o confirmada bloquea otra solicitud desde la tarjeta; el servicio conserva la decisión definitiva.
- El administrador ve los indicadores, crea materias, consulta ocupación e inscriptos confirmados (con paginación) y puede reconciliar.
- Ambos roles ven el aviso de contingencia cuando PostgreSQL no responde. El catálogo se reconstruye desde el feed y los cupos se consultan al servicio.
- `GET /inscripciones` toma el participante de la sesión y recorre todas las páginas de cada materia antes de filtrar. Una query con otro participante no cambia el alcance. No devuelve un resultado parcial si falla el servicio.
- Continúan las cookies, CSRF, roles, comprobación de propiedad y TLS existentes. Los textos de usuarios se insertan con textContent, no como HTML. El navegador no muestra JSON ni claves del tenant.
- JavaScript y CSS sin framework ni compilación. jsdom es solamente una dependencia de desarrollo para las pruebas de interacción.

## Validación local

`npm test --prefix reserva-cupos/clientes/aula`: 26 pruebas aprobadas y 5 de contrato omitidas por no estar Prism disponible. Incluye el backend real frente a una API simulada, control de propiedad, paginación, contingencia, CSRF y las cinco pruebas del DOM. No es una prueba visual del navegador ni del entorno Docker.

La usuaria ejecutó estos comandos en PowerShell/IntelliJ: Aula quedó healthy, el recorrido aprobó sus ocho comprobaciones y la suite de seguridad aprobó sus dieciséis comprobaciones, incluida la operación sin PostgreSQL y la reconciliación. Evidencias en [ensayos/aula-por-rol](ensayos/aula-por-rol/).

```powershell
cd C:\Users\mcons\Documents\final-pdc\reserva-cupos
docker compose -f docker-compose.yml -f docker-compose.particiones.yml up -d --build --no-deps --wait --wait-timeout 180 aula
node pruebas/final/recorrido.js
node pruebas/seguridad/aula.js
```

La última suite detiene `aula-db` brevemente y la vuelve a iniciar en su bloque de limpieza; no elimina volúmenes. Se amplió para comprobar Mis inscripciones y cupos durante la caída. Los resultados aprobados fueron aportados por la usuaria y se conservaron en el directorio de evidencias. La primera ejecución cortó un socket HTTPS después de docker stop; la corrección de la prueba solicita una conexión nueva después de comandos síncronos largos, sin reintentar ni desactivar TLS.

## Revisión visual

Las capturas aportadas muestran:

- [Alumno](ensayos/aula-por-rol/alumno.png): catálogo con cupos, botones deshabilitados, inscripciones confirmadas y canceladas; sin panel de administración ni JSON.
- [Administrador](ensayos/aula-por-rol/administrador.png): indicadores, creación, ocupación y acceso a inscriptos.
- [Contingencia](ensayos/aula-por-rol/contingencia.png): aviso visible con aula-db detenida. La usuaria confirmó que desaparece automáticamente al iniciar de nuevo la base.

La revisión automatizada del DOM comprueba el aviso en ambos roles y su desaparición, además de inscripción, cancelación, creación, listado y reconciliación. La revisión visual de ventana angosta/proyector y el listado administrativo de más de 100 confirmados no se ensayaron manualmente en esta sesión. El backend sí tiene cobertura de paginación para la ruta Mis inscripciones.

El ensayo paso a paso y la guía de defensa ya usan los nombres de estas pantallas. La PR debe apuntar a `feature/entrega-7-integracion-final`; no a main. No se hizo merge ni se cerró el issue.
