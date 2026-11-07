# Entrega 3 — Comunicación síncrona y asíncrona

**Programación Distribuida y Componentes · Proyecto Final**
**Módulo 3 — Comunicación y sincronización en sistemas distribuidos**

| | |
|---|---|
| **Grupo N°** | 15 |
| **Integrantes** | Jonathan Mora Colodrero · María Constanza Gigli |
| **Tag / Release** | `v3-comunicacion` |
| **Fecha de entrega** | 19/10/2026 |
| **Certificación de la cátedra** | `Entrega3-Comunicacion.pdf`, completada con el texto de la [última sección](#texto-de-la-certificación) y entregada por separado (no se versiona) |
| **Evidencias** | [`evidencias/`](evidencias/README.md) — ejecución del 19/10/2026 sobre volúmenes nuevos |

## Checklist de la entrega

| Requisito | Cumple | Justificación breve / evidencia |
|---|---|---|
| Hay un canal de comunicación síncrono funcionando entre componentes | ☑ Sí | REST/HTTP `/v1` entre el cliente de referencia **Aula** y la **API**, autenticado con la clave del tenant. Aula crea materias, solicita inscripciones (`202` + `Location`) y consulta su estado y los inscriptos. [02](evidencias/02-api-sincrona.txt) · [03](evidencias/03-aula.txt) |
| Hay un canal de comunicación asíncrono funcionando entre componentes | ☑ Sí | AMQP (RabbitMQ) entre **relay** y **worker**: el relay lee el outbox, publica el comando `reservar` con *publisher confirms* en el exchange `reservas.comandos` (hash consistente por `actividad_id`) y el worker lo consume con `prefetch(1)` y `ack` después del `COMMIT`. [04](evidencias/04-asincrono.txt) |
| Está justificado por qué se usó cada semántica en cada punto del sistema | ☑ Sí | Ver la [tabla por punto](#por-qué-cada-semántica-en-cada-punto): síncrono donde el cliente necesita una respuesta inmediata o lee el estado; asíncrono donde la decisión es contenciosa y puede diferirse. |
| Se identificó un caso de concurrencia concreto | ☑ Sí | *Flash crowd* sobre una actividad: cientos de solicitudes compiten a la vez por los últimos cupos de **la misma fila** (`actividades.cupos_disponibles`). Leer el cupo y después escribirlo pierde actualizaciones y sobreasigna. [05](evidencias/05-concurrencia-ingenua-atomica.txt) |
| Ese caso de concurrencia está resuelto y la solución puede demostrarse | ☑ Sí | `UPDATE` condicional atómico de InnoDB (`WHERE cupos_disponibles > 0`) más `CHECK`. 500 solicitudes simultáneas sobre 10 cupos: **10 confirmadas, 490 rechazadas, 0 pendientes, 0 cupos**, con uno y con dos workers. [06](evidencias/06-rafaga-1-worker.txt) · [07](evidencias/07-rafaga-2-workers.txt) |

## Por qué cada semántica en cada punto

| Punto | Semántica | Por qué | Evidencia |
|---|---|---|---|
| Aula → API: crear actividad, solicitar reserva | Síncrona, HTTP | El cliente necesita saber en el momento si la solicitud fue **admitida** (`202`) o rechazada por el contrato (`400`, `401`, `404`, `409`, `422`). Lo que se responde es la admisión, no la decisión. | [02](evidencias/02-api-sincrona.txt) |
| API → MySQL: reserva + cambio | Síncrona, una transacción local | La admisión tiene que estar persistida —en dos nodos, por la réplica semisíncrona— antes de responder `202`. Reserva y comando se escriben en la **misma transacción** (outbox): no hay doble escritura con el broker porque la API no publica. | [02](evidencias/02-api-sincrona.txt) |
| Relay → RabbitMQ | Asíncrona, *publisher confirms* | Desacopla la admisión de la publicación: si el broker cae, la API sigue admitiendo y el feed sigue avanzando. El cambio se marca como publicado solo cuando RabbitMQ lo confirma; ante una caída se republica (al-menos-una-vez). | [04](evidencias/04-asincrono.txt) |
| RabbitMQ → worker | Asíncrona, `ack` manual, `prefetch(1)` | La decisión es **contenciosa** (todas las solicitudes van a la misma fila) y se puede diferir. La cola absorbe el pico y entrega de a un comando por worker: nivela la carga sobre MySQL. **No** es lo que evita la sobreasignación. | [04](evidencias/04-asincrono.txt) · [06](evidencias/06-rafaga-1-worker.txt) |
| Aula → API: estado de la reserva, listado, feed | Síncrona, *pull* | El cliente consulta el resultado cuando lo necesita, guiado por `Location` y `Retry-After`. El feed `/v1/cambios` es la base de la reconciliación de la Entrega 5. | [02](evidencias/02-api-sincrona.txt) · [03](evidencias/03-aula.txt) |
| Notificador → tenant (Entrega 4) | Asíncrona, webhooks al-menos-una-vez | Aviso de baja latencia al tenant. La garantía de entrega la da el feed, no el webhook. | — |

## El caso de concurrencia

### Identificación

Una actividad de 10 cupos recibe 500 solicitudes en el mismo instante. La implementación ingenua lee `cupos_disponibles`, lo compara en la aplicación y escribe el valor calculado:

```sql
SELECT cupos_disponibles FROM actividades WHERE id = ?;   -- todas leen 10
UPDATE actividades SET cupos_disponibles = 9 WHERE id = ?; -- todas escriben 9
```

Entre la lectura y la escritura se cuelan otras transacciones (*lost update*). En la [evidencia 05](evidencias/05-concurrencia-ingenua-atomica.txt), 50 transacciones simultáneas sobre 10 cupos con esta estrategia asignan **50 lugares**: 40 sobreasignados, aunque el contador nunca baja de cero y la restricción `CHECK` no lo detecta.

### Resolución

El worker decide cada reserva en una transacción InnoDB:

1. `SELECT … FOR UPDATE` sobre la reserva. Si ya no está `pendiente`, el comando es una reentrega y no se hace nada: **idempotencia** frente a la entrega al-menos-una-vez.
2. Descuento atómico, con la condición evaluada por el motor bajo bloqueo de fila:
   ```sql
   UPDATE actividades
      SET cupos_disponibles = cupos_disponibles - 1, version = version + 1
    WHERE id = ? AND estado = 'abierta' AND cupos_disponibles > 0;
   ```
   Una fila afectada: `confirmada`. Cero filas: `rechazada`.
3. Cambio de estado de la reserva y registro del cambio en el outbox, en la misma transacción.
4. `COMMIT` y recién después `ack` a RabbitMQ.

La garantía **la da la base de datos**, no la cantidad de workers ni el `prefetch`. Se refuerza con `CHECK (cupos_disponibles BETWEEN 0 AND capacidad)` y con privilegios de columna: solo `worker_app` puede modificar `cupos_disponibles`. Los bloqueos siguen un orden fijo (`reservas` → `actividades`) para evitar *deadlocks* con la cancelación de la Entrega 4.

### Demostración

| Prueba | Resultado | Evidencia |
|---|---|---|
| 50 transacciones sobre 10 cupos, estrategia ingenua | 50 asignados (40 sobreasignados) | [05](evidencias/05-concurrencia-ingenua-atomica.txt) |
| 50 transacciones sobre 10 cupos, `UPDATE` condicional | 10 asignados, 0 cupos | [05](evidencias/05-concurrencia-ingenua-atomica.txt) |
| 500 solicitudes HTTP simultáneas, 1 worker | 10 confirmadas · 490 rechazadas · 0 pendientes · 0 cupos | [06](evidencias/06-rafaga-1-worker.txt) |
| 500 solicitudes HTTP simultáneas, 2 workers en la misma cola | 10 confirmadas · 490 rechazadas · 0 pendientes · 0 cupos; los workers confirmaron 6 y 4 reservas de la misma actividad | [07](evidencias/07-rafaga-2-workers.txt) |
| 20 solicitudes simultáneas del mismo participante | 1 × `202`, 19 × `409` (índice único de reserva activa) | [08](evidencias/08-duplicados.txt) |
| 20 reintentos simultáneos con la misma `Idempotency-Key` | 1 × `202`, 19 × `200` con la misma reserva | [08](evidencias/08-duplicados.txt) |
| Reentrega de un comando ya procesado | El worker lo detecta; cupos y versión sin cambios | [09](evidencias/09-reentrega.txt) |

La prueba con dos workers usa una única cola con dos consumidores, de modo que dos transacciones compiten de verdad sobre la misma fila. Si cada actividad tuviera un único consumidor (el particionado de la Entrega 6), la prueba no demostraría nada sobre la base de datos.

## Cómo reproducir el caso de concurrencia resuelto

Desde `reserva-cupos`, con el entorno levantado y la réplica configurada ([README de ejecución](../../reserva-cupos/README.md)):

```shell
# 1. Crear un tenant y guardar la clave que se muestra
docker compose exec mysql-primary mysql -uroot -proot_local_2026 reservas -e "SET @nombre = 'Pruebas de carga'; SOURCE /crear-tenant.sql"
export CLAVE=<clave_api>

# 2. Ráfaga: 500 solicitudes simultáneas sobre 10 cupos, verificadas por la API
docker compose run --rm k6 run -e API_KEY=$CLAVE /pruebas/carga/rafaga.js

# 3. Lo mismo con dos workers sobre la misma cola
docker compose up -d --scale worker=2
docker compose run --rm k6 run -e API_KEY=$CLAVE /pruebas/carga/rafaga.js
docker compose up -d --scale worker=1

# 4. Comparación con la estrategia ingenua (actividad de prueba vacía)
docker compose exec worker node src/demostrar-concurrencia.js <actividad_id> 50 0
```

El script de k6 crea la actividad, envía las 500 solicitudes con `Idempotency-Key` y participante únicos, espera a que no queden reservas pendientes (el procesamiento es asíncrono) y termina con error si no hay exactamente 10 confirmadas, 490 rechazadas, 0 pendientes y `cupos_disponibles = 0`.

## Decisiones y límites medidos

- **El comando `reservar` del worker se adelantó de la Entrega 4 a esta.** La plantilla exige demostrar el caso de concurrencia, y la decisión vive en el worker. En la Entrega 4 quedan `cancelar`, el estado `fallida` y el notificador.
- **Costo de la admisión durable.** Cada admisión hace un `COMMIT` que espera el acuse de la réplica semisíncrona. En el equipo de prueba, la ráfaga de 500 se admite completa en 8 a 16 segundos (medianas de 6,9 s y 3,4 s por solicitud en las evidencias 06 y 07; la variación entre corridas es del disco virtual de Docker Desktop): cada solicitud espera su turno en el pool de 10 conexiones de la API. En una medición de desarrollo, no incluida en las evidencias, el primario sostuvo unos 110-120 commits por segundo con semisync contra unos 580 sin ella. Es el precio de RPO = 0 y se optimiza en la Entrega 6.
- **Contención mínima en la admisión.** Las admisiones no compiten entre sí (cada una inserta una fila nueva), pero la clave foránea `reservas → actividades` toma un bloqueo compartido sobre la fila de la actividad, compatible con otras admisiones y no con el bloqueo exclusivo del worker. En desarrollo, una ráfaga con el worker detenido tuvo una latencia similar: el límite dominante es el `COMMIT`, no este bloqueo.
- **Dos consumidores en la misma cola no garantizan el orden de llegada.** La no sobreasignación se mantiene, pero una solicitud posterior puede quedarse con el último cupo. El diseño prevé un consumidor por partición (exchange de hash consistente por `actividad_id`), que se mide en la Entrega 6.
- **El secuenciador del relay usa `READ COMMITTED`**: numera solo los cambios confirmados y no toma bloqueos de intervalo que frenen los `INSERT` de la API. La garantía de orden del feed se mantiene porque el relay es la única instancia que asigna secuencias, y el índice único sobre `secuencia` rechaza una segunda instancia por error.

## Texto de la certificación

Versión corta de cada celda de la columna *Justificación breve / evidencia*, tal como figura en `Entrega3-Comunicacion.pdf`:

1. **Canal síncrono:** REST/HTTP `/v1` entre Aula (cliente) y la API, con clave de tenant. Admisión `202` + `Location`; consultas de estado, listado y feed. Evidencias 02 y 03.
2. **Canal asíncrono:** RabbitMQ entre relay y worker. El relay publica desde el outbox con *publisher confirms* y el worker consume con `prefetch(1)` y `ack` tras el `COMMIT`. Evidencia 04.
3. **Justificación:** síncrono donde el cliente necesita respuesta inmediata (admisión, errores del contrato, lectura de estado); asíncrono donde la decisión es contenciosa y diferible (asignación del cupo). Tabla por punto en `docs/entrega-3/README.md`.
4. **Caso de concurrencia:** 500 solicitudes simultáneas compiten por los 10 cupos de una misma fila de `actividades`; leer y después escribir sobreasigna (50 sobre 10 en la evidencia 05).
5. **Resolución demostrada:** `UPDATE … WHERE cupos_disponibles > 0` atómico en InnoDB + `CHECK`. Resultado 10/490/0 pendientes/0 cupos con 1 y 2 workers (k6, evidencias 06 y 07). Worker idempotente ante reentregas (09).

**Cómo reproducir:** `docker compose run --rm k6 run -e API_KEY=$CLAVE /pruebas/carga/rafaga.js` desde `reserva-cupos` (pasos completos en `docs/entrega-3/README.md`, sección *Cómo reproducir*).
