# Evidencias de la Entrega 6

Corrida del 20/11/2026, de 01:41 a 02:20 (hora de Argentina; los registros están en UTC, de 04:41 a 05:20), en macOS 13.7.8 con Docker Engine 24.0.2, Docker Compose 2.18.1 y Node.js 24, sobre el código de la rama `entrega-6-final` que se publica en el tag `v6-escalabilidad`. Se partió de volúmenes vacíos (`docker compose down -v`) y todo se generó en una misma sesión, en el orden de la tabla, con el entorno de cuatro particiones salvo las dos últimas filas.

Dos pruebas de esta corrida encontraron errores que se corrigieron en el momento: el escenario `tenant` de la matriz (un reintento de webhook podía esperar más allá del plazo de 400 s) y la reducción de particiones (vaciando las colas sobrantes de a una, un comando se podía mover dos veces). Las dos se repitieron con la corrección (02:07 a 02:17) y son las que figuran acá. Las correcciones no cambian lo que miden las pruebas anteriores, en las que ninguna entrega llega al plazo ni baja la cantidad de particiones.

Ninguna evidencia contiene claves, contraseñas ni secretos de webhook: los tenants de prueba se crean en la sesión con la API de administración, las salidas ocultan cualquier clave y las credenciales quedan en `reserva-cupos/seguridad/local/`, fuera de Git.

| Archivo | Comando | Qué demuestra |
|---|---|---|
| [01-recorrido.txt](01-recorrido.txt) | `pruebas/final/recorrido.js` | El recorrido de punta a punta por HTTPS: login y roles en Aula, materia de un cupo, confirmación, rechazo sin sobreasignar, cancelación y reasignación del lugar. |
| [circuito-recuperacion.json](circuito-recuperacion.json) · [circuito-metricas.txt](circuito-metricas.txt) | `verificar-e6.js circuito` | Circuit breaker con un receptor que falla y se recupera: 9 entregas diferidas sin HTTP; cerrado → abierto → semiabierto → cerrado; 11 de 11 entregadas. |
| [circuito-aula/](circuito-aula/resultado.json) | `pruebas/final/circuito-aula.js` | El mismo ciclo con Aula real detenida y recuperada: 11 de 11 webhooks. |
| [redis-escalado.json](redis-escalado.json) | `verificar-e6.js redis` | 1, 2 y 4 API: lecturas por segundo, 1 consulta de autenticación a MySQL en 600 lecturas, límite global (5 de 40 con ráfaga 5) e invalidación al rotar la clave y cambiar permisos. |
| [multi-particiones-n4.json](multi-particiones-n4.json) | `pruebas/final/particiones.js 4` | 320 reservas en 8 actividades con 4 particiones: decisiones por segundo y orden por actividad. |
| [diagnostico-2026-11-20T04-43-47-531Z/](diagnostico-2026-11-20T04-43-47-531Z/k6.txt) | `diagnosticar-carga.js --duplicados` | Idempotencia concurrente con 4 particiones: misma clave → 1 reserva; mismo participante → 1 reserva. |
| [carga-caliente/](carga-caliente/informe.html) · [carga-multitenant/](carga-multitenant/informe.html) · [carga-rampa/](carga-rampa/informe.html) | `verificar-e6.js carga` | Los tres escenarios de k6 con su informe HTML (series de Prometheus), resumen, resultado y salida. |
| [curva-admisiones/](curva-admisiones/informe.html) | `pruebas/final/curva-admisiones.js` | Admisiones con 1, 2 y 4 API, tres corridas cada una, con los commits por configuración. |
| [fallos-bajo-carga/](fallos-bajo-carga/informe.html) | `verificar-e6.js fallos` | Una API y un worker detenidos durante la ráfaga de 500, con las marcas de cada falla sobre las series. |
| [seguridad-componentes.txt](seguridad-componentes.txt) | `pruebas/final/seguridad-componentes.js` | Redis solo TLS y con contraseña, la caché sin credenciales, Prometheus y Grafana solo HTTPS en `127.0.0.1`, Grafana sin `admin/admin` y las métricas fuera del gateway. |
| [matriz/redis.txt](matriz/redis.txt) · [matriz/tenant.txt](matriz/tenant.txt) | `pruebas/fallos/matriz.js --e6 redis tenant` | Redis detenido durante una ráfaga; el servidor del tenant caído hasta que sus webhooks llegan a la DLQ con el circuito abierto. |
| [particiones-reduccion.json](particiones-reduccion.json) | `pruebas/final/reducir-particiones.js` | De 4 a 1 partición con comandos esperando en las colas 1 a 3: el relay las desenlaza y los reenvía; ninguno queda varado. |
| [multi-particiones-n1.json](multi-particiones-n1.json) | `pruebas/final/particiones.js 1` | La misma carga que con 4 particiones, con una. |
| [21](21-decisiones-por-segundo.png) a [28](28-traefik.png) | Grafana | Ocho paneles del dashboard sobre la ventana de toda la corrida (decisiones, lotes, colas, circuito, límite, caché, demora del webhook y Traefik). Ver [observabilidad](../observabilidad.md#evidencias). |
| [verificacion/](verificacion/) | `verificar-e6.js` | La salida de cada paso del verificador. |

Para repetirlas: [cómo reproducir](../README.md#cómo-reproducir). El job *Escalabilidad* del CI corre en cada PR el circuito, Redis, el orden con cuatro particiones, los tres escenarios de carga y los fallos bajo carga, y sube sus evidencias como artifact (`evidencias-escalabilidad`).
