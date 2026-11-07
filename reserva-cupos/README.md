# Reserva de cupos — Entrega 3: comunicación síncrona y asíncrona

Proyecto final de Programación Distribuida y Componentes.
Grupo 15: Jonathan Mora Colodrero y María Constanza Gigli.

## Alcance

Esta entrega reemplaza los mensajes de prueba de la Entrega 2 por el
recorrido real de una reserva:

```
Aula ──HTTP──▶ API ──transacción──▶ MySQL (reserva + outbox)
                                       │
                         relay ◀───────┘ secuencia y publica
                           │
                           ▼
                RabbitMQ reservas.comandos ──▶ worker ──▶ MySQL (decisión + outbox)
```

Incluye:
- API pública v1 con autenticación por tenant, admisión `202` con
  `Idempotency-Key`, consultas, listado paginado y feed de cambios.
- Contrato OpenAPI 3.1 en [`contrato/openapi.yaml`](contrato/openapi.yaml).
- Outbox transaccional: la API y el worker escriben cada cambio en la
  tabla `cambios` dentro de la misma transacción; ninguno publica en
  RabbitMQ.
- Relay: secuenciador del feed, publicador de comandos con
  *publisher confirms* y barredor de reservas pendientes.
- Worker: comando `reservar` idempotente con descuento atómico del cupo.
- Aula: crea materias e inscribe alumnos a través de la API.
- Pruebas de concurrencia: comparación ingenua/atómica, ráfaga de 500
  solicitudes con k6 (con uno y con dos workers), duplicados simultáneos
  y reentrega de comandos.

Todavía no incluye: cancelación de reservas (`DELETE /v1/reservas/{id}`),
envío de webhooks, límite de tasa, contingencia y reconciliación de Aula.
Se incorporan en las Entregas 4 y 5.

## Requisitos

- Git.
- Docker Desktop iniciado, utilizando contenedores Linux.
- Docker Compose.
- Puertos locales 3000, 3001 y 15672 disponibles.

Node.js, MySQL, PostgreSQL, RabbitMQ y k6 se ejecutan dentro de
contenedores; no es necesario instalarlos en el equipo.

Los ejemplos con `curl` están escritos para bash o zsh. En Windows usar
`curl.exe` desde PowerShell o ejecutarlos en Git Bash o WSL.

## Componentes

| Servicio | Función en esta entrega |
|---|---|
| api | API pública v1. Escribe en MySQL; no usa RabbitMQ. |
| relay | Configura la topología, secuencia el outbox, publica comandos y barre pendientes. |
| worker | Consume `reservas.comandos.0` y decide cada reserva. |
| mysql-primary | Persistencia del servicio: tenants, actividades, reservas y cambios. |
| mysql-replica | Réplica semisíncrona en solo lectura. |
| rabbitmq | Exchange de hash consistente `reservas.comandos` y colas. |
| notificador | Sin cambios respecto de la Entrega 2 (comprueba conexiones). |
| aula | Cliente de referencia: materias e inscripciones por HTTP. |
| aula-db | Base propia de Aula (PostgreSQL). |
| k6 | Herramienta de pruebas de carga. Solo se ejecuta a pedido. |

Las redes no cambian: `publica`, `interna` y `tenant`. Aula llega a la
API por HTTP y no tiene ruta hacia MySQL ni RabbitMQ. El contenedor de
k6 está únicamente en la red `publica`: prueba el servicio igual que un
cliente externo.

## Inicio

### Obtener el código

```shell
git clone https://github.com/JoniMora/final-pdc.git
cd final-pdc
git checkout v3-comunicacion
cd reserva-cupos
```

### Volúmenes nuevos

Esta entrega modifica los scripts iniciales de MySQL (índice nuevo y
tenant de Aula) y de PostgreSQL (tabla `materias`). Los scripts solo se
ejecutan al inicializar volúmenes vacíos, así que una instalación que
viene de la Entrega 2 debe eliminar sus volúmenes:

```shell
docker compose down -v
```

Esto borra los datos locales de la Entrega 2.

### Levantar el entorno

```shell
docker compose up --build -d
docker compose ps -a
```

Cuando MySQL primario y réplica estén healthy, configurar la réplica
(una vez por instalación):

```shell
docker compose exec -T mysql-replica sh -c "mysql -uroot -proot_local_2026 < /configurar-replica.sql"
```

Si responde `Access denied`, la réplica todavía está inicializando:
esperar unos segundos y repetir.

Comprobar la replicación y el modo semisíncrono:

```shell
docker compose exec mysql-replica mysql -uroot -proot_local_2026 -e "SHOW REPLICA STATUS\G"
docker compose exec mysql-primary mysql -uroot -proot_local_2026 -e "SHOW GLOBAL STATUS LIKE 'Rpl_semi_sync_source_status'"
```

Se espera `Replica_IO_Running: Yes`, `Replica_SQL_Running: Yes` y
`Rpl_semi_sync_source_status: ON`. Hasta que la réplica esté configurada,
cada escritura espera el tiempo límite semisíncrono de diez segundos.

## Tenants y claves de API

Toda ruta `/v1` exige `Authorization: Bearer <clave>`. La base guarda
solo el hash SHA-256 de cada clave.

El tenant **Aula** se crea al inicializar MySQL. Su clave, solo para
desarrollo local, está en `docker-compose.yml`:

```bash
export CLAVE_AULA=rc_aula_5589268069a379faa72a98ae640f818c09fc6179adf5f2146bd97aadbb06bc42
```

Para crear otro tenant (las pruebas de carga usan uno propio):

```shell
docker compose exec mysql-primary mysql -uroot -proot_local_2026 reservas -e "SET @nombre = 'Pruebas de carga'; SOURCE /crear-tenant.sql"
```

El comando muestra `tenant_id`, `nombre` y `clave_api`. La clave se
genera con 256 bits aleatorios y no vuelve a mostrarse:

```bash
export CLAVE=<clave_api mostrada>
```

## API v1

| Método y ruta | Respuestas |
|---|---|
| `POST /v1/actividades` | `201` + `Location` · `400` · `401` |
| `GET /v1/actividades/{id}` | `200` · `404` |
| `PATCH /v1/actividades/{id}` (`{"estado":"cerrada"}`) | `200` · `400` · `404` |
| `POST /v1/actividades/{id}/reservas` (exige `Idempotency-Key`) | `202` + `Location` + `Retry-After` · `200` repetición · `409` · `422` |
| `GET /v1/reservas/{id}` | `200` (+ `Retry-After` si está pendiente) · `404` |
| `GET /v1/actividades/{id}/reservas?estado=&cursor=&limite=` | `200` |
| `GET /v1/cambios?desde=&limite=` | `200` |

Los errores son `application/problem+json` (RFC 9457). Si MySQL no
responde, la API devuelve `503` con `Retry-After`. Un recurso de otro
tenant responde `404`, igual que uno inexistente.

## Canal síncrono: Aula → API

Abrir http://localhost:3001 y:
1. Crear una materia con cupo. Aula llama a `POST /v1/actividades` y
   guarda la materia en su PostgreSQL.
2. Seleccionarla e inscribir un alumno. Aula llama a
   `POST /v1/actividades/{id}/reservas` con una `Idempotency-Key`
   generada en el navegador.
3. La página muestra la respuesta `202` con `Location` y consulta
   `GET /v1/reservas/{id}` respetando `Retry-After` hasta que el worker
   decide.

El mismo recorrido desde la terminal:

```bash
curl -s -X POST http://localhost:3000/v1/actividades \
  -H "Authorization: Bearer $CLAVE_AULA" -H "Content-Type: application/json" \
  -d '{"nombre":"Programación Distribuida","capacidad":2}'
```

```bash
export ACTIVIDAD=<id devuelto>

curl -s -i -X POST http://localhost:3000/v1/actividades/$ACTIVIDAD/reservas \
  -H "Authorization: Bearer $CLAVE_AULA" -H "Content-Type: application/json" \
  -H "Idempotency-Key: inscripcion-ana-1" -d '{"participante":"ana"}'
```

Se espera `HTTP/1.1 202 Accepted`, `Location: /v1/reservas/<id>` y la
reserva en estado `pendiente`. Consultar la `Location` un instante
después muestra `confirmada`. Repetir el mismo `POST` devuelve `200` con
la misma reserva; cambiar el participante con la misma clave devuelve
`422`.

## Canal asíncrono: outbox → relay → RabbitMQ → worker

```shell
docker compose logs --tail=20 relay worker
```

El relay informa `Secuenciados: N · comandos publicados: M` y el worker
`Reserva <id> (actividad <id>) confirmada` o `rechazada`.

### Worker detenido

```shell
docker compose stop worker
```

Las solicitudes siguen respondiendo `202` y los comandos quedan en
`reservas.comandos.0`:

```shell
docker compose exec rabbitmq rabbitmqctl list_queues name messages consumers
```

Al ejecutar `docker compose start worker`, las reservas pendientes se
deciden.

### RabbitMQ detenido

Con `docker compose stop rabbitmq`, la API sigue admitiendo y el relay
sigue secuenciando: el feed (`GET /v1/cambios`) avanza y los comandos
quedan en el outbox con `publicado_comando = 0`. Al ejecutar
`docker compose start rabbitmq`, el relay se reconecta y los publica.

## Caso de concurrencia: cupos de una misma actividad

### Comparación ingenua y atómica

Crear una actividad de prueba vacía y ejecutar la comparación dentro del
worker (usa el usuario `worker_app`):

```bash
ACTIVIDAD=$(curl -s -X POST http://localhost:3000/v1/actividades \
  -H "Authorization: Bearer $CLAVE" -H "Content-Type: application/json" \
  -d '{"nombre":"Demostración de concurrencia","capacidad":10}' | sed 's/.*"id":"\([^"]*\)".*/\1/')

docker compose exec worker node src/demostrar-concurrencia.js $ACTIVIDAD 50 0
```

Cincuenta transacciones compiten por diez cupos. La estrategia ingenua
(leer el cupo y después escribir el valor calculado) pierde
actualizaciones y asigna más lugares que la capacidad; la sentencia
condicional del worker asigna exactamente diez. El script restablece el
contador al terminar.

### Ráfaga de 500 solicitudes

```shell
docker compose run --rm k6 run -e API_KEY=$CLAVE /pruebas/carga/rafaga.js
```

El script crea una actividad de 10 cupos, envía 500 solicitudes
simultáneas con claves y participantes únicos, espera a que no queden
pendientes y verifica por la API: 10 confirmadas, 490 rechazadas,
0 pendientes y `cupos_disponibles = 0`. Termina con código distinto de
cero si algún control falla.

Con dos workers consumiendo la misma cola:

```shell
docker compose up -d --scale worker=2
docker compose run --rm k6 run -e API_KEY=$CLAVE /pruebas/carga/rafaga.js
docker compose up -d --scale worker=1
```

El resultado debe ser el mismo: la garantía la da el `UPDATE`
condicional de InnoDB, no la cantidad de consumidores.

Comprobación directa en MySQL:

```shell
docker compose exec mysql-primary mysql --default-character-set=utf8mb4 -uroot -proot_local_2026 reservas -e "SELECT a.nombre, a.capacidad, a.cupos_disponibles, r.estado, COUNT(*) AS reservas FROM actividades a JOIN reservas r ON r.actividad_id = a.id WHERE a.nombre LIKE 'Ráfaga%' GROUP BY a.id, r.estado ORDER BY a.creado_en, r.estado"
```

`--default-character-set=utf8mb4` es necesario para que el cliente
interprete la "á" del filtro: el contenedor no define un locale.

### Duplicados simultáneos

```shell
docker compose run --rm k6 run -e API_KEY=$CLAVE /pruebas/carga/duplicados.js
```

Veinte solicitudes simultáneas del mismo participante con claves
distintas producen una `202` y diecinueve `409`; veinte reintentos
simultáneos con la misma `Idempotency-Key` producen una `202` y
diecinueve `200`. La actividad termina con exactamente dos reservas.

### Reentrega de un comando

```shell
docker compose exec relay node src/reenviar-comando.js <reserva_id confirmada>
docker compose logs --tail=5 worker
```

El worker informa `comando repetido, sin cambios`; los cupos y la
versión de la reserva no cambian.

## Logs

```shell
docker compose logs --tail=30 api relay worker
```

## Detener y reanudar

```shell
docker compose stop
docker compose up -d
```

`docker compose down` elimina contenedores y redes y conserva los
volúmenes. `docker compose down -v` también elimina los datos.

## Problemas frecuentes

- `dependency failed to start: container ... is unhealthy` en el primer
  arranque: ejecutar nuevamente `docker compose up -d`.
- Las escrituras tardan diez segundos: la réplica no está configurada o
  está detenida, y el primario espera el tiempo límite semisíncrono.
- `401` en todas las rutas: la clave no corresponde a un tenant de esta
  instalación (por ejemplo, volúmenes de la Entrega 2).
- Aula responde "La base de Aula no esta disponible" y su log muestra
  `relation "materias" does not exist`: volúmenes creados con los
  scripts de la Entrega 2.
- Alguno de los puertos 3000, 3001 o 15672 está en uso: detener el
  proceso que lo ocupa o cambiar el puerto publicado en
  `docker-compose.yml`.

## Credenciales locales

Exclusivamente para desarrollo local.

- Clave de API de Aula:
  `rc_aula_5589268069a379faa72a98ae640f818c09fc6179adf5f2146bd97aadbb06bc42`.
- RabbitMQ: demo / demo_local_2026.
- MySQL: root_local_2026; api_app, worker_app, relay_app,
  notificador_app y replicador con las contraseñas de
  `docker-compose.yml` y `02-usuarios.sql`.
- PostgreSQL: aula_admin / postgres_local_2026; aula_app / aula_local_2026.

## Limitaciones

- La admisión durable está acotada por el `COMMIT` semisíncrono: en el
  equipo de prueba, una ráfaga de 500 se admite completa en 8 a 16
  segundos según la corrida (ver evidencias 06 y 07); cada solicitud
  espera su turno en el pool de conexiones de la API.
- Con dos workers sobre la misma cola no se garantiza el orden de
  llegada: la no sobreasignación se mantiene, pero una solicitud
  posterior puede obtener el último cupo. El particionado por actividad
  (un consumidor por partición) se mide en la Entrega 6.
- Sin cancelación, webhooks, límite de tasa ni contingencia de Aula.
- Errores de datos del worker van a `reservas.dlq`; la reserva queda
  pendiente (el estado `fallida` se incorpora en la Entrega 4).
- Si Aula no puede guardar una materia en PostgreSQL después de crearla
  en el servicio, la actividad queda sin materia local hasta la
  reconciliación de la Entrega 5.
- Todos los contenedores se ejecutan en un único equipo y el failover
  de MySQL es manual.

## Documentación

- [Certificación y evidencias de la Entrega 3](../docs/entrega-3/README.md)
- [Contrato OpenAPI](contrato/openapi.yaml)
- Las pruebas de infraestructura de la Entrega 2 (permisos, semisync,
  colas de espera) siguen disponibles en el tag `v2.1-infraestructura`.
