# Evidencias de entrega 3

Ejecución del 19/10/2026 en macOS 13.7.8 con Docker Engine 24.0.2 y
Docker Compose 2.18.1, con el código de la rama
`feature/entrega-3-comunicacion` que se publica en el tag
`v3-comunicacion`, a partir de volúmenes vacíos (`docker compose down -v`
y `docker compose up --build -d`). Las evidencias 06, 07 y 10 se
regeneraron en la misma sesión, después de corregir la consulta de
verificación de las ráfagas.

Cada archivo de texto muestra el comando, precedido por `$`, su salida
sin editar y el código de salida. Los comandos `docker compose exec` y
`docker compose run` usan `-T` para poder guardar la salida en un
archivo; k6 se ejecuta con `-q` para omitir la barra de progreso. Las
advertencias de MySQL sobre la contraseña en la línea de comandos forman
parte de la salida.

`$CLAVE_AULA` es la clave local del tenant Aula (ver
`docker-compose.yml`) y `$CLAVE` la del tenant *Pruebas de carga*,
creado en 02 con `crear-tenant.sql`.

| Archivo | Qué demuestra |
|---|---|
| [01-entorno.txt](01-entorno.txt) | Nueve contenedores, réplica configurada y semisíncrona, tenant de Aula guardado solo como hash y arranque de API, relay y worker. |
| [02-api-sincrona.txt](02-api-sincrona.txt) | Canal síncrono: admisión `202` + `Location` y decisión posterior, idempotencia (`200` y `422`), errores del contrato (`400`, `401`, `409`), aislamiento entre tenants (`404`), cierre de la admisión, listado por cursor y feed de cambios. |
| [03-aula.txt](03-aula.txt) | Aula → HTTP → API: crea una materia (actividad en el servicio y materia en su PostgreSQL), inscribe a tres alumnos en dos cupos y lee el resultado desde la API. |
| [04-asincrono.txt](04-asincrono.txt) | Canal asíncrono: exchange de hash consistente; con el worker detenido la API admite y los comandos esperan en la cola; con RabbitMQ detenido la API admite y el relay sigue secuenciando el feed, y al volver el broker se reconecta y publica. |
| [05-concurrencia-ingenua-atomica.txt](05-concurrencia-ingenua-atomica.txt) | El caso de concurrencia: 50 transacciones sobre 10 cupos. Leer y después escribir asigna 50 (40 sobreasignados); el `UPDATE` condicional asigna 10. |
| [06-rafaga-1-worker.txt](06-rafaga-1-worker.txt) | 500 solicitudes HTTP simultáneas sobre 10 cupos con un worker: 10 confirmadas, 490 rechazadas, 0 pendientes, 0 cupos (k6 y MySQL). |
| [07-rafaga-2-workers.txt](07-rafaga-2-workers.txt) | La misma ráfaga con dos workers sobre la misma cola: mismo resultado, con decisiones de ambos workers sobre la misma actividad. |
| [08-duplicados.txt](08-duplicados.txt) | 20 solicitudes simultáneas del mismo participante (1 × `202`, 19 × `409`) y 20 reintentos simultáneos con la misma `Idempotency-Key` (1 × `202`, 19 × `200`). |
| [09-reentrega.txt](09-reentrega.txt) | Reentrega de un comando ya procesado: el worker la detecta y no descuenta otro cupo (4 de 5 antes y después). |
| [10-mysql-caido.txt](10-mysql-caido.txt) | Con el primario detenido la API responde `503` + `Retry-After` y el relay reintenta sin perder trabajo; al volver, todo se recupera sin intervención. |
| [11-contrato.txt](11-contrato.txt) | El contrato `openapi.yaml` es válido según Redocly CLI. |

Las instrucciones para repetir cada prueba están en el
[README de ejecución](../../../reserva-cupos/README.md) y en la
[certificación de la entrega](../README.md#cómo-reproducir-el-caso-de-concurrencia-resuelto).
