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

La configuración de Docker de la sesión del agente devuelve permiso denegado al motor. La vista previa del navegador tampoco pudo conectarse al servidor local. Quedan pendientes de ejecutar en la terminal y navegador del equipo:

```powershell
cd C:\Users\mcons\Documents\final-pdc\reserva-cupos
docker compose -f docker-compose.yml -f docker-compose.particiones.yml up -d --build --no-deps --wait --wait-timeout 180 aula
node pruebas/final/recorrido.js
node pruebas/seguridad/aula.js
```

La última suite detiene `aula-db` brevemente y la vuelve a iniciar en su bloque de limpieza; no elimina volúmenes. Se amplió para comprobar Mis inscripciones y cupos durante la caída. Sus resultados todavía no están certificados aquí.

## Revisión visual pendiente

1. Abrir https://localhost:3001: debe mostrar el login separado.
2. Entrar como admin en ventana normal y como alumno1 en privada: cada uno debe ver su pantalla y ningún JSON.
3. Crear materia de un cupo, inscribirse, esperar Confirmada y cancelar. Verificar cupo y bloqueo del botón durante la inscripción activa.
4. En el admin, abrir Ver inscriptos. Revisar también una materia con más de 100 confirmados si está disponible para comprobar Ver más inscriptos.
5. Detener `aula-db`, comprobar el aviso en ambas ventanas y que siga funcionando la consulta e inscripción. Volver a iniciarla y pulsar Reconciliar ahora: al completarse, debe desaparecer el aviso.
6. Revisar la página con ventana angosta y con zoom de proyector. Las pruebas DOM no sustituyen esa revisión.

El ensayo paso a paso y la guía de defensa ya usan los nombres de estas pantallas. La PR debe apuntar a `feature/entrega-7-integracion-final`; no a main. No se hizo merge ni se cerró el issue.
