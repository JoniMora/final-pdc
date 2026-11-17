# Patrones distribuidos: problema, implementación y evidencia

Grupo 15 · Entrega 6, patrones y escalabilidad · En preparación.

Este documento responde al comentario de revisión del PR #59 y aporta al
[issue #51](https://github.com/JoniMora/final-pdc/issues/51). No cierra ese issue:
faltan material visual, revision y release; curva repetida y Aula real ya
aprobaron. Ver [estado de cierre](cierre-validacion.md).

## Cómo leer las evidencias

Las salidas enlazadas son ejecuciones ya registradas en el repositorio, no pruebas
nuevas ejecutadas al escribir este documento. E3 y E4 son antecedentes históricos;
E5 proviene de la rama corregida de la PR #58, incorporada en la integración local.
Los timestamps de las salidas son los originales; algunas están expresadas en UTC.
La nueva integración debe repetir sus ensayos antes de certificarse.

La evidencia mide un comportamiento del sistema; no prueba aisladamente todas las
propiedades de un patrón. Por ejemplo, recuperar pendientes tras reiniciar el relay
no prueba por sí solo cada punto posible de caída entre publicar y marcar.

## Resumen

| Patrón | Estado en el código integrado | Evidencia disponible |
|---|---|---|
| Transactional Outbox | Implementado | Relay detenido: pendientes recuperadas al volver, E5. |
| Idempotent Consumer | Implementado | Reentrega sin descontar dos veces, E3. |
| Queue-Based Load Leveling | Implementado | Admisión continúa con worker detenido, E5. |
| Competing Consumers | Implementado sobre una cola | Ráfaga con dos workers, E3. Particionado de E6 pendiente. |
| Retry + DLQ | Implementado | Tres esperas y derivación a DLQ, E4. |
| Gateway con balanceo y health checks | Implementado | Descubrimiento E4 y caída de una API con carga, E5. |
| Circuit Breaker simplificado de Aula | Implementado | Contingencia y reconciliación de PostgreSQL, E5. No es el breaker del notificador. |
| Rate Limiting con token bucket | Implementado por proceso | Tenant limitado y vecino no afectado, E5. Redis global pendiente. |

Todas las rutas de código siguientes parten de la raíz del repositorio.

## 1. Transactional Outbox

**Problema.** Guardar una reserva en MySQL y publicar además en RabbitMQ son dos
escrituras independientes: una caída entre ambas puede dejar datos sin comando
 o un comando que no corresponde a una transacción confirmada.

**Patrón.** Guardar el estado y una fila de outbox en la misma transacción local.
Un relay independiente publica después y marca como publicado tras la confirmación
del broker. Si publica y cae antes de marcar, puede volver a publicar.

**Dónde está.** En [rutas de API](../../reserva-cupos/servicios/api/src/rutas.js),
la admisión escribe la reserva pendiente y llama a `registrarCambio` dentro de
`enTransaccion`. [modelo.js](../../reserva-cupos/servicios/api/src/modelo.js)
construye la fila de `cambios`. El [relay](../../reserva-cupos/servicios/relay/src/main.js)
secuencia y publica en `publicar`/`publicarWebhooks`, espera confirms y marca
`publicado_comando` o `publicado_webhook`. El worker también registra sus cambios
junto con la decisión, sin publicar directamente al broker.

**Evidencia medida.** [E5: relay detenido](../entrega-5/evidencias/fallos/relay.txt):
200 solicitudes admitidas; 178 pendientes en la observación con relay detenido.
Al volver, termina con 10 confirmadas, 190 rechazadas, cero pendientes y cero
duplicadas. El drenaje desde el regreso del relay tarda 7,1 s en esa ejecución.

**Límite.** La entrega es al menos una vez. Se necesita idempotencia del consumidor;
no se promete una transacción distribuida ni entrega exactamente una vez.

## 2. Idempotent Consumer e idempotencia de admisión

**Problema.** RabbitMQ puede reentregar si el worker cae después del commit y antes
del ack. El cliente HTTP también puede reintentar al perder una respuesta.
Sin protección, podrían descontarse dos cupos por la misma operación.

**Patrón.** Un consumidor idempotente detecta trabajo ya decidido y no repite su
efecto. En el borde HTTP, una clave de idempotencia identifica el reintento de la
misma operación. Son protecciones distintas que se complementan.

**Dónde está.** [reservar.js](../../reserva-cupos/servicios/worker/src/reservar.js)
bloquea la reserva con `FOR UPDATE` y retorna `repetido: true` si no está pendiente.
El UPDATE condicional de cupos, el estado y el cambio se confirman juntos.
[cancelar.js](../../reserva-cupos/servicios/worker/src/cancelar.js) evita devolver
el cupo dos veces. [main.js del worker](../../reserva-cupos/servicios/worker/src/main.js)
hace el ack tras procesar. En [rutas.js](../../reserva-cupos/servicios/api/src/rutas.js),
`leerReservaPorClave` y `responderRepeticion` resuelven la `Idempotency-Key` del tenant.

**Evidencia medida.** [E3: reentrega](../entrega-3/evidencias/09-reentrega.txt):
una reserva confirmada se reenvía dos veces; cupos disponibles sigue en 4 sobre 5
y la versión de reserva permanece en 2. [E3: duplicados HTTP](../entrega-3/evidencias/08-duplicados.txt):
veinte solicitudes con la misma clave producen una respuesta 202 y diecinueve 200;
veinte del mismo participante producen una 202 y diecinueve 409.

**Límite.** La protección es sobre el estado transaccional de la reserva. No implica
que cualquier efecto externo futuro, como un correo, sea automáticamente idempotente.

## 3. Queue-Based Load Leveling

**Problema.** Un pico de solicitudes compite por un recurso de capacidad limitada.
Hacer esperar al cliente hasta completar toda la decisión acopla admisión y consumo.

**Patrón.** Separar admisión durable y procesamiento asíncrono. La API responde 202
tras guardar; la cola transporta el trabajo hacia los consumidores y amortigua la
 diferencia de ritmos. La cola no garantiza por sí sola que haya cupo.

**Dónde está.** [rutas de API](../../reserva-cupos/servicios/api/src/rutas.js),
[relay](../../reserva-cupos/servicios/relay/src/main.js),
[configuración de colas](../../reserva-cupos/servicios/relay/src/configurar-colas.js)
y [worker](../../reserva-cupos/servicios/worker/src/main.js). El resultado definitivo
se consulta por HTTP o llega como notificación. El UPDATE de `reservar.js` impide
la sobreasignación dentro de MySQL.

**Evidencia medida.** [E5: worker detenido](../entrega-5/evidencias/fallos/worker.txt):
200 de 200 solicitudes responden 202; se observan 194 pendientes con el worker
detenido. Al regresar termina en 10 confirmadas, 190 rechazadas y cero pendientes,
sin duplicadas. Desde el regreso hasta drenar pendientes transcurren 7,2 s.

**Límite.** 202 no garantiza confirmación ni inmediatez. MySQL sigue participando en
la admisión; la cola no elimina el costo del primario semisíncrono ni tiene capacidad infinita.

## 4. Competing Consumers

**Problema.** Un consumidor puede ser insuficiente para procesar todo el trabajo;
se desea distribuirlo sin que cada instancia ejecute deliberadamente todo el lote.

**Patrón.** Varios consumidores compiten por mensajes de una misma cola. El broker
reparte entregas; el prefetch limita mensajes en vuelo por consumidor. Las
transacciones y la idempotencia protegen el estado ante concurrencia y reentregas.

**Dónde está.** [main.js del worker](../../reserva-cupos/servicios/worker/src/main.js)
consume comandos con `prefetch(1)`; [Compose](../../reserva-cupos/docker-compose.yml)
permite varias instancias de `worker`. Actualmente consumen la misma cola.

**Evidencia medida.** [E3: ráfaga con dos workers](../entrega-3/evidencias/07-rafaga-2-workers.txt)
registra 500 solicitudes: 10 confirmadas, 490 rechazadas y cero pendientes. La prueba
preliminar de [E6](evidencias/02-carga-escalado.txt) repite esos conteos con tres API
y dos workers, pero pertenece a la base anterior y no es una curva de rendimiento.

**Límite y pendiente.** Dos consumidores no garantizan orden global estricto ni
mejora lineal. El [issue #46](https://github.com/JoniMora/final-pdc/issues/46) exige
colas particionadas por actividad, un worker por partición y verificación de orden
y throughput con N=1/4. Esa variante todavía no se acredita aquí.

## 5. Retry con espera y Dead Letter Queue

**Problema.** Un receptor de webhook puede fallar temporalmente. Reintentar sin pausa
lo sobrecarga; descartar al primer fallo pierde la oportunidad de entregar.

**Patrón.** Reintentos acotados con espera; agotados los intentos, conservar la
entrega en una DLQ para inspección. Los errores permanentes no requieren la misma
política que los transitorios.

**Dónde está.** [notificador](../../reserva-cupos/servicios/notificador/src/main.js),
`reprogramar`, `procesar` y `ESPERAS`; [configurar-colas.js](../../reserva-cupos/servicios/relay/src/configurar-colas.js)
define TTL y enrutamiento de retorno para 10 s, 1 min y 5 min, más `webhooks.dlq`.

**Evidencia medida.** [E4: fallas de webhooks](../entrega-4/evidencias/09-webhooks-fallas.txt)
registra el mismo webhook pasando por las esperas de 10 s, 1 min y 5 min y luego
a `webhooks.dlq`. Tras agotar reintentos el evento sigue disponible en el feed;
la salida muestra `reserva.solicitada` y `reserva.confirmada` para el participante.

**Límite y pendiente.** Retry + DLQ no es un Circuit Breaker: mientras corresponde
reintentar, todavía se intenta el envío. El breaker por tenant del
[issue #47](https://github.com/JoniMora/final-pdc/issues/47) es trabajo separado.

## 6. Gateway con balanceo y health checks

**Problema.** Al agregar o retirar API no queremos cambiar direcciones en cada cliente,
y una instancia caída no debería seguir siendo un destino estable del tráfico.

**Patrón.** Un gateway descubre instancias y balancea sobre destinos saludables.
Los clientes mantienen una dirección del servicio; ante fallos pueden reintentar
operaciones protegidas por idempotencia.

**Dónde está.** [Compose](../../reserva-cupos/docker-compose.yml), etiquetas de API
y configuración de Traefik; [server.js](../../reserva-cupos/servicios/api/src/server.js)
expone `/health`. La integración local utiliza un pool de salud separado del pool
de negocio, con las opciones TLS compartidas de E5, para evitar esperar detrás
de la admisión. Su cambio debe volver a medirse con carga.

**Evidencia medida.** [E4: descubrimiento](../entrega-4/evidencias/07-descubrimiento.txt)
observa tres instancias UP y la retirada/reincorporación de una.
[E5: caída de una API](../entrega-5/evidencias/fallos/api.txt) usa dos instancias,
300 solicitudes y SIGKILL tras 60 admisiones: 10 confirmadas, 290 rechazadas y cero
duplicadas. Registra 27 reintentos (17 respuestas 502 y 10 respuestas 504), no una
transición invisible para el cliente. Es evidencia de E5 anterior al merge local.

**Límite.** Un gateway en un único host sigue siendo un punto de falla. La prueba
no acredita balanceo entre hosts, cero errores transitorios ni failover de MySQL.

## 7. Circuit Breaker simplificado en Aula

**Problema.** Con PostgreSQL caído, intentar conectarse en cada solicitud añade
resoluciones y timeouts al pico, aunque la API central siga disponible.

**Patrón.** Abrir un interruptor tras un fallo para evitar intentos repetidos durante
un intervalo. El ciclo de reconciliación sondea la base y restablece el acceso.

**Dónde está.** [interruptor.js](../../reserva-cupos/clientes/aula/src/interruptor.js),
`crearInterruptor` y `conBase`; [server.js](../../reserva-cupos/clientes/aula/src/server.js)
envuelve las operaciones locales; [recuperacion.js](../../reserva-cupos/clientes/aula/src/recuperacion.js)
actúa como sonda y llama a `exito` al recuperarse.

**Evidencia medida.** [E5: escenario de Aula](../entrega-5/evidencias/fallos/aula-db.txt):
500 solicitudes, PostgreSQL detenido tras 150 admisiones y 14,0 s de caída;
10 confirmadas, 490 rechazadas y cero duplicadas. La proyección coincide con el
servicio 12,1 s después de volver PostgreSQL.

**Límite.** Es un interruptor simple por proceso, no una máquina completa con
métricas y prueba exclusiva de estado semiabierto. La evidencia acredita la
contingencia integrada, no aísla su mejora de latencia. Tampoco sustituye el
Circuit Breaker del notificador exigido en #47.

## 8. Rate Limiting con token bucket

**Problema.** Un tenant puede saturar el servicio; necesitamos acotar su ritmo y
permitir una ráfaga limitada sin bloquear automáticamente a todos los vecinos.

**Patrón.** Un balde acumula fichas hasta un máximo y se recarga con el tiempo.
Cada solicitud consume una; sin fichas se responde 429 con `Retry-After`.

**Dónde está.** [acceso.js](../../reserva-cupos/servicios/api/src/acceso.js),
`crearLimitador`, `recargar`, `rechazarSiAgotado`; la autenticación usa el hash de
la clave para identificar su balde. Los baldes están en un Map del proceso.

**Evidencia medida.** [E5: seguridad de API](../entrega-5/evidencias/seguridad-api.txt)
registra 40 solicitudes con límite 5/s y ráfaga 10: 13 atendidas y 27 respuestas
429 con `Retry-After`. Las ocho solicitudes simultáneas de otro tenant fueron 200.
El número de atendidas incluye fichas recargadas durante esa ejecución.

**Límite y pendiente.** Con varias API los baldes locales no forman un límite global.
El [issue #48](https://github.com/JoniMora/final-pdc/issues/48) exige Redis y prueba
sobre varias instancias. La caché Cache-aside de autenticación también sigue
pendiente; este documento no la declara implementada.

## Incorporaciones de E6 verificadas en Docker

| Problema | Patron | Codigo | Evidencia y estado |
|---|---|---|---|
| Un receptor caido recibe intentos que agravan la caida | Circuit Breaker por tenant | `servicios/notificador/src/circuitos.js`, `reintento.js` | Pruebas locales con receptor HTTP real aprobadas; [integracion Docker aprobada](circuit-breaker.md) |
| Todas las solicitudes repiten la misma lectura de credenciales | Cache-aside con invalidacion de generacion | `servicios/api/src/cache-autenticacion.js`, `acceso.js`, `admin.js` | Pruebas de carreras e invalidacion aprobadas; [metricas y Redis real aprobados](redis.md) |
| Varias API multiplican los limites locales | Token bucket distribuido y atomico | `servicios/api/src/limite-redis.js` | [Limite global aprobado con cuatro APIs](evidencias/redis-escalado.json) |
| Una sola cola limita actividades independientes | Competing Consumers por particion | `compartido/src/particiones.js`, relay y worker | [Medicion real N1/N4](particionado.md): 4,72 frente a 6,74 decisiones/s, orden conservado |
| Reintentos simultaneos crean reservas adicionales | Idempotent Consumer y restriccion unica | admision de API y transaccion del worker | [k6 de duplicados aprobado](evidencias/diagnostico-2026-11-17T03-58-42-009Z/k6.txt): exactamente dos reservas en 40 solicitudes de dos casos |
| Los commits semisincronos saturan la admision | Escritura en lote manteniendo Transactional Outbox | `servicios/api/src/admisiones.js` | [Rafaga aprobada](evidencias/diagnostico-2026-11-17T03-55-55-916Z/k6.txt): 500 admisiones correctas y 10/490/0 |

Las secciones anteriores describen la base historica de E5. Las incorporaciones
de esta tabla tienen pruebas Docker aprobadas el 17/11/2026; sus evidencias
se enlazan en los documentos de cada requisito.

## Cierre de este documento

Se presenta la trazabilidad de los patrones ya implementados. Para cerrar #51
faltan completar las capturas y grabacion, revisar CI del nuevo commit y la aceptacion de los
issues, y publicar `v6-escalabilidad` sobre la version aprobada. La demo y
la defensa del cierre final se siguen por separado en #52 a #56.
