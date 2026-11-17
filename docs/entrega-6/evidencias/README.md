# Indice de evidencias de E6

## Ejecuciones aprobadas del 17/11/2026

- [Recorrido funcional](01-recorrido.txt).
- [Circuito por tenant](circuito-recuperacion.json) y [metricas](circuito-metricas.txt).
- [Redis y curva de lecturas 1/2/4 APIs](redis-escalado.json). No es una curva de admision de reservas.
- [Carga caliente](carga-caliente/informe.html), [multitenant](carga-multitenant/informe.html) y [rampa](carga-rampa/informe.html).
- [Fallos bajo carga](fallos-bajo-carga/informe.html) e [invariantes](fallos-bajo-carga/resultado.json).
- [Video de fallos bajo carga](https://drive.google.com/file/d/1A_N1ycuPNV_gmTaPBNMfOlLRruA-ttKp/view?usp=sharing): aportado el 17/11/2026; revisar acceso y contenido antes de entregar.
- [107 pruebas unitarias](verificacion-local.json).

Cada carpeta de carga contiene JSON y salida k6. Los resultados aprobados
incluyen repeticiones y estadistica. El estado de cierre se documenta
en [cierre de validacion](../cierre-validacion.md).

- [Curva repetida de admisiones POST](curva-admisiones/informe.html): nueve corridas con media y desvio.
- [Circuito con Aula real](circuito-aula/resultado.json): detencion y recuperacion aprobadas.

## Antecedentes

02-carga-escalado.txt y 03-seguridad-recuperacion.txt pertenecen a la base
anterior. Las mediciones N1/N4 y su comparacion se describen en
[particionado](../particionado.md), con sus limites y fecha.
Los diagnosticos fallidos no acreditan aprobacion. La primera ejecucion de
verificacion-todo.json fallo; las pruebas posteriores estan registradas
por requisito, sin modificar retroactivamente ese resultado.

## Capturas y trazabilidad temporal

[21: dashboard general](21-dashboard-tres-horas.png) y
[22: Redis y circuitos](22-dashboard-redis-circuitos.png) se capturaron el
17/11/2026 alrededor de las 11:20, con Last 3 hours. Muestran un intervalo
compartido; no son tres capturas independientes ni una corrida continua.
Las ventanas de las corridas aprobadas, hora de Buenos Aires (UTC-3), son:

| Escenario | Intervalo registrado | Evidencia detallada |
|---|---|---|
| caliente | 10:23:00 a 10:24:58 | [HTML](carga-caliente/informe.html) / [JSON](carga-caliente/resultado.json) |
| multitenant | 10:25:18 a 10:26:42 | [HTML](carga-multitenant/informe.html) / [JSON](carga-multitenant/resultado.json) |
| rampa | 10:27:01 a 10:29:02 | [HTML](carga-rampa/informe.html) / [JSON](carga-rampa/resultado.json) |

Las capturas tambien incluyen ensayos anteriores, incluidos fallos; las
marcas de tiempo anteriores identifican los resultados aprobados. Los
HTML contienen las series de Prometheus de cada escenario y sus p95.
La curva repetida se observa alrededor de las 11:08-11:13 y el circuito
con Aula alrededor de las 11:16-11:17. La ausencia de un punto semiabierto
en el scraping no contradice las transiciones de los registros del circuito.

## CI de la version tecnica

[CI completo de ec1cecf](https://github.com/JoniMora/final-pdc/actions/runs/44107729654): los doce jobs aprobaron sobre ec1cecf.
El ajuste del 502 se documenta en [ci-integracion.md](../ci-integracion.md).
