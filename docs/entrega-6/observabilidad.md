# Observabilidad — #45

Cada componente expone métricas que Prometheus recolecta cada 5 s; Grafana las muestra en un dashboard provisionado desde el repositorio. Todo viaja por HTTPS con la CA local.

## Qué se mide

| Componente | Métricas | Origen |
|---|---|---|
| API | Solicitudes y duración por método, ruta y estado HTTP; aciertos de la caché de autenticación; consultas de autenticación a MySQL; límite global aceptado y rechazado; **admisiones por commit** (`pdc_admision_lote_tamano`) | `compartido/src/metricas.js`, `servicios/api/src/server.js` |
| Worker | Reservas confirmadas, rechazadas y fallidas, cancelaciones, repeticiones y errores | `servicios/worker/src/main.js` |
| Relay | Cambios secuenciados, publicaciones confirmadas y republicaciones | `servicios/relay/src/main.js` |
| Notificador | Intentos HTTP y su duración, entregas, reintentos, diferidos por el circuito, estado y transiciones del circuito por tenant, demora total del webhook | `servicios/notificador/src/main.js`, `circuitos.js` |
| RabbitMQ | Mensajes por cola (plugin `rabbitmq_prometheus`, por TLS en el 15691) | `Infraestructura/tls/rabbitmq.conf` |
| Traefik | Respuestas por entrada, método y código HTTP | `docker-compose.yml` |

Cada servicio publica sus métricas en el puerto 9464 por HTTPS, solo en la red interna: no se publican en el equipo ni pasan por el gateway (`https://localhost:3000/metrics` responde `404`).

## Dashboard

`Infraestructura/grafana/dashboards/reserva-cupos.json`, 14 paneles: instancias con métricas, reservas admitidas por segundo y su p95, decisiones por segundo, webhooks (entregas, errores, reintentos y p95 del intento HTTP), mensajes por cola, respuestas de Traefik por código, circuito por tenant, aciertos de la caché, consultas de autenticación a MySQL, p95 de la demora total del webhook, límite global y admisiones por commit.

`node scripts/recargar-grafana.js` recarga la provisión y comprueba que Grafana guardó todos los paneles del archivo.

## Acceso

| Qué | Dónde |
|---|---|
| Prometheus | https://localhost:9090 |
| Grafana | https://localhost:3002 · usuario `admin`; contraseña en `seguridad/local/accesos-locales.txt` |

Los dos se publican solo en `127.0.0.1`. La contraseña de Grafana la genera `node scripts/sistema.js preparar` (no queda la de fábrica, `admin/admin`) y `levantar` la fija también en un volumen anterior. Prometheus no tiene autenticación: solo es accesible desde el propio equipo (ver [seguridad de los componentes nuevos](README.md#seguridad-de-los-componentes-nuevos)).

## Evidencias

Capturas del 20/11/2026 sobre la ventana de la corrida de evidencias (01:41 a 02:19, hora de Argentina):

- [Decisiones de reserva por segundo](evidencias/21-decisiones-por-segundo.png): confirmadas y rechazadas en cada prueba.
- [Admisiones por commit y commits por segundo](evidencias/22-admision-y-lotes.png): hasta 36 admisiones por commit en la ráfaga caliente; lotes más chicos en la curva con 4 API.
- [Mensajes por cola de RabbitMQ](evidencias/23-colas-rabbitmq.png): las cuatro particiones, las esperas de los webhooks y la DLQ del escenario del tenant.
- [Circuito por tenant](evidencias/24-circuito-por-tenant.png): las aperturas y semiaperturas mientras el receptor o Aula están caídos.
- [Límite global](evidencias/25-limite-global.png): solicitudes aceptadas y rechazadas.
- [Aciertos de la caché de autenticación](evidencias/26-cache-autenticacion.png): cerca del 100 % durante la carga (0 % significa que no hubo tráfico).
- [p95 de la demora total del webhook](evidencias/27-demora-webhook.png): 29 s con Aula detenida en la prueba del circuito; menos de 2 s en la carga.
- [Respuestas de Traefik por código](evidencias/28-traefik.png).

Son paneles sueltos del mismo dashboard (`viewPanel`), capturados con `kiosk`.

Los [informes de carga](carga.md) incluyen las series de Prometheus de cada escenario, y la [prueba de seguridad de los componentes](evidencias/seguridad-componentes.txt) comprueba que cada destino se recolecta por HTTPS y está `up`.

## Cómo leer las métricas

- Los contadores se reinician con cada proceso; las tasas del dashboard usan ventanas de un minuto.
- El p95 se estima desde histogramas, no es un promedio.
- La duración del intento HTTP del webhook no es la demora total: esa la mide `pdc_webhook_demora_segundos`, desde que ocurrió el cambio hasta la entrega.
- Una publicación confirmada por RabbitMQ no es una reserva decidida ni un webhook aceptado por el receptor.
- Un destino `up` significa que Prometheus pudo leer sus métricas, no que sus dependencias funcionen.
