# Circuit Breaker del notificador — #47

Estado: implementado; pruebas locales e integracion con RabbitMQ y TLS
aprobadas en Docker el 17/11/2026. El cierre del issue requiere revision.

El problema es un receptor de webhooks que responde con errores o no
termina de responder. Repetir cada mensaje inmediatamente consume capacidad
y empeora la caida. Se usa `opossum` 10.0.0, con un circuito por tenant en
`servicios/notificador/src/circuitos.js`.

- Cerrado: permite intentos. Minimo tres muestras y umbral de errores del 50%.
- Abierto: rechaza llamadas sin hacer HTTP. Espera de recuperacion: 10 s.
- Semiabierto: admite una sola prueba. Exito cierra; error vuelve a abrir.
- El timeout total de HTTP sigue en `enviar.js`; no se superponen dos timers
  que pudieran dejar una solicitud anterior ejecutandose sin control.

`main.js` conserva contrato, HMAC, validacion de destino, TLS y publisher
confirms. Un mensaje rechazado por circuito abierto vuelve a espera de 10 s
sin incrementar `x-intento`. Solo los intentos HTTP consumen el presupuesto
existente de 10 s / 1 min / 5 min y posterior DLQ. La copia en espera se
confirma en RabbitMQ antes de confirmar el mensaje original.

Un tenant caido no abre el circuito de otro. La tabla local se limita a
1000 circuitos y solo desaloja circuitos cerrados, inactivos y sin solicitudes
en vuelo. La instancia del notificador sigue siendo unica: el estado de los
circuitos no es distribuido entre varios notificadores.

## Metricas

- `pdc_webhook_circuito_estado{tenant}`: 0 cerrado, 1 abierto, 2 semiabierto.
- `pdc_webhook_circuito_transiciones_total{tenant,estado}`.
- `pdc_eventos_total{tipo="webhook",resultado="diferido_circuito"}`.
- `pdc_webhook_demora_segundos`: desde `ocurrido_en` hasta el HTTP exitoso,
  diferente de la duracion del intento HTTP que ya se media.

El dashboard incorpora los estados y el p95 de demora total.

## Verificacion

Las pruebas unitarias incluyen un receptor HTTP real de loopback: falla
tres veces, el cuarto envio se bloquea sin llegar al receptor, se recupera
y se observa cerrado -> abierto -> semiabierto -> cerrado. Es una prueba
local, no una evidencia de la integracion Docker. Ver el registro real de
[pruebas del notificador](evidencias/verificacion/unitarias-servicios-notificador.txt).

Para repetir la integracion:

```powershell
node reserva-cupos/scripts/verificar-e6.js circuito
```

Requiere el entorno actualizado por `verificar-e6.js levantar`. Inicia un
receptor HTTPS solo de prueba, registra un tenant con secreto propio, hace
fallar el receptor, comprueba apertura y diferimiento, lo recupera y exige
once entregas junto con todas las transiciones. Restaura el notificador
habitual y retira el receptor temporal al terminar, tambien ante error.

La configuracion de prueba vive en `docker-compose.pruebas-e6.yml`; el
receptor no se publica en el host ni se agrega a la lista permitida normal.
Resultados esperados: `circuito-recuperacion.json` y `circuito-metricas.txt`.
Esos archivos solo acreditan la integracion cuando la prueba fue ejecutada
y `aprobada` es verdadero.

Referencia: [opossum](https://github.com/nodeshift/opossum).

## Resultado Docker

[circuito-recuperacion.json](evidencias/circuito-recuperacion.json) registra
`aprobada: true`, las transiciones cerrado -> abierto -> semiabierto -> cerrado
y once entregas recuperadas. [circuito-metricas.txt](evidencias/circuito-metricas.txt)
conserva las metricas observadas. La ejecucion reemplaza el estado anterior
de integracion pendiente; la prueba de loopback sigue siendo evidencia unitaria.

## Aula real

La prueba `pruebas/final/circuito-aula.js` tambien aprobo el 17/11/2026.
Detuvo Aula, observo apertura, la recupero y verifico once entregas HTTP 204
y el ciclo completo. Ver [resultado](evidencias/circuito-aula/resultado.json),
[registros](evidencias/circuito-aula/notificador.txt) y
[metricas](evidencias/circuito-aula/metricas.txt). Es una corrida distinta de
la prueba anterior con receptor HTTPS temporal.
