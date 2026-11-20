# Patrones distribuidos: problema, patrón, código y evidencia

Entrega 6 · Grupo 15. Cada patrón responde a un problema concreto del servicio, está en un lugar preciso del código y tiene una evidencia medida. Los de la Entrega 6 se midieron el 20/11/2026 sobre el código de esta entrega ([evidencias](evidencias/README.md)); los de entregas anteriores conservan la evidencia con la que se certificaron, porque esta entrega no cambió su comportamiento.

Las rutas de código parten de `reserva-cupos/`.

## Resumen

| Patrón | Problema que resuelve | Código | Evidencia medida | Desde |
|---|---|---|---|---|
| [Queue-Based Load Leveling](#1-queue-based-load-leveling) | Un pico de reservas compite por pocos cupos | `servicios/api/src/rutas.js` → `servicios/worker/src/reservar.js` | Worker detenido: 200 de 200 admitidas, 10 confirmadas al volver | E3 |
| [Transactional Outbox](#2-transactional-outbox-con-admisión-por-lotes) con admisión por lotes | Guardar y publicar son dos escrituras; cada commit semisincrónico es caro | `servicios/api/src/admisiones.js`, `servicios/relay/src/main.js` | Relay detenido sin pérdidas; ráfaga de 500 en commits de hasta 50; 10/490/0 | E3 · lotes E6 |
| [Idempotent Consumer](#3-idempotent-consumer-e-idempotency-key) e `Idempotency-Key` | Reentregas de RabbitMQ y reintentos HTTP | `servicios/worker/src/reservar.js`, `servicios/api/src/rutas.js` | 20 pedidos con la misma clave: 1 reserva; 20 del mismo participante: 1 | E3 |
| [Competing Consumers particionado](#4-competing-consumers-con-particiones-por-actividad) | Una cola limita actividades independientes | `compartido/src/particiones.js`, `servicios/relay/src/configurar-colas.js` | N=1 28,69 y N=4 32,98 decisiones/s; orden conservado; de 4 a 1 sin comandos varados | E6 |
| [Circuit Breaker por tenant](#5-circuit-breaker-por-tenant) | Un receptor caído recibe intentos que lo hunden y ocupan al notificador | `servicios/notificador/src/circuitos.js`, `reintento.js` | 9 entregas diferidas sin HTTP; cerrado → abierto → semiabierto → cerrado en 10 s; 11 de 11 entregadas | E6 |
| [Retry escalonado + DLQ](#6-retry-escalonado-y-dead-letter-queue-con-plazo) con plazo | Un receptor que falla un rato o para siempre | `servicios/notificador/src/main.js`, `reintento.js` | 20 webhooks a la DLQ en 409 s con el circuito abierto; Aula se reconstruye del feed | E4 · plazo E6 |
| [Cache-aside](#7-cache-aside-de-la-autenticación) | Cada pedido repetía la consulta de la clave en MySQL | `servicios/api/src/cache-autenticacion.js` | 600 lecturas con 1, 2 y 4 API: 1 consulta a MySQL | E6 |
| [Rate limiting distribuido](#8-token-bucket-distribuido) | Con N API, N límites locales | `servicios/api/src/limite-redis.js` | 4 API, ráfaga 5: 5 admitidas de 40 (no 20) | E5 · global E6 |
| [Gateway con balanceo y health checks](#9-gateway-con-balanceo-y-health-checks) | Agregar o perder instancias sin tocar los clientes | `docker-compose.yml` (Traefik), `servicios/api/src/server.js` | Una API detenida durante la ráfaga: 500 de 500 admitidas con 44 reintentos del cliente; 10/490, 0 duplicadas | E4 |

Los patrones 4, 5, 7 y 8 y la admisión por lotes son de esta entrega; la consigna pide al menos dos con evidencia.

## 1. Queue-Based Load Leveling

**Problema.** La decisión de una reserva compite por la fila de la actividad. Hacer esperar a cada cliente hasta decidir acopla el ritmo de llegada (un pico) con el de procesamiento (de a una por actividad).

**Patrón.** Separar la admisión durable del procesamiento: la API guarda la reserva `pendiente` y responde `202`; la cola transporta el trabajo y amortigua la diferencia de ritmos; el worker decide con un `UPDATE` condicional que impide sobreasignar dentro de MySQL.

**Dónde está.** Admisión en `servicios/api/src/rutas.js` (`POST /actividades/:id/reservas`); decisión en `servicios/worker/src/reservar.js` (`UPDATE actividades ... WHERE cupos_disponibles > 0`).

**Evidencia.** [Worker detenido con una ráfaga](../entrega-5/evidencias/fallos/worker.txt) (E5): 200 de 200 solicitudes responden `202` con el worker detenido; al volver, 10 confirmadas, 190 rechazadas, cero pendientes y cero duplicadas, en 7,2 s. En esta entrega, el [escenario caliente](evidencias/carga-caliente/informe.html) repite 500 sobre 10 cupos con cuatro particiones: 500 de 500 con `202`, 10 confirmadas, 490 rechazadas, 0 pendientes, decididas 10,5 s después de la última admisión.

**Límite.** `202` no promete la confirmación ni su demora. La cola no tiene capacidad infinita ni elimina el costo del primario: la admisión sigue escribiendo en MySQL.

## 2. Transactional Outbox con admisión por lotes

**Problema.** Guardar la reserva en MySQL y publicar el comando en RabbitMQ son dos escrituras: una caída entre ambas deja una reserva sin comando o un comando sin reserva. Además, cada admisión pagaba un commit semisincrónico (espera la réplica), que es el cuello de botella del primario.

**Patrón.** La reserva y su fila en `cambios` se guardan en la misma transacción; un relay independiente publica con *publisher confirms* y marca lo publicado. En la Entrega 6 las admisiones que llegan juntas comparten la transacción (*group commit*): hasta 50 por commit, sin responder a ninguna antes de que el lote se confirme.

**Dónde está.** `servicios/api/src/admisiones.js`: `crearAdmisor` agrupa, `insertarAdmisiones` escribe reservas y outbox con dos `INSERT` en una transacción. Si el lote falla por una solicitud (una clave duplicada), se revierte y cada una se repite sola; si falla la infraestructura (MySQL caído), el lote entero se rechaza de inmediato con `503`. `servicios/relay/src/main.js` secuencia y publica.

**Evidencia.** [Relay detenido](../entrega-5/evidencias/fallos/relay.txt) (E5): 178 pendientes con el relay detenido; al volver, 10 confirmadas, 190 rechazadas y ninguna perdida ni duplicada. [Curva de admisiones](evidencias/curva-admisiones/informe.html): con 1 API, 100 admisiones se confirman en 10 commits (10,7 por commit); con 4 API, en 27 (3,7 por commit), porque cada instancia arma sus propios lotes. Pruebas de `admisiones.test.js`: con la base caída, 50 admisiones fallan en 1 intento (antes, 51 transacciones en serie).

**Límite.** Entrega al-menos-una-vez: los consumidores son idempotentes (patrón 3). El lote se forma por proceso: más instancias de la API con la misma carga forman lotes más chicos (ver [carga](carga.md#por-qué-más-api-no-admiten-más)).

## 3. Idempotent Consumer e Idempotency-Key

**Problema.** RabbitMQ reentrega si el worker cae entre el commit y el ack; un cliente HTTP reintenta si pierde la respuesta. Sin protección, se descontarían dos cupos por la misma operación.

**Patrón.** El consumidor detecta el trabajo ya decidido y no repite el efecto; en el borde HTTP, la `Idempotency-Key` identifica el reintento de la misma operación. Son dos protecciones que se complementan.

**Dónde está.** `servicios/worker/src/reservar.js` bloquea la reserva (`FOR UPDATE`) y devuelve `repetido` si ya no está pendiente; `servicios/api/src/rutas.js` resuelve la clave con `leerReservaPorClave` y el índice único.

**Evidencia.** [Duplicados concurrentes](evidencias/diagnostico-2026-11-20T04-43-47-531Z/k6.txt) con cuatro particiones: 20 pedidos simultáneos con la misma clave dan un `202` y 19 `200`; 20 del mismo participante con claves distintas, un `202` y 19 `409`; quedan exactamente 2 reservas. [Reentrega](../entrega-3/evidencias/09-reentrega.txt) (E3): el cupo se descuenta una vez.

**Límite.** Protege el estado transaccional de la reserva; un efecto externo nuevo (un correo, por ejemplo) necesitaría su propia deduplicación.

## 4. Competing Consumers con particiones por actividad

**Problema.** Con una sola cola, una actividad muy demandada retrasa las decisiones de todas las demás; y varios workers sobre la misma cola no conservan el orden de una actividad.

**Patrón.** N colas detrás de un exchange de hash consistente cuya clave es el `actividad_id`: cada actividad cae siempre en la misma partición, y cada partición tiene un único worker (consumidor exclusivo). Las particiones compiten por el trabajo total; dentro de una actividad, el orden se conserva.

**Dónde está.** `compartido/src/particiones.js` (`COMANDOS_PARTICIONES`, `WORKER_PARTICION`); `servicios/relay/src/configurar-colas.js` declara y enlaza las N colas con el mismo peso y, al bajar N, desenlaza las sobrantes y reenvía sus comandos al exchange; `servicios/worker/src/main.js` consume con `exclusive: true`; `docker-compose.particiones.yml` levanta cuatro workers.

**Evidencia.** [N=1](evidencias/multi-particiones-n1.json) y [N=4](evidencias/multi-particiones-n4.json) con la misma carga (8 actividades, 320 reservas, 10 cupos cada una), el mismo código y el mismo equipo: las 320 se deciden en 9,7 s con 4 particiones y en 11,2 s con 1 (33 contra 29 decisiones por segundo); la diferencia es chica porque la mitad del tiempo es la admisión, que limita el primario. En las dos, cada actividad termina con 10 confirmadas y 30 rechazadas, y el orden de las decisiones coincide con el de los comandos. [De 4 a 1 partición](evidencias/particiones-reduccion.json): 35 comandos que esperaban en las particiones 1 a 3 se reenvían una vez cada uno y las 40 reservas se confirman.

**Límite.** El orden es por actividad, no global. Cambiar N con tráfico en curso puede desordenar una actividad durante el cambio (los comandos de la cola vieja y los nuevos); se hace con la carga detenida. Todas las particiones comparten el primario.

## 5. Circuit Breaker por tenant

**Problema.** Un receptor de webhooks caído recibía todos los intentos de todos sus eventos: cada uno ocupaba al notificador hasta el plazo de 5 s y agravaba la caída del receptor.

**Patrón.** Un circuito por tenant (opossum): cerrado deja pasar; con al menos 3 envíos y la mitad fallidos, se abre y rechaza sin HTTP; a los 10 s pasa a semiabierto y prueba con un solo envío; si sale bien, se cierra. Un tenant caído no abre el circuito de otro.

**Dónde está.** `servicios/notificador/src/circuitos.js` (`crearCircuitos`); `servicios/notificador/src/main.js` difiere a `webhooks.espera.10s` el mensaje rechazado por el circuito sin gastar un intento (`reprogramar(..., { consumirIntento: false })`). Métricas `pdc_webhook_circuito_estado` y `pdc_webhook_circuito_transiciones_total`.

**Evidencia.** [Receptor que falla y se recupera](evidencias/circuito-recuperacion.json) y [métricas](evidencias/circuito-metricas.txt): 8 errores HTTP abren el circuito; 9 entregas se difieren sin llegar al receptor; abierto 04:41:28,486 → semiabierto 04:41:38,486 (10 s) → cerrado 19 ms después; las 11 entregas llegan. [Con Aula real](evidencias/circuito-aula/resultado.json): Aula detenida, el mismo ciclo y 11 de 11 webhooks entregados al volver. [Panel de Grafana](evidencias/24-circuito-por-tenant.png).

**Límite.** El estado del circuito es del proceso del notificador (hay uno solo). El circuito de Aula (`clientes/aula/src/interruptor.js`, E5) es un interruptor más simple hacia su propia base.

## 6. Retry escalonado y Dead Letter Queue, con plazo

**Problema.** Un receptor puede fallar un rato (reintentar tiene sentido) o para siempre (hay que dejar de intentar sin perder el evento).

**Patrón.** Reintentos a los 10 s, 1 min y 5 min con colas de espera con TTL; agotados, el evento va a `webhooks.dlq` y sigue en el feed. En la Entrega 6, como el circuito abierto difiere sin gastar intentos, se agrega un tope: a los 400 s del primer fallo de un evento (el calendario completo más un margen), va a la DLQ aunque le queden intentos. Sin ese tope, con el circuito abierto solo la prueba de cada semiapertura gastaba un intento y un evento podía tardar horas en llegar a la DLQ.

**Dónde está.** `servicios/notificador/src/reintento.js` (`planReintento`, `PLAZO_MS`); la cabecera `x-primer-fallo` (contrato AsyncAPI 1.1.0) lleva el instante del primer fallo; `servicios/relay/src/configurar-colas.js` declara las esperas.

**Evidencia.** [Servidor del tenant caído](evidencias/matriz/tenant.txt), con el circuito: Con Aula y aula-db detenidas, el servicio decide igual las 20 reservas del tenant (5 confirmadas, 15 rechazadas); sus 20 webhooks llegan a la DLQ a los 409 s de la caída, con el circuito abriéndose y cerrándose (el plazo de 400 s más, como mucho, una espera de 10 s); al volver, Aula reconstruye las 20 inscripciones desde el feed en 17,9 s.. [Reintentos escalonados](../entrega-4/evidencias/09-webhooks-fallas.txt) (E4). Pruebas de `reintento.test.js`: un mensaje diferido indefinidamente llega a la DLQ en el plazo.

**Límite.** El webhook es de baja latencia, no de garantía: la garantía es el feed `/v1/cambios`, desde el que Aula se reconstruye.

## 7. Cache-aside de la autenticación

**Problema.** Cada pedido buscaba en MySQL el tenant de su clave: con varias API, el primario pagaba esa lectura por cada solicitud.

**Patrón.** Leer primero de Redis; si no está, de MySQL, y guardarlo (30 s; 1 s si la clave no existe). La entrada guarda id, permisos y límites, nunca la clave ni el secreto del webhook. Una generación global invalida todo al rotar una clave o cambiar permisos: se incrementa antes y después del cambio, y una lectura vieja no puede repoblar la generación nueva. Mientras dura el cambio, la autenticación consulta MySQL directo.

**Dónde está.** `servicios/api/src/cache-autenticacion.js` (`buscar`, `mutar` y los scripts Lua); `servicios/api/src/admin.js` envuelve cada cambio en `mutar`; `servicios/api/src/acceso.js` la usa al autenticar.

**Evidencia.** [Redis con 1, 2 y 4 API](evidencias/redis-escalado.json): 200 lecturas autenticadas por configuración, 600 en total, con **1 consulta** de autenticación a MySQL. Después de rotar una clave y cambiar permisos, la clave vieja deja de autenticar y los permisos nuevos rigen en las cuatro API. [Seguridad de la caché](evidencias/seguridad-componentes.txt): no contiene claves ni secretos.

**Límite.** La generación es global: administrar un tenant invalida la caché de todos (es una operación poco frecuente).

## 8. Token bucket distribuido

**Problema.** El límite de tasa de la Entrega 5 vivía en la memoria de cada API: con N instancias, un tenant obtenía N veces su límite.

**Patrón.** Un balde por tenant en Redis, recargado y descontado por un script Lua atómico con el reloj de Redis (`TIME`), no el de cada API.

**Dónde está.** `servicios/api/src/limite-redis.js`. Si Redis no responde, `503`: no hay un límite local de reserva, que volvería a multiplicarse por N.

**Evidencia.** [Redis con 4 API](evidencias/redis-escalado.json): un tenant con 1/s y ráfaga 5 envía 40 pedidos repartidos entre las cuatro: 5 admitidos y 35 `429` con `Retry-After` (con límites locales habrían sido hasta 20). [Redis detenido durante una ráfaga](evidencias/matriz/redis.txt): 15 s en plena ráfaga de 200. Desde los 0,7 s, `/v1` responde `503` con `Retry-After` mientras `/health` sigue en `200`; los clientes reintentaron 521 veces con la misma clave y el resultado fue 10 confirmadas, 190 rechazadas, ninguna duplicada; la API volvió a atender en cuanto Redis quedó sano, sin reiniciarse..

**Límite.** Redis es una sola instancia: si cae, `/v1` no atiende hasta que vuelve.

## 9. Gateway con balanceo y health checks

**Problema.** Agregar o perder instancias de la API sin cambiar la dirección que usan los clientes.

**Patrón.** Traefik descubre las instancias por etiquetas de Docker, les hace health check y balancea; los clientes reintentan con la misma `Idempotency-Key`.

**Dónde está.** `docker-compose.yml` (Traefik y las etiquetas de `api`); `/health` en `servicios/api/src/server.js`, con un pool propio y una sola consulta compartida entre chequeos simultáneos, para que una instancia ocupada no parezca caída.

**Evidencia.** [Fallos bajo carga](fallos-bajo-carga.md): con cuatro API, una se detiene en plena ráfaga de 500 (y el worker de la partición activa): Traefik deja de enviarle tráfico, el cliente reintenta 44 solicitudes con la misma clave y el resultado es 10 confirmadas, 490 rechazadas, ninguna duplicada. [Una API terminada con SIGKILL](../entrega-5/evidencias/fallos/api.txt) (E5).

**Límite.** Un solo host: el gateway también es un punto único de falla.
