# Circuit breaker del notificador — #47

**Problema.** Un receptor de webhooks caído o lento recibía todos los intentos de todos sus eventos. Cada intento ocupaba al notificador hasta su plazo de 5 s y le sumaba carga a un receptor que ya estaba fallando.

**Patrón.** Un circuito por tenant, con [opossum](https://github.com/nodeshift/opossum) 10.0.0, en `servicios/notificador/src/circuitos.js`:

- **Cerrado:** deja pasar. Con al menos 3 envíos en la ventana de 30 s y la mitad o más fallidos, se abre.
- **Abierto:** rechaza sin hacer HTTP. A los 10 s pasa a semiabierto.
- **Semiabierto:** deja pasar un solo envío de prueba; si sale bien se cierra, si falla vuelve a abrirse.

Solo cuentan como fallas las respuestas que no son `2xx` y los errores de red. Un destino rechazado por la protección SSRF va directo a la DLQ y no abre el circuito. Un tenant caído no abre el de otro: cada uno tiene el suyo. La tabla admite hasta 1000 circuitos y solo desaloja los cerrados, inactivos y sin envíos en curso.

## Qué pasa con los eventos mientras el circuito está abierto

`servicios/notificador/src/main.js` manda el evento rechazado a `webhooks.espera.10s` **sin gastar un intento** (`x-intento` no cambia): el receptor no recibió nada. La copia se confirma en RabbitMQ antes de confirmar el mensaje original, así que no se pierde.

Para que eso no demore indefinidamente la DLQ, `servicios/notificador/src/reintento.js` fija un plazo: a los **400 s del primer fallo** de un evento (el calendario de 10 s, 1 min y 5 min, que suma 370 s, más un margen), el evento va a la DLQ aunque le queden intentos. El instante del primer fallo viaja en la cabecera `x-primer-fallo` (AsyncAPI 1.1.0). Como el plazo solo se comprueba cuando el evento vuelve de su espera, ningún reintento espera más allá del plazo: si le tocaba la espera de 5 min y quedan 100 s, usa la de 1 min. Así llega a la DLQ a más tardar 10 s después de vencido el plazo. Antes de este plazo, con el circuito abierto, solo la prueba de cada semiapertura gastaba un intento: con 20 eventos pendientes la DLQ llegaba a los 13 minutos, y con 1000, en horas.

La garantía no cambia: el webhook es el camino rápido y el feed `/v1/cambios` es la garantía, desde la que el tenant se reconstruye.

## Métricas

| Métrica | Qué mide |
|---|---|
| `pdc_webhook_circuito_estado{tenant}` | 0 cerrado, 1 abierto, 2 semiabierto |
| `pdc_webhook_circuito_transiciones_total{tenant,estado}` | Transiciones de cada circuito |
| `pdc_eventos_total{tipo="webhook",resultado="diferido_circuito"}` | Entregas diferidas sin HTTP |
| `pdc_webhook_demora_segundos` | Demora total, desde que ocurrió el cambio hasta la entrega exitosa (distinta de la duración de un intento HTTP) |

## Evidencia

**Receptor que falla y se recupera** (`node scripts/verificar-e6.js circuito`): un receptor HTTPS solo de prueba (`docker-compose.pruebas-e6.yml`, no publicado en el equipo) responde con error; se generan 11 eventos.

- 8 errores HTTP abren el circuito; **9 entregas se difieren sin llegar al receptor**.
- Abierto a las 04:41:28,486 (UTC) → semiabierto a las 04:41:38,486 (10 s) → cerrado 19 ms después, con el receptor recuperado.
- **11 de 11** entregas llegan.

[Resultado](evidencias/circuito-recuperacion.json) · [métricas](evidencias/circuito-metricas.txt)

**Con Aula real** (`node pruebas/final/circuito-aula.js`): se detiene Aula, se generan 11 decisiones, el circuito del tenant Aula se abre, Aula vuelve y el circuito cierra: **11 de 11** webhooks entregados (`204`). [Resultado](evidencias/circuito-aula/resultado.json) · [registros del notificador](evidencias/circuito-aula/notificador.txt) · [métricas](evidencias/circuito-aula/metricas.txt)

**Servidor del tenant caído varios minutos** (matriz de fallos, escenario `tenant`): Con Aula y aula-db detenidas, el servicio decide igual las 20 reservas del tenant (5 confirmadas, 15 rechazadas); sus 20 webhooks llegan a la DLQ a los 409 s de la caída, con el circuito abriéndose y cerrándose (el plazo de 400 s más, como mucho, una espera de 10 s); al volver, Aula reconstruye las 20 inscripciones desde el feed en 17,9 s. [Detalle](evidencias/matriz/tenant.txt)

**Pruebas de componente** (`servicios/notificador/test/`): el ciclo completo contra un receptor HTTP real de loopback, la eliminación de circuitos inactivos y el plan de reintentos con el plazo (`reintento.test.js`).

## Límites

- El estado del circuito es del proceso del notificador. Hay un solo notificador; con varios, cada uno tendría su circuito por tenant.
- El umbral (3 envíos, 50 %) y la espera (10 s) son fijos por variable de entorno, no por tenant.
