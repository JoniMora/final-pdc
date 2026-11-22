> Borrador del cierre final (issue #53). Se ensaya y completa en la integración
> final (`v7-final`); las cifras de carga vigentes son las de la
> [Entrega 6](../entrega-6/README.md).

# Demo final: orden y explicación

Duración orientativa: 8 a 10 minutos, sin contar la prueba de carga completa.
Ensayar antes de la defensa. Este documento no registra que el ensayo ya ocurrió.
Todos los comandos parten de la raíz del repositorio, en la terminal de IntelliJ.

## 1. Preparación previa

Abrir Docker Desktop. Desde la raíz del repositorio:

```powershell
node reserva-cupos/scripts/sistema.js demo
```

Deja todo listo y comprobado (API, Aula, réplica, particiones, Prometheus) y crea
el tenant de la demo. Si algo no responde, se detiene y dice qué.

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

Mostrar `docker-compose.yml` con TLS integrado. Nombrar API, worker,
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

## 5. Escenario +1 en vivo

Para hacerlo a mano, con Aula en pantalla, k6 y Grafana: [ensayo paso a paso](ensayo-paso-a-paso.md).
Lo que sigue es la versión automatizada, útil para comprobar el entorno antes.

Es la demostración que promete el plan (Entrega 0): una materia de 10 cupos, 500
alumnos inscribiéndose a la vez y la base de Aula que se cae en plena ráfaga.

```powershell
node reserva-cupos/pruebas/final/escenario-mas-uno.js --pausas
```

Con `--pausas` espera Enter entre pasos para explicar cada uno:

1. **Todo sano:** la API ve MySQL y Aula está en modo normal.
2. **El administrador abre la materia** (mostrarla en Aula, https://localhost:3001).
3. **500 inscripciones a la vez; a las 150 se detiene aula-db.** Decir: "Aula no
   se cae: el catálogo sale del feed de la API y las inscripciones van directo a
   la API, que nunca dependió de la base de Aula".
4. **El servicio decidió:** 10 confirmadas, 490 rechazadas, 0 duplicadas, 0 cupos
   negativos. Decir: "la garantía la da el UPDATE condicional en MySQL".
5. **Vuelve aula-db:** Aula lee `/v1/cambios` desde su punto de control y su base
   queda igual al servicio. Decir: "el webhook es el camino rápido; el feed es la
   garantía".

Tarda unos dos minutos sin pausas. Cada corrida deja su registro en
`docs/final/ensayos/`. Para mostrar también el resto de la seguridad (401, 403,
CSRF, cifrado), correr antes `node reserva-cupos/scripts/sistema.js seguridad` y
mostrar su salida.

### Si se cae nuestro servidor

El escenario +1 tira abajo la base del **cliente**. La Parte 2 del
[ensayo paso a paso](ensayo-paso-a-paso.md#parte-2-se-cae-nuestro-servidor-unos-6-minutos)
tira abajo piezas del **servicio** con una ráfaga en curso: una de dos instancias
de la API, el worker y, al final, el MySQL primario. Para el primario:

```shell
docker compose kill mysql-primary
node scripts/sistema.js failover
```

Decir: "nadie pierde una reserva confirmada: la réplica ya tenía cada commit
(semisincrónica); el failover es un comando y lo hacemos a mano porque con dos
nodos una detección automática puede terminar en dos primarios". Va al final de la
demo: después hay que correr `node scripts/sistema.js restaurar`, que borra los
datos del entorno.

## 6. Carga y escalado

Mostrar el [informe del escenario caliente](../entrega-6/evidencias/carga-caliente/informe.html):
500 solicitudes para 10 cupos, 10 confirmadas, 490 rechazadas y cero pendientes, con
las series de Prometheus. Después, el dashboard de Grafana (`https://localhost:3002`)
y la [curva con 1, 2 y 4 API](../entrega-6/evidencias/curva-admisiones/informe.html).

```powershell
node reserva-cupos/scripts/verificar-e6.js carga
```

La ejecución completa tarda varios minutos. Preferir las evidencias si el tiempo de
exposición es corto. Explicar que cada actividad cae en una sola partición (orden por
actividad, no global) y que agregar API no acelera la admisión porque el límite es el
commit semisincrónico del primario.

## 7. Cierre

Decir: “Integramos el recorrido, probamos que no se sobreasignan cupos en las
ráfagas documentadas y verificamos seguridad y recuperación. Las limitaciones
son el único host, failover manual, sesiones en memoria y CA de desarrollo”.

Si algo falla, mostrar el error real y la evidencia anterior con su fecha.
No presentar una ejecución anterior como si acabara de ocurrir.

## Checklist de ensayo

Antes de cada ensayo y el día de la defensa:

- [ ] Docker Desktop abierto y con al menos 6 GB de memoria.
- [ ] `node reserva-cupos/scripts/sistema.js demo` terminó con "Listo para la demo" (si dice que la réplica fue promovida, correr antes `restaurar`).
- [ ] El navegador confía en `reserva-cupos/seguridad/local/ca.crt` (sin advertencias en https://localhost:3001).
- [ ] Ventana normal con el administrador y ventana privada con un alumno, ya logueados.
- [ ] Grafana abierto en https://localhost:3002 con el dashboard "Reserva de cupos".
- [ ] El escenario +1 corrió completo al menos una vez ese día (`escenario-mas-uno.js`).
- [ ] Terminal con letra grande; `accesos-locales.txt` cerrado y fuera de la pantalla.
- [ ] El video de respaldo a mano.

Cada ensayo completo (los dos integrantes, de punta a punta, con tiempo) se anota en
la página "Ensayos de la demo" de la Wiki.

## Plan B

Si en vivo falla algo que no se resuelve en un minuto:

1. Mostrar el video de respaldo del escenario +1.
2. Mostrar el último registro de `docs/final/ensayos/` y los informes de la
   [Entrega 6](../entrega-6/evidencias/README.md), con su fecha.
3. Explicar con el código abierto qué debía pasar en el paso que falló.
