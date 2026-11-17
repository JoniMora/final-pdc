# Indice de evidencias de E6

## Ejecuciones aprobadas del 17/11/2026

- [Recorrido funcional](01-recorrido.txt).
- [Circuito por tenant](circuito-recuperacion.json) y [metricas](circuito-metricas.txt).
- [Redis y curva de lecturas 1/2/4 APIs](redis-escalado.json). No es una curva de admision de reservas.
- [Carga caliente](carga-caliente/informe.html), [multitenant](carga-multitenant/informe.html) y [rampa](carga-rampa/informe.html).
- [Fallos bajo carga](fallos-bajo-carga/informe.html) e [invariantes](fallos-bajo-carga/resultado.json).
- [107 pruebas unitarias](verificacion-local.json).

Cada carpeta de carga contiene JSON y salida k6. Los resultados aprobados
incluyen repeticiones y estadistica; el material visual pendiente se detalla,
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
