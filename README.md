# Servicio multi-tenant de reserva de cupos

**Programación Distribuida y Componentes · Proyecto Final**
Temática 7 — Plataforma de e-learning de alta concurrencia, generalizada a un servicio de reserva de cupos para cualquier dominio · Sector SaaS / EdTech

| | |
|---|---|
| **Grupo N°** | 15 |
| **Integrantes** | Jonathan Mora Colodrero · María Constanza Gigli |
| **Repositorio** | https://github.com/JoniMora/final-pdc |
| **Estado actual** | Entrega 1 — Propuesta de arquitectura, revisión 2 del 22/09/2026 |

| Entrega | Contenido | Tag |
|---|---|---|
| 0 | Plan del proyecto | `v0.2-plan-del-proyecto` (original: `v0-plan-del-proyecto`) |
| 1 | Propuesta de arquitectura (modelo 4+1) | `v1.2-propuesta-arquitectura` (original: `v1-propuesta-arquitectura`) |

> **Revisión 1 (17/09/2026)** — persistencia primario-réplica con replicación semi-sincrónica: el nodo único de MySQL era un punto único de falla.
> **Revisión 2 (22/09/2026)** — ampliación de alcance a pedido de la cátedra: API pública multi-tenant para cualquier dominio con cupo y continuidad operativa de los sistemas consumidores ante la caída de su propia base de datos.

---

## El problema

Toda actividad con cupo limitado —una materia, un partido de fútbol 5, un asado entre amigos, un turno— vive el mismo momento crítico cuando la demanda llega junta: muchas solicitudes compiten por pocos lugares en el mismo instante (*flash crowd*). El caso local más conocido es la apertura de inscripciones en sistemas como **SIU Guaraní**.

Una implementación síncrona ingenua lee el cupo, lo compara y escribe sobre **la misma fila**: las conexiones se agotan, la latencia crece hasta el timeout, el usuario reintenta y multiplica la carga, y entre la lectura y la escritura se cuelan otras peticiones. El sistema asigna **más lugares de los que existen** (*overbooking*) o registra dos veces a la misma persona.

A ese problema de concurrencia se suma uno de fragilidad: cada organización reimplementa esta lógica sobre su propia base de datos y, si esa base cae, pierde justo en el pico el registro de quién está inscripto.

## La solución

### Un servicio para cualquier dominio: API pública multi-tenant

Cada organización consumidora es un **tenant** que se autentica con su propia clave de API. El dominio se reduce a lo que todos los casos comparten: una **actividad** tiene capacidad y cupos disponibles; una **reserva** asigna un cupo a un **participante**, identificado por un valor opaco del sistema del tenant. Todo lo demás —el nombre de la materia, la cancha del partido, quién lleva el carbón— viaja en un campo `metadata` JSON de hasta 16 KB que el servicio **almacena y devuelve sin interpretar**. Funciona para cualquier dominio porque no conoce ninguno: no hay esquema del consumidor que conocer, sólo un contrato HTTP.

El contrato sigue convenciones difundidas en APIs públicas: versionado en la ruta (`/v1`), errores como *Problem Details* (RFC 9457), `202 Accepted` con `Location` para operaciones asíncronas y cabecera `Idempotency-Key` obligatoria al crear reservas, para que un consumidor que no recibió la respuesta pueda reintentar sin duplicar.

### Nivelación de carga: la decisión contenciosa, de a una

El patrón central es **Queue-Based Load Leveling**. La **admisión** —registrar que un participante *quiere* un cupo— es rápida y paralela: una fila nueva por solicitud, sin contención. La **decisión** —si lo *obtiene*— es contenciosa. Por eso se separan: la API registra la reserva en estado `pendiente` y responde `202`; la decisión la toma un **worker** que consume comandos de RabbitMQ de a uno (`prefetch(1)`) y descuenta el cupo con una única sentencia condicional dentro de una transacción InnoDB:

```sql
UPDATE actividades
   SET cupos_disponibles = cupos_disponibles - 1
 WHERE id = ? AND estado = 'abierta' AND cupos_disponibles > 0;
```

Una fila afectada: la reserva pasa a `confirmada`. Cero filas: pasa a `rechazada`. La garantía de no sobreasignación **la da la base de datos**, no la lógica de aplicación, y se refuerza con `CHECK (cupos_disponibles BETWEEN 0 AND capacidad)` y con privilegios de columna: sólo el usuario MySQL del worker puede modificar el contador de cupos.

### Un único registro de cambios: outbox transaccional, feed y auditoría

Escribir en una base de datos y además publicar en un broker expone al problema de la **doble escritura**: si el proceso cae entre ambas operaciones, queda un cambio sin mensaje o un mensaje sin cambio. Se resuelve de raíz con el patrón **Transactional Outbox**: ni la API ni el worker publican en RabbitMQ. Cada cambio de estado se escribe **en la misma transacción** junto con una fila en la tabla `cambios`, que guarda el tipo de cambio y una instantánea completa de la entidad con su número de versión.

Un proceso independiente, el **relay**, es el único que lee esa tabla y publica:

1. **Secuenciador del feed** — asigna a cada cambio un número de secuencia creciente en transacciones serializadas; como es la única instancia que lo hace, la secuencia es densa y respeta el orden de confirmación (un lector que ya vio *n* nunca verá aparecer después una menor).
2. **Publicador** — publica con *publisher confirms* los comandos hacia el worker y las notificaciones hacia la cola de webhooks. Si cae entre publicar y marcar, republica: la entrega es **al-menos-una-vez** y todos los consumidores son idempotentes, lo que da un **efecto exactamente-una-vez** sobre el estado.

Un **barredor** periódico republica el comando de las reservas que siguen `pendientes`, sólo cuando las colas de comandos están vacías. Así, la tabla `cambios` cumple tres funciones con una sola escritura: **outbox**, **feed de reconciliación** (`GET /v1/cambios`) y **registro de auditoría**.

### Notificaciones: webhooks firmados

El **notificador** hace un `POST` a la URL registrada por el tenant por cada cambio, firmado con HMAC-SHA256 sobre la marca de tiempo y el cuerpo (`X-Firma: t=<unix>,v1=<hex>`); el receptor descarta mensajes de más de cinco minutos, lo que impide la falsificación y la reinyección (*replay*). Si no responde `2xx`, el mensaje pasa por colas de espera con TTL escalonado (10 s · 1 min · 5 min) y, agotados los intentos, a `webhooks.dlq`. Esa DLQ **no implica pérdida de información**: el webhook es un mecanismo de baja latencia, no de garantía — la garantía la da el feed.

### Continuidad operativa del tenant

El servicio **no aloja, replica ni respalda bases de datos de terceros**. Es la **fuente de verdad** del estado de las actividades y reservas de cada consumidor, y lo expone completo, paginado y ordenado. Con eso:

- **Operación normal** — el tenant mantiene su base al día con los webhooks (o sondeando el feed) y guarda la última secuencia aplicada como punto de control.
- **Modo contingencia** — si su base cae, su aplicación no se detiene: lee el estado vigente desde la API (`GET /v1/actividades/{id}/reservas`, paginado por cursor) y sigue admitiendo reservas, porque la API nunca dependió de su base.
- **Reconciliación** — al recuperarse lee `GET /v1/cambios?desde=<punto de control>` y aplica cada cambio sólo si su versión es mayor. Como cada cambio trae la instantánea completa, aplicarlo dos veces o fuera de orden no altera el resultado.

La plataforma de e-learning del diseño original pasa a ser el **cliente de referencia** (`aula`) que demuestra este comportamiento.

### Alta disponibilidad de la persistencia

La capa de persistencia es un esquema **primario-réplica**. Un servicio que se ofrece como fuente de verdad de terceros no puede tener el dato en un punto único de falla.

La replicación es **semi-sincrónica en modo `AFTER_SYNC`**: el primario no devuelve el `COMMIT` hasta que la réplica acusa haber persistido la transacción en su *relay log*. Como el worker confirma el mensaje a RabbitMQ recién después del `COMMIT`, toda reserva confirmada existe ya en dos nodos — **RPO = 0 para el dato confirmado**. El límite es explícito: si la réplica no responde dentro de `rpl_semi_sync_source_timeout`, MySQL degrada a replicación asíncrona; ese estado se monitorea (`Rpl_semi_sync_source_status`) y se registra como incidente.

El **failover es manual** y la arquitectura tolera su duración: relay y worker distinguen errores de infraestructura de errores de datos y, ante los primeros, pausan sin consumir reintentos ni derivar mensajes a la DLQ; RabbitMQ y el outbox retienen el trabajo pendiente; la API responde `503` con `Retry-After` a las solicitudes nuevas. La cola amortigua el *trabajo en curso*, no la *admisión de trabajo nuevo*: la distinción es deliberada. Al promover la réplica y redirigir el pool de conexiones, el consumo se reanuda de forma segura, porque la idempotencia del worker impide que una transacción ya confirmada vuelva a descontar cupo. Automatizar la promoción queda declarado como trabajo futuro.

### Seguridad

Claves de 256 bits guardadas como hash SHA-256; `tenant_id` derivado siempre de la clave y nunca de la ruta o el cuerpo (un recurso ajeno responde `404`, no `403`); límite de tasa por tenant (`429`); mínimo privilegio en MySQL con un usuario por componente; firma HMAC de webhooks con ventana contra la reinyección; y validación de las URLs de webhook contra **SSRF** —el notificador rechaza direcciones privadas, de *loopback* y nombres de servicios internos, y en el entorno local sólo admite una lista explícita de hosts.

## Arquitectura

![Diagrama de despliegue](docs/entrega-1/arquitectura.png)

Un host con **nueve contenedores en tres redes** de Docker Compose. Siete forman el servicio; dos simulan un sistema consumidor independiente.

| Contenedor | Rol | Redes | Expone |
|---|---|---|---|
| `api` (Node.js) | API pública v1: autenticación, admisión, consultas, listado y feed | pública, interna | Sí (HTTP) |
| `relay` (Node.js) | Outbox: secuenciador del feed, publicador y barredor | interna | No |
| `worker` (Node.js) | Comandos `reservar` y `cancelar`: asignación atómica de cupos | interna | No |
| `notificador` (Node.js) | Webhooks salientes firmados con reintentos escalonados | interna, pública | No |
| `rabbitmq` | Comandos, notificaciones, colas de espera y DLQ | interna | No |
| `mysql-primary` (MySQL 8 · InnoDB) | Persistencia: escrituras y lecturas; binlog + GTID | interna | No |
| `mysql-replica` (MySQL 8) | Réplica semi-sincrónica en `super_read_only`; nodo de contingencia | interna | No |
| `aula` (Node.js) | Cliente de referencia: plataforma de e-learning mínima | pública, tenant | Sí (web) |
| `aula-db` (PostgreSQL) | Base propia del cliente de referencia | tenant | No |

La red `publica` simula internet; la red `interna` contiene el broker y las bases del servicio; la red `tenant` es privada del cliente. **Ningún consumidor tiene ruta de red hacia la base del servicio, ni el servicio hacia la del consumidor**: la única interfaz es HTTP, en ambos sentidos. Que el cliente de referencia use PostgreSQL demuestra que el servicio no impone motor ni esquema. Todos los componentes escalan horizontalmente salvo el primario, único por definición, y el relay, instancia única por diseño.

## Stack

| Componente | Tecnología | Motivo |
|---|---|---|
| API, relay, worker y notificador | Node.js (Express · mysql2 · amqplib) | Un lenguaje para los cuatro servicios; E/S no bloqueante |
| Contrato | OpenAPI 3.1 | Contrato verificable y documentación generada |
| Broker | RabbitMQ + plugin de exchange de hash consistente | Colas durables, `ack` manual, `prefetch`, TTL y *dead-lettering* nativos; particionado por clave |
| Base del servicio | MySQL 8 (InnoDB), primario + réplica semi-sincrónica | Transacciones ACID, bloqueo de fila, `CHECK`, columnas generadas, privilegios por columna, replicación sin pérdida de lo confirmado |
| Cliente de referencia | Node.js + PostgreSQL | Demuestra independencia de motor y de esquema |
| Pruebas de carga | k6 | Escenarios concurrentes reproducibles y métricas de latencia |
| Orquestación | Docker Compose | Nueve contenedores y tres redes con un comando |

## Estructura del repositorio

```
final-pdc/
├── servicios/
│   ├── api/            # API pública v1: autenticación, admisión, consultas, listado y feed
│   ├── relay/          # Outbox: secuenciador del feed, publicador y barredor
│   ├── worker/         # Comandos reservar y cancelar: asignación atómica de cupos
│   └── notificador/    # Webhooks firmados con reintentos escalonados
├── compartido/
│   ├── db/             # Pool mysql2, migraciones, usuarios y privilegios por componente
│   ├── mensajeria/     # amqplib: exchanges, colas, esperas y DLQ
│   └── contrato/       # openapi.yaml (fuente del contrato) y esquemas
├── clientes/
│   └── aula/           # Cliente de referencia: e-learning mínimo con PostgreSQL propio
├── pruebas/
│   ├── carga/          # k6: actividad caliente y escenario multi-tenant
│   └── fallos/         # Guiones de inyección de fallos
├── docker-compose.yml
└── docs/               # Documentación por entrega
    ├── entrega-0/
    └── entrega-1/
```

> **Nota:** por ahora el repositorio contiene únicamente `docs/`. Las Entregas 0 y 1 son el plan y la propuesta de arquitectura; el código se incorpora a partir de la Entrega 2.

## Documentación

- [`docs/entrega-0/Entrega0-Plan-del-proyecto.pdf`](docs/entrega-0/Entrega0-Plan-del-proyecto.pdf) — plan del proyecto: descripción, Gantt por módulo, épicas, sprints y reparto.
- [`docs/entrega-0/infografia.png`](docs/entrega-0/infografia.png) — infografía del problema, la solución y el criterio de aceptación.
- [`docs/entrega-1/informe.md`](docs/entrega-1/informe.md) — informe completo: modelo 4+1 de Kruchten, contrato de la API v1, matriz de fallos y límites declarados.
- [`docs/entrega-1/arquitectura.mmd`](docs/entrega-1/arquitectura.mmd) — fuente Mermaid del diagrama de despliegue.
- [`docs/entrega-1/arquitectura.png`](docs/entrega-1/arquitectura.png) — diagrama exportado.
- [`docs/entrega-1/presentacion.pdf`](docs/entrega-1/presentacion.pdf) — presentación de tres diapositivas.

## Escenario de validación

«Apertura de una materia de 10 cupos con la base del cliente caída»: el tenant *Aula* crea una actividad de 10 cupos y 500 alumnos solicitan una reserva. Cada admisión inserta su reserva `pendiente` y su cambio en una transacción y responde `202`; el relay secuencia y publica los 500 comandos; el worker confirma 10 y rechaza 490; el notificador envía los webhooks. A mitad de la ráfaga se detiene `aula-db`: Aula pasa a modo contingencia, lee los inscriptos desde la API y sigue admitiendo; al volver, reconcilia desde `/v1/cambios`.

Criterio de aceptación: **exactamente 10 confirmadas, 0 duplicadas, 0 cupos negativos**, y al finalizar la base de Aula coincide con el estado del servicio. Es también la demostración de la defensa final.

## Planificación

| Entrega | Módulo | Período estimado | Entregable certificable |
|---|---|---|---|
| 0 — Plan de proyecto | Definición del proyecto | 31/08 – 06/09 · rev. 17/09 y 22/09 | Plan, Gantt, épicas y reparto |
| 1 — Propuesta de arquitectura | 1 — Introducción a la programación distribuida | 31/08 – 06/09 · rev. 17/09 y 22/09 | Vistas 4+1, contrato v1, matriz de fallos, diagrama, informe |
| 2 — Infraestructura | 2 — Infraestructura | 28/09 – 11/10 | Nueve contenedores y tres redes; primario-réplica semi-sincrónico; esquema y usuarios por componente; topología RabbitMQ |
| 3 — Comunicación | 3 — Comunicación | 05/10 – 25/10 | Contrato OpenAPI v1; autenticación y aislamiento; admisión `202` con `Idempotency-Key`; listado; outbox, relay y feed |
| 4 — Middleware | 4 — Middleware | 12/10 – 01/11 | Worker idempotente (`reservar` / `cancelar`); notificador de webhooks con HMAC, reintentos escalonados y DLQ |
| 5 — Seguridad y tolerancia a fallos | 5 — Seguridad y fallos | 19/10 – 08/11 | Cliente de referencia con contingencia y reconciliación; matriz de fallos ejecutada; pruebas de aislamiento, firma y SSRF |
| 6 — Escalabilidad | 6 — Escalabilidad | 02/11 – 15/11 | k6: actividad caliente 10 / 0 / 0; escenario multi-tenant; particionado con 1 y N workers; latencia de webhooks |
| 7 — Integración final | Cierre y defensa | 16/11 – 29/11 | Demostración en vivo del escenario +1, documentación consolidada, release final y defensa |

## Alcance y límites declarados

**Extensiones, en orden de recorte si el calendario lo exige:** particionado por actividad · límite de tasa por tenant · reintentos escalonados de webhooks · webhooks (el tenant sondearía el feed). El núcleo que prueba las garantías no se recorta.

**Límites:** relay de instancia única (su caída demora, no pierde) · failover manual · degradación a replicación asíncrona si vence el timeout de la réplica · límite de tasa por instancia de la API · webhooks al-menos-una-vez, el receptor deduplica · `metadata` opaca de hasta 16 KB, sin búsquedas por su contenido · un único host.

**Fuera de alcance:** alojar, replicar o respaldar bases de datos de los tenants · alta de tenants autoservicio (script de administración) · autenticación de los usuarios finales del tenant · listas de espera · modificación de la capacidad de una actividad · pagos · TLS en el entorno local · cifrado en reposo.

## Equipo

| Integrante | Frente de trabajo |
|---|---|
| **Jonathan Mora Colodrero** (leg. 100462) | Infraestructura y procesamiento asíncrono: Docker Compose, MySQL primario-réplica y failover, topología RabbitMQ, relay, worker y notificador |
| **María Constanza Gigli** (leg. 112075) | API pública y cliente de referencia: contrato OpenAPI, API v1 completa, Aula con contingencia y reconciliación, pruebas de carga con k6 |

Los dos puntos de integración entre ambos frentes —el esquema de la tabla `cambios` y el contrato del webhook— se acuerdan al inicio y se revisan de forma cruzada.
