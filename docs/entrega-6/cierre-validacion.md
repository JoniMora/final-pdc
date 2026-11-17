# Estado de validacion de E6

Fecha de revision: 17/11/2026. Rama: entrega-6-final.

## Resultados locales aprobados

| Requisito | Evidencia | Alcance |
|---|---|---|
| Circuit Breaker #47 | [circuito-recuperacion.json](evidencias/circuito-recuperacion.json) | Ciclo completo y once entregas recuperadas usando receptor HTTPS de prueba |
| Redis #48 | [redis-escalado.json](evidencias/redis-escalado.json) | Lecturas con 1/2/4 APIs, limite global, cache e invalidacion |
| Carga #49 | [verificacion-carga.json](evidencias/verificacion-carga.json) | Caliente, multitenant y rampa aprobados; reportes HTML y series Prometheus |
| Fallos #50 | [resultado.json](evidencias/fallos-bajo-carga/resultado.json) | API y worker detenidos y recuperados; 10/490/0, cero duplicadas y cupos negativos |
| Unitarias | [verificacion-local.json](evidencias/verificacion-local.json) | 107 pruebas aprobadas |

Los resultados anteriores no representan una unica corrida aprobada de 'todo'.
Esa primera corrida fallo y luego se repitieron los requisitos por separado.
No se deben mezclar mediciones anteriores a Redis con las posteriores.

## Diferencias frente a la revision del PR #59

- Repeticiones y estadistica aprobadas: nueve corridas POST, tres por configuracion. Ver [resultado](evidencias/curva-admisiones/resultado.json) e [informe](evidencias/curva-admisiones/informe.html). Cada corrida usa 100 solicitudes; la rafaga de 500 esta documentada por separado.
- Curva de admisiones aprobada con 1/2/4 APIs y cuatro workers constantes. Se registran media y desvio muestral de admisiones/s y de los p95 por corrida. No hay mejora sostenida con mas APIs en esta muestra.
- Circuito con Aula real aprobado: detencion, apertura, recuperacion, ciclo completo y once webhooks entregados. Ver [resultado](evidencias/circuito-aula/resultado.json).
- Capturas generales 21 y 22 registradas, con intervalos de cada escenario en evidencias/README.md. Video de fallos enlazado; su acceso sin sesion debe confirmarlo el equipo.
- [CI completo de ec1cecf](https://github.com/JoniMora/final-pdc/actions/runs/44107729654) aprobado: doce jobs exitosos, incluidas Integracion, Seguridad y Escalabilidad.
- La descripcion del PR sigue describiendo el antiguo escalado de tres APIs y dos workers; actualizarla cuando las mediciones y la revision esten completas.
- La comparacion de GitHub confirma que ec1cecf contiene c1b2c3b de E5: behind_by=0 y merge-base=c1b2c3b. La PR #58 y el issue #44 aun estan abiertos; coordinar su cierre antes de E6, sin rebase ni force-push automaticos.
- Tag y release v6-escalabilidad pendientes de version aprobada; v7-final es otra entrega.

## Material visual

Las capturas 21 y 22 y los intervalos locales de cada escenario estan en
[el indice de evidencias](evidencias/README.md). Incluyen ensayos previos;
los HTML y JSON separan los resultados aprobados.

La grabacion de #50 esta enlazada en [fallos bajo carga](fallos-bajo-carga.md).
No hace falta repetir la prueba para corregir este documento. Su acceso sin
sesion y el contenido del video deben confirmarse en la revision del equipo.

## Publicacion

No crear release ni resolver conversaciones solo porque el codigo este escrito.
Revisar el diff y la descripcion del PR, cerrar E5 (#58/#44), aprobar E6 y
confirmar CI del commit final. Publicar v6-escalabilidad sobre la version
acordada, sin mover tags existentes. La integracion v7-final se evalua aparte.
