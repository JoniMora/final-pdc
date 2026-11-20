# Fallos parciales bajo carga — #50

**Qué se prueba.** Que el sistema escalado resista una ráfaga real mientras se caen piezas: la ráfaga de 500 reservas sobre 10 cupos, con cuatro API y cuatro particiones, durante la cual se detiene una API y el worker de la partición que está procesando la actividad.

`node scripts/verificar-e6.js fallos`:

1. Escala la API a cuatro instancias y crea un tenant de prueba.
2. Lanza la ráfaga de k6 (500 usuarios virtuales). El cliente se comporta como uno correcto: ante un error de red, `429` o `5xx`, reintenta con la **misma** `Idempotency-Key` y el mismo cuerpo, hasta 8 veces.
3. Apenas empieza la carga real, detiene una API.
4. Cuando la cola de la actividad tiene comandos, detiene el worker de esa partición.
5. A los 3 s vuelve a iniciar el worker, y después la API.
6. Al terminar k6, comprueba en MySQL las invariantes y exporta las series de Prometheus con las marcas de cada falla.

## Resultado (20/11/2026)

| Momento (UTC) | Evento |
|---|---|
| 04:51:15,1 | Se detiene una de las cuatro API |
| 04:51:40,7 | Se detiene `worker-p1`, que tenía los comandos de la actividad |
| 04:51:46,8 | Vuelve `worker-p1` |
| 04:51:47,4 | Vuelve la API |

- **500 de 500 admitidas**; el cliente vio 44 errores transitorios (solicitudes en curso en la API detenida) y los reintentó con la misma clave.
- **10 confirmadas, 490 rechazadas, 0 pendientes, 0 participantes con dos reservas, 0 cupos negativos.**
- Las decisiones terminaron 19,7 s después de la última admisión: los comandos de la partición detenida esperaron en su cola durable, y RabbitMQ le reentregó al worker lo que no había confirmado; su idempotencia evitó descontar dos veces.
- La latencia de admisión sube (p95 16,6 s, máximo 20,4 s) porque 500 clientes abren TLS a la vez contra tres API mientras una está caída (p95 del apretón de manos TLS: 12,2 s): es el costo de la falla, no una pérdida.

[Informe con las series de Prometheus y las marcas de cada falla](evidencias/fallos-bajo-carga/informe.html) · [resultado](evidencias/fallos-bajo-carga/resultado.json) · [k6](evidencias/fallos-bajo-carga/k6.txt)

## Configuración que depende de esta prueba

Durante esta prueba, y solo en ella, `docker-compose.fallos-e6.yml` le agrega a Traefik un reintento de transporte (2 intentos, 100 ms) en la ruta `POST /v1/actividades/{id}/reservas`. Es seguro porque esa operación exige `Idempotency-Key`; no se agrega a altas de actividades, tenants ni rotaciones, que no son idempotentes. El entorno normal no reintenta en el gateway.

Sin ese reintento, las solicitudes en curso en la API detenida llegarían al cliente como `502` o `504` y el cliente las reintentaría igual, con la misma clave: el resultado (10 confirmadas, ninguna duplicada) no cambia, pero el cliente vería más errores transitorios. Es lo que mide la [matriz de fallos de la Entrega 5](../entrega-5/evidencias/fallos/api.txt) con una API terminada con SIGKILL, sin ese reintento: 10 confirmadas, 290 rechazadas, cero duplicadas, con 27 reintentos del cliente.

## Otras fallas medidas

La [matriz de fallos](../entrega-5/README.md#recuperación-ante-fallos) de la Entrega 5 cubre worker, relay, RabbitMQ, notificador, API, réplica, aula-db, el servidor del tenant y el failover del primario. Esta entrega le agrega Redis, y vuelve a correr el escenario del tenant con el circuit breaker:

- [Redis detenido durante una ráfaga](evidencias/matriz/redis.txt): 15 s en plena ráfaga de 200. Desde los 0,3 s, `/v1` responde `503` con `Retry-After` mientras `/health` sigue en `200`; los clientes reintentaron 526 veces con la misma clave y el resultado fue 10 confirmadas, 190 rechazadas, ninguna duplicada; la API volvió a atender en cuanto Redis quedó sano, sin reiniciarse.
- [Servidor del tenant caído](evidencias/matriz/tenant.txt): Con Aula y aula-db detenidas, el servicio decide igual las 20 reservas del tenant (5 confirmadas, 15 rechazadas); sus 20 webhooks llegan a la DLQ a los 409 s de la caída, con el circuito abriéndose y cerrándose (el plazo de 400 s más, como mucho, una espera de 10 s); al volver, Aula reconstruye las 20 inscripciones desde el feed en 17,9 s.

## Grabación

Video de una corrida anterior de esta prueba (17/11/2026), editado por la integrante: [fallo.mp4 en Google Drive](https://drive.google.com/file/d/1A_N1ycuPNV_gmTaPBNMfOlLRruA-ttKp/view?usp=sharing). Muestra el mismo procedimiento; los números de esta página son los de la corrida del 20/11. El video no se versiona en Git.
