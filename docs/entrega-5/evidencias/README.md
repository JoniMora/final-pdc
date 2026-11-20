# Evidencias de la Entrega 5

Ejecución del 14/11/2026 (21:11, hora de Argentina; los registros están en UTC) en macOS 13.7.8 con Docker Engine 24.0.2, Docker Compose 2.18.1 y Node.js 24, con el código del commit `3eeac3a` de la rama `entrega-5-seguridad`, que se publica en el tag `v5-seguridad`. Se partió de volúmenes vacíos (`docker compose down -v`) y todas las evidencias se generaron en una misma sesión, en el orden de la tabla. La matriz de fallos va última porque su último escenario deja la réplica promovida.

Las 01 a 05 transcriben cada comando, precedido por `$`, con su salida sin editar y el código de salida. Las suites de seguridad y la matriz de fallos escriben su propio registro: una línea `OK:` por cada comprobación, los datos medidos con `·` y el resultado al final. Las claves de los tenants de prueba se crean en la misma sesión con la API de administración y no aparecen en la salida. Ninguna evidencia contiene claves privadas, contraseñas ni cookies: los certificados y las credenciales se generan en `reserva-cupos/seguridad/local/`, fuera de Git.

| Archivo | Qué demuestra |
|---|---|
| [01-entorno.txt](01-entorno.txt) | Once contenedores (los diez de la Entrega 4 más el proxy del socket), todos sanos; la réplica conectada por TLS; la API y Aula respondiendo por HTTPS verificado con la CA local. |
| [02-contratos.txt](02-contratos.txt) | `openapi.yaml` 1.2.0 y `asyncapi.yaml` válidos; sin cambios incompatibles respecto de `v4-middleware` (oasdiff y ejemplos de los mensajes). |
| [03-pruebas-componentes.txt](03-pruebas-componentes.txt) | Pruebas `node:test` de cada componente: conexiones TLS comunes, permisos, límite de tasa y `/admin` de la API, HTTPS obligatorio en el notificador, y login, sesiones, CSRF, roles, rutas reales y reconciliación de Aula. |
| [seguridad-api.txt](seguridad-api.txt) | Administración de tenants y rotación de claves; aislamiento entre tenants (`404`); permisos por clave (`403`); límite de tasa (`429` para el saturado, el vecino sin efecto); firma inválida y reinyección de webhooks (`401`); SSRF a metadatos, a la red interna y por HTTP, derivado a la DLQ. |
| [seguridad-aula.txt](seguridad-aula.txt) | Login, cookie `HttpOnly; Secure; SameSite=Strict`, roles, CSRF, propiedad de las reservas, reconstrucción desde el feed, operación con `aula-db` detenida y reconciliación al volver. |
| [cifrado.txt](cifrado.txt) | TLS positivo y negativo en cada puerto publicado; la API sin HTTP; `Ssl_version` y `Ssl_cipher` de cada servicio y de la réplica en MySQL; MySQL y PostgreSQL rechazan el texto plano; RabbitMQ solo AMQPS con `ssl=true` en cada conexión; replicación cifrada y verificada; Traefik sin el socket de Docker (escritura → `403`). |
| [captura-trafico.txt](captura-trafico.txt) | tcpdump entre Traefik y la API mientras se crean actividades con un nombre conocido: el nombre, la clave y las cabeceras no aparecen; sí los registros TLS. |
| [04-schemathesis.txt](04-schemathesis.txt) | Schemathesis por HTTPS contra la API pública (clave de tenant) y contra la administración (clave del operador): 1067 y 925 casos generados, sin fallas. La fase con estado crea, consulta y cancela reservas, y crea, cambia y rota tenants. |
| [05-carga.txt](05-carga.txt) | k6 por HTTPS: la ráfaga de 500 sobre 10 cupos de la Entrega 3 da 10 confirmadas, 490 rechazadas y 0 cupos; con el mismo límite (10/s, ráfaga 20), el tenant saturado recibe 4929 respuestas `429` y el vecino ninguna. |
| [fallos/resumen.md](fallos/resumen.md) | Matriz de fallos: un archivo por escenario con el efecto observado, la garantía verificada y el tiempo de recuperación; el último, el failover del primario con RTO y RPO. |

Para repetirlas: [README de ejecución](../../../reserva-cupos/README.md#pruebas) y [certificación](../README.md#cómo-reproducir).
