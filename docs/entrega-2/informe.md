# Entrega 2 — Infraestructura

**Programación Distribuida y Componentes · Proyecto Final · Grupo 15**

**Integrantes:** Jonathan Mora Colodrero y María Constanza Gigli.  
**Fecha de documentación y pruebas:** 07/10/2026.  
**Rama:** `entrega-2-infraestructura`.  
**Tag previsto:** `v2-infraestructura` (pendiente de creación y publicación).  
**Repositorio:** [final-pdc](https://github.com/JoniMora/final-pdc).  
**Instrucciones de ejecución:** [README de la aplicación](../../reserva-cupos/README.md).

## Objetivo y alcance

Esta entrega convierte la propuesta de arquitectura en un esqueleto ejecutable. Los componentes corren en contenedores distintos y se comunican mediante HTTP, AMQP y conexiones a bases de datos. No se trata únicamente de una interfaz visual: los mensajes llegan a un consumidor independiente y los registros de Aula se guardan en PostgreSQL.

El objetivo funcional final es ofrecer reservas de cupos para múltiples organizaciones. En esta etapa se implementan la infraestructura, el esquema inicial y pruebas de comunicación. Las reservas reales, la autenticación multi-tenant, el outbox operativo, el feed y los webhooks quedan para las siguientes entregas.

## Modelo de ejecución y justificación

Se utiliza un modelo **cliente-servidor con componentes separados y mensajería asíncrona**. Aula es un cliente del servicio: su backend llama por HTTP a la API. La API publica mensajes de prueba en RabbitMQ y un worker independiente los consume.

La comunicación HTTP permite pedir una operación y recibir una respuesta inmediata. La cola permite separar la recepción del trabajo de su procesamiento. Esta separación prepara el manejo de picos de solicitudes del sistema de reservas; la entrega actual demuestra el transporte, pero no mide todavía su comportamiento bajo alta concurrencia.

Cada proceso puede ejecutarse y detenerse por separado. Docker Compose permite reproducir su configuración, dependencias de arranque, redes y almacenamiento. Todos los contenedores están en un solo equipo: existe separación de procesos, pero no tolerancia a la pérdida del host.

El servicio comparte una base MySQL entre componentes; por ello no se afirma que sean microservicios con bases autónomas. Aula sí tiene una base propia, separada de la base del servicio.

## Vista física: nueve contenedores y tres redes

| Contenedor | Responsabilidad implementada |
|---|---|
| api | Endpoint de salud y publicación de mensajes de prueba con confirmación del broker. |
| worker | Consumo de la cola de prueba y confirmación después de mostrar el mensaje en logs. |
| mysql-primary | Persistencia del esquema inicial y usuarios del servicio. |
| mysql-replica | Recepción y aplicación de cambios del primario; modo de solo lectura. |
| rabbitmq | Exchanges, colas durables, esperas por TTL y rutas de errores. |
| relay | Declaración de la topología y comprobaciones de conexión y consulta. |
| notificador | Comprobaciones de conexión y consulta; no envía webhooks todavía. |
| aula | Interfaz web, acceso a su PostgreSQL y envío HTTP a la API. |
| aula-db | Base PostgreSQL propia del cliente de referencia. |

| Red bridge | Contenedores |
|---|---|
| publica | api, aula, notificador |
| interna | api, worker, mysql-primary, mysql-replica, rabbitmq, relay, notificador |
| tenant | aula, aula-db |

Aula no comparte la red interna de MySQL. Se conecta a la API por la red publica y a PostgreSQL por tenant. Estas redes no están configuradas con `internal: true`; su separación no equivale a una política completa de firewall.

Los únicos puertos publicados se vinculan a `127.0.0.1`: API 3000, Aula 3001 y administración de RabbitMQ 15672. MySQL y PostgreSQL no publican puertos al host.

Hay cuatro volúmenes persistentes: datos de RabbitMQ, MySQL primario, MySQL réplica y PostgreSQL. Detener o recrear contenedores conservando los volúmenes permite mantener los datos.

## Persistencia y permisos

La base MySQL `reservas` contiene `tenants`, `actividades`, `reservas` y `cambios`. La tabla `cambios` prepara el futuro outbox y feed; todavía no existe su procesamiento funcional.

Se crearon usuarios separados para API, worker, relay, notificador y replicación. La API no tiene permiso para modificar `cupos_disponibles`; el worker sí. La prueba de permisos utiliza `WHERE 1 = 0`, de modo que comprueba autorización sin cambiar filas. Las aplicaciones API y worker de esta etapa todavía no realizan operaciones de reservas en MySQL.

MySQL utiliza replicación con GTID y el complemento semisíncrono. Se comprobó que el primario informa `ON` y una réplica conectada. En una comprobación anterior, ambos hilos de la réplica estaban activos, sin errores, con retraso cero y con las transacciones del primario aplicadas. La réplica tiene `read_only = 1` y `super_read_only = 1`.

La confirmación semisíncrona de recepción no significa que la réplica ya haya aplicado cada transacción. El tiempo de espera configurado es de diez segundos; si vence, puede producirse un paso a replicación asíncrona. No se implementa promoción automática ni se declara ausencia de pérdida de datos ante cualquier fallo.

PostgreSQL almacena los registros de prueba de Aula. La aplicación utiliza el usuario `aula_app`; el usuario administrador se utiliza para inicializar la base.

## Mensajería

El recorrido comprobado es `Aula → HTTP → API → RabbitMQ → worker`. La API publica mensajes persistentes y espera la confirmación del broker antes de responder HTTP 202. El worker utiliza `prefetch(1)` y confirmación manual después del procesamiento de prueba.

HTTP 202 significa aceptación de la publicación; el procesamiento se verifica comparando el identificador de la respuesta con el del log del worker. La persistencia y las confirmaciones no garantizan por sí solas un efecto exactamente una vez. Esa propiedad requiere la lógica idempotente de negocio prevista para las siguientes entregas.

La topología incluye el exchange de comandos de tipo consistent hash y una partición `reservas.comandos.0`, además de colas de errores y notificaciones. Se declaran esperas de 10 segundos, un minuto y cinco minutos que reenvían mensajes expirados hacia `webhooks.entregas`.

La prueba automática de diez segundos publicó un mensaje, comprobó su llegada a la cola de entregas con el mismo identificador y lo confirmó. No se probaron los otros dos intervalos ni el envío de webhooks. Las DLQ están declaradas, pero no se comprobó todavía un ciclo completo de errores de negocio. La cola `infraestructura.pruebas` no utiliza esas DLQ.

## Pruebas y resultados

Los resultados proceden de los comandos y capturas compartidos durante la ejecución local. Los archivos de evidencia identifican si contienen una transcripción resumida o una captura original.

| Prueba | Resultado observado | Evidencia |
|---|---|---|
| Contenedores | Nueve en ejecución; seis con estado healthy. | [Estado del entorno](evidencias/01-entorno.txt) |
| Redes | Tres redes bridge locales: publica, interna y tenant. | [Estado del entorno](evidencias/01-entorno.txt) |
| Semisíncrona | Estado ON y un cliente conectado. | [Estado del entorno](evidencias/01-entorno.txt) |
| Réplica | Hilos IO y SQL activos, sin errores, retraso cero en la comprobación registrada. | [Persistencia y permisos](evidencias/02-persistencia-permisos.txt) |
| Esquema | Cuatro tablas disponibles en la réplica. | [Persistencia y permisos](evidencias/02-persistencia-permisos.txt) |
| Solo lectura | read_only y super_read_only iguales a 1. | [Persistencia y permisos](evidencias/02-persistencia-permisos.txt) |
| Permisos | UPDATE de cupos denegado a API y permitido a worker sin modificar filas. | [Persistencia y permisos](evidencias/02-persistencia-permisos.txt) |
| HTTP y AMQP | Mensaje aceptado y recibido por worker con el mismo identificador. | [Comunicación e independencia](evidencias/03-comunicacion.txt) |
| Independencia | Con aula-db detenido, Aula pudo enviar un mensaje que llegó al worker. | [Comunicación e independencia](evidencias/03-comunicacion.txt) |
| Persistencia de Aula | Tras iniciar PostgreSQL, volvieron a consultarse los tres registros previos. | [Captura de registros](evidencias/aula-registros.png) |
| Topología RabbitMQ | Ocho colas; un consumidor en la cola de prueba. | [Topología](evidencias/04-colas.txt) |
| TTL de 10 segundos | Mismo mensaje recibido tras 10,09 segundos; resultado OK. | [Salida original compartida](evidencias/05-espera-10s.txt) |

La detención independiente de PostgreSQL demuestra separación física y que el envío de mensajes no necesita esa base. No demuestra todavía el modo de contingencia de reservas ni su reconciliación.

## Correspondencia con la plantilla del profesor

| Requisito | Cumplimiento y justificación |
|---|---|
| Al menos dos nodos separados funcionando | Sí: nueve contenedores distintos con backend real. |
| Nodos que pueden iniciarse y detenerse independientemente | Sí: se detuvo e inició aula-db y se procesó un mensaje mientras estaba detenido. |
| Modelo de ejecución identificado | Sí: cliente-servidor con componentes separados y mensajería asíncrona. |
| Modelo justificado según el caso de uso | Sí: separación del cliente, recepción y procesamiento para preparar el manejo de solicitudes concurrentes. |
| README con inicio local paso a paso | Sí: incluye construcción, arranque y configuración inicial de la réplica. |
| Informe descriptivo y técnico | Este documento y sus evidencias. |

La certificación del profesor, si debe entregarse como formulario, debe completarse con Grupo 15, fecha efectiva de entrega, tag publicado y enlace a este informe. Los campos de nota, corrección y observaciones corresponden al docente.

## Ejecución y presentación

Seguir el [README](../../reserva-cupos/README.md). En una instalación nueva se configura la réplica una vez después de que ambas bases estén saludables. Esa configuración persiste en el volumen; no se repite en cada arranque.

Para la demostración: mostrar los contenedores y redes, abrir Aula en `http://localhost:3001`, guardar un registro, enviar un mensaje y comparar su identificador en los logs del worker. Después mostrar replicación, permisos y prueba TTL. La prueba de detención de PostgreSQL puede repetirse siguiendo el README.

**Enlace al informe en la rama, disponible después del push:**

[Informe de entrega 2](https://github.com/JoniMora/final-pdc/blob/entrega-2-infraestructura/docs/entrega-2/informe.md).

## Trabajo posterior

Las siguientes entregas incorporarán autenticación y aislamiento por tenant, admisión de reservas e idempotencia, operaciones transaccionales con outbox, secuenciación del feed, decisión de cupos en el worker y notificaciones HMAC con reintentos. La interfaz de Aula actual es una herramienta de comprobación de infraestructura.
