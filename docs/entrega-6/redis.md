# API sin estado con Redis — #48

En la Entrega 5, el límite de tasa de cada tenant y los datos de autenticación vivían en la memoria de cada instancia de la API: con `--scale api=4`, un tenant obtenía hasta cuatro veces su límite, y cada instancia repetía en MySQL la búsqueda de cada clave. En esta entrega los dos pasan a Redis y la API queda sin estado propio.

## Límite de tasa global

`servicios/api/src/limite-redis.js` ejecuta un token bucket con un script Lua atómico. La clave del balde es el id del tenant, así que todas sus claves y todas las instancias comparten el mismo. El script usa el reloj de Redis (`TIME`), no el de cada API. Al agotarlo, `429` con `Retry-After`. El límite propio de cada tenant sigue saliendo de su fila en MySQL.

## Caché de autenticación (cache-aside)

`servicios/api/src/cache-autenticacion.js` busca primero en Redis el tenant de una clave (por su hash SHA-256) y, si no está, en MySQL, y lo guarda: 30 s si existe, 1 s si no. Varias búsquedas simultáneas del mismo hash en una instancia comparten la consulta en curso. Cada entrada guarda el id, los permisos y los límites; nunca la clave ni el secreto del webhook.

**Invalidación.** Las entradas llevan una generación. Rotar una clave, cambiar permisos o activar o desactivar un tenant toma una marca corta en Redis e incrementa la generación antes y después de cambiar MySQL: una lectura anterior no puede repoblar la generación nueva. Mientras dura el cambio, la autenticación consulta MySQL directo, sin usar ni poblar la caché; como cada cambio es un solo `UPDATE`, nunca ve permisos intermedios. Una reconexión con Redis también incrementa la generación, por si una invalidación no llegó a hacerse durante la caída.

Antes de esta entrega, durante el cambio la autenticación respondía `503` a todos los tenants, hasta 30 s si la API caía a mitad del cambio.

## Si Redis no responde

La API responde `503` (`no-disponible`, con `Retry-After`) en `/v1`, y vuelve sola cuando Redis vuelve. No sigue con un límite local: con N instancias se multiplicaría por N. Lo ya admitido sigue su curso por el outbox. [Redis detenido durante una ráfaga](evidencias/matriz/redis.txt): 15 s en plena ráfaga de 200. Desde los 0,3 s, `/v1` responde `503` con `Retry-After` mientras `/health` sigue en `200`; los clientes reintentaron 526 veces con la misma clave y el resultado fue 10 confirmadas, 190 rechazadas, ninguna duplicada; la API volvió a atender en cuanto Redis quedó sano, sin reiniciarse.

Al reconectar, la API incrementa la generación de la caché antes de atender. Esa preparación se reintenta en cada uso hasta que sale bien: si Redis vuelve todavía cargando su AOF, el `INCR` responde `LOADING`, y con un solo intento la API quedaba en `503` aunque Redis ya estuviera sano (lo encontró la matriz de fallos en el CI; con una carga forzada de 3,1 s, la API corregida vuelve a los 3 s).

## Configuración y seguridad

Redis 8.2 (`Infraestructura/redis/redis.conf`): solo TLS (`port 0`), con certificado de la CA local que la API verifica; contraseña; red interna sin puerto publicado; `maxmemory-policy noeviction`, para no expulsar un balde y regalar su ráfaga; AOF con `everysec`. Redis no guarda reservas: la fuente de verdad sigue siendo MySQL. [Comprobación](evidencias/seguridad-componentes.txt).

## Métricas

- `pdc_eventos_total{tipo="auth_cache",resultado="hit|miss|bypass"}`: aciertos, fallos y lecturas durante un cambio de permisos.
- `pdc_eventos_total{tipo="auth_mysql",resultado="consulta"}`: consultas de autenticación que llegan a MySQL.
- `pdc_eventos_total{tipo="limite_distribuido",resultado="aceptada|rechazada"}`.

## Evidencia

`node scripts/verificar-e6.js redis` escala la API a 1, 2 y 4 instancias, comprueba que Traefik las descubrió y hace en cada caso las mismas 200 lecturas autenticadas (`GET /v1/cambios?limite=1`, 64 conexiones). [Resultado](evidencias/redis-escalado.json):

| API | Lecturas/s | p95 del cliente | Instancias que respondieron | Consultas de autenticación a MySQL |
|---:|---:|---:|---:|---:|
| 1 | 77,1 | 2482 ms | 1 | 1 |
| 2 | 207,6 | 904 ms | 2 | 0 |
| 4 | 157,9 | 1229 ms | 4 | 0 |

- **Caché:** 600 lecturas autenticadas, repartidas entre instancias, con **una sola** consulta a MySQL.
- **Límite global:** con 4 API, un tenant con 1/s y ráfaga 5 envía 40 pedidos: **5 admitidos** y 35 `429` con `Retry-After`. Con límites locales podrían haber sido hasta 20.
- **Invalidación:** después de rotar la clave, la anterior deja de autenticar en las cuatro API; después de cambiar los permisos, rigen los nuevos en las cuatro.

La curva es de lecturas, que no escriben en el primario: de 1 a 2 instancias casi se triplica. Con 4 no mejora respecto de 2; es una sola corrida por configuración, y las cuatro instancias comparten la CPU del mismo equipo con el resto del entorno, así que no se interpreta como un límite de la API. La de admisiones de reservas, que sí escriben, está en [carga](carga.md#curva-con-1-2-y-4-api).

Las pruebas de componente (`servicios/api/test/redis.test.js`) cubren las carreras de la caché con un doble del transporte; la atomicidad real del script Lua es la de esta prueba con Redis.

## Límites

- Redis es una sola instancia, sin réplica ni Sentinel.
- La generación es global: un cambio de un tenant invalida la caché de todos.
- Las sesiones de Aula siguen en su memoria: Aula es una sola instancia.

Referencias: [node-redis](https://github.com/redis/node-redis) · [scripts en Redis](https://redis.io/docs/latest/develop/programmability/eval-intro/).
