# API sin estado con Redis — #48

Estado: pruebas unitarias e integracion con Redis real, cuatro APIs y gateway
aprobadas el 17/11/2026. El cierre de #48 requiere revision y CI.

## Limite global

`servicios/api/src/limite-redis.js` ejecuta un token bucket mediante un
script Lua atomico. La clave es el ID del tenant: todas las instancias y
todas sus claves de API comparten el mismo balde. Se usa `TIME` de Redis,
no los relojes potencialmente diferentes de las APIs. El rechazo devuelve
429 con `Retry-After`; los limites propios siguen viniendo de MySQL.

Si Redis esta configurado y no responde, la API devuelve 503. No pasa a un
limite independiente en memoria, que multiplicaria el cupo al escalar.
El limitador de memoria se conserva solo para pruebas sin `REDIS_URL`.

Redis usa TLS con CA e identidad verificadas, password de desarrollo,
red interna y ningun puerto publicado. Se genera `redis.crt` al preparar
el entorno. `maxmemory-policy noeviction` evita expulsar un balde y volver
a habilitar su rafaga mientras sigue consumido. AOF usa `everysec`: ante
un fallo abrupto de Redis puede perderse hasta aproximadamente un segundo
de sus cambios; esto no convierte el rate limiter en un registro durable
de reservas. La fuente de verdad de reservas sigue siendo MySQL.

## Cache-aside de autenticacion

`cache-autenticacion.js` guarda ID, permisos y limites, nunca la clave
original ni el secreto de webhook. TTL positivo: 30 s; negativo: 1 s.
Una consulta fria del mismo hash comparte el trabajo en vuelo dentro de
cada instancia. Los resultados persistentes se comparten mediante Redis.

La clave de cache incluye una generacion. Cambiar permisos, activar o
desactivar un tenant o rotar una clave toma un bloqueo corto en Redis e
incrementa la generacion antes y despues de cambiar MySQL. Las lecturas
anteriores no pueden repoblar la generacion nueva. Durante esa mutacion la
autenticacion responde 503 en vez de usar permisos intermedios. El bloqueo
expira en 30 s para no dejar la plataforma cerrada si muere el proceso.
Una reconexion tambien invalida la generacion, por si una invalidacion
anterior no pudo completarse durante la caida.

El bloqueo y la generacion son globales: es una decision simple y
conservadora para esta entrega, a costa de invalidar caches de otros tenants
al administrar uno. La cache nunca reemplaza las comprobaciones de
permisos y aislamiento por tenant de E5.

## Metricas y prueba de aceptacion

- `pdc_eventos_total{tipo="auth_cache",resultado="hit|miss"}`.
- `pdc_eventos_total{tipo="auth_mysql",resultado="consulta"}` cuenta
  consultas reales de autenticacion; no es el total de consultas de negocio.
- `pdc_eventos_total{tipo="limite_distribuido",resultado="aceptada|rechazada"}`.

```powershell
node reserva-cupos/scripts/verificar-e6.js redis
```

El runner escala la API a 1, 2 y 4, comprueba descubrimiento por Traefik y
ejecuta las mismas 200 lecturas autenticadas sobre `/v1/cambios?limite=1`.
Guarda throughput, p95 del cliente, instancias observadas y consultas de
autenticacion a MySQL. La curva es de lecturas, no de decisiones de reservas.

Con cuatro instancias crea un tenant con tasa 1/s y rafaga 5: las respuestas
200 no pueden superar cinco mas la recarga transcurrida, en vez de veinte
mas recarga. Comprueba 429 y `Retry-After`. Finalmente calienta cache, rota
una clave y cambia permisos; exige invalidacion en todas las instancias.
Restaura la cantidad inicial de APIs en `finally`.

Evidencia aprobada: [redis-escalado.json](evidencias/redis-escalado.json).
Contiene la curva medida con 1, 2 y 4 APIs, las consultas MySQL, el limite
global y las comprobaciones de invalidacion de clave y permisos. La curva
es una medicion de esta corrida; no implica crecimiento lineal garantizado.
Las pruebas locales usan un doble de transporte para carreras de cache;
no se presentan como una validacion del motor Lua de Redis.

Referencias: [node-redis](https://github.com/redis/node-redis),
[scripts atomicos en Redis](https://redis.io/docs/latest/develop/programmability/eval-intro/).
