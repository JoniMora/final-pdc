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

Los comandos siguientes pueden ejecutarse en la terminal de IntelliJ.

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

Desde la raíz del repositorio, ingresar a la carpeta de la aplicación:

```powershell
cd reserva-cupos
```

Validar la configuración:

```powershell
docker compose config --quiet
```

Construir las imágenes y levantar los servicios:

```powershell
docker compose up --build -d
```

Comprobar el estado:

```powershell
docker compose ps -a
```

La primera construcción puede tardar porque descarga imágenes e instala
dependencias.

### Configurar la réplica en una instalación nueva

Cuando MySQL primario y réplica aparezcan como healthy, ejecutar:

```powershell
docker compose exec -T mysql-replica sh -c "mysql -uroot -proot_local_2026 < /configurar-replica.sql"
```

Este paso se realiza una sola vez por instalación con volúmenes nuevos.
La configuración se conserva en el volumen de la réplica.

No es necesario repetirlo al detener y volver a iniciar los contenedores.

Comprobar la replicación:

```powershell
docker compose exec mysql-replica mysql -uroot -proot_local_2026 -e "SHOW REPLICA STATUS\G"
```

Resultados esperados:
- Replica_IO_Running: Yes.
- Replica_SQL_Running: Yes.
- Last_IO_Error y Last_SQL_Error vacíos.
- Seconds_Behind_Source: 0 cuando termine de aplicar los cambios.

Comprobar el estado semisíncrono en el primario:

```powershell
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

```powershell
docker compose logs --tail=20 worker
```

El identificador del mensaje recibido por el worker debe coincidir con
el identificador mostrado en la respuesta de la interfaz.

También se puede probar directamente desde la terminal:

```powershell
Invoke-RestMethod -Uri http://localhost:3000/health
```

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/pruebas/mensajes -ContentType "application/json" -Body '{"texto":"Mensaje de prueba"}'
```

## Independencia y persistencia de PostgreSQL

Detener únicamente la base de Aula:

```powershell
docker compose stop aula-db
```

Desde la interfaz, enviar un mensaje al servicio.

El mensaje puede seguir el recorrido Aula → API → RabbitMQ → worker
aunque PostgreSQL esté detenido. Guardar o consultar registros de Aula
requiere que PostgreSQL esté disponible.

Comprobar el mensaje:

```powershell
docker compose logs --tail=20 worker
```

Volver a iniciar PostgreSQL:

```powershell
docker compose start aula-db
```

Cuando esté disponible, actualizar el estado y consultar los registros.

Los registros anteriores permanecen almacenados en el volumen.
Esta prueba demuestra independencia del envío de mensajes respecto
de PostgreSQL; no implementa reconciliación de reservas.

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

```powershell
docker compose exec mysql-replica mysql -uroot -proot_local_2026 -e "SHOW TABLES FROM reservas; SELECT @@global.read_only, @@global.super_read_only;"
```

Ambas variables de solo lectura deben valer 1.

### Prueba de permisos

La API no debe poder modificar los cupos:

```powershell
docker compose exec mysql-primary mysql -uapi_app -papi_local_2026 -e "UPDATE reservas.actividades SET cupos_disponibles = cupos_disponibles WHERE 1 = 0;"
```

Se espera un error de permiso UPDATE denegado.

El worker sí tiene ese permiso:

```powershell
docker compose exec mysql-primary mysql -uworker_app -pworker_local_2026 -e "UPDATE reservas.actividades SET cupos_disponibles = cupos_disponibles WHERE 1 = 0;"
```

Se espera que termine sin error.
La condición WHERE 1 = 0 evita modificar filas en ambas pruebas.

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

```powershell
docker compose exec rabbitmq rabbitmqctl list_queues name messages consumers
```

En reposo se espera un consumidor en infraestructura.pruebas.
Las colas destinadas a las reservas y webhooks todavía no tienen
consumidores de negocio.

### Prueba de espera de diez segundos

Con webhooks.espera.10s y webhooks.entregas vacías y sin consumidores,
ejecutar:

```powershell
docker compose exec relay node src/probar-espera.js
```

El script:
1. Publica un mensaje persistente en webhooks.espera.10s.
2. Espera su llegada a webhooks.entregas.
3. Comprueba el identificador y el tiempo transcurrido.
4. Confirma el mensaje recibido.

La prueba realizada obtuvo una espera de 10,09 segundos y terminó
con el resultado OK.

La prueba verifica TTL y enrutamiento; no verifica un envío de webhook
ni los intervalos de uno y cinco minutos.

## Logs

```powershell
docker compose logs --tail=30 api worker
```

```powershell
docker compose logs --tail=30 relay notificador
```

Relay y notificador deben informar sus conexiones con MySQL y RabbitMQ.

## Detener y reanudar

Detener los servicios conservando los contenedores y volúmenes:

```powershell
docker compose stop
```

Reanudar:

```powershell
docker compose up -d
```

Eliminar los contenedores y redes del proyecto conservando los volúmenes:

```powershell
docker compose down
```

No utilizar `docker compose down -v` para una detención normal:
esa opción elimina los volúmenes y sus datos.

Los scripts iniciales de MySQL y PostgreSQL se ejecutan al inicializar
volúmenes vacíos. Editarlos no modifica automáticamente una base
ya inicializada.

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

## Documentación

La propuesta de arquitectura y la documentación de las entregas
se encuentran en la carpeta `docs` de la raíz del repositorio.

El informe de esta entrega se encuentra en:

[Informe de entrega 2](../docs/entrega-2/informe.md)