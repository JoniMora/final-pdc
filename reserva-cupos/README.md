# Reserva de cupos — Entrega 2: infraestructura

Proyecto final de Programación Distribuida y Componentes.
Grupo 15: Jonathan Mora Colodrero y María Constanza Gigli.

## Alcance

Esta entrega implementa la infraestructura de ejecución y pruebas de
comunicación entre componentes.

Incluye:
- Nueve contenedores administrados con Docker Compose.
- Tres redes para separar las comunicaciones.
- MySQL primario y réplica con replicación semisíncrona.
- Esquema inicial de reservas y usuarios con permisos por componente.
- RabbitMQ con colas de comandos, notificaciones, esperas y errores.
- API y worker que permiten publicar y procesar mensajes de prueba.
- Cliente Aula con interfaz web y base propia en PostgreSQL.
- Volúmenes persistentes para las bases de datos y RabbitMQ.

Todavía no implementa reservas reales, autenticación multi-tenant,
procesamiento del outbox, feed de cambios ni envío de webhooks.
Relay y notificador comprueban conexiones y ejecutan consultas de prueba.
Relay también configura la topología de RabbitMQ al iniciar.

## Requisitos

- Git.
- Docker Desktop iniciado, utilizando contenedores Linux.
- Docker Compose.
- Puertos locales 3000, 3001 y 15672 disponibles.

Node.js, MySQL, PostgreSQL y RabbitMQ se ejecutan dentro de los
contenedores; no es necesario instalarlos directamente en el equipo.

Los comandos pueden ejecutarse en cualquier terminal (PowerShell, bash o zsh).
Cuando un comando cambia según el sistema, se muestran las dos variantes.

## Componentes

| Servicio | Función en esta entrega |
|---|---|
| api | Recibe mensajes por HTTP y los publica en RabbitMQ. |
| worker | Consume mensajes de prueba, los muestra en los logs y confirma su procesamiento. |
| mysql-primary | Almacena el esquema y los datos del servicio. |
| mysql-replica | Replica los cambios del primario y permanece en modo de solo lectura. |
| rabbitmq | Mantiene la infraestructura de mensajería. |
| relay | Configura exchanges y colas; comprueba acceso a MySQL y RabbitMQ. |
| notificador | Comprueba acceso a MySQL y RabbitMQ. |
| aula | Proporciona la interfaz web y se comunica con la API y su base propia. |
| aula-db | Almacena los registros de prueba de Aula en PostgreSQL. |

## Redes

| Red | Servicios conectados |
|---|---|
| publica | api, aula, notificador |
| interna | api, worker, mysql-primary, mysql-replica, rabbitmq, relay, notificador |
| tenant | aula, aula-db |

Aula accede a la API mediante HTTP y no comparte la red de MySQL.
PostgreSQL se encuentra únicamente en la red del tenant.

Estas redes son redes bridge locales. El nombre `publica` no significa
que los servicios estén publicados en Internet.

Solo se publican en el equipo:
- API: http://localhost:3000
- Aula: http://localhost:3001
- Administración de RabbitMQ: http://localhost:15672

Los puertos publicados están vinculados a 127.0.0.1.
Las bases de datos no publican puertos al equipo.

## Inicio

### Obtener el código

El código de esta entrega está publicado en el tag `v2.1-infraestructura`
(rama `entrega-2-infraestructura`). La rama `main` se actualiza cuando
se aprueba la entrega.

```shell
git clone https://github.com/JoniMora/final-pdc.git
cd final-pdc
git checkout v2.1-infraestructura
```

### Levantar el entorno

Desde la raíz del repositorio, ingresar a la carpeta de la aplicación:

```shell
cd reserva-cupos
```

Validar la configuración:

```shell
docker compose config --quiet
```

Construir las imágenes y levantar los servicios:

```shell
docker compose up --build -d
```

Comprobar el estado:

```shell
docker compose ps -a
```

La primera construcción puede tardar porque descarga imágenes e instala
dependencias. Si el comando termina con un error de dependencia, ver
[Problemas frecuentes](#problemas-frecuentes).

### Configurar la réplica en una instalación nueva

Cuando MySQL primario y réplica aparezcan como healthy, ejecutar:

```shell
docker compose exec -T mysql-replica sh -c "mysql -uroot -proot_local_2026 < /configurar-replica.sql"
```

Este paso se realiza una sola vez por instalación con volúmenes nuevos.
La configuración se conserva en el volumen de la réplica.

No es necesario repetirlo al detener y volver a iniciar los contenedores.

Comprobar la replicación:

```shell
docker compose exec mysql-replica mysql -uroot -proot_local_2026 -e "SHOW REPLICA STATUS\G"
```

Resultados esperados:
- Replica_IO_Running: Yes.
- Replica_SQL_Running: Yes.
- Last_IO_Error y Last_SQL_Error vacíos.
- Seconds_Behind_Source: 0 cuando termine de aplicar los cambios.

Comprobar el estado semisíncrono en el primario:

```shell
docker compose exec mysql-primary mysql -uroot -proot_local_2026 -e "SHOW GLOBAL STATUS LIKE 'Rpl_semi_sync_source_status'; SHOW GLOBAL STATUS LIKE 'Rpl_semi_sync_source_clients';"
```

Resultados esperados:
- Rpl_semi_sync_source_status: ON.
- Rpl_semi_sync_source_clients: 1.

La réplica puede necesitar tiempo para aplicar los datos iniciales.
Que ambos contenedores estén healthy no demuestra, por sí solo,
que la replicación esté configurada o actualizada.

## Demostración de comunicación

Abrir:

http://localhost:3001

La interfaz permite:
1. Consultar las conexiones de Aula con PostgreSQL y la API.
2. Guardar y consultar registros de prueba en PostgreSQL.
3. Enviar un mensaje al servicio.

El recorrido del mensaje es:

Aula → HTTP → API → RabbitMQ → worker.

La respuesta HTTP 202 indica que la API aceptó la publicación del
mensaje después de recibir la confirmación de RabbitMQ.
No significa que el worker ya lo haya procesado.

Para comprobar el procesamiento:

```shell
docker compose logs --tail=20 worker
```

El identificador del mensaje recibido por el worker debe coincidir con
el identificador mostrado en la respuesta de la interfaz.

También se puede probar directamente desde la terminal.

macOS o Linux:

```bash
curl http://localhost:3000/health
```

```bash
curl -X POST http://localhost:3000/pruebas/mensajes -H "Content-Type: application/json" -d '{"texto":"Mensaje de prueba"}'
```

Windows (PowerShell):

```powershell
Invoke-RestMethod -Uri http://localhost:3000/health
```

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/pruebas/mensajes -ContentType "application/json" -Body '{"texto":"Mensaje de prueba"}'
```

## Independencia y persistencia de PostgreSQL

Detener únicamente la base de Aula:

```shell
docker compose stop aula-db
```

Desde la interfaz, enviar un mensaje al servicio.

El mensaje puede seguir el recorrido Aula → API → RabbitMQ → worker
aunque PostgreSQL esté detenido. Guardar o consultar registros de Aula
requiere que PostgreSQL esté disponible.

Comprobar el mensaje:

```shell
docker compose logs --tail=20 worker
```

Volver a iniciar PostgreSQL:

```shell
docker compose start aula-db
```

Cuando esté disponible, actualizar el estado y consultar los registros.

Los registros anteriores permanecen almacenados en el volumen.
Esta prueba demuestra independencia del envío de mensajes respecto
de PostgreSQL; no implementa reconciliación de reservas.

## Independencia del worker

Detener únicamente el worker:

```shell
docker compose stop worker
```

Enviar tres mensajes. La API los acepta (HTTP 202) aunque el worker
esté detenido.

macOS o Linux:

```bash
for i in 1 2 3; do curl -s -X POST http://localhost:3000/pruebas/mensajes -H "Content-Type: application/json" -d "{\"texto\":\"Con worker detenido $i\"}"; echo; done
```

Windows (PowerShell):

```powershell
1..3 | ForEach-Object { Invoke-RestMethod -Method Post -Uri http://localhost:3000/pruebas/mensajes -ContentType "application/json" -Body (@{ texto = "Con worker detenido $_" } | ConvertTo-Json) }
```

Comprobar que RabbitMQ retiene los mensajes:

```shell
docker compose exec rabbitmq rabbitmqctl list_queues name messages consumers
```

Se espera infraestructura.pruebas con 3 mensajes y 0 consumidores.

Volver a iniciar el worker y comprobar que procesa los pendientes:

```shell
docker compose start worker
```

```shell
docker compose exec rabbitmq rabbitmqctl list_queues name messages consumers
```

```shell
docker compose logs --tail=30 worker
```

Se espera infraestructura.pruebas sin mensajes, con un consumidor,
y los tres identificadores en los logs del worker.

## Aislamiento de redes

Aula no comparte red con MySQL ni con RabbitMQ, y la API no comparte
red con PostgreSQL. Desde cada contenedor, esos nombres no se resuelven:

```shell
docker compose exec aula node -e "require('dns').lookup('mysql-primary', (e, a) => console.log(e ? e.code : a))"
```

```shell
docker compose exec aula node -e "require('dns').lookup('rabbitmq', (e, a) => console.log(e ? e.code : a))"
```

```shell
docker compose exec api node -e "require('dns').lookup('aula-db', (e, a) => console.log(e ? e.code : a))"
```

Se espera ENOTFOUND en los tres casos. Como control, el mismo comando
desde aula hacia api devuelve una dirección IP.

## Esquema y permisos de MySQL

La base `reservas` contiene:
- tenants.
- actividades.
- reservas.
- cambios.

Existen usuarios separados:
- api_app.
- worker_app.
- relay_app.
- notificador_app.
- replicador.

Los permisos preparan la separación de responsabilidades.
En esta entrega la API y el worker de prueba utilizan RabbitMQ;
todavía no ejecutan operaciones de reservas en MySQL.

Comprobar las tablas y el modo de solo lectura de la réplica:

```shell
docker compose exec mysql-replica mysql -uroot -proot_local_2026 -e "SHOW TABLES FROM reservas; SELECT @@global.read_only, @@global.super_read_only;"
```

Ambas variables de solo lectura deben valer 1.

### Prueba de permisos

La API no debe poder modificar los cupos:

```shell
docker compose exec mysql-primary mysql -uapi_app -papi_local_2026 -e "UPDATE reservas.actividades SET cupos_disponibles = cupos_disponibles WHERE 1 = 0;"
```

Se espera un error de permiso UPDATE denegado.

El worker sí tiene ese permiso:

```shell
docker compose exec mysql-primary mysql -uworker_app -pworker_local_2026 -e "UPDATE reservas.actividades SET cupos_disponibles = cupos_disponibles WHERE 1 = 0;"
```

Se espera que termine sin error.
La condición WHERE 1 = 0 evita modificar filas en ambas pruebas.

### Caída de la réplica

Con la réplica detenida, el primario espera la confirmación hasta el
tiempo límite de diez segundos y continúa en modo asíncrono:

```shell
docker compose stop mysql-replica
```

```shell
docker compose exec mysql-primary mysql -uroot -proot_local_2026 -e "CREATE DATABASE prueba_semisync;"
```

```shell
docker compose exec mysql-primary mysql -uroot -proot_local_2026 -e "SHOW GLOBAL STATUS LIKE 'Rpl_semi_sync_source_status';"
```

Se espera que CREATE DATABASE tarde unos diez segundos y que el estado
pase a OFF.

Volver a iniciar la réplica:

```shell
docker compose start mysql-replica
```

Cuando la réplica esté al día, el siguiente commit restablece el modo
semisíncrono. Eliminar la base de prueba y, unos segundos después,
consultar el estado:

```shell
docker compose exec mysql-primary mysql -uroot -proot_local_2026 -e "DROP DATABASE prueba_semisync;"
```

```shell
docker compose exec mysql-primary mysql -uroot -proot_local_2026 -e "SHOW GLOBAL STATUS LIKE 'Rpl_semi_sync_source_status'; SHOW GLOBAL STATUS LIKE 'Rpl_semi_sync_source_clients';"
```

Resultados esperados:
- Rpl_semi_sync_source_status: ON.
- Rpl_semi_sync_source_clients: 1.

### Reinicio de la réplica

Al reiniciarse, la réplica vuelve a registrarse como semisíncrona.
`replica.cnf` incluye `loose-rpl-semi-sync-replica-enabled=ON` para que
la opción esté activa antes de que la réplica se reconecte al primario.

```shell
docker compose restart mysql-replica
```

Cuando vuelva a estar healthy:

```shell
docker compose exec mysql-replica mysql -uroot -proot_local_2026 -e "SHOW GLOBAL STATUS LIKE 'Rpl_semi_sync_replica_status';"
```

```shell
docker compose exec mysql-primary mysql -uroot -proot_local_2026 -e "SHOW GLOBAL STATUS LIKE 'Rpl_semi_sync_source_clients';"
```

Resultados esperados:
- Rpl_semi_sync_replica_status: ON.
- Rpl_semi_sync_source_clients: 1.

## Topología de RabbitMQ

Exchanges:
- reservas.comandos: distribución mediante consistent hash.
- reservas.dlx: enrutamiento de errores de comandos.
- webhooks.eventos: enrutamiento de notificaciones.
- webhooks.dlx: enrutamiento de errores de notificaciones.

Colas:
- infraestructura.pruebas.
- reservas.comandos.0.
- reservas.dlq.
- webhooks.entregas.
- webhooks.dlq.
- webhooks.espera.10s.
- webhooks.espera.1m.
- webhooks.espera.5m.

Las colas de espera tienen TTL y reenvían los mensajes expirados
hacia webhooks.entregas.

La topología está preparada, pero todavía no existe un notificador
que envíe webhooks y gestione sus reintentos.

Consultar las colas:

```shell
docker compose exec rabbitmq rabbitmqctl list_queues name messages consumers
```

En reposo se espera un consumidor en infraestructura.pruebas.
Las colas destinadas a las reservas y webhooks todavía no tienen
consumidores de negocio.

### Prueba de espera de diez segundos

Con webhooks.espera.10s y webhooks.entregas vacías y sin consumidores,
ejecutar:

```shell
docker compose exec relay node src/probar-espera.js
```

El script:
1. Publica un mensaje persistente en webhooks.espera.10s.
2. Espera su llegada a webhooks.entregas.
3. Comprueba el identificador y el tiempo transcurrido.
4. Confirma el mensaje recibido.

Se espera un tiempo transcurrido de al menos diez segundos y el
resultado OK.

La prueba verifica TTL y enrutamiento; no verifica un envío de webhook
ni los intervalos de uno y cinco minutos.

## Logs

```shell
docker compose logs --tail=30 api worker
```

```shell
docker compose logs --tail=30 relay notificador
```

Relay y notificador deben informar sus conexiones con MySQL y RabbitMQ.

## Detener y reanudar

Detener los servicios conservando los contenedores y volúmenes:

```shell
docker compose stop
```

Reanudar:

```shell
docker compose up -d
```

Eliminar los contenedores y redes del proyecto conservando los volúmenes:

```shell
docker compose down
```

No utilizar `docker compose down -v` para una detención normal:
esa opción elimina los volúmenes y sus datos.

Los scripts iniciales de MySQL y PostgreSQL se ejecutan al inicializar
volúmenes vacíos. Editarlos no modifica automáticamente una base
ya inicializada.

## Problemas frecuentes

- `docker compose up` termina con
  `dependency failed to start: container ... is unhealthy`:
  en el primer arranque, un servicio puede no estar disponible a tiempo
  para los que dependen de él. Ejecutar nuevamente `docker compose up -d`
  y comprobar con `docker compose ps -a` que los nueve contenedores
  estén en ejecución.
- La réplica recién configurada responde `Unknown database 'reservas'`:
  todavía está aplicando las transacciones iniciales del primario.
  Esperar y consultar `Seconds_Behind_Source` en `SHOW REPLICA STATUS`.
- Alguno de los puertos 3000, 3001 o 15672 está en uso: detener el
  proceso que lo ocupa o cambiar el puerto publicado en
  `docker-compose.yml`.

## Credenciales locales

Las credenciales incluidas son exclusivamente para desarrollo local.

Administración de RabbitMQ:
- Usuario: demo.
- Contraseña: demo_local_2026.

MySQL:
- root: root_local_2026.
- api_app: api_local_2026.
- worker_app: worker_local_2026.
- relay_app: relay_local_2026.
- notificador_app: notificador_local_2026.
- replicador: replica_local_2026.

PostgreSQL:
- aula_admin: postgres_local_2026.
- aula_app: aula_local_2026.

## Limitaciones

- Todos los contenedores se ejecutan en un único equipo.
- No existe promoción automática de la réplica.
- La replicación semisíncrona puede pasar a asíncrona si vence el
  tiempo de espera configurado de diez segundos.
- No se garantiza ausencia de pérdida de datos ante cualquier fallo.
- Los healthchecks comprueban condiciones específicas de cada servicio;
  no sustituyen las pruebas de comunicación o replicación.
- El worker procesa mensajes de prueba, no reservas.
- Relay todavía no publica cambios del outbox.
- Notificador todavía no envía webhooks.
- Aula todavía no permite reservar cupos.
- La cola de prueba no está conectada a las DLQ de reservas o webhooks.
- Todos los componentes usan el mismo usuario de RabbitMQ; los permisos
  por componente se aplican solamente en MySQL.
- Worker, relay y notificador no tienen healthcheck; su estado se
  comprueba en los logs.

## Documentación

La propuesta de arquitectura y la documentación de las entregas
se encuentran en la carpeta `docs` de la raíz del repositorio.

Las evidencias de esta entrega se encuentran en:

[Evidencias de entrega 2](../docs/entrega-2/evidencias/README.md)