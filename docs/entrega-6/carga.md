# Escenarios de carga e informe — #49

Tres escenarios de k6 contra el entorno completo (TLS, Redis, cuatro particiones), una curva de admisiones con 1, 2 y 4 API repetida tres veces, y fallos parciales durante la ráfaga ([fallos bajo carga](fallos-bajo-carga.md)). Todo se midió el 20/11/2026, en una notebook con macOS y Docker Desktop, sobre el código de esta entrega.

## Escenarios

`node scripts/verificar-e6.js carga` corre los tres en orden. Cada uno crea sus tenants (límite 1000/s, para medir el sistema y no el límite) con un receptor de webhooks HTTPS de prueba que verifica la firma, espera a que se decidan las reservas y se entreguen los webhooks, y deja en `evidencias/carga-<escenario>/` la salida de k6, su resumen en JSON, el resultado y un informe HTML con las series de Prometheus.

| Escenario | Carga | Resultado | p95 de admisión (k6) | p95 de la demora total del webhook | Informe |
|---|---|---|---:|---:|---|
| Caliente | 500 reservas simultáneas sobre una actividad de 10 cupos | 500 de 500 con `202`; **10 confirmadas, 490 rechazadas, 0 pendientes, 0 cupos**; decididas 10,5 s después de la última admisión; 1004 de 1004 checks | 5,42 s | 1,7 s | [HTML](evidencias/carga-caliente/informe.html) · [k6](evidencias/carga-caliente/k6.txt) |
| Multitenant | 4 tenants con 2 actividades cada uno, 400 reservas, 80 usuarios virtuales | 400 de 400 con `202`; **80 confirmadas y 320 rechazadas** (10 y 40 por actividad); 400 webhooks entregados a sus tenants | 1,94 s | 1,9 s | [HTML](evidencias/carga-multitenant/informe.html) · [k6](evidencias/carga-multitenant/k6.txt) |
| Rampa | 0 → 5 → 10 → 20 → 40 → 80 → 0 solicitudes/s, etapas de 5 s | 684 de 684 con `202`; **80 confirmadas y 604 rechazadas**; 684 webhooks entregados | 2,58 s | 2,5 s | [HTML](evidencias/carga-rampa/informe.html) · [k6](evidencias/carga-rampa/k6.txt) |

En los tres: ningún cupo negativo, ningún participante con dos reservas y ninguna reserva pendiente al final.

**Cómo leer los números.**

- La latencia de admisión es de un sistema que espera la réplica en cada commit: incluye la conexión TLS de cada usuario virtual (en el caliente, 500 apretones de manos TLS a la vez: p95 de 1,5 s solo en eso) y la espera de su lote.
- La demora del webhook (`pdc_webhook_demora_segundos`) va desde que ocurrió la decisión hasta que el receptor la aceptó: cola, worker, outbox, relay y notificador.
- Las series de Prometheus usan ventanas de un minuto, así que sus picos están suavizados respecto de k6.
- La tasa general de k6 incluye la preparación (crear tenants y actividades): no se usa como tasa de admisión.

## Curva con 1, 2 y 4 API

`node pruebas/final/curva-admisiones.js`: con cuatro particiones constantes, 100 reservas por corrida sobre una actividad de 10 cupos (64 conexiones, autenticación calentada, sin reintentos), tres corridas por configuración en orden rotado (1-2-4, 4-1-2, 2-4-1). Además de las admisiones por segundo, cuenta en cada API los commits de admisión (`pdc_admision_lote_tamano`). Todas las corridas: 100 de 100 con `202`, 10 confirmadas, 90 rechazadas y 0 cupos.

| API | Admisiones/s (media ± desvío) | p95 del cliente | Commits para 100 admisiones | Admisiones por commit |
|---:|---:|---:|---:|---:|
| 1 | 64,6 ± 21,4 | 1624 ± 610 ms | 10,0 ± 3,0 | 10,7 ± 3,4 |
| 2 | 68,0 ± 24,8 | 1635 ± 740 ms | 14,0 ± 1,7 | 7,2 ± 0,8 |
| 4 | 57,2 ± 15,3 | 1787 ± 564 ms | 27,3 ± 3,8 | 3,7 ± 0,6 |

[Gráficos](evidencias/curva-admisiones/informe.html) · [datos por corrida](evidencias/curva-admisiones/resultado.json) · [panel de Grafana](evidencias/22-admision-y-lotes.png)

### Por qué más API no admiten más

Cada admisión es un commit que espera la confirmación de la réplica semisincrónica: ese commit es el recurso escaso, y es del primario, no de la API. La admisión por lotes lo amortiza, pero cada API arma sus propios lotes: con la misma carga repartida entre cuatro instancias, cada una junta menos solicitudes por lote, y el primario hace casi el triple de commits (27 contra 10) para las mismas 100 reservas. Por eso las admisiones por segundo no crecen con las instancias: la dispersión entre corridas (±15 a ±25) es mayor que las diferencias entre configuraciones.

Escalar la API horizontalmente sí sirve para lo que no escribe: las [lecturas autenticadas](redis.md#evidencia) casi se triplican de 1 a 2 instancias. Para que la admisión escale haría falta repartir el commit (varios primarios por grupo de tenants) o relajar la durabilidad de la admisión; las dos cambian garantías y quedan fuera de esta entrega.

## Particiones

La comparación de 1 y 4 particiones (decisiones por segundo y orden por actividad) está en [particionado.md](particionado.md).

## Reproducir

Con el entorno de cuatro particiones (`node scripts/verificar-e6.js levantar`):

```shell
node scripts/verificar-e6.js carga          # caliente, multitenant y rampa
node pruebas/final/carga.js caliente        # o uno solo
node pruebas/final/curva-admisiones.js
```

No correr dos a la vez: todos miden sobre el mismo primario. El job *Escalabilidad* del CI corre los tres escenarios en cada PR, con los mismos criterios.
