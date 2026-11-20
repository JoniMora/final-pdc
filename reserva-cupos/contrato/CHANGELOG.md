# Cambios del contrato

Versionado semántico sobre cada documento. Un cambio compatible sube la versión menor. Un cambio incompatible exige una versión mayor (y, en la API, una ruta `/v2`). El CI compara cada PR contra `main` y la rechaza si encuentra un cambio incompatible: `openapi.yaml` con [oasdiff](https://github.com/oasdiff/oasdiff) y `asyncapi.yaml` validando los ejemplos de cada versión contra los esquemas de la otra (`pruebas/contrato/compatibilidad-mensajes.sh`). Una excepción a esa regla se registra acá con su justificación y la revisan los dos integrantes (CODEOWNERS).

## `openapi.yaml`: API pública

### 1.3.0 · Entrega 6

Compatible con 1.2.0: solo cambian descripciones; oasdiff no informa cambios. Documenta comportamiento que la Entrega 6 agregó detrás de la misma interfaz.

- **Reintentos de webhooks con circuit breaker.** Si la mitad o más de los envíos recientes a un tenant fallan (con al menos 3), el notificador deja de enviarle durante 10 s y después prueba con un solo evento; mientras tanto retiene sus eventos sin gastar intentos. El calendario de reintentos (10 s, 1 min y 5 min) no cambia, y se agrega un tope: a los 400 s del primer fallo de un evento, este queda en la DLQ aunque le queden intentos. Sin ese tope, con el circuito abierto un evento podía tardar horas en llegar a la DLQ.
- **`503` más amplio.** `NoDisponible` cubre también la caída del almacén del límite de tasa (Redis), no solo la de la base de datos.
- **Límite de tasa global.** Aclara que el límite de cada tenant vale igual con varias instancias de la API detrás del gateway (antes cada instancia contaba por su cuenta).

### 1.2.0 · Entrega 5

Compatible con 1.1.0: oasdiff no informa cambios incompatibles ni advertencias. Un cliente de 1.1.0 sigue funcionando sin cambios, porque su clave conserva los cuatro permisos y el límite de tasa por defecto (50/s, ráfaga 100) supera el uso normal.

- **Nuevo: permisos por clave (scopes).** Cada operación de `/v1` declara en `security` el permiso que exige (`actividades:escribir`, `reservas:escribir`, `lectura` o `cambios:leer`). La API los aplica leyendo esa misma declaración del contrato, así que el permiso documentado y el aplicado no pueden diferir. Una clave sin el permiso responde `403` (`permiso-insuficiente`).
- **Nuevo: límite de tasa por tenant.** Token bucket por tenant. Al superarlo, `429` (`limite-de-tasa`) con `Retry-After`. El operador puede fijar un límite propio por tenant.
- **Nuevo: administración de tenants** (`/admin/v1/tenants`, tag `administracion`), con la clave del operador (`claveAdministrador`): alta con permisos, webhook y límite; consulta; cambio de permisos, webhook, límite o estado; y rotación de la clave, que invalida la anterior en el momento. La clave y el secreto del webhook se muestran una sola vez. Reemplaza al script `crear-tenant.sql`. Una clave de tenant recibe `403` en estas rutas.
- **Respuestas nuevas** `403` y `429` en todas las operaciones de `/v1`. Agregar respuestas de error no es un cambio incompatible.
- **Transporte:** el servidor del contrato pasa a `https://localhost:3000`. La API solo atiende por HTTPS.

### 1.1.0 · Entrega 4

Compatible con 1.0.0 para los clientes que siguen el contrato, con dos excepciones justificadas: el `minLength` de `cursor` (ver *Precisión*) y los tipos nuevos del feed (ver *Cambio en el feed*).

- **Nuevo:** `POST /v1/reservas/{id}/cancelacion`. La cancelación es asíncrona, igual que la reserva: responde `202` y el worker devuelve el cupo. Es idempotente por naturaleza, así que no requiere `Idempotency-Key`. Si 30 segundos después del pedido la reserva sigue activa, repetir la cancelación vuelve a registrar el comando; así el cliente recupera un comando perdido. Se eligió un `POST` sobre un subrecurso y no `DELETE /v1/reservas/{id}`, que anticipaba la versión 1.0.0: la reserva no desaparece, cambia de estado y sigue consultable y en el feed.
- **Nuevo:** sección `webhooks` con el evento `cambioDeReserva` (esquema `EventoReserva`), la cabecera `X-Firma` y las reglas de verificación, reintentos y deduplicación. El contrato fija cómo se representa el secreto (32 bytes, entregados en hexadecimal; la clave del HMAC son los bytes, no el texto) y trae un vector de prueba (`x-vector-de-prueba`) que verifican por separado las pruebas del notificador y las de Aula.
- **Nuevo:** respuesta `400` en `GET /v1/actividades/{id}` y `GET /v1/reservas/{id}` para un identificador que no es un UUID. Antes respondían `404`; ahora la API valida cada solicitud contra este contrato.
- **Nuevo:** respuesta `415` en las operaciones con cuerpo cuando la solicitud no es `application/json`. La encontró Schemathesis: la API ya la devolvía y el contrato no la documentaba.
- **Precisión:** `cursor` exige al menos un carácter y `desde` no puede superar 2⁵³−1. La API ya rechazaba esos valores con `400` desde 1.0.0, pero el contrato no lo decía (lo encontró Schemathesis). oasdiff marca el `minLength` de `cursor` como incompatible; como ningún cliente pudo usar un cursor vacío, se registró como excepción explícita en `oasdiff-excepciones.txt`, que revisan los dos integrantes (CODEOWNERS).
- **Cambio en el feed (excepción justificada):** `Cambio.tipo` suma `reserva.cancelada` y `reserva.fallida`. Para un cliente de 1.0.0 que valide el feed de forma estricta, es un cambio incompatible: en 1.0.0 el tipo era un `enum` cerrado, y la descripción del feed no decía que se ignoraran los tipos desconocidos. oasdiff lo marcó así cuando se agregaron los valores al `enum`. Se acepta en una versión menor porque ningún cliente distingue hoy los tipos del feed (Aula lo va a usar para reconciliar en la Entrega 5). Para que no vuelva a pasar, desde 1.1.0 el campo es un `x-extensible-enum` y el contrato establece que el lector aplica la instantánea según su versión e ignora los tipos que no conoce. Con esa declaración oasdiff ya no marca el cambio: la excepción queda registrada acá y no en `oasdiff-excepciones.txt`.

### 1.0.0 · Entrega 3

Primera versión: actividades, admisión de reservas con `Idempotency-Key`, consulta, listado paginado por cursor y feed de cambios.

## `asyncapi.yaml`: mensajería interna

### 1.1.0 · Entrega 6

Compatible con 1.0.0: los ejemplos de cada versión validan contra los esquemas de la otra (`compatibilidad-mensajes.sh`).

- **Particiones.** `reservas.comandos.{particion}` pasa de una cola a N (`COMANDOS_PARTICIONES`, hasta 32) enlazadas con el mismo peso al exchange de hash consistente. Cada worker consume una sola partición como consumidor exclusivo. Al bajar N, el relay desenlaza las colas sobrantes y reenvía sus comandos al exchange antes de publicar.
- **Nueva cabecera opcional `x-primer-fallo`** en las entregas de webhook reprogramadas: el instante del primer fallo, desde el que cuenta el plazo de 400 s hasta la DLQ. Un consumidor de 1.0.0 la ignora.
- **Esperas:** con el circuito del tenant abierto, una entrega vuelve a `webhooks.espera.10s` sin gastar un intento.

### 1.0.0 · Entrega 4

Primera versión. Formaliza los mensajes que ya existían en la Entrega 3 (`reservar`) y agrega `cancelar` y las entregas de webhook. Las entidades se referencian desde `openapi.yaml`.

- Cada mensaje trae ejemplos que cubren todas sus propiedades (lo exige una prueba de `compartido/`). Son la base de la verificación de compatibilidad entre versiones: los consumidores nuevos tienen que aceptar los ejemplos de la versión anterior, y los anteriores, los de la nueva.
- La descripción documenta el outbox: qué tipo de cambio produce cada mensaje y quién lo escribe.
