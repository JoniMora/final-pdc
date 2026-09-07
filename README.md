# Motor Transaccional de Inscripciones — Plataforma de E-learning

**Programación Distribuida y Componentes · Proyecto Final**
Temática 7 — Plataforma de e-learning de alta concurrencia · Sector EdTech

| | |
|---|---|
| **Grupo N°** | 15 |
| **Integrantes** | Jonathan Mora Colodrero · Maria Constanza Gigli |
| **Estado actual** | Entrega 1 — Propuesta de arquitectura (`v1-propuesta-arquitectura`) |

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
- **Tolerancia a fallos** — colas y mensajes durables, *publisher confirms*, reintentos acotados, *dead-letter queue* y `ack` solo después del `COMMIT`.

## Arquitectura

![Diagrama de despliegue](docs/entrega-1/arquitectura.png)

Cuatro contenedores en una red interna de Docker Compose. Solo `api` se expone al exterior; API y Worker se comunican únicamente a través del broker.

| Contenedor | Rol | Expone |
|---|---|---|
| `api` (Node.js) | Servicio HTTP síncrono | Sí |
| `rabbitmq` | Broker: cola principal + DLQ | No |
| `worker` (Node.js) | Consumidor asíncrono | No |
| `mysql` (MySQL 8 / InnoDB) | Persistencia con volumen propio | No |

## Stack

| Componente | Tecnología | Motivo |
|---|---|---|
| API y Worker | Node.js (Express · amqplib · mysql2) | Un solo lenguaje para ambos servicios; I/O no bloqueante |
| Message broker | RabbitMQ | Colas durables, `ack` manual, `prefetch`, DLQ nativa |
| Base de datos | MySQL 8 (InnoDB) | Transacciones ACID, bloqueo de fila, `UNIQUE` |
| Orquestación | Docker Compose | Reproduce los cuatro contenedores con un comando |

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
    └── entrega-1/
```

> **Nota:** por ahora el repositorio contiene únicamente `docs/`. La Entrega 1 es la propuesta de arquitectura; el código de `api/`, `worker/` y `shared/` se incorpora en las entregas siguientes.

## Documentación

- [`docs/entrega-1/informe.md`](docs/entrega-1/informe.md) — informe completo con el modelo 4+1 de Kruchten.
- [`docs/entrega-1/arquitectura.mmd`](docs/entrega-1/arquitectura.mmd) — fuente Mermaid del diagrama.
- [`docs/entrega-1/arquitectura.png`](docs/entrega-1/arquitectura.png) — diagrama exportado.
- [`docs/entrega-1/presentacion.pdf`](docs/entrega-1/presentacion.pdf) — presentación de tres diapositivas.

## Escenario de validación

«Apertura de inscripciones a un curso con cupo limitado»: 500 solicitudes concurrentes sobre un curso con 10 cupos. El criterio de aceptación de la prueba de carga de las próximas entregas es **exactamente 10 confirmados, 0 duplicados, 0 cupos negativos**.
