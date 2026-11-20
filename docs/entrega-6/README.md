# Entrega 6 — Patrones y escalabilidad

Módulo 6 — Patrones de diseño distribuido y escalabilidad.

| | |
|---|---|
| **Grupo N°** | 15 |
| **Integrantes** | Jonathan Mora Colodrero · María Constanza Gigli |
| **Tag / Release** | `v6-escalabilidad` |
| **Fecha de entrega** | 20/11/2026 |
| **Documento de patrones** | [`patrones.md`](patrones.md): problema → patrón → código → evidencia medida |
| **Evidencias** | [`evidencias/`](evidencias/README.md): corrida del 20/11/2026 sobre el código de esta entrega, con volúmenes nuevos |

La integración final (demo ensayada, defensa y cierre del proyecto) es la etapa siguiente, con el tag `v7-final` (issues #52 a #56). Sus borradores están en [`docs/final`](../final/).

## Checklist del módulo

La consigna del Módulo 6 pide aplicar al menos dos patrones de diseño distribuido, una prueba de escalado horizontal y un test de carga documentado, con evidencia concreta (métricas y gráficos).

| Requisito | Cumple | Justificación breve / evidencia |
|---|---|---|
| Al menos dos patrones de diseño distribuido aplicados, con evidencia | ☑ Sí | Cuatro patrones nuevos medidos —*circuit breaker* por tenant, *cache-aside* de la autenticación, *token bucket* distribuido y *competing consumers* particionados por actividad— más la admisión por lotes sobre el *outbox*, junto con los cinco de entregas anteriores. [patrones.md](patrones.md) |
| Prueba de escalado horizontal | ☑ Sí | API sin estado con 1, 2 y 4 instancias (límite y caché comunes en Redis) y comandos en 1 y 4 particiones, con el mismo código y el mismo equipo. [Redis](redis.md) · [particiones](particionado.md) · [curva de admisiones](carga.md#curva-con-1-2-y-4-api) |
| Test de carga documentado | ☑ Sí | k6 con tres escenarios (caliente, multitenant y rampa), informes HTML con las series de Prometheus, curva repetida tres veces con media y desvío, y fallos parciales durante la ráfaga. [carga.md](carga.md) · [fallos bajo carga](fallos-bajo-carga.md) |
| Métricas y gráficos | ☑ Sí | Prometheus y un dashboard de Grafana provisionado, por HTTPS. [observabilidad.md](observabilidad.md) |

## Qué se agregó

| Issue | Trabajo | Resultado medido | Detalle |
|---|---|---|---|
| [#45](https://github.com/JoniMora/final-pdc/issues/45) | Métricas con Prometheus y Grafana | 14 paneles; todos los destinos recolectados por HTTPS | [observabilidad.md](observabilidad.md) |
| [#46](https://github.com/JoniMora/final-pdc/issues/46) | Comandos particionados por actividad | Con la misma carga, 29 decisiones/s con 1 partición y 33 con 4, orden por actividad conservado; de 4 a 1 partición sin comandos varados | [particionado.md](particionado.md) |
| [#47](https://github.com/JoniMora/final-pdc/issues/47) | Circuit breaker por tenant en el notificador | Abierto → semiabierto → cerrado en 10 s; 9 entregas diferidas sin HTTP; 11 de 11 entregadas, también con Aula real | [circuit-breaker.md](circuit-breaker.md) |
| [#48](https://github.com/JoniMora/final-pdc/issues/48) | API sin estado con Redis | 600 lecturas con 1, 2 y 4 API: 1 consulta de autenticación a MySQL; límite global con 4 API (5 de 40 con ráfaga 5) | [redis.md](redis.md) |
| [#49](https://github.com/JoniMora/final-pdc/issues/49) | Escenarios de carga con k6 e informe | Caliente 500 → 10/490/0 (p95 de admisión 5,4 s); multitenant 400 en 8 actividades → 80/320; rampa hasta 80/s → 80/604; curva 1-2-4 API con media y desvío | [carga.md](carga.md) |
| [#50](https://github.com/JoniMora/final-pdc/issues/50) | Fallos parciales bajo carga | Una API y el worker de la partición activa detenidos en plena ráfaga: 500 de 500 admitidas, 10/490, 0 duplicadas, 0 cupos negativos | [fallos-bajo-carga.md](fallos-bajo-carga.md) |
| [#51](https://github.com/JoniMora/final-pdc/issues/51) | Documento de patrones y cierre | Este documento, [patrones.md](patrones.md) y las evidencias | |

## Errores encontrados al medir y cómo se corrigieron

Medir con carga y fallos encontró problemas que las pruebas funcionales no mostraban:

- **La admisión por lotes multiplicaba la espera con MySQL caído.** Si fallaba un lote, cada admisión se repetía sola y en serie: con la base caída, 50 admisiones hacían 51 transacciones seguidas (unos 150 s con el `connectTimeout` de 3 s) y bloqueaban a las siguientes. Ahora un error de infraestructura rechaza el lote entero de inmediato con `503`; la repetición individual queda para los errores de una solicitud, como una clave duplicada.
- **Con el circuito abierto, un webhook podía tardar horas en llegar a la DLQ.** El diferido no gastaba intentos, y en cada semiapertura solo un mensaje hacía un intento real. Se agregó un plazo de 400 s desde el primer fallo (cabecera `x-primer-fallo`) y se actualizaron los contratos (OpenAPI 1.3.0, AsyncAPI 1.1.0). La primera versión del plazo tampoco alcanzaba, y la encontró la matriz de fallos: el plazo se comprueba cuando la entrega vuelve de su espera, y una que pasaba a la espera de 5 min a los 390 s volvía a los 690 s. Ahora ningún reintento espera más allá del plazo.
- **Un cambio de permisos dejaba a todos los tenants en `503`.** Mientras el operador rotaba una clave, toda autenticación respondía "actualizando permisos" (hasta 30 s si la API caía a mitad). Ahora, durante el cambio, la autenticación consulta MySQL directo, sin caché; cada cambio es un `UPDATE` atómico, así que nunca ve permisos intermedios.
- **Bajar la cantidad de particiones dejaba comandos varados.** Al pasar de 4 a 1, las colas 1 a 3 seguían enlazadas al exchange. Ahora el relay las desenlaza y reenvía sus comandos pendientes antes de publicar.
- **El health check podía informar la base como caída sin estarlo.** Su pool tiene una conexión y no espera: dos chequeos simultáneos (Docker, Traefik) hacían fallar al segundo. Ahora comparten la misma consulta en curso.
- **Si Redis volvía cargando su AOF, la API quedaba en `503` para siempre.** Al reconectar, la API invalida la caché de permisos con un `INCR` antes de atender; si Redis todavía estaba cargando, respondía `LOADING`, y como había un solo intento, la API no volvía a atender aunque Redis ya estuviera sano. Lo encontró la matriz de fallos en el CI, donde la carga duró 0,3 s. Ahora la preparación se reintenta en cada uso: con una carga forzada de 3,1 s, la API vuelve a los 3 s (con el código anterior seguía en `503` a los 40 s).
- **Grafana quedaba con `admin/admin`.** La contraseña la genera `preparar`, como las demás credenciales.
- **502 aislados en el CI.** La causa probable: Node cerraba las conexiones ociosas a los 5 s y Traefik las reutilizaba hasta los 90 s, así que podía mandar un pedido por una conexión que la API estaba cerrando. Se alinearon (Traefik las retira a los 60 s y la API a los 65 s); los registros no alcanzan para probar que esa era la causa. El 20/11 volvió a aparecer uno en el CI de la integración final, en la prueba de límite de tasa (1 en 10.844 solicitudes a unas 1.000 por segundo), y no se reprodujo en 36.000 solicitudes en local. Esa prueba ahora lo reintenta, como un cliente correcto, y lo cuenta: si son más de 5, falla.

## Seguridad de los componentes nuevos

Complementa el [informe de amenazas de la Entrega 5](../entrega-5/amenazas.md) con las fronteras que agrega esta entrega: API → Redis, Prometheus → servicios y el operador → Prometheus y Grafana.

| Flujo | STRIDE | Amenaza | Mitigación | Evidencia |
|---|---|---|---|---|
| API → Redis | I, T | Espiar o alterar los baldes y la caché de permisos en la red | Redis solo atiende TLS (`port 0`), con la CA local verificada por la API (`rediss://`), contraseña y sin puerto publicado | [seguridad-componentes](evidencias/seguridad-componentes.txt) |
| API → Redis | E | Autenticar con permisos viejos después de rotar una clave o quitar un permiso | Generación global incrementada antes y después de cada cambio; durante el cambio se consulta MySQL; una reconexión también invalida | [redis-escalado](evidencias/redis-escalado.json) |
| Redis | I | Que la caché filtre credenciales | Cada entrada se indexa por el hash de la clave y guarda solo id, permisos y límites | [seguridad-componentes](evidencias/seguridad-componentes.txt) |
| API → Redis | D | Redis caído: sin límite global ni caché | La API responde `503` con `Retry-After` en lugar de seguir sin límite o con uno por instancia; reconecta sola | [matriz: redis](evidencias/matriz/redis.txt) |
| Tenant → API | D | Un tenant que reparte su ráfaga entre instancias para multiplicar su límite | Balde global en Redis, atómico (Lua) y con el reloj de Redis | [redis-escalado](evidencias/redis-escalado.json) |
| Notificador → tenant | D | Un receptor caído que retiene al notificador | Circuito por tenant y plazo de 400 s hasta la DLQ | [circuito](evidencias/circuito-recuperacion.json) · [matriz: tenant](evidencias/matriz/tenant.txt) |
| Prometheus → servicios | I, T | Leer o alterar las métricas en la red | Recolección por HTTPS con la CA verificada; el puerto 9464 no se publica ni pasa por el gateway | [seguridad-componentes](evidencias/seguridad-componentes.txt) |
| Operador → Grafana | S | Entrar con la contraseña de fábrica | Contraseña aleatoria generada por `preparar` y fijada por `levantar`; registro de usuarios deshabilitado; HTTPS; solo `127.0.0.1` | [seguridad-componentes](evidencias/seguridad-componentes.txt) |
| Operador → Prometheus | I | Ver métricas, que incluyen ids de tenant en las del circuito | Solo HTTPS y solo `127.0.0.1` | [seguridad-componentes](evidencias/seguridad-componentes.txt) |

**Riesgos que quedan.** Prometheus no tiene autenticación: quien tenga acceso al equipo puede leer las métricas. La contraseña de Redis está en el repositorio, como las demás de la infraestructura (ver la Entrega 5). Redis es una sola instancia, sin réplica: su caída deja a `/v1` en `503` hasta que vuelve. La contraseña de Grafana queda en `accesos-locales.txt`, que hay que tratar como secreto.

## Decisiones y límites

- **Redis falla cerrado.** Sin Redis, `/v1` responde `503`. Un límite local de reserva multiplicaría el de cada tenant por la cantidad de API, y autenticar sin la caché devolvería la carga a MySQL en el peor momento. Lo admitido sigue su curso por el outbox.
- **Lotes por proceso.** La admisión agrupa las solicitudes de cada instancia. Repartir la misma carga entre más instancias forma lotes más chicos y más commits: por eso agregar API no aumenta las admisiones por segundo. El límite es el commit semisincrónico del primario (ver [carga](carga.md#por-qué-más-api-no-admiten-más)).
- **Un worker por partición.** El consumidor exclusivo conserva el orden por actividad; escalar es agregar particiones, no workers sobre la misma cola.
- **El circuito no gasta intentos, pero tiene plazo.** El receptor no recibe tráfico mientras está caído, y aun así el evento llega a la DLQ a tiempo.
- **Los reintentos de Traefik solo en la prueba de fallos.** `docker-compose.fallos-e6.yml` agrega un reintento de transporte al `POST` de reservas (idempotente por su clave) solo durante esa prueba. El entorno normal no reintenta en el gateway: los reintentos son del cliente, con la misma `Idempotency-Key`. Ver [fallos bajo carga](fallos-bajo-carga.md).
- **Un solo equipo.** Las mediciones son de una notebook (macOS, Docker Desktop): sirven para comparar configuraciones entre sí con el mismo código, no como capacidad de producción.

## Cómo reproducir

Desde `reserva-cupos`, con volúmenes nuevos (`docker compose down -v`):

```shell
node scripts/sistema.js preparar
node scripts/verificar-e6.js levantar                # cuatro particiones, TLS, Redis, Prometheus y Grafana
node pruebas/final/recorrido.js
node scripts/verificar-e6.js circuito
node pruebas/final/circuito-aula.js
node scripts/verificar-e6.js redis
node pruebas/final/particiones.js 4
node scripts/diagnosticar-carga.js --duplicados
node scripts/verificar-e6.js carga
node pruebas/final/curva-admisiones.js
node scripts/verificar-e6.js fallos
node pruebas/final/seguridad-componentes.js
node pruebas/fallos/matriz.js --e6 redis tenant      # el escenario tenant espera la DLQ (unos 7 min)
node pruebas/final/reducir-particiones.js            # deja el entorno con una partición
node pruebas/final/particiones.js 1
```

Ese es el orden en que se generaron las [evidencias](evidencias/README.md). En el CI, el job *Escalabilidad* repite con cuatro particiones el circuito, Redis, el orden por partición, los tres escenarios de carga y los fallos bajo carga; el job *Seguridad* corre la matriz con Redis.
