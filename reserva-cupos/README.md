# Reserva de cupos — Entrega 6: patrones y escalabilidad

Proyecto final de Programación Distribuida y Componentes.
Grupo 15: Jonathan Mora Colodrero y María Constanza Gigli.

## Alcance

Sobre la Entrega 5 (seguridad y confiabilidad), esta entrega hace que el sistema escale horizontalmente y lo mide:

- **API sin estado:** el límite de tasa (token bucket atómico en Lua) y la caché de autenticación (*cache-aside* con invalidación por generación) pasan a **Redis**, así que N instancias detrás de Traefik se comportan como una sola.
- **Comandos particionados por actividad:** N colas en el exchange de hash consistente, un worker exclusivo por partición; el orden por actividad se conserva.
- **Circuit breaker por tenant** en el notificador (opossum): un receptor caído deja de recibir intentos y sus eventos esperan sin gastar reintentos.
- **Admisión por lotes:** las reservas de una ráfaga comparten un commit semisincrónico, sin responder antes de persistir.
- **Observabilidad:** métricas de cada componente en **Prometheus** y un dashboard provisionado en **Grafana**, todo por HTTPS.
- **Carga y fallos medidos con k6:** escenarios caliente, multitenant y rampa con informes HTML; curva con 1, 2 y 4 API; una API y un worker detenidos durante la ráfaga.

La documentación de los patrones, las mediciones y las evidencias están en [`docs/entrega-6`](../docs/entrega-6/README.md).

### Base: seguridad y confiabilidad (Entrega 5)

Identidad y permisos, cifrado de cada enlace y comportamiento ante la falla de cada componente:

```
navegador ──HTTPS──▶ Aula ──HTTPS──▶ Traefik ──HTTPS──▶ API (N) ──TLS──▶ MySQL primario ──TLS──▶ réplica
 (login, rol,         │ TLS            ▲  lee Docker por             │ outbox         (semisíncrona)
  CSRF)               ▼                │  socket-proxy (solo GET)    ▼
                   aula-db                                  relay ──AMQPS──▶ RabbitMQ ──AMQPS──▶ worker
                      ▲                                                          │
                      └──────────── webhook HTTPS + HMAC ◀── notificador ◀──AMQPS┘
```

Incluye:
- **Personas de Aula** con login (contraseñas scrypt con sal), sesión del lado del servidor, CSRF y dos roles: el administrador crea materias y gestiona inscripciones; el alumno se inscribe y cancela solo lo propio.
- **Permisos por clave de API (scopes)**, declarados por operación en el contrato 1.2.0 y aplicados por la API leyendo esa declaración: `actividades:escribir`, `reservas:escribir`, `lectura`, `cambios:leer`.
- **Administración de tenants** (`/admin/v1/tenants`) con una clave de operador: alta, permisos, webhook, límite de tasa y rotación de la clave. Reemplaza a `crear-tenant.sql`.
- **Límite de tasa por tenant** (token bucket): `429` con `Retry-After`, sin afectar a otros tenants. Desde la Entrega 6 es global (Redis).
- **TLS en todos los saltos**, con una CA local y verificación de identidad en cada cliente: HTTPS (navegador, Traefik, API, webhooks), AMQPS, MySQL con `require_secure_transport`, replicación con `SOURCE_SSL` y PostgreSQL con `pg_hba` que rechaza el texto plano.
- **Traefik sin el socket de Docker:** lo consulta por un proxy que solo permite lecturas.
- **Contingencia y reconciliación de Aula:** con `aula-db` caída, el catálogo sale del feed y las inscripciones siguen; al volver, un ciclo aplica `/v1/cambios` desde su propio punto de control.
- **Matriz de fallos** con un arnés que detiene cada componente con carga en curso y verifica las invariantes, incluido el **failover del primario** con RTO y RPO medidos.

La certificación, el informe de amenazas y las evidencias de la Entrega 5 están en [`docs/entrega-5`](../docs/entrega-5/README.md).

## Requisitos

- Git.
- Docker Desktop iniciado, utilizando contenedores Linux, con Docker Compose 2.17 o superior.
- Node.js 22 o superior (scripts de preparación, operación y pruebas).
- OpenSSL. En macOS y Linux viene instalado; en Windows sirve el que trae Git (el script lo busca solo) o se indica con `OPENSSL=<ruta>`.
- Puertos locales 3000, 3001, 3002, 8080, 9090 y 15672 disponibles.

Los comandos son los mismos en bash, zsh, PowerShell y la terminal de IntelliJ: todo se opera con `node scripts/sistema.js <acción>`.

## Componentes

| Servicio | Función |
|---|---|
| traefik | Gateway y descubrimiento de servicios. Única entrada a la API: `https://localhost:3000`. Panel por HTTPS en el 8080. |
| socket-proxy | Expone a Traefik solo las lecturas de la API de Docker (contenedores, eventos, versión). Cualquier escritura responde 403. |
| api | API pública v1 y administración de tenants. Solo HTTPS; sin puerto propio: se escala con `--scale api=N`. |
| relay | Topología de RabbitMQ, secuenciador del feed, publicador de comandos y de entregas de webhook, barredor de pendientes. |
| worker | Consume una partición (`reservas.comandos.<n>`) como consumidor exclusivo: comandos `reservar` y `cancelar`. El Compose base levanta una partición; `docker-compose.particiones.yml` agrega `worker-p1` a `worker-p3` para cuatro. |
| notificador | Entrega los webhooks firmados por HTTPS, con reintentos escalonados, un circuit breaker por tenant y protección contra SSRF. |
| redis | Límite de tasa global y caché de autenticación de la API. Solo TLS, en la red interna, sin puerto publicado. |
| prometheus | Recolecta por HTTPS las métricas de la API, el worker, el relay, el notificador, RabbitMQ y Traefik. `https://localhost:9090`, solo en 127.0.0.1. |
| grafana | Dashboard provisionado sobre Prometheus. `https://localhost:3002`, solo en 127.0.0.1, con la contraseña generada por `preparar`. |
| mysql-primary | Persistencia del servicio. Exige TLS en toda conexión por red. |
| mysql-replica | Réplica semisíncrona en solo lectura, conectada por TLS. Se promueve en el failover. |
| rabbitmq | Solo AMQPS (5671) y administración por HTTPS. |
| aula | Cliente de referencia con login y roles, receptor de webhooks y reconciliación por feed. |
| aula-db | Base propia de Aula (PostgreSQL), solo por TLS. |
| k6 | Pruebas de carga. Solo se ejecuta a pedido. |

Redes: `publica`, `interna` y `tenant` como en la Entrega 4, más `docker` (interna, sin salida) entre Traefik y el proxy del socket.

## Inicio

### Obtener el código

```shell
git clone https://github.com/JoniMora/final-pdc.git
cd final-pdc
git checkout v6-escalabilidad
cd reserva-cupos
```

### Todo con un comando

```shell
node scripts/sistema.js demo                    # una partición de comandos
node scripts/sistema.js demo --particiones 4    # cuatro, como las pruebas de la Entrega 6
```

Desde volúmenes vacíos o sobre una instalación existente: genera lo que falte en `seguridad/local/`, construye y levanta todo, configura la réplica y la contraseña de Grafana, crea un tenant para la demo (su clave queda en `seguridad/local/tenant-demo.key`) y comprueba que la API, Aula, la replicación semisincrónica, las particiones y Prometheus respondan. No borra volúmenes. Es lo que corre el CI en cada PR. Los pasos por separado se describen a continuación.

### Volúmenes nuevos

La Entrega 6 no cambia los scripts iniciales de las bases: una instalación de la Entrega 5 conserva sus volúmenes (Redis, Prometheus y Grafana crean los suyos). La Entrega 5 sí los cambió (permisos y límite por tenant, usuario `admin_app`, webhook de Aula por HTTPS, punto de control del feed), así que una instalación de la Entrega 4 o anterior debe eliminarlos:

```shell
docker compose down -v
```

### Preparar la seguridad local (una vez)

```shell
node scripts/sistema.js preparar
```

Genera en `seguridad/local/` (excluido de Git) la CA de desarrollo, un certificado por servicio, las identidades de Aula con contraseñas aleatorias, la clave del operador y la contraseña del administrador de Grafana. Las credenciales quedan en `seguridad/local/accesos-locales.txt`. Es repetible: no reemplaza lo que ya existe. Sin este paso el entorno no arranca, porque cada certificado se monta como un archivo que tiene que existir.

### Levantar el entorno

```shell
node scripts/sistema.js levantar
node scripts/sistema.js estado
```

`levantar` construye y arranca todo, espera a que cada servicio esté healthy, configura la réplica con TLS (una vez por instalación) y fija la contraseña del admin de Grafana (también en un volumen anterior, que tenía la de fábrica). `estado` muestra los contenedores y la replicación.

Con cuatro particiones de comandos (lo que usan las pruebas de la Entrega 6):

```shell
node scripts/verificar-e6.js levantar
```

Para volver a una partición basta con `node scripts/sistema.js levantar`: el relay desenlaza las colas sobrantes y reenvía sus comandos pendientes a la partición 0 antes de publicar.

### Accesos

| Qué | Dónde |
|---|---|
| API v1 y administración (a través de Traefik) | https://localhost:3000 |
| Aula | https://localhost:3001 (usuarios en `seguridad/local/accesos-locales.txt`) |
| Panel de Traefik: servicios descubiertos | https://localhost:8080/dashboard/ |
| Administración de RabbitMQ | https://localhost:15672 (demo / demo_local_2026) |
| Prometheus | https://localhost:9090 |
| Grafana: dashboard "Reserva de cupos" | https://localhost:3002 (admin; contraseña en `seguridad/local/accesos-locales.txt`) |

Todos usan certificados de la CA local. Desde la terminal, `curl --cacert seguridad/local/ca.crt ...`. Para que el navegador no advierta, confiar en `seguridad/local/ca.crt` desde el administrador de certificados del sistema; es una CA solo para este entorno y su clave privada no sale de `seguridad/local/`.

## Tenants, claves y permisos

Toda ruta `/v1` exige `Authorization: Bearer <clave>`. La base guarda solo el hash SHA-256 de cada clave.

El tenant **Aula** se crea al inicializar MySQL, con su webhook (`https://aula:3001/webhooks/reservas`), los cuatro permisos y un límite propio (500/s, ráfaga 1500). Su clave y su secreto de webhook, solo para desarrollo local, están en `docker-compose.yml`.

Los demás tenants los crea el operador con la API de administración. El atajo:

```shell
CLAVE=$(node scripts/sistema.js tenant "Pruebas de carga" --limite 1000/1000)
LECTOR=$(node scripts/sistema.js tenant "Solo lectura" --scopes lectura,cambios:leer)
```

o directamente:

```shell
curl --cacert seguridad/local/ca.crt -X POST https://localhost:3000/admin/v1/tenants \
  -H "Authorization: Bearer $(cat seguridad/local/admin.key)" -H "Content-Type: application/json" \
  -d '{"nombre":"Mi tenant","scopes":["lectura","reservas:escribir"],"webhook_url":"https://tenant.ejemplo/webhooks"}'
```

La respuesta trae `clave_api` y, si hay webhook, `webhook_secreto`: se muestran una sola vez. Con `PATCH /admin/v1/tenants/{id}` se cambian los permisos, el webhook, el límite o el estado; con `POST /admin/v1/tenants/{id}/rotacion`, la clave (la anterior deja de autenticar en el momento). Una clave de tenant recibe `403` en `/admin`.

| Permiso | Operaciones |
|---|---|
| `actividades:escribir` | `POST /v1/actividades`, `PATCH /v1/actividades/{id}` |
| `reservas:escribir` | `POST /v1/actividades/{id}/reservas`, `POST /v1/reservas/{id}/cancelacion` |
| `lectura` | `GET /v1/actividades/{id}`, `GET /v1/reservas/{id}`, `GET /v1/actividades/{id}/reservas` |
| `cambios:leer` | `GET /v1/cambios` |

## API v1

El contrato completo está en [`contrato/openapi.yaml`](contrato/openapi.yaml) (1.3.0). Resumen:

| Método y ruta | Respuestas |
|---|---|
| `POST /v1/actividades` | `201` + `Location` · `400` · `401` · `403` · `415` · `429` |
| `GET /v1/actividades/{id}` | `200` · `400` · `404` |
| `PATCH /v1/actividades/{id}` (`{"estado":"cerrada"}`) | `200` · `400` · `404` · `415` |
| `POST /v1/actividades/{id}/reservas` (exige `Idempotency-Key`) | `202` + `Location` + `Retry-After` · `200` repetición · `409` · `422` |
| `GET /v1/reservas/{id}` | `200` (+ `Retry-After` si está pendiente) · `400` · `404` |
| `POST /v1/reservas/{id}/cancelacion` | `202` + `Location` · `200` ya cancelada · `409` rechazada o fallida |
| `GET /v1/actividades/{id}/reservas?estado=&cursor=&limite=` | `200` · `400` |
| `GET /v1/cambios?desde=&limite=` | `200` · `400` |

Todas las operaciones de `/v1` pueden responder además `401` (clave inválida), `403` (falta el permiso) y `429` (límite de tasa, con `Retry-After`). Los errores son `application/problem+json` (RFC 9457). Una solicitud que no cumple el contrato responde `400` (o `405`/`415`) antes de llegar a la ruta. Si MySQL o Redis no responden, `503` con `Retry-After`. Un recurso de otro tenant responde `404`, igual que uno inexistente.

## Aula

https://localhost:3001: iniciar sesión con un usuario de `accesos-locales.txt`.

- **admin** (administrador): crea materias, inscribe a cualquier alumno, ve todas las inscripciones y el estado de la reconciliación (`GET/POST /reconciliacion`).
- **alumno1**, **alumno2** (alumno): se inscriben a sí mismos (el participante sale de la sesión), ven y cancelan solo lo propio. Una reserva ajena responde `404`.

La sesión dura una hora, vive en memoria de Aula (reiniciarla obliga a volver a entrar) y viaja en una cookie `HttpOnly; Secure; SameSite=Strict`. Cada escritura exige el token CSRF de la sesión. Diez contraseñas incorrectas desde una IP bloquean el login de esa IP durante 15 minutos; los logins correctos no cuentan. Las identidades se administran en `seguridad/local/usuarios.json` (solo hashes; `hashPassword` de `clientes/aula/src/seguridad.js` genera uno nuevo).

**Contingencia.** Si `aula-db` no responde, `/materias` responde con `X-Aula-Modo: contingencia` y un catálogo armado desde el feed; las inscripciones siguen yendo a la API y el login sigue funcionando. Un ciclo de reconciliación lee `/v1/cambios` desde `punto_control.ultima_secuencia_feed` (cada 30 s en modo normal, cada 5 s en degradado) y aplica cada instantánea si su versión es mayor, en la misma transacción que el punto de control.

## Descubrimiento de servicios

Traefik encuentra cada instancia de la API por sus etiquetas, ahora a través del proxy del socket:

```shell
docker compose up -d --scale api=3 --no-recreate api
pruebas/descubrimiento/instancias.sh --esperar 3
for i in $(seq 1 9); do curl -s --cacert seguridad/local/ca.crt https://localhost:3000/health; echo; done
```

Cada respuesta trae `X-Instancia`, el contenedor que la atendió. Traefik le habla a cada instancia por HTTPS y verifica que su certificado sea `api`. Si una instancia muere con solicitudes en curso, Traefik responde `502`/`504` en 15 s como máximo y el cliente reintenta con la misma `Idempotency-Key`. Para volver a una instancia: `docker compose up -d --scale api=1 api`.

## Pruebas

### Pruebas de cada componente

```shell
for c in compartido servicios/api servicios/worker servicios/relay servicios/notificador clientes/aula; do (cd $c && npm ci && npm test); done
```

Incluyen el control de acceso de la API (permisos, límite, `/admin`), la admisión por lotes, la caché de autenticación y el límite con Redis (con un doble del transporte), las particiones, el circuit breaker y los reintentos del notificador, el login, las sesiones, el CSRF y los roles de Aula (también contra el backend real de Aula con la API simulada), la reconciliación y la configuración TLS común. Los reportes de carga se prueban con `node --test pruebas/final/test/*.test.js`.

### Seguridad contra el entorno levantado

```shell
node scripts/sistema.js seguridad
```

Corre tres suites y deja su salida en `docs/entrega-5/evidencias/`:

- `pruebas/seguridad/api.js`: aislamiento entre tenants, permisos, administración y rotación, límite de tasa, firma y reinyección de webhooks, SSRF.
- `pruebas/seguridad/aula.js`: login, roles, CSRF, propiedad de las reservas, reconstrucción desde el feed y operación con `aula-db` detenida.
- `pruebas/seguridad/cifrado.js`: TLS positivo y negativo en cada protocolo, `Ssl_cipher` por servicio, `ssl` en cada conexión de RabbitMQ y PostgreSQL, réplica cifrada, proxy del socket y una captura de tráfico Traefik → API.

### Matriz de fallos

```shell
node scripts/sistema.js fallos                 # todos (unos 10 minutos)
node scripts/sistema.js fallos worker          # uno o varios: worker relay rabbitmq notificador api redis mysql-replica aula-db tenant mysql-primary
node pruebas/fallos/matriz.js --e6 redis tenant  # evidencias en docs/entrega-6/evidencias/matriz/
```

El arnés ([`pruebas/fallos/arnes.js`](pruebas/fallos/arnes.js)) lanza una ráfaga de reservas que reintenta como un cliente correcto, detiene el componente a mitad de la ráfaga, lo vuelve a iniciar y verifica por la API: exactamente tantas confirmadas como cupos, ninguna pendiente, ningún participante con dos reservas activas y `cupos_disponibles` coherente. Cada escenario deja `docs/entrega-5/evidencias/fallos/<escenario>.txt`, y la corrida completa, `resumen.md`.

`mysql-primary` va último: termina el primario con SIGKILL, lo deja aislado, promueve la réplica, le pasa el alias de red `mysql-primary` (los clientes no cambian su configuración y el certificado de la réplica también vale para ese nombre) y mide el RTO y el RPO. Deja la réplica como primario y sin réplica; para volver a la topología inicial: `docker compose down -v` y `node scripts/sistema.js levantar`.

### Contrato, carga y límite de tasa

```shell
CLAVE=$(node scripts/sistema.js tenant "Schemathesis" --limite 1000/1000)
docker run --rm --network reserva-cupos-infra_publica -e SCHEMATHESIS_HOOKS=/config/hooks.py \
  -v "$PWD/contrato:/contrato:ro" -v "$PWD/pruebas/contrato:/config:ro" -v "$PWD/seguridad/local/ca.crt:/tls/ca.crt:ro" \
  schemathesis/schemathesis:4.33.1 --config-file /config/schemathesis.toml \
  run /contrato/openapi.yaml --url https://traefik --tls-verify /tls/ca.crt -H "Authorization: Bearer $CLAVE" \
  --exclude-tag administracion --checks all --max-examples 25 --seed 2026 --generation-with-security-parameters false

docker compose run --rm k6 run -e API_KEY=$CLAVE /pruebas/carga/rafaga.js
docker compose run --rm k6 run -e CLAVE_SATURADO=$(node scripts/sistema.js tenant A --limite 10/20) \
  -e CLAVE_VECINO=$(node scripts/sistema.js tenant B --limite 10/20) /pruebas/carga/limite.js
```

k6 verifica el certificado del gateway con la CA local (`SSL_CERT_FILE`). La ráfaga de la Entrega 3 (500 solicitudes sobre 10 cupos) corre igual sobre TLS. `limite.js` satura un tenant y comprueba que recibe `429` y que el vecino no.

### Patrones y escalabilidad (Entrega 6)

Con el entorno de cuatro particiones (`node scripts/verificar-e6.js levantar`), un comando por requisito; cada uno deja su evidencia en `docs/entrega-6/evidencias/`:

```shell
node pruebas/final/recorrido.js                 # recorrido funcional de punta a punta
node scripts/verificar-e6.js circuito           # circuit breaker con un receptor que falla y se recupera
node pruebas/final/circuito-aula.js             # el mismo ciclo con Aula real
node scripts/verificar-e6.js redis              # límite global, caché e invalidación con 1, 2 y 4 API
node pruebas/final/particiones.js 4             # orden por actividad con 4 particiones (y 1, en el entorno base)
node pruebas/final/reducir-particiones.js       # de 4 a 1 partición sin comandos varados
node scripts/verificar-e6.js carga              # k6: caliente, multitenant y rampa, con informes HTML
node pruebas/final/curva-admisiones.js          # admisiones con 1, 2 y 4 API, 3 repeticiones
node scripts/verificar-e6.js fallos             # una API y un worker detenidos durante la ráfaga
```

No ejecutar dos a la vez: todos miden sobre el mismo primario. El detalle de cada uno está en [`docs/entrega-6`](../docs/entrega-6/README.md).

### Cambios incompatibles de los contratos y Aula contra un mock

Como en la Entrega 4: `pruebas/contrato/oasdiff.sh v4-middleware`, `pruebas/contrato/compatibilidad-mensajes.sh` y Aula contra Prism con `PRISM_URL`.

## Integración continua

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) corre en cada PR:

| Trabajo | Qué verifica |
|---|---|
| Contratos | OpenAPI y AsyncAPI válidos; sin cambios incompatibles respecto de `main`. |
| Pruebas | `npm test` en cada componente. |
| Aula contra el mock del contrato | El consumidor funciona solo con el contrato (Prism). |
| Integración | Con TLS: Schemathesis contra la API pública y contra la administración, la ráfaga de 500 sobre 10 cupos y el límite de tasa con k6. |
| Seguridad, cifrado y matriz de fallos | El recorrido funcional, las tres suites de seguridad y la matriz de fallos completa, Redis y failover incluidos (el escenario del tenant sin esperar la DLQ). Sube las evidencias como artifact. |
| Escalabilidad | Con cuatro particiones: circuit breaker, Redis con 1, 2 y 4 API, orden por partición, los tres escenarios de carga y los fallos bajo carga. Sube las evidencias como artifact. |
| CI completo | Que todos los anteriores hayan terminado bien. Es el check obligatorio de `main`. |

Cada job genera en el runner su propia CA y credenciales: no hay secretos en el repositorio ni en GitHub.

## Logs, detener y reanudar

```shell
docker compose logs --tail=30 api relay worker notificador aula redis
node scripts/sistema.js detener
node scripts/sistema.js levantar
```

`docker compose down` elimina contenedores y redes y conserva los volúmenes. `docker compose down -v` también elimina los datos.

## Problemas frecuentes

- `bind source path does not exist: .../seguridad/local/...`: falta `node scripts/sistema.js preparar`.
- `unable to verify the first certificate` o advertencia del navegador: el cliente no confía en `seguridad/local/ca.crt`.
- `401` en todas las rutas: la clave no corresponde a un tenant de esta instalación (por ejemplo, volúmenes de otra entrega o una clave rotada).
- `403 permiso-insuficiente`: la clave no tiene el permiso de esa operación (ver la tabla de permisos).
- `429 limite-de-tasa`: respetar `Retry-After` o pedir al operador un límite mayor para ese tenant.
- Aula responde `503 Identidades no disponibles`: falta `seguridad/local/usuarios.json`.
- Las escrituras tardan diez segundos: la réplica está detenida y el primario espera el tiempo límite semisíncrono.
- `La réplica fue promovida a primario`: después de `fallos mysql-primary`, `levantar` se niega a arrancar el primario viejo, que sería un segundo primario. Recrear el entorno: `docker compose down -v` y `levantar`.
- `503 no-disponible` en todo `/v1` con MySQL sano: Redis no responde (`docker compose ps redis`). La API no sigue sin él: no limitaría por tenant de forma global.
- Grafana rechaza la contraseña de `accesos-locales.txt`: el volumen es anterior; `node scripts/sistema.js grafana` la vuelve a fijar.
- Alguno de los puertos 3000, 3001, 3002, 8080, 9090 o 15672 está en uso: detener el proceso que lo ocupa.

## Credenciales locales

Exclusivamente para desarrollo local.

- Generadas por `preparar` en `seguridad/local/` (fuera de Git): CA y claves privadas de cada servicio, usuarios de Aula (`accesos-locales.txt`), clave del operador (`admin.key`; la API recibe solo su hash) y contraseña del admin de Grafana (`grafana-admin.txt`).
- En el repositorio, como en entregas anteriores: la clave de API y el secreto del webhook de Aula (`docker-compose.yml`), y las contraseñas de MySQL (root, `api_app`, `worker_app`, `relay_app`, `notificador_app`, `admin_app`, `replicador`), RabbitMQ (`demo`), PostgreSQL (`aula_admin`, `aula_app`) y Redis (`Infraestructura/redis/redis.conf`), en `docker-compose.yml` y los scripts iniciales. Las conexiones van cifradas, pero estas contraseñas no son secretas: ver el informe de amenazas.

## Limitaciones

- Redis es una sola instancia: si cae, `/v1` responde `503` hasta que vuelve (ver la matriz de fallos). Se eligió así, y no un límite por instancia, porque con N API ese límite se multiplicaría por N.
- Las sesiones de Aula siguen en la memoria de su proceso: Aula es una sola instancia.
- El estado de los circuitos del notificador es de su proceso: con varios notificadores, cada uno tendría su propio circuito por tenant.
- Cambiar la cantidad de particiones con tráfico en curso puede desordenar los comandos de una actividad mientras dura el cambio (los que ya estaban en la cola vieja y los nuevos). Hacerlo con la carga detenida.
- Se autentica cada servidor con su certificado; los clientes se autentican con credenciales, no con certificados (sin mTLS). La CA es local y sin rotación automática.
- El failover de MySQL es un script que se ejecuta a pedido (no hay detección automática), sobre un único equipo; volver a la topología con réplica requiere recrear el entorno.
- Las contraseñas de la infraestructura siguen en el repositorio (ver *Credenciales locales*).
- La admisión durable está acotada por el `COMMIT` semisíncrono del primario: agregar API o particiones no lo elimina (ver las mediciones de la Entrega 6).

## Documentación

- [Patrones, mediciones y evidencias de la Entrega 6](../docs/entrega-6/README.md)
- [Certificación, informe de amenazas y evidencias de la Entrega 5](../docs/entrega-5/README.md)
- [Contratos](contrato/) y su [historial de versiones](contrato/CHANGELOG.md)
- [Entrega 4](../docs/entrega-4/README.md): contratos de interfaz y descubrimiento de servicios.
- [Entrega 3](../docs/entrega-3/README.md): comunicación síncrona y asíncrona y caso de concurrencia.
