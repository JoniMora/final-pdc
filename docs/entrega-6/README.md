# Entrega 6 — Integración final, demo y defensa oral

Programación Distribuida y Componentes · Proyecto Final

- Grupo: 15.
- Integrantes: Jonathan Mora Colodrero y María Constanza Gigli.
- Caso de uso: servicio multi-tenant de reserva de cupos, con Aula como
  cliente de referencia para inscripciones.
- Rama de integración: entrega-6-final.
- Identificador previsto de la versión final: v6-final.
- Fecha de las pruebas documentadas: 14/11/2026.

## Objetivo

Integrar la infraestructura, comunicación, middleware, seguridad,
patrones y escalado desarrollados durante el proyecto.

El sistema permite crear actividades, solicitar reservas, decidirlas sin
sobreasignar cupos, cancelarlas y recuperar la proyección local de Aula
después de una caída de PostgreSQL.

## Recorrido integrado

1. Una persona inicia sesión en Aula.
2. Aula aplica los permisos de administrador o alumno.
3. El administrador crea una materia mediante la API.
4. El alumno solicita una inscripción.
5. La API autentica al tenant y guarda la reserva pendiente y su cambio
   en una transacción MySQL.
6. El relay publica el comando desde el outbox hacia RabbitMQ.
7. El worker decide la reserva mediante una operación condicional atómica.
8. El estado y sus cambios quedan confirmados antes del ack del mensaje.
9. Aula consulta el resultado y mantiene su proyección local.
10. La cancelación devuelve el cupo, que puede asignarse nuevamente.
11. Si PostgreSQL cae, Aula utiliza el servicio y después reconcilia
    desde el feed con un punto de control independiente.

Los webhooks firmados y sus reintentos forman parte de la implementación
de middleware. El listado de pruebas de esta carpeta describe exactamente
qué verifica cada ensayo; no se atribuye exclusivamente a los webhooks
una actualización que también puede producir el feed o una respuesta HTTP.

## Componentes y responsabilidades

| Componente | Responsabilidad |
|---|---|
| Aula | Interfaz, sesiones, permisos y proyección local. |
| PostgreSQL | Datos locales de materias, inscripciones y puntos de control. |
| Traefik | Descubrimiento y balanceo de instancias de la API. |
| API | Autenticación del tenant, contrato HTTP y admisión de solicitudes. |
| MySQL primario | Fuente de verdad de actividades y reservas. |
| MySQL réplica | Replicación semisíncrona y solo lectura. |
| Relay | Secuenciación del feed y publicación del outbox. |
| RabbitMQ | Transporte asíncrono, esperas y colas de errores. |
| Worker | Decisión atómica y cancelación de reservas. |
| Notificador | Webhooks firmados, reintentos y tratamiento de errores. |

## Evidencias finales

### 01 — Recorrido funcional

Archivo: [01-recorrido.txt](evidencias/01-recorrido.txt).

Prueba ejecutada mediante:

    node reserva-cupos/pruebas/final/recorrido.js

Resultado aprobado:

- Rechazo del acceso sin sesión.
- Login de administrador y alumno mediante HTTPS.
- Rechazo de creación de materias por un alumno.
- Creación de una materia con un cupo.
- Primera reserva confirmada y cupo disponible igual a cero.
- Segunda reserva rechazada por falta de cupo.
- Cancelación de la primera reserva y devolución del cupo.
- Nueva solicitud del segundo participante confirmada.

### 02 — Carga, balanceo y escalado

Archivo: [02-carga-escalado.txt](evidencias/02-carga-escalado.txt).

Prueba ejecutada mediante:

    node reserva-cupos/pruebas/final/carga-escalado.js

Se realizaron dos escenarios de 500 solicitudes para diez cupos:

| Configuración | Confirmadas | Rechazadas | Pendientes | Cupos |
|---|---:|---:|---:|---:|
| Una API y un worker | 10 | 490 | 0 | 0 |
| Tres API y dos workers | 10 | 490 | 0 | 0 |

Cada escenario aprobó 1004 comprobaciones.

También se verificó que Traefik respondiera desde las tres instancias de
API. Al terminar se restauró la cantidad inicial de API y workers.

Las pruebas utilizan HTTPS y un tenant separado de los datos de Aula.
Las claves no se imprimen ni se incluyen en la evidencia.

Los dos workers consumen la misma cola. No se implementaron nuevas
particiones ni se demuestra orden estricto de llegada.

Los resultados prueban corrección en esas ejecuciones; no equivalen a
una garantía general de rendimiento ni de mejora lineal al escalar.

### 03 — Seguridad y recuperación

Archivo:
[03-seguridad-recuperacion.txt](evidencias/03-seguridad-recuperacion.txt).

Se repitió la prueba de integración de seguridad sobre la versión final:

    node reserva-cupos/scripts/entrega5.js pruebas

Las veinte comprobaciones finalizaron correctamente, incluyendo:

- Autenticación y cierre de sesión.
- Permisos y protección de reservas ajenas.
- Protección CSRF.
- Continuidad de sesión y operaciones con PostgreSQL detenido.
- Reconstrucción de datos mediante el feed.
- HTTPS y TLS con verificación de certificados.
- Rechazo de conexiones de red sin TLS en las bases.
- RabbitMQ con AMQPS.
- Replicación activa con TLS y verificación del certificado del origen.

## Corrección encontrada durante la integración

El endpoint /health utilizaba el mismo pool MySQL que las solicitudes
de reservas.

Durante una ráfaga podía esperar detrás de las operaciones de negocio.
Los controles de Docker y Traefik podían superar sus tiempos de espera
y retirar la instancia, aunque el proceso siguiera ejecutándose.

Se agregó un pool exclusivo de una conexión para salud, sin espera
en cola y con tiempos limitados. Conserva la verificación TLS.

Después de esa corrección, los dos escenarios de carga terminaron
correctamente.

También se mejoró el diagnóstico del script de carga: ahora valida el
código HTTP y el formato de las respuestas antes de leer los resultados.
Una respuesta de error nunca se interpreta como cero reservas.

## Ejecución local

Seguir primero la
[guía de preparación y TLS](../entrega-5/README.md).

Desde la raíz del repositorio, con Docker Desktop abierto:

    node reserva-cupos/scripts/entrega5.js preparar
    node reserva-cupos/scripts/entrega5.js levantar
    node reserva-cupos/scripts/entrega5.js migrar

Ejecutar cada comando por separado y continuar solo si termina bien.
No eliminar volúmenes para un arranque normal.

La aplicación se abre en:

https://localhost:3001

Los accesos de demostración están en el archivo local:

reserva-cupos/seguridad/local/accesos-locales.txt

Ese archivo, las identidades y las claves privadas están excluidos de Git.
Cada instalación debe preparar sus propios archivos locales.

## Alcance y limitaciones

- Todo se ejecuta en un único host.
- Failover MySQL manual.
- La replicación semisíncrona puede degradar a asíncrona por timeout.
- Aula mantiene sesiones en memoria en una sola instancia.
- El relay secuenciador es de instancia única.
- Los workers escalados comparten una cola.
- La admisión durable tiene un costo que se observa en las mediciones.
- TLS utiliza una CA de desarrollo local, no certificados de producción.
- Las pruebas ejecutadas no sustituyen una auditoría de seguridad.
- Replicación y reconciliación no sustituyen los backups.

## Devoluciones anteriores

Los integrantes informaron que el docente no dejó devoluciones
pendientes de entregas anteriores.

Durante la integración se resolvieron los problemas identificados en
la ejecución y se documentaron sus correcciones.

## Cierre y defensa

Las pruebas automatizadas finales están aprobadas.

Antes de entregar todavía se debe:

- Ensayar la demo visual completa.
- Practicar que ambos integrantes expliquen cualquier componente.
- Revisar los checks del pull request final.
- Verificar y publicar los tags correspondientes.
- Completar la certificación de la cátedra con la fecha efectiva y
  el enlace a la versión final publicada.

No se marca el ensayo oral como realizado solamente porque pasaron
las pruebas automatizadas.
## Material para presentar

- [Demo paso a paso](demo.md).
- [Guía de defensa y mapa del código](defensa.md).
- [Estado de la certificación](certificacion-texto.md).
- [Índice de evidencias](evidencias/README.md).

El CI incluye el recorrido y la carga final dentro del trabajo de seguridad.
Su resultado debe comprobarse en el pull request; la configuración local
no acredita que GitHub ya lo haya ejecutado.
