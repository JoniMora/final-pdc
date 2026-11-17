# Escenarios de carga e informe — #49

Estado: escenarios, exportacion y graficos preparados. Las nuevas corridas
con Redis y sus reportes requieren Docker y todavia no fueron ejecutadas
por el asistente. No se declaran resultados inexistentes.

## Mediciones reales ya disponibles

Antes de incorporar Redis, la escritura en bloque de la API permitio
admitir 500 reservas sin errores, conservando 10 confirmadas, 490 rechazadas
y cero pendientes, con N=1 y N=4. La idempotencia concurrente tambien paso.
Con ocho actividades, N=1 midio 4,72 decisiones/s y N=4 6,74: mejora observada
1,43x en una corrida de cada configuracion. El p95 cliente empeoro de
2.989 a 5.218 ms en ese escenario: throughput y latencia no son lo mismo.

Ver [detalle y limites de la comparacion](particionado.md). Los datos de esas
ejecuciones son anteriores a Redis; no certifican el rendimiento del codigo
nuevo. No se comparan corridas de CI y de la notebook como si fueran el mismo
entorno, ni corridas con versiones diferentes de la API.

## Comandos reproducibles

Con el entorno actualizado ya levantado:

```powershell
node reserva-cupos/pruebas/final/carga.js caliente
node reserva-cupos/pruebas/final/carga.js multitenant
node reserva-cupos/pruebas/final/carga.js rampa
```

O los tres en secuencia:

```powershell
node reserva-cupos/scripts/verificar-e6.js carga
```

- **Caliente:** 500 solicitudes concurrentes para 10 cupos; exige todas las
  admisiones correctas y el resultado 10 / 490 / 0.
- **Multitenant:** cuatro tenants, dos actividades por tenant, 400
  solicitudes con 80 usuarios virtuales. Exige 202 en cada admision y que
  no haya cupos negativos ni decisiones pendientes al final.
- **Rampa:** tasas 0 -> 5 -> 10 -> 20 -> 40 -> 80 -> 0 solicitudes/s,
  con etapas de 5 s. Mide la aparicion de 429/5xx, backlog y latencia.
  Es una prueba de saturacion: esos rechazos se registran, no se presentan
  como admisiones exitosas. No se exige ausencia de sobrecarga; se exige
  coherencia del protocolo y conservacion de cupos.

Cada runner crea tenants propios y un receptor HTTPS firmado de prueba
para medir demora real de webhooks. Espera a que se entreguen los webhooks
de las reservas decididas y restaura el notificador al terminar.

## Reportes

Cada escenario escribe en `evidencias/carga-<escenario>/`:

- `k6.txt`: salida real y errores, sin claves.
- `resumen.json`: metricas de k6; excluye `setup_data` y `options.env`,
  porque pueden contener credenciales.
- `informe.html`: tabla de metricas y graficos generados desde series reales
  de Prometheus; no usa servicios externos ni inventa muestras.
- `resultado.json`: estado, reservas, series y cualquier error.

Se grafican admisiones/s, p95 de admision, mensajes por cola y p95 de demora
del webhook. Si faltan muestras, el runner lo informa como pendiente y
falla la verificacion del escenario. Los paneles equivalentes estan en
Grafana; todavia deben guardarse capturas de las nuevas corridas.

La tasa general de k6 incluye setup y teardown. No se usa ese valor como
throughput de admision. El histograma `admision_duracion_ms` mide el intento
HTTP; `pdc_webhook_demora_segundos` mide hasta la entrega efectiva. La demora
del webhook incluye la cola y sus reintentos y no debe confundirse con la
duracion del intento HTTP.

## Limite del primario

El issue #49 referencia aproximadamente 110-120 commits/s medidos en E3.
Ese dato es historico, no un resultado de la notebook actual. En los
diagnosticos actuales se observaron esperas `waiting for handler commit` y
`Waiting for semi-sync ACK from replica`. Agregar conexiones no resolvio
la saturacion. La escritura masiva reduce consultas y commits por admision,
pero todos los workers siguen compartiendo el primario y su almacenamiento.
Escalar APIs o colas no elimina ese limite y no permite prometer crecimiento
lineal. Las nuevas curvas deben analizarse cuando terminen las corridas.

## Plazo de drenaje de la rafaga

La prueba admite 500 solicitudes concurrentes y exige al finalizar 10 confirmadas,
490 rechazadas, cero pendientes y cero cupos disponibles. Espera como maximo
180 segundos despues de las admisiones para el procesamiento asincrono. Este
plazo funcional no es un objetivo de rendimiento: `espera_decisiones_ms` conserva
el tiempo real y los reportes conservan la latencia de admision.

La corrida del 17/11/2026 a las 13:07 UTC admitio las 500 solicitudes sin errores
HTTP, pero alcanzo el antiguo limite de 120 segundos con 35 pendientes. Esa
corrida sigue siendo fallida; el cambio de plazo requiere una nueva ejecucion.

El cliente de admision espera hasta 60 segundos por respuesta. Este timeout
no es un SLO ni sustituye analizar el p95. En la corrida de las 13:18 UTC,
las 500 reservas terminaron en 10 confirmadas y 490 rechazadas, pero varias
respuestas excedieron el anterior timeout de 20 segundos. Esa corrida tambien
se conserva como fallida: persistir la reserva no acredita haber respondido
HTTP 202 al cliente. La nueva corrida sigue exigiendo 500 respuestas 202.

