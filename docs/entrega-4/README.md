# Entrega 4 — Contratos de interfaz y descubrimiento de servicios

**Programación Distribuida y Componentes · Proyecto Final**
**Módulo 4 — Middleware y componentes distribuidos**

| | |
|---|---|
| **Grupo N°** | 15 |
| **Integrantes** | Jonathan Mora Colodrero · María Constanza Gigli |
| **Tag / Release** | `v4-middleware` |
| **Fecha de entrega** | 09/11/2026 |
| **Certificación de la cátedra** | `Entrega4-Middleware.pdf`, completada con el texto de la [última sección](#texto-de-la-certificación) y entregada por separado (no se versiona) |
| **Documentación de la API** | https://jonimora.github.io/final-pdc/ (fuente: [`reserva-cupos/contrato/`](../../reserva-cupos/contrato/)) |
| **Evidencias** | [`evidencias/`](evidencias/README.md): ejecución del 09/11/2026 sobre volúmenes nuevos |

> **Qué evalúa esta entrega:** que el sistema esté desacoplado por contrato explícito, no por coincidencia entre los integrantes.

## Checklist de la entrega

| Requisito | Cumple | Justificación breve / evidencia |
|---|---|---|
| Los contratos de interfaz (API REST) entre componentes están documentados formalmente | ☑ Sí | [`openapi.yaml`](../../reserva-cupos/contrato/openapi.yaml) 1.1.0 (OpenAPI 3.1) define la API REST y los webhooks; [`asyncapi.yaml`](../../reserva-cupos/contrato/asyncapi.yaml) 1.0.0 (AsyncAPI 3.0), los mensajes de RabbitMQ. Tienen versionado semántico y [CHANGELOG](../../reserva-cupos/contrato/CHANGELOG.md), los valida el CI y se publican en GitHub Pages. Ver el [mapa de contratos](#mapa-de-contratos). [02](evidencias/02-contratos.txt) |
| Cada componente puede modificarse internamente sin romper el contrato hacia los demás | ☑ Sí | Cada componente se valida contra el contrato: la API, cada solicitud y respuesta; el relay, el worker y el notificador, cada mensaje. En esta entrega cambió la implementación de la API, el worker, el relay y el despliegue, y el cliente de carga de la Entrega 3 —sin cambios— sigue obteniendo 10/490/0 con dos instancias de la API. [03](evidencias/03-validacion-api.txt) · [06](evidencias/06-pruebas-componentes.txt) · [11](evidencias/11-cambio-interno.txt) |
| Hay un mecanismo de descubrimiento de servicios implementado (aunque sea simplificado) | ☑ Sí | Traefik descubre las instancias de la API a partir de las etiquetas de Docker, les hace health check y balancea. Escalar a tres instancias o detener una no requiere configuración. Ver [descubrimiento](#descubrimiento-de-servicios). [07](evidencias/07-descubrimiento.txt) |
| El desacople está verificado: no depende de que los integrantes se hayan puesto de acuerdo informalmente | ☑ Sí | El CI verifica cada lado contra el contrato por separado: Aula contra un mock de Prism generado del contrato, sin la API real; la API real con Schemathesis; y el emisor y el receptor del webhook contra el vector de prueba de la firma que trae el contrato. Los cambios incompatibles se rechazan en los dos contratos (oasdiff y ejemplos de los mensajes), el check obligatorio exige que pasen todos los trabajos del CI y CODEOWNERS exige la aprobación del otro integrante. Ver [cómo se verifica](#cómo-se-verifica-el-desacople). [02](evidencias/02-contratos.txt) · [04](evidencias/04-schemathesis.txt) · [05](evidencias/05-aula-contra-mock.txt) · [06](evidencias/06-pruebas-componentes.txt) · [09](evidencias/09-webhooks-fallas.txt) |

## Mapa de contratos

Cada interfaz entre componentes tiene un contrato formal y una forma automática de verificar que cada lado lo cumple. Ningún componente define a mano la forma de un mensaje o de una respuesta: la toma del contrato.

| Interfaz | Produce | Consume | Contrato | Verificación del productor | Verificación del consumidor |
|---|---|---|---|---|---|
| Sistema del tenant → API (REST) | API | Aula | `openapi.yaml` · `paths` | `express-openapi-validator` en ejecución (solicitudes y, en desarrollo, respuestas); Schemathesis en CI | Cliente derivado del contrato (`operationId`), que valida cada respuesta; pruebas contra Prism en CI |
| Notificador → tenant (webhook REST) | Notificador | Receptor de Aula | `openapi.yaml` · `webhooks` · `X-Firma` y `x-vector-de-prueba` | Reproduce el vector de prueba del contrato; prueba contra un receptor que aplica el esquema y la firma | Acepta el vector de prueba del contrato; prueba con eventos firmados según el contrato, sin el notificador |
| Relay → worker (AMQP) | Relay | Worker | `asyncapi.yaml` · `ComandoReservar`, `ComandoCancelar` | Ajv antes de publicar | Ajv antes de ejecutar; fuera de contrato → DLQ |
| Relay → notificador (AMQP) | Relay | Notificador | `asyncapi.yaml` · `EntregaWebhook` (reutiliza `EventoReserva` de OpenAPI) | Ajv antes de publicar | Ajv antes de entregar; fuera de contrato → DLQ |
| API y worker → relay (outbox, interno al servicio) | API, worker | Relay | Tabla `cambios` (`01-esquema.sql`); qué tipo de cambio produce cada mensaje está en `asyncapi.yaml` (*Origen de los mensajes*) | Transacción única con el cambio de estado | Permisos por columna del usuario MySQL de cada componente |
| Traefik → API (descubrimiento) | API | Traefik | Etiquetas de Docker y `GET /health` | `/health` responde mientras el proceso atiende | Health check cada 5 s |

**Una sola definición de cada entidad.** `asyncapi.yaml` no redefine `Reserva` ni el evento de webhook: los toma de `openapi.yaml`. El módulo [`compartido/`](../../reserva-cupos/compartido/src/contrato.js) carga los dos documentos y resuelve esas referencias. Así el feed, el webhook y el mensaje interno no pueden divergir.

**Versionado.** Un cambio compatible sube la versión menor; uno incompatible exige versión mayor y una ruta `/v2`. La versión 1.1.0 agrega la cancelación, los webhooks y respuestas que la API ya devolvía. oasdiff detectó dos casos que pueden romper a un cliente estricto de 1.0.0, y los dos quedaron como excepciones justificadas en el [CHANGELOG](../../reserva-cupos/contrato/CHANGELOG.md): el `minLength` del cursor (ningún cliente pudo usar un cursor vacío) y los tipos nuevos del feed (ningún cliente los distingue todavía). Para que lo segundo no se repita, desde 1.1.0 el tipo es una enumeración extensible y el contrato dice que el lector ignora los tipos que no conoce.

**Compatibilidad de los mensajes.** oasdiff no compara AsyncAPI, y `asyncapi diff` clasifica los cambios en los esquemas de los mensajes como *unclassified*. Por eso cada mensaje de `asyncapi.yaml` trae ejemplos que cubren todas sus propiedades, y [`compatibilidad-mensajes.sh`](../../reserva-cupos/pruebas/contrato/compatibilidad-mensajes.sh) valida los ejemplos de cada versión contra los esquemas de la otra: los consumidores nuevos tienen que aceptar los mensajes que siguen en las colas, y los anteriores, los de la versión nueva.

## Cómo se verifica el desacople

El argumento no es que los integrantes se pusieron de acuerdo, sino que **cada lado se verifica solo contra el contrato** y un cambio que lo rompa no se puede mergear.

| Mecanismo | Qué impide | Dónde |
|---|---|---|
| La API valida cada solicitud contra `openapi.yaml` antes de ejecutar la ruta | Que acepte algo que el contrato no define | [03](evidencias/03-validacion-api.txt) |
| Prueba de la API: cada ruta implementada está en el contrato y viceversa | Una ruta sin documentar o una operación documentada sin implementar | `servicios/api/test/contrato.test.js` |
| Schemathesis genera solicitudes desde el contrato contra la API real detrás de Traefik | Una respuesta con un código, una cabecera o un cuerpo distintos de los documentados | [04](evidencias/04-schemathesis.txt) |
| Aula probada contra un mock de Prism generado del contrato | Que Aula dependa de algo de la API que no está en el contrato | [05](evidencias/05-aula-contra-mock.txt) |
| Webhook: el emisor y el receptor se prueban por separado contra el vector de prueba de la firma que trae el contrato (secreto en hexadecimal, clave de 32 bytes) | Un acuerdo implícito sobre el formato, la firma o cómo se usa el secreto | [06](evidencias/06-pruebas-componentes.txt) · [09](evidencias/09-webhooks-fallas.txt) |
| Mensajes validados con JSON Schema en el productor y el consumidor | Que un cambio en el relay rompa en silencio al worker o al notificador | [10](evidencias/10-mensajes-fuera-de-contrato.txt) |
| oasdiff contra `main` en cada PR | Un cambio incompatible de la API sin versión mayor | [02](evidencias/02-contratos.txt) |
| Ejemplos de `asyncapi.yaml` validados entre versiones en cada PR | Un cambio en un mensaje que rechace lo que está en las colas o lo que mandan los productores de la otra versión | [02](evidencias/02-contratos.txt) |
| Job *CI completo* como check obligatorio de `main` | Que una PR se mergee con una prueba rota: GitHub cuenta como exitoso un job salteado | `.github/workflows/ci.yml` |
| CODEOWNERS y protección de `main` | Que un integrante cambie un contrato sin la revisión del otro | `.github/CODEOWNERS` |

Schemathesis encontró, en sus primeras corridas, seis diferencias entre la implementación y el contrato 1.1.0: un `415` sin documentar en las tres operaciones con cuerpo, límites que la API aplicaba y el contrato no decía (`cursor` vacío y `desde` mayor que 2⁵³−1) y un `422` documentado que se tomaba como rechazo. Se corrigieron en el contrato antes de esta entrega. Es exactamente lo que tiene que detectar esta verificación: diferencias que nadie había notado.

Al principio, la fase con estado casi no llegaba a la cancelación: Schemathesis repetía valores cortos de `Idempotency-Key` con cuerpos distintos, la API respondía `422` y casi ninguna reserva se creaba. Con una clave nueva por solicitud válida ([`hooks.py`](../../reserva-cupos/pruebas/contrato/hooks.py)) y secuencias de hasta 30 pasos, la corrida de la [04](evidencias/04-schemathesis.txt) genera 1093 casos sin fallas y cancela reservas reales.

## Descubrimiento de servicios

**Mecanismo.** Traefik, con el proveedor Docker, observa los contenedores y registra cada uno que tenga la etiqueta `traefik.enable`. La API declara en sus etiquetas la regla de enrutamiento, el puerto y el health check. No hay ninguna lista de instancias ni direcciones escritas en la configuración: Traefik las descubre cuando aparecen y las retira cuando dejan de responder.

**Qué se ganó.** La API dejó de publicar un puerto propio: se escala con `docker compose up -d --scale api=N`, y tanto Aula como k6 entran por el gateway sin conocer las instancias. El panel (`http://localhost:8080`) muestra lo descubierto; [`instancias.sh`](../../reserva-cupos/pruebas/descubrimiento/instancias.sh) lo consulta y puede esperar a que Traefik tenga N instancias `UP` (una instancia nueva aparece cuando Docker la marca healthy, unos segundos después de arrancar). El mismo gateway es el lugar donde se terminará TLS (Entrega 5) y donde se mide el escalado horizontal (Entrega 6).

**Por qué Traefik.** Una sola herramienta resuelve el descubrimiento, el balanceo y, más adelante, TLS. La alternativa evaluada fue Consul con HAProxy (registro explícito y DNS SRV), que suma dos componentes nuevos para el mismo resultado en un único host.

**Límites.** El descubrimiento cubre el tráfico HTTP hacia la API. Los componentes internos encuentran MySQL y RabbitMQ por el DNS de Docker. Traefik monta el socket de Docker en solo lectura y su panel no tiene autenticación: los dos puntos se protegen en la Entrega 5.

## Decisiones y límites

- **Cancelación con `POST /v1/reservas/{id}/cancelacion`, no `DELETE`.** La reserva no desaparece: pasa a `cancelada`, sigue consultable y queda en el feed. Además, la operación es asíncrona (`202`), igual que la reserva. Es idempotente por naturaleza, así que no pide `Idempotency-Key`.
- **El pedido de cancelación no aparece en el feed.** Es un comando para el worker, no un cambio de estado; el feed muestra `reserva.cancelada` cuando ocurre.
- **Estado `fallida`.** Un comando `reservar` que falla por un error de datos se reintenta tres veces. Si sigue fallando, la reserva pendiente pasa a `fallida` y se notifica. Un `cancelar` que falla va a la DLQ: la reserva confirmada conserva su cupo.
- **Webhooks al-menos-una-vez.** Se reintentan a los 10 s, 1 min y 5 min. Agotados, quedan en `webhooks.dlq`, sin pérdida de información: el evento sigue en el feed ([09](evidencias/09-webhooks-fallas.txt)). El receptor aplica cada evento solo si la versión es mayor.
- **Secreto del webhook.** Son 32 bytes aleatorios que el servicio genera al registrar el webhook (`crear-tenant.sql` con `@webhook_url`) y entrega una sola vez, en hexadecimal. La clave del HMAC son los bytes, no el texto: el contrato lo dice y trae un vector de prueba. Aula no arranca sin un secreto válido, porque con una clave vacía cualquiera podría firmar.
- **SSRF.** El notificador valida la dirección al conectar, no solo la URL, así que tampoco lo engaña un nombre que cambia de IP. Las direcciones IPv6 se comparan por sus grupos de 16 bits: `[::ffff:169.254.169.254]` llega como `[::ffff:a9fe:a9fe]` y se rechaza igual que la IPv4 que lleva adentro ([09](evidencias/09-webhooks-fallas.txt)). El plazo de 5 s es total, así que un receptor lento no retiene la entrega. En local admite solo el host de Aula.
- **Comando de cancelación perdido.** El barredor del relay republica solo los `reservar` pendientes, porque un `cancelar` que falla no tiene un estado terminal y se republicaría para siempre. El contrato establece en cambio que, si 30 segundos después del pedido la reserva sigue activa, repetir la cancelación vuelve a registrar el comando.
- **Módulo `compartido/` parcial.** Por ahora contiene la validación contra los contratos. Unificar la conexión a MySQL y a RabbitMQ (issue #9) queda para la próxima etapa.
- **Traefik 3.6.** La primera versión usaba Traefik 3.3, que consulta la API de Docker con la versión 1.24. Funcionaba en el equipo de prueba (Docker Engine 24), pero el CI, con Docker Engine 29, la rechazó y Traefik no descubría ningún servicio. Lo detectó el job de integración, y se pasó a Traefik 3.6, que negocia la versión de la API.
- **Compose en un solo archivo.** Partirlo con `include:` (issue #8) requiere Docker Compose 2.20, y el entorno de prueba tiene 2.18.

## Cómo reproducir

Desde `reserva-cupos`, con el entorno levantado (ver [README de ejecución](../../reserva-cupos/README.md)):

```shell
# Contratos válidos y compatibles con la Entrega 3 y con main
npx --yes @redocly/cli@2.76.0 lint contrato/openapi.yaml --config contrato/redocly.yaml
npx --yes @asyncapi/cli@6.3.0 validate contrato/asyncapi.yaml
pruebas/contrato/oasdiff.sh v3-comunicacion
(cd compartido && npm ci) && pruebas/contrato/compatibilidad-mensajes.sh

# Descubrimiento: tres instancias sin tocar configuración
docker compose up -d --scale api=3 --no-recreate api
pruebas/descubrimiento/instancias.sh --esperar 3

# La API real contra el contrato (tenant propio en $CLAVE)
docker run --rm --network reserva-cupos-infra_publica -e SCHEMATHESIS_HOOKS=/config/hooks.py -v "$PWD/contrato:/contrato:ro" -v "$PWD/pruebas/contrato:/config:ro" \
  schemathesis/schemathesis:4.33.1 --config-file /config/schemathesis.toml run /contrato/openapi.yaml \
  --url http://traefik -H "Authorization: Bearer $CLAVE" --checks all --max-examples 25 --seed 2026 \
  --generation-with-security-parameters false

# Aula contra un mock del contrato, sin la API real
docker run -d --name prism-mock -p 4010:4010 -v "$PWD/contrato:/contrato:ro" stoplight/prism:5 mock -d -m false -h 0.0.0.0 /contrato/openapi.yaml
(cd clientes/aula && npm ci && PRISM_URL=http://localhost:4010 npm test)
```

## Texto de la certificación

Versión corta de cada celda de la columna *Justificación breve / evidencia*, para `Entrega4-Middleware.pdf`:

1. **Contratos documentados formalmente:** OpenAPI 3.1 (API REST y webhooks, v1.1.0) y AsyncAPI 3.0 (mensajes de RabbitMQ entre relay, worker y notificador, v1.0.0) en reserva-cupos/contrato. Versionado semántico y CHANGELOG; validados en CI y publicados en GitHub Pages. Ev. 02.
2. **Modificable sin romper el contrato:** La API valida cada solicitud y respuesta (express-openapi-validator); relay, worker y notificador, cada mensaje (JSON Schema). Con API, worker y relay modificados, el k6 de la E3 sin cambios da 10/490/0 con 2 APIs. Ev. 03, 06 y 11.
3. **Descubrimiento de servicios:** Traefik (proveedor Docker) descubre las instancias de la API por etiquetas, les hace health check en /health y balancea. Escalar a 3 instancias o detener una no requiere configuración: Traefik las agrega o las retira solo. Ev. 07.
4. **Desacople verificado:** Cada lado se verifica solo contra el contrato en el CI: Aula contra un mock de Prism (sin la API real), la API real con Schemathesis (1093 casos, 0 fallas) y el emisor y el receptor del webhook contra el vector de firma del contrato. Se rechazan cambios incompatibles en los dos contratos y CODEOWNERS exige la aprobación del otro integrante. Ev. 02, 04, 05, 06 y 09.

**Link a la documentación de la API:** documentación online en https://jonimora.github.io/final-pdc/ (Redoc para la API REST y los webhooks; visor AsyncAPI para la mensajería). Fuente: [`reserva-cupos/contrato/`](../../reserva-cupos/contrato/) en el tag `v4-middleware`.
