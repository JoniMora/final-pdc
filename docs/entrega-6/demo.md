# Demo final: orden y explicación

Duración orientativa: 8 a 10 minutos, sin contar la prueba de carga completa.
Ensayar antes de la defensa. Este documento no registra que el ensayo ya ocurrió.
Todos los comandos parten de la raíz del repositorio, en la terminal de IntelliJ.

## 1. Preparación previa

Abrir Docker Desktop. Ejecutar, por separado:

```powershell
node reserva-cupos/scripts/entrega5.js preparar
node reserva-cupos/scripts/entrega5.js levantar
node reserva-cupos/scripts/entrega5.js migrar
node reserva-cupos/scripts/entrega5.js estado
```

Abrir https://localhost:3001. Los usuarios y contraseñas de esta instalación están
 en `reserva-cupos/seguridad/local/accesos-locales.txt`; no mostrar ese archivo en
la presentación. El navegador debe confiar en la CA local para evitar advertencias;
las pruebas de Node verifican explícitamente esa CA y la identidad del servidor.
No desactivar la verificación TLS para demostrar seguridad.

Preparar una ventana normal y otra privada, para que administrador y alumno no
compartan la misma cookie. Mantener visible el README y las evidencias finales.
No ejecutar `down -v`: borraría los volúmenes.

## 2. Presentar el problema

Decir: “Resolvemos la competencia de muchas personas por pocos cupos. Aula es un
cliente de ejemplo; el servicio recibe actividades y participantes de distintos
tenants. MySQL conserva el estado definitivo y PostgreSQL la proyección de Aula”.

Mostrar `docker-compose.yml` y su overlay de seguridad. Nombrar API, worker,
relay, notificador, RabbitMQ, primario, réplica, Aula, PostgreSQL y Traefik.
Son procesos separados en un único equipo, no un clúster de varios servidores.

## 3. Recorrido en pantalla

1. Entrar como administrador y crear una materia de prueba con un cupo y nombre único.
2. Entrar como alumno en la otra ventana y solicitar inscripción.
3. Esperar el estado definitivo: la aceptación inicial no es confirmación de cupo.
4. Mostrar que el cupo disponible queda en cero.
5. Solicitar para otro participante desde las opciones del administrador. Esperar
   el rechazo por falta de cupo. Si la interfaz no permite este paso, mostrar la
   evidencia automatizada y ejecutar `recorrido.js`; no inventar un botón.
6. Cancelar como titular. Esperar la cancelación y mostrar la devolución del cupo.
7. Volver a solicitar para el segundo participante y mostrar la confirmación.

Decir: “La API guarda pendiente y cambio en la misma transacción. El relay lo
publica. El worker decide con un UPDATE condicional. Por eso aceptar la solicitud
con 202 no promete un cupo, y la cola no es la garantía de no sobreasignación”.

El recorrido reproducible es:

```powershell
node reserva-cupos/pruebas/final/recorrido.js
```

## 4. Código que conviene abrir

- API `servicios/api/src/rutas.js`: admisión y contrato.
- Worker `servicios/worker/src`: decisión, transacción e idempotencia.
- Relay `servicios/relay/src/main.js`: publicación del outbox.
- Aula `clientes/aula/src/seguridad.js`: sesión, permisos y CSRF.
- Aula `clientes/aula/src/recuperacion.js`: lectura del feed y punto de control.
- API `servicios/api/src/server.js`: pool independiente del endpoint de salud.

Todas esas rutas están dentro de `reserva-cupos`. Seguir el mapa de la guía de
 defensa; no leer archivos completos durante la exposición.

## 5. Seguridad y caída de PostgreSQL

Ejecutar antes de la exposición, o durante ella si hay tiempo suficiente:

```powershell
node reserva-cupos/scripts/entrega5.js pruebas
```

Explicar las comprobaciones: sin sesión 401, permiso insuficiente 403, CSRF,
reservas ajenas, cifrado verificado y recuperación. La prueba detiene PostgreSQL,
reserva utilizando el servicio y luego lo inicia y reconcilia. No detiene MySQL.
La sesión sigue funcionando porque está en memoria; los usuarios provienen del
archivo local de identidades. La recuperación utiliza el feed y un cursor propio.

## 6. Carga y escalado

Mostrar `02-carga-escalado.txt`: 500 solicitudes para 10 cupos, 10 confirmadas,
490 rechazadas y cero pendientes en ambos escenarios. Mostrar las tres instancias
que respondieron detrás de Traefik y la restauración de la configuración inicial.

```powershell
node reserva-cupos/pruebas/final/carga-escalado.js
```

La ejecución completa tarda varios minutos. Preferir evidencias si el tiempo de
exposición es corto. Explicar que los dos workers comparten una cola y que esto
no acredita orden FIFO estricto, tolerancia a caída del host ni mejora lineal.

## 7. Cierre

Decir: “Integramos el recorrido, probamos que no se sobreasignan cupos en las
ráfagas documentadas y verificamos seguridad y recuperación. Las limitaciones
son el único host, failover manual, sesiones en memoria y CA de desarrollo”.

Si algo falla, mostrar el error real y la evidencia anterior con su fecha.
No presentar una ejecución anterior como si acabara de ocurrir.
