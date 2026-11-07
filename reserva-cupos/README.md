# Reserva de cupos — Entrega 4: contratos de interfaz y descubrimiento de servicios

Proyecto final de Programación Distribuida y Componentes.
Grupo 15: Jonathan Mora Colodrero y María Constanza Gigli.

## Alcance

Sobre el recorrido de la Entrega 3, esta entrega formaliza cómo se comunican los componentes y agrega un gateway con descubrimiento de servicios:

```
                 contrato/openapi.yaml (REST + webhooks)
Aula ──HTTP──▶ Traefik ──▶ API (N instancias) ──transacción──▶ MySQL (reserva + outbox)
 ▲                (descubre por Docker)                           │
 │                                             relay ◀────────────┘ secuencia y publica
 │                                               │  contrato/asyncapi.yaml (AMQP)
 │                         reservas.comandos ◀───┤───▶ webhooks.eventos
 │                               │                          │
 │                            worker                   notificador
 │                         reservar/cancelar               │
 └──────────── webhook firmado (X-Firma, HMAC-SHA256) ──────┘
```

Incluye:
- **Contratos formales.** [`contrato/openapi.yaml`](contrato/openapi.yaml) 1.1.0 (API pública y webhooks) y [`contrato/asyncapi.yaml`](contrato/asyncapi.yaml) 1.0.0 (mensajes de RabbitMQ), con su [CHANGELOG](contrato/CHANGELOG.md). La documentación se publica en GitHub Pages.
- **Validación contra el contrato en cada componente.** La API valida solicitudes y respuestas con `express-openapi-validator`; el relay, el worker y el notificador validan cada mensaje; Aula arma cada llamada a partir del contrato y valida las respuestas. La validación de mensajes y respuestas vive en el módulo [`compartido/`](compartido/src/contrato.js).
- **Descubrimiento de servicios con Traefik.** Encuentra las instancias de la API por etiquetas de Docker, les hace health check y balancea; escalar no requiere configuración.
- **Cancelación asíncrona:** `POST /v1/reservas/{id}/cancelacion` → comando `cancelar` → el worker devuelve el cupo.
- **Webhooks firmados:** el notificador entrega cada decisión con `X-Firma`, reintenta a los 10 s, 1 min y 5 min, deriva a `webhooks.dlq` y protege contra SSRF. Aula verifica la firma y mantiene su proyección local.
- **Estado `fallida`** para reservas cuyo comando falla por un error de datos después de los reintentos.
- **Verificación automática del desacople:** pruebas `node:test` en cada componente, Aula contra un mock de Prism generado del contrato, Schemathesis contra la API real y oasdiff contra `main` en cada PR.

Todavía no incluye: límite de tasa, autenticación de personas y permisos, TLS, contingencia y reconciliación de Aula (Entrega 5).

## Requisitos

- Git.
- Docker Desktop iniciado, utilizando contenedores Linux, con Docker Compose 2.17 o superior (los servicios usan contextos de build adicionales).
- Puertos locales 3000, 3001, 8080 y 15672 disponibles.
- Para correr las pruebas fuera de Docker: Node.js 22 o superior.

Node.js, MySQL, PostgreSQL, RabbitMQ, Traefik y k6 se ejecutan dentro de contenedores.

Los ejemplos con `curl` están escritos para bash o zsh. En Windows usar `curl.exe` desde PowerShell o ejecutarlos en Git Bash o WSL.

## Componentes

| Servicio | Función en esta entrega |
|---|---|
| traefik | Gateway y descubrimiento de servicios. Único punto de entrada HTTP a la API (puerto 3000 del host); panel en el 8080. |
| api | API pública v1. Valida cada solicitud contra el contrato. Sin puerto propio: se escala con `--scale api=N`. |
| relay | Topología de RabbitMQ, secuenciador del feed, publicador de comandos y de entregas de webhook, barredor de pendientes. |
| worker | Consume `reservas.comandos.0`: comandos `reservar` y `cancelar`. |
| notificador | Entrega los webhooks firmados con reintentos escalonados. |
| mysql-primary | Persistencia del servicio: tenants, actividades, reservas y cambios. |
| mysql-replica | Réplica semisíncrona en solo lectura. |
| rabbitmq | Comandos, entregas de webhook, colas de espera y DLQ. |
| aula | Cliente de referencia: materias, inscripciones, cancelaciones y receptor de webhooks. |
| aula-db | Base propia de Aula (PostgreSQL), con la proyección local de las inscripciones. |
| k6 | Herramienta de pruebas de carga. Solo se ejecuta a pedido. |

Las redes no cambian: `publica`, `interna` y `tenant`. Traefik está solo en `publica`. El notificador llega a Aula por `publica`, como llegaría a cualquier tenant en internet.

## Inicio

### Obtener el código

```shell
git clone https://github.com/JoniMora/final-pdc.git
cd final-pdc
git checkout v4-middleware
cd reserva-cupos
```

### Volúmenes nuevos

Esta entrega modifica los scripts iniciales de MySQL (índice de cambios por entidad y webhook del tenant Aula) y de PostgreSQL (proyección de inscripciones). Una instalación que viene de una entrega anterior debe eliminar sus volúmenes:

```shell
docker compose down -v
```

### Levantar el entorno

```shell
docker compose up --build -d
docker compose ps -a
```

Cuando MySQL primario y réplica estén healthy, configurar la réplica (una vez por instalación):

```shell
docker compose exec -T mysql-replica sh -c "mysql -uroot -proot_local_2026 < /configurar-replica.sql"
```

Si responde `Access denied`, la réplica todavía está inicializando: esperar unos segundos y repetir.

Comprobar la replicación y el modo semisíncrono:

```shell
docker compose exec mysql-replica mysql -uroot -proot_local_2026 -e "SHOW REPLICA STATUS\G"
docker compose exec mysql-primary mysql -uroot -proot_local_2026 -e "SHOW GLOBAL STATUS LIKE 'Rpl_semi_sync_source_status'"
```

Se espera `Replica_IO_Running: Yes`, `Replica_SQL_Running: Yes` y `Rpl_semi_sync_source_status: ON`. Hasta que la réplica esté configurada, cada escritura espera el tiempo límite semisíncrono de diez segundos.

### Accesos

| Qué | Dónde |
|---|---|
| API v1 (a través de Traefik) | http://localhost:3000 |
| Aula | http://localhost:3001 |
| Panel de Traefik: servicios descubiertos | http://localhost:8080 |
| Administración de RabbitMQ | http://localhost:15672 (demo / demo_local_2026) |

## Tenants y claves de API

Toda ruta `/v1` exige `Authorization: Bearer <clave>`. La base guarda solo el hash SHA-256 de cada clave.

El tenant **Aula** se crea al inicializar MySQL, con su URL de webhook (`http://aula:3001/webhooks/reservas`) y el secreto con el que se firman. La clave y el secreto, solo para desarrollo local, están en `docker-compose.yml`:

```bash
export CLAVE_AULA=rc_aula_5589268069a379faa72a98ae640f818c09fc6179adf5f2146bd97aadbb06bc42
```

Para crear otro tenant (las pruebas de carga y Schemathesis usan uno propio):

```shell
docker compose exec mysql-primary mysql -uroot -proot_local_2026 reservas -e "SET @nombre = 'Pruebas de carga'; SOURCE /crear-tenant.sql"
```

El comando muestra `tenant_id`, `nombre` y `clave_api`. La clave se genera con 256 bits aleatorios y no vuelve a mostrarse:

```bash
export CLAVE=<clave_api mostrada>
```

## API v1

El contrato completo está en [`contrato/openapi.yaml`](contrato/openapi.yaml). Resumen:

| Método y ruta | Respuestas |
|---|---|
| `POST /v1/actividades` | `201` + `Location` · `400` · `401` · `415` |
| `GET /v1/actividades/{id}` | `200` · `400` · `404` |
| `PATCH /v1/actividades/{id}` (`{"estado":"cerrada"}`) | `200` · `400` · `404` · `415` |
| `POST /v1/actividades/{id}/reservas` (exige `Idempotency-Key`) | `202` + `Location` + `Retry-After` · `200` repetición · `409` · `422` |
| `GET /v1/reservas/{id}` | `200` (+ `Retry-After` si está pendiente) · `400` · `404` |
| `POST /v1/reservas/{id}/cancelacion` | `202` + `Location` · `200` ya cancelada · `409` rechazada o fallida |
| `GET /v1/actividades/{id}/reservas?estado=&cursor=&limite=` | `200` · `400` |
| `GET /v1/cambios?desde=&limite=` | `200` · `400` |

Los errores son `application/problem+json` (RFC 9457). Una solicitud que no cumple el contrato responde `400` (o `405`/`415`) antes de llegar a la ruta. Si MySQL no responde, la API devuelve `503` con `Retry-After`. Un recurso de otro tenant responde `404`, igual que uno inexistente.

En desarrollo (`VALIDAR_RESPUESTAS=true` en `docker-compose.yml`) la API también valida cada respuesta: una que no cumpla el contrato se registra y se responde `500`.

## Descubrimiento de servicios

Traefik observa Docker y registra cada contenedor con la etiqueta `traefik.enable`. Escalar la API no requiere tocar configuración:

```shell
docker compose up -d --scale api=3 --no-recreate api
curl -s http://localhost:8080/api/http/services/api@docker
for i in $(seq 1 9); do curl -s http://localhost:3000/health; echo; done
```

El panel muestra tres servidores `UP` y `/health` informa la `instancia` que atendió cada solicitud. Si una instancia se detiene, Traefik deja de enviarle tráfico. Para volver a una instancia: `docker compose up -d --scale api=1 api`.

## Cancelación y webhooks

Desde Aula (http://localhost:3001): crear una materia, inscribir alumnos y usar **Cancelar esta inscripción**. La sección *Cupos e inscriptos* muestra lo que informa la API y lo que tiene la base de Aula, actualizada por los webhooks.

Desde la terminal:

```bash
curl -s -i -X POST http://localhost:3000/v1/reservas/$RESERVA/cancelacion -H "Authorization: Bearer $CLAVE_AULA"
docker compose logs --tail=10 worker notificador aula
```

El worker informa `cancelada, cupo devuelto`, el notificador `reserva.cancelada entregado a aula:3001 (204)` y Aula `Webhook N: reserva.cancelada v3 aplicado`.

Reintentos: con `docker compose stop aula`, las entregas pasan por `webhooks.espera.10s`, `webhooks.espera.1m` y `webhooks.espera.5m` y, agotadas, quedan en `webhooks.dlq`:

```shell
docker compose exec rabbitmq rabbitmqctl list_queues name messages
```

## Pruebas

### Pruebas de cada componente

```shell
(cd compartido && npm ci)
for c in compartido servicios/api servicios/worker servicios/relay servicios/notificador clientes/aula; do (cd $c && npm ci && npm test); done
```

### Aula contra un mock del contrato

```shell
docker run -d --name prism-mock -p 4010:4010 -v "$PWD/contrato:/contrato:ro" stoplight/prism:5 mock -d -m false -h 0.0.0.0 /contrato/openapi.yaml
(cd clientes/aula && PRISM_URL=http://localhost:4010 npm test)
docker rm -f prism-mock
```

### La API contra el contrato (Schemathesis)

Con el entorno levantado y la clave de un tenant propio en `$CLAVE`:

```shell
docker run --rm --network reserva-cupos-infra_publica \
  -v "$PWD/contrato:/contrato:ro" -v "$PWD/pruebas/contrato:/config:ro" \
  schemathesis/schemathesis:4.33.1 --config-file /config/schemathesis.toml \
  run /contrato/openapi.yaml --url http://traefik -H "Authorization: Bearer $CLAVE" \
  --checks all --max-examples 25 --seed 2026 --generation-with-security-parameters false
```

### Cambios incompatibles del contrato

```shell
pruebas/contrato/oasdiff.sh v3-comunicacion
```

Compara `contrato/openapi.yaml` con el de otra versión (tag, rama o commit) y falla si encuentra un cambio incompatible. El CI lo ejecuta contra `main` en cada PR.

### Caso de concurrencia (Entrega 3)

Las pruebas de la Entrega 3 siguen vigentes y ahora pasan por Traefik:

```shell
docker compose run --rm k6 run -e API_KEY=$CLAVE /pruebas/carga/rafaga.js
docker compose run --rm k6 run -e API_KEY=$CLAVE /pruebas/carga/duplicados.js
```

La ráfaga verifica 10 confirmadas, 490 rechazadas, 0 pendientes y `cupos_disponibles = 0`, también con varias instancias de la API (`--scale api=2`) o del worker (`--scale worker=2`). La comparación ingenua/atómica y la reentrega de comandos se ejecutan como en la Entrega 3 (`docker compose exec worker node src/demostrar-concurrencia.js` y `docker compose exec relay node src/reenviar-comando.js`).

## Integración continua

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) corre en cada PR:

| Trabajo | Qué verifica |
|---|---|
| Contratos | OpenAPI y AsyncAPI válidos; sin cambios incompatibles respecto de `main` (oasdiff). |
| Pruebas | `npm test` en cada componente. |
| Aula contra el mock del contrato | El consumidor funciona solo con el contrato (Prism). |
| Integración | Schemathesis contra la API real detrás de Traefik y la ráfaga de 500 sobre 10 cupos. |

[`.github/workflows/documentacion.yml`](../.github/workflows/documentacion.yml) publica la documentación de los contratos en GitHub Pages cuando cambian en `main`.

## Logs

```shell
docker compose logs --tail=30 api relay worker notificador aula
```

## Detener y reanudar

```shell
docker compose stop
docker compose up -d
```

`docker compose down` elimina contenedores y redes y conserva los volúmenes. `docker compose down -v` también elimina los datos.

## Problemas frecuentes

- `dependency failed to start: container ... is unhealthy` en el primer arranque: ejecutar nuevamente `docker compose up -d`.
- Las escrituras tardan diez segundos: la réplica no está configurada o está detenida, y el primario espera el tiempo límite semisíncrono.
- `401` en todas las rutas: la clave no corresponde a un tenant de esta instalación (por ejemplo, volúmenes de otra entrega).
- `404` en `http://localhost:3000` recién levantado: Traefik todavía no registró la API (espera su health check); reintentar en unos segundos.
- `additional_contexts` no reconocido al construir: actualizar Docker Compose a 2.17 o superior.
- Aula informa `relation "inscripciones" does not exist`: volúmenes creados con los scripts de una entrega anterior.
- Alguno de los puertos 3000, 3001, 8080 o 15672 está en uso: detener el proceso que lo ocupa o cambiar el puerto publicado en `docker-compose.yml`.

## Credenciales locales

Exclusivamente para desarrollo local.

- Clave de API de Aula: `rc_aula_5589268069a379faa72a98ae640f818c09fc6179adf5f2146bd97aadbb06bc42`.
- Secreto del webhook de Aula: `WEBHOOK_SECRET` en `docker-compose.yml` (y su `UNHEX` en `03-tenants.sql`).
- RabbitMQ: demo / demo_local_2026.
- MySQL: root_local_2026; api_app, worker_app, relay_app, notificador_app y replicador con las contraseñas de `docker-compose.yml` y `02-usuarios.sql`.
- PostgreSQL: aula_admin / postgres_local_2026; aula_app / aula_local_2026.

## Limitaciones

- La admisión durable está acotada por el `COMMIT` semisíncrono: una ráfaga de 500 se admite completa en 8 a 16 segundos según la corrida. Agregar instancias de la API no la acelera; se mide en la Entrega 6.
- Con dos workers sobre la misma cola no se garantiza el orden de llegada; el particionado por actividad se mide en la Entrega 6.
- La URL y el secreto de webhook de un tenant se cargan por SQL; la API de administración llega en la Entrega 5.
- El panel de Traefik (8080) no tiene autenticación y Traefik monta el socket de Docker en solo lectura; ambos se protegen en la Entrega 5. Sin TLS ni límite de tasa.
- Aula guarda la última secuencia recibida por webhook; la reconciliación desde el feed y el modo contingencia llegan en la Entrega 5.
- Todos los contenedores se ejecutan en un único equipo y el failover de MySQL es manual.

## Documentación

- [Certificación y evidencias de la Entrega 4](../docs/entrega-4/README.md)
- [Contratos](contrato/) y su [historial de versiones](contrato/CHANGELOG.md)
- [Entrega 3](../docs/entrega-3/README.md): comunicación síncrona y asíncrona y caso de concurrencia.
- Las pruebas de infraestructura de la Entrega 2 (permisos, semisync, colas de espera) siguen disponibles en el tag `v2.1-infraestructura`.
