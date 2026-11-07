# Evidencias de entrega 4

Ejecución del 07/11/2026 en macOS 13.7.8 con Docker Engine 24.0.2 y Docker Compose 2.18.1, con el código de la rama `feature/entrega-4-middleware`, que se publica en el tag `v4-middleware`. Se partió de volúmenes vacíos (`docker compose down -v` y `docker compose up --build -d`) y todas las evidencias se generaron en una misma sesión, en el orden de la tabla salvo la 04 y la 09, que se ejecutaron al final. El primer caso de la 09 (firma inválida con marca de tiempo vigente) se repitió al cerrar la sesión: la primera versión usaba una marca de tiempo vieja y el rechazo se debía a la ventana, no a la firma.

Cada archivo de texto muestra el comando, precedido por `$`, su salida sin editar y el código de salida. Un código distinto de cero aparece solo donde la falla es lo que se demuestra: oasdiff rechazando un cambio incompatible en la 02. Las advertencias de MySQL sobre la contraseña en la línea de comandos forman parte de la salida.

`$CLAVE_AULA` es la clave local del tenant Aula (ver `docker-compose.yml`). `$CLAVE`, `$CLAVE_CONTRATO`, `$CLAVE_A` y `$CLAVE_B` son claves de tenants creados durante la sesión con `crear-tenant.sql`: *Pruebas de carga*, *Verificación del contrato* y los dos *Atacante*.

| Archivo | Qué demuestra |
|---|---|
| [01-entorno.txt](01-entorno.txt) | Diez contenedores (los nueve de la Entrega 3 más Traefik). La API ya no publica puerto propio y se alcanza por el gateway. Réplica semisíncrona activa y cada componente cargando el contrato. |
| [02-contratos.txt](02-contratos.txt) | `openapi.yaml` y `asyncapi.yaml` válidos (Redocly y AsyncAPI CLI). La versión 1.1.0 es compatible con la 1.0.0 de la Entrega 3 según oasdiff, y un cambio incompatible simulado se detecta. |
| [03-validacion-api.txt](03-validacion-api.txt) | La API rechaza lo que el contrato no admite antes de ejecutar la ruta (`400`, `401`, `404`, `405` con `Allow`, `415`). Cada ruta implementada está en el contrato y viceversa. |
| [04-schemathesis.txt](04-schemathesis.txt) | Verificación del proveedor: Schemathesis genera cientos de solicitudes desde el contrato contra la API real detrás de Traefik, sin fallas. |
| [05-aula-contra-mock.txt](05-aula-contra-mock.txt) | Verificación del consumidor: Aula funciona contra un mock de Prism generado del contrato, sin la API real, y el mock rechaza una solicitud fuera de contrato. |
| [06-pruebas-componentes.txt](06-pruebas-componentes.txt) | Pruebas `node:test` de cada componente: validador compartido, rutas de la API, decisiones del worker, mensajes del relay y webhook (emisor y receptor probados por separado contra el contrato). |
| [07-descubrimiento.txt](07-descubrimiento.txt) | Traefik descubre tres instancias de la API sin configuración, reparte las solicitudes, retira una instancia detenida y vuelve a una. |
| [08-cancelacion-y-webhooks.txt](08-cancelacion-y-webhooks.txt) | Recorrido completo desde Aula: tres alumnos y dos cupos. Una cancelación devuelve el cupo. Los webhooks firmados mantienen la base de Aula igual a la API. Repetir la cancelación responde `200`, cancelar una rechazada responde `409`, y el feed muestra solo los cambios de estado. |
| [09-webhooks-fallas.txt](09-webhooks-fallas.txt) | Receptor de Aula: firma inválida y reinyección → `401`; evento viejo → sin cambios. SSRF: destinos internos y de metadatos rechazados. Reintentos a los 10 s, 1 min y 5 min con Aula detenida y, agotados, `webhooks.dlq`, con el evento todavía en el feed. |
| [10-mensajes-fuera-de-contrato.txt](10-mensajes-fuera-de-contrato.txt) | Un comando y una entrega de webhook publicados a mano sin cumplir `asyncapi.yaml` van a la DLQ sin ejecutarse. |
| [11-cambio-interno.txt](11-cambio-interno.txt) | Cambió la implementación de la API, el worker, el relay y el despliegue. El cliente de carga de la Entrega 3, sin cambios, obtiene 10 confirmadas, 490 rechazadas y 0 cupos con dos instancias de la API. |

Las instrucciones para repetir cada prueba están en el [README de ejecución](../../../reserva-cupos/README.md) y en la [certificación de la entrega](../README.md#cómo-reproducir).
