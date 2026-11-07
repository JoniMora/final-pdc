# Cambios del contrato

Versionado semántico sobre cada documento. Un cambio compatible sube la versión menor. Un cambio incompatible exige una versión mayor (y, en la API, una ruta `/v2`). El CI compara cada PR contra `main` con [oasdiff](https://github.com/oasdiff/oasdiff) y la rechaza si encuentra un cambio incompatible.

## `openapi.yaml`: API pública

### 1.1.0 · Entrega 4

Compatible con 1.0.0 (verificado con `oasdiff breaking`).

- **Nuevo:** `POST /v1/reservas/{id}/cancelacion`. La cancelación es asíncrona, igual que la reserva: responde `202` y el worker devuelve el cupo. Es idempotente por naturaleza, así que no requiere `Idempotency-Key`. Se eligió un `POST` sobre un subrecurso y no `DELETE /v1/reservas/{id}`, que anticipaba la versión 1.0.0: la reserva no desaparece, cambia de estado y sigue consultable y en el feed.
- **Nuevo:** sección `webhooks` con el evento `cambioDeReserva` (esquema `EventoReserva`), la cabecera `X-Firma` y las reglas de verificación, reintentos y deduplicación.
- **Nuevo:** respuesta `400` en `GET /v1/actividades/{id}` y `GET /v1/reservas/{id}` para un identificador que no es un UUID. Antes respondían `404`; ahora la API valida cada solicitud contra este contrato.
- **Cambio en el feed:** `Cambio.tipo` pasa de `enum` a `x-extensible-enum` y suma `reserva.cancelada` y `reserva.fallida`. El primer intento agregó los valores al `enum`, y oasdiff lo marcó como incompatible: un cliente escrito contra 1.0.0 podía rechazar un tipo que no conocía. Se resolvió declarando la enumeración como extensible, como establece la descripción del feed: el lector aplica la instantánea según su versión e ignora los tipos desconocidos. Aula, el único consumidor del feed, ya trabaja así.

### 1.0.0 · Entrega 3

Primera versión: actividades, admisión de reservas con `Idempotency-Key`, consulta, listado paginado por cursor y feed de cambios.

## `asyncapi.yaml`: mensajería interna

### 1.0.0 · Entrega 4

Primera versión. Formaliza los mensajes que ya existían en la Entrega 3 (`reservar`) y agrega `cancelar` y las entregas de webhook. Las entidades se referencian desde `openapi.yaml`.
