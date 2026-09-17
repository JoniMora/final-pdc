# Motor Transaccional de Inscripciones — Plataforma de E-learning

**Programación Distribuida y Componentes · Proyecto Final**
Temática 7 — Plataforma de e-learning de alta concurrencia · Sector EdTech

| | |
|---|---|
| **Grupo N°** | 15 |
| **Integrantes** | Jonathan Mora Colodrero · Maria Constanza Gigli |
| **Estado actual** | Entrega 1 — Propuesta de arquitectura, revisada el 17/09/2026 |

| Entrega | Contenido | Tag |
|---|---|---|
| 0 | Plan del proyecto | `v0-plan-del-proyecto` |
| 1 | Propuesta de arquitectura (modelo 4+1) | `v1-propuesta-arquitectura` |

---

## El problema

Toda plataforma educativa con cupos limitados vive el mismo momento crítico: la apertura del período de inscripción. Durante días no pasa nada y, a la hora señalada, miles de alumnos intentan inscribirse en los mismos cursos en el mismo minuto — un pico masivo de carga concurrente (*flash crowd*). El caso local más conocido es la saturación de **SIU Guaraní** en cada inicio de cuatrimestre.

Una arquitectura síncrona tradicional falla justo ahí: miles de peticiones compiten por **la misma fila** (el cupo de un curso), las conexiones se agotan, los tiempos de respuesta crecen hasta el timeout y el usuario reintenta, multiplicando la carga. Peor todavía, entre leer el cupo y escribirlo se cuelan otras peticiones, y el sistema asigna **más cupos de los que existen** (*overbooking*).

## La solución: Queue-Based Load Leveling

Separar la parte rápida y paralelizable de la petición (registrar que un alumno *quiere* inscribirse) de la parte contenciosa que debe ser secuencial (decidir si *obtiene* el cupo).

1. **La API registra la intención y responde de inmediato.** Inserta la inscripción en estado `pending` — una fila nueva por alumno, sin contención — publica un evento en RabbitMQ y devuelve `202 Accepted` con la URL de consulta. Milisegundos, y escala horizontalmente.
2. **La cola amortigua el pico.** Diez mil peticiones en un segundo quedan encoladas de forma durable. La base de datos nunca ve el pico: ve un flujo constante.
3. **El worker decide de a uno.** Consume con `prefetch(1)` y, dentro de una transacción InnoDB, descuenta el cupo con un `UPDATE cursos SET cupos = cupos - 1 WHERE id = ? AND cupos > 0`. Si afecta una fila hay cupo (`confirmed`); si afecta cero, `rejected`. Atómico: sin overbooking y sin lógica de bloqueo en Node.js.
4. **El alumno consulta el resultado** por *polling* en `GET /inscripciones/:id`.

Dos garantías que el diseño resuelve explícitamente:

- **Idempotencia** — ante una reentrega de RabbitMQ, el worker verifica bajo `SELECT ... FOR UPDATE` que la inscripción siga en `pending`; si ya fue procesada, hace `ack` y no toca el cupo. La restricción `UNIQUE (alumno_id, curso_id)` frena el doble clic.
- **Tolerancia a fallos** — colas y mensajes durables, *publisher confirms*, `ack` solo después del `COMMIT`, y una *dead-letter queue* para lo que no se puede procesar. El worker distingue **errores de datos** (agotan reintentos y van a la DLQ) de **errores de infraestructura** (devuelven el mensaje a la cola con `nack` + `requeue` y pausan el consumo), de modo que una caída de la base de datos nunca vacía la cola hacia la DLQ.

## Alta disponibilidad de la persistencia

El diseño inicial dejaba toda la verdad del sistema en un único contenedor MySQL. RabbitMQ y los workers son recuperables por construcción — la cola es durable y un worker que muere se reemplaza sin estado que perder — pero la base de datos no: su caída detenía a la vez el registro de intenciones y la asignación de cupos. Un motor cuyo único propósito es no perder ni duplicar inscripciones no puede tener el dato en un punto único de falla (*SPOF*). La capa de persistencia pasa entonces a un esquema **primario-réplica**.

**Replicación semi-sincrónica en modo `AFTER_SYNC`** (la variante «sin pérdida» de MySQL 8): el primario no devuelve el `COMMIT` hasta que la réplica acusa haber recibido y persistido la transacción en su relay log. Como el worker envía el `ack` a RabbitMQ recién después del `COMMIT`, toda inscripción confirmada existe ya en dos nodos — **RPO = 0 para el dato confirmado**. El límite es explícito: si la réplica no responde dentro de `rpl_semi_sync_source_timeout`, MySQL degrada a replicación asíncrona para no bloquear al primario; ese estado se monitorea (`Rpl_semi_sync_source_status`) y se registra como incidente.

**El failover es manual**, y la arquitectura está diseñada para tolerar su duración: el worker devuelve los mensajes a la cola y suspende el consumo, RabbitMQ retiene lo pendiente en orden, y la API responde `503` con `Retry-After` a las solicitudes nuevas. La cola amortigua el *trabajo en curso*, no la *admisión de trabajo nuevo*; la distinción es deliberada. Al promover la réplica y redirigir el pool de conexiones por variable de entorno, el consumo se reanuda y la cola se drena — de forma segura, porque la misma garantía de idempotencia hace que una transacción ya confirmada no vuelva a descontar cupo. Automatizar la promoción (Orchestrator, MySQL Router, ProxySQL) queda declarado como trabajo futuro.

## Arquitectura

![Diagrama de despliegue](docs/entrega-1/arquitectura.png)

Cinco contenedores en una red interna de Docker Compose sobre un host. Solo `api` se expone al exterior; API y Worker se comunican únicamente a través del broker y acceden al primario, mientras la réplica solo recibe tráfico de replicación hasta su promoción.

| Contenedor | Rol | Expone |
|---|---|---|
| `api` (Node.js) | Servicio HTTP síncrono | Sí |
| `rabbitmq` | Broker: cola principal + DLQ | No |
| `worker` (Node.js) | Consumidor asíncrono | No |
| `mysql-primary` (MySQL 8 / InnoDB) | Escrituras y lecturas; binlog + GTID; volumen propio | No |
| `mysql-replica` (MySQL 8 / InnoDB) | Réplica semi-sincrónica en `super_read_only`; nodo de contingencia; volumen propio | No |

Todos los contenedores pueden escalarse de forma independiente, con excepción del primario, único por definición del esquema.

## Stack

| Componente | Tecnología | Motivo |
|---|---|---|
| API y Worker | Node.js (Express · amqplib · mysql2) | Un solo lenguaje para ambos servicios; I/O no bloqueante |
| Message broker | RabbitMQ | Colas durables, `ack` manual, `prefetch`, DLQ nativa |
| Base de datos | MySQL 8 (InnoDB), primario + réplica semi-sincrónica | Transacciones ACID, bloqueo de fila, `UNIQUE`; replicación `AFTER_SYNC` para no perder inscripciones confirmadas ante la caída del primario |
| Orquestación | Docker Compose | Reproduce los cinco contenedores con un comando |

## Estructura del repositorio

```
final-pdc/
├── api/              # Servicio HTTP: catálogo, registro de intención, consulta de estado
├── worker/           # Consumidor asíncrono: validación y asignación de cupo
├── shared/
│   ├── db/           # Acceso a MySQL (mysql2) y migraciones
│   └── messaging/    # Cliente RabbitMQ (amqplib), colas y DLQ
├── docker-compose.yml
└── docs/             # Documentación por entrega
    ├── entrega-0/
    └── entrega-1/
```

> **Nota:** por ahora el repositorio contiene únicamente `docs/`. Las Entregas 0 y 1 son el plan y la propuesta de arquitectura; el código de `api/`, `worker/` y `shared/` se incorpora en las entregas siguientes.

## Documentación

- [`docs/entrega-0/Entrega0-Plan-del-proyecto.pdf`](docs/entrega-0/Entrega0-Plan-del-proyecto.pdf) — plan del proyecto.
- [`docs/entrega-1/informe.md`](docs/entrega-1/informe.md) — informe completo con el modelo 4+1 de Kruchten.
- [`docs/entrega-1/arquitectura.mmd`](docs/entrega-1/arquitectura.mmd) — fuente Mermaid del diagrama.
- [`docs/entrega-1/arquitectura.png`](docs/entrega-1/arquitectura.png) — diagrama exportado.
- [`docs/entrega-1/presentacion.pdf`](docs/entrega-1/presentacion.pdf) — presentación de tres diapositivas.

## Escenario de validación

«Apertura de inscripciones a un curso con cupo limitado»: 500 solicitudes concurrentes sobre un curso con 10 cupos. La petición entra por `api`, transita por `rabbitmq`, la procesa `worker`, persiste en `mysql-primary` y se replica de forma semi-sincrónica en `mysql-replica`. El criterio de aceptación de la prueba de carga de las próximas entregas es **exactamente 10 confirmados, 0 duplicados, 0 cupos negativos**.
