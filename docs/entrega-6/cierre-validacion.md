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
- Capturas actuales de Grafana por escenario y grabacion del fallo pendientes.
- [CI de c9a28ca](https://github.com/JoniMora/final-pdc/actions/runs/44098389774) completo: todos los jobs aprobaron. Los commits nuevos requieren su propio CI.
- La descripcion del PR sigue describiendo el antiguo escalado de tres APIs y dos workers; actualizarla cuando las mediciones y la revision esten completas.
- Revisar integracion de E5 y base de merge con el companero. No rebasar ni forzar el push automaticamente.
- Tag y release v6-escalabilidad pendientes de version aprobada; v7-final es otra entrega.

## Material visual

Dashboard: https://localhost:3002/d/reserva-cupos-e6

Seleccionar un intervalo que incluya la corrida real. Para cada escenario guardar
una captura con admisiones/s, p95, decisiones y colas; capturar tambien cache,
consultas MySQL y estado de circuitos cuando corresponda. Si no hay datos no
presentar un panel vacio como prueba. Conservar el intervalo y nombre del escenario.

Para la grabacion de #50, usar la captura de pantalla de Windows y repetir
'node reserva-cupos/scripts/verificar-e6.js fallos' en la terminal de IntelliJ,
mostrando los instantes de detencion, recuperacion, resultado y reporte HTML.
No mostrar accesos-locales.txt ni claves. Guardar el video o un enlace accesible
para el evaluador; el reporte HTML existente no sustituye una grabacion.

## Publicacion

No crear release ni resolver conversaciones solo porque el codigo este escrito.
Completar los puntos anteriores, revisar el diff con el companero y confirmar CI.
