# Observabilidad — Entrega 6

Implementación relacionada con el issue #45.

## Funcionamiento

Los servicios exponen métricas que Prometheus consulta cada cinco
segundos. Grafana consulta a Prometheus y muestra el historial.

Las conexiones de recolección y la conexión Grafana → Prometheus
utilizan HTTPS con verificación de certificados mediante la CA local.

## Componentes monitoreados

| Componente | Métricas |
|---|---|
| API | Solicitudes y duración por método, ruta y estado HTTP. |
| Worker | Reservas confirmadas, rechazadas, cancelaciones, repeticiones y errores. |
| Relay | Cambios secuenciados, publicaciones confirmadas y republicaciones. |
| Notificador | Intentos HTTP, duración, entregas, reintentos y errores. |
| RabbitMQ | Cantidad de mensajes por cola. |
| Traefik | Solicitudes por entrada, método y código HTTP. |

## Archivos principales

- `reserva-cupos/compartido/src/metricas.js`: registro compartido.
- `reserva-cupos/Infraestructura/prometheus/prometheus.yml`:
  destinos y frecuencia de recolección.
- `reserva-cupos/Infraestructura/prometheus/web.yml`:
  HTTPS del servidor Prometheus.
- `reserva-cupos/Infraestructura/grafana/provisioning/`:
  conexión y proveedor de dashboards.
- `reserva-cupos/Infraestructura/grafana/dashboards/reserva-cupos.json`:
  ocho paneles provisionados.
- `reserva-cupos/scripts/recargar-grafana.js`:
  recarga administrativa y comprobación de los paneles guardados.

## Acceso local

- Prometheus: https://localhost:9090
- Grafana: https://localhost:3002

Los puertos publicados están limitados a la interfaz local.
Los certificados se generan con `scripts/sistema.js preparar`
y no se incluyen en Git.

Prometheus y Grafana conservan sus datos en volúmenes separados:
`prometheus-data` y `grafana-data`.

## Verificaciones realizadas

- Los seis destinos de Prometheus respondieron `up`.
- El recorrido funcional de reservas terminó aprobado.
- El worker registró confirmaciones, rechazo y cancelación.
- El relay registró cambios secuenciados y publicaciones.
- El notificador registró cuatro entregas HTTP 204.
- RabbitMQ expuso sus ocho colas con cero mensajes en la consulta.
- Traefik registró respuestas 200, 201 y 202 después de recuperar
  su dependencia de descubrimiento `socket-proxy`.
- Grafana confirmó mediante su API los ocho paneles guardados.

## Evidencias

- [Dashboard inicial](evidencias/04-dashboard-inicial.png).
- [Mensajes por cola](evidencias/05-colas-rabbitmq.png).
- [Tráfico de Traefik](evidencias/06-traefik.png).
- [Recorrido funcional](evidencias/01-recorrido.txt).

## Interpretación y límites

Los contadores se reinician al reiniciar cada proceso. Las tasas del
dashboard se calculan sobre ventanas de un minuto.

El p95 se estima a partir de histogramas; no es un promedio.
La duración HTTP del webhook mide cada intento, no toda la demora
desde que ocurrió la reserva.

Una publicación confirmada por RabbitMQ no equivale a una reserva
decidida ni a un webhook aceptado por el destinatario.

Un destino `up` significa que Prometheus pudo recoger sus métricas;
no acredita por sí solo que sus dependencias o rutas funcionen.

Estas verificaciones son funcionales. No sustituyen los escenarios
de carga, escalado y fallos parciales de los issues #46 a #50.

El cierre del issue #45 queda sujeto a revisar sus criterios y
la implementación en el pull request.

## Ampliacion de Redis y circuitos verificada

El dashboard incorpora paneles de estado y transiciones del circuito por tenant,
cache de autenticacion, consultas a MySQL, limite distribuido y demora total de
webhooks. Prometheus tambien consulta los workers de las particiones adicionales.
Las integraciones Docker de circuito, Redis, carga y fallos aprobaron por
separado el 17/11/2026. Los reportes de carga contienen series reales de
Prometheus. Las capturas 21 y 22 muestran las ampliaciones con datos reales;
ver sus intervalos y alcances en [el indice de evidencias](evidencias/README.md).
