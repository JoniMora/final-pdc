# Evidencias de entrega 2

Ejecución del 08/10/2026 en macOS 13.7.8 con Docker Engine 24.0.2 y
Docker Compose 2.18.1, con el código del tag `v2.1-infraestructura`,
a partir de volúmenes vacíos (`docker compose down -v` y
`docker compose up --build -d`).

Cada archivo de texto muestra el comando, precedido por `$`, su salida
sin editar y el código de salida. Los comandos `docker compose exec`
usan `-T` para poder guardar la salida en un archivo. Las advertencias
de MySQL sobre la contraseña en la línea de comandos forman parte de
la salida.

| Archivo | Qué demuestra |
|---|---|
| [01-entorno.txt](01-entorno.txt) | Nueve contenedores en ejecución, tres redes con sus miembros y cuatro volúmenes. |
| [02-persistencia-permisos.txt](02-persistencia-permisos.txt) | Configuración de la réplica, replicación GTID semisíncrona, esquema replicado, réplica en solo lectura y permisos por componente. |
| [03-comunicacion.txt](03-comunicacion.txt) | Recorrido Aula → HTTP → API → RabbitMQ → worker con el mismo identificador; Aula con PostgreSQL detenido y persistencia de sus registros. |
| [04-colas.txt](04-colas.txt) | Exchanges, colas y enlaces de RabbitMQ. |
| [05-espera-10s.txt](05-espera-10s.txt) | Espera de diez segundos por TTL y reenvío a webhooks.entregas. |
| [06-independencia-worker.txt](06-independencia-worker.txt) | Con el worker detenido, la API sigue aceptando mensajes y RabbitMQ los retiene hasta que el worker vuelve. |
| [07-aislamiento-redes.txt](07-aislamiento-redes.txt) | Aula no resuelve los nombres de MySQL ni de RabbitMQ, y la API no resuelve el de PostgreSQL. |
| [08-semisync.txt](08-semisync.txt) | Paso a modo asíncrono con la réplica detenida, recuperación al volver y semisincronía tras reiniciar la réplica. |
| [aula-conexiones.png](aula-conexiones.png) | Interfaz de Aula con PostgreSQL y la API conectados. |
| [aula-registros.png](aula-registros.png) | Registros guardados en PostgreSQL desde la interfaz de Aula (los mismos de 03). |
| [aula-postgresql-detenido.png](aula-postgresql-detenido.png) | Con PostgreSQL detenido: estado "no disponible", consulta rechazada con HTTP 503 y mensaje aceptado con HTTP 202 (su identificador figura en el log del worker de 03). |

Las instrucciones para repetir cada prueba están en el
[README de ejecución](../../../reserva-cupos/README.md).
