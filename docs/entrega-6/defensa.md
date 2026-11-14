# Guía de defensa: qué decir y qué mostrar del código

## Apertura: aproximadamente un minuto

“Desarrollamos un servicio de reserva de cupos para varias organizaciones. Aula
es el ejemplo de una plataforma educativa que lo consume. El problema aparece
cuando muchas personas intentan reservar al mismo tiempo: hay que evitar asignar
más lugares que la capacidad y evitar duplicar una reserva por un reintento.

Separamos recibir la solicitud de decidirla. La API registra una reserva pendiente
y responde 202. El relay publica desde una tabla outbox hacia RabbitMQ y un worker
decide dentro de una transacción. MySQL es la fuente de verdad; PostgreSQL guarda
la proyección local de Aula. Así podemos continuar ciertas operaciones cuando
PostgreSQL está caído y reconstruir después esa proyección”.

## Qué se integra en cada etapa

- E0 y E1: planificación y arquitectura. Documentan decisiones; no prueban por sí
  solas que estuvieran implementadas.
- E2: contenedores, redes, persistencia, permisos de base, replicación y comunicación
  inicial. La pantalla de prueba de infraestructura no era todavía una inscripción.
- E3: recorrido real de actividades y reservas, outbox, mensajería y concurrencia.
- E4: contratos, descubrimiento con Traefik, cancelación y webhooks.
- E5: autenticación de personas, autorización, TLS y recuperación de Aula.
- E6: integración final, recorrido completo, carga y escalado; corrección del pool
  de salud y documentación de la demo y defensa.

## Mapa del código para abrir en IntelliJ

Las rutas siguientes son relativas a `reserva-cupos`. Usar Ctrl+Shift+F para buscar
el símbolo indicado. Los nombres son más estables que números de línea que pueden
cambiar al editar.

| Archivo o carpeta | Qué mirar y explicar |
|---|---|
| `docker-compose.yml` | Define servicios, redes, volúmenes y dependencias. Es la topología base; no contiene por sí solo toda la configuración segura. |
| `docker-compose.seguridad.yml` | Complementa el base: certificados, HTTPS, AMQPS y conexiones TLS de bases y réplica. Se aplican ambos archivos. |
| `Infraestructura/mysql/primary/init/01-esquema.sql` | Tablas tenants, actividades, reservas y cambios; restricciones que refuerzan la consistencia. |
| `Infraestructura/mysql/primary/init/02-usuarios.sql` | Privilegios por componente. La API no decide el descuento de cupos. |
| `Infraestructura/mysql/primary/primary.cnf` y `mysql/replica/replica.cnf` | Identidades, binlog/GTID y configuración de replicación. |
| `Infraestructura/mysql/replica/activar-tls.sql` | Activa TLS y verificación del certificado del origen en el canal de replicación. |
| `contrato/openapi.yaml` | Solicitudes, respuestas, estados, errores y seguridad HTTP. Es el contrato, no el código que ejecuta la reserva. |
| `contrato/asyncapi.yaml` | Estructura de los mensajes entre componentes. |
| `servicios/api/src/server.js` | Express, validación del contrato, errores y endpoint de salud. Buscar `poolSalud` y `/health`. |
| `servicios/api/src/rutas.js` | Autenticación de tenant, admisión, consultas y cancelación. Buscar `Idempotency-Key`, `pendiente` y las transacciones. |
| `servicios/api/src/modelo.js` | Conversión de filas y `registrarCambio`: instantánea que alimenta outbox/feed. |
| `servicios/api/src/db.js` | Pool de negocio y transacciones; conexión TLS cuando se configura. |
| `servicios/relay/src/main.js` | Secuenciar cambios y publicar; publisher confirms y marcado posterior. |
| `servicios/relay/src/configurar-colas.js` | Exchanges, comandos, entregas, esperas y DLQ. Tener la cola creada no significa que exista un consumidor activo. |
| `servicios/worker/src/reservar.js` | `reservar`: bloqueo de reserva, detección de repetidos, UPDATE condicional y registro del cambio en la misma transacción. |
| `servicios/worker/src/cancelar.js` | `cancelar`: devolver cupo si estaba confirmada y evitar devolverlo dos veces. |
| `servicios/worker/src/procesar.js` | Clasifica resultado y errores: ack, reencolar o DLQ. |
| `servicios/worker/src/main.js` | Conexión a RabbitMQ, prefetch y ejecución del ack después del procesamiento. |
| `servicios/notificador/src/main.js` | Envío de webhooks firmados, reintentos y errores. |
| `clientes/aula/src/server.js` | Rutas de la aplicación, permisos, integración con API y PostgreSQL. |
| `clientes/aula/src/seguridad.js` | `hashPassword`, `login`, `autenticar`, `administrador` y `puedeVer`. |
| `clientes/aula/src/recuperacion.js` | `aplicarPagina` y `sincronizar`: cambios y cursor de feed en una misma transacción local. |
| `clientes/aula/public/index.html` | Interfaz que llama al backend. Ocultar un botón no reemplaza autorización en el servidor. |
| `scripts/preparar-seguridad.js` | Genera CA local, certificados y usuarios con contraseñas derivadas. Los archivos secretos quedan fuera de Git. |
| `scripts/entrega5.js` | Preparación, arranque seguro, migración y pruebas. E6 reutiliza este entorno. |
| `pruebas/final/recorrido.js` | Comprueba el caso completo con HTTPS, roles, confirmación, rechazo, cancelación y reasignación. |
| `pruebas/final/carga-escalado.js` | Crea tenant de ensayo, ejecuta dos escenarios k6, comprueba instancias y restaura el escalado inicial en finally. |
| `pruebas/carga/rafaga.js` | Genera 500 solicitudes para diez cupos y verifica resultados finales; distingue errores HTTP de respuestas válidas. |
| `pruebas/seguridad/integracion.js` | Prueba permisos, TLS y caída/recuperación de PostgreSQL con componentes reales. |
| `../.github/workflows/ci.yml` | Ejecuta contratos, módulos, consumidor, integración y entorno seguro; el check final exige éxito de todos los trabajos. |

## Explicación del bloque central del worker

Abrir `servicios/worker/src/reservar.js`.

1. `enTransaccion` agrupa las operaciones: si falla una, se revierte el conjunto.
2. `SELECT ... FOR UPDATE` bloquea la reserva para que dos entregas del mismo
   comando no la procesen simultáneamente.
3. Si el estado ya no es pendiente, devuelve `repetido: true`: no descuenta otra vez.
4. `UPDATE actividades ... cupos_disponibles > 0` descuenta de forma atómica.
   `affectedRows === 1` determina confirmación; cero filas determina rechazo.
5. Actualiza el estado y su versión y llama a `registrarCambio` dentro de la misma
   transacción. El estado y su evento quedan juntos.
6. El consumidor confirma el mensaje después de completar el procesamiento. Si
   cae después del commit pero antes del ack, habrá reentrega, y la comprobación
   de estado evita repetir el efecto.

Frase para el profesor: “La garantía contra sobreasignación depende del UPDATE
condicional en InnoDB y sus restricciones. Prefetch limita mensajes en vuelo por
consumidor; no convierte varios workers en una única ejecución global”.

## Seguridad por dentro

En `seguridad.js`, `hashPassword` usa scrypt con sal aleatoria. No se guarda la
contraseña original en el archivo de identidades. El archivo local de accesos de
demostración sí contiene las contraseñas generadas: está ignorado por Git y debe
tratarse como secreto de desarrollo.

`login` verifica las credenciales, limita intentos por IP y genera un token
aleatorio. La cookie es HttpOnly, Secure y SameSite Strict. La sesión se guarda
en un Map del proceso usando un hash del token, con vencimiento. No usamos JWT.
El límite cuenta intentos de login, incluidos los exitosos; no es rate limiting
general de todos los endpoints.

`autenticar` recupera la sesión y vuelve a comprobar que el usuario siga activo.
Para modificar estado exige CSRF y valida el origen cuando está presente.
`administrador` exige ese rol; la propiedad de una inscripción también se verifica
en el backend. El participante del alumno se obtiene de su sesión para evitar
suplantación cambiando el JSON de una solicitud.

TLS cifra las conexiones y los clientes verifican CA e identidad del servidor.
HMAC firma los webhooks y permite comprobar integridad/autenticidad con un secreto
compartido; no cifra el mensaje. La configuración utiliza certificados de servidor,
no autenticación mutua con certificados de cliente.

## Recuperación por dentro

PostgreSQL no es la fuente definitiva de los cupos. Durante su caída, Aula puede
consultar el servicio y conservar sesión y catálogo en memoria. Eso no significa
que cualquier operación local funcione sin base ni que un reinicio preserve esa memoria.

Al volver PostgreSQL, `recuperacion.js` consulta `/v1/cambios` desde el último cursor
aplicado. `aplicarPagina` bloquea el punto de control, aplica cambios y actualiza
el cursor en una transacción. Si falla, no avanza el cursor dejando datos sin aplicar.
Las versiones evitan reemplazar un estado más nuevo por uno viejo.
El cursor del feed es independiente del máximo visto por webhook: recibir un evento
posterior no autoriza saltear cambios anteriores que faltan en la proyección.

## Lo que encontramos y corregimos en E6

“Con carga, el health check esperaba conexiones en el mismo pool que el negocio.
Eso podía hacer que Docker o Traefik consideraran no disponible una instancia
ocupada. Creamos un pool de salud independiente, de una conexión, sin cola de espera
y con tiempos limitados. Conservamos TLS. Después pasaron los dos escenarios”.

Mostrar `poolSalud` en `server.js`. El endpoint informa el estado de MySQL en el
cuerpo; HTTP 200 significa que respondió el proceso, no que una reserva esté confirmada.

“También corregimos el diagnóstico de k6: antes de leer `datos` comprobamos HTTP
y la estructura JSON. Así un error de transporte o gateway no se interpreta como
una lista vacía ni se oculta detrás de un error de parseo”.

## Resultados que sí podés afirmar

- Recorrido final: ocho verificaciones aprobadas.
- Seguridad y recuperación: veinte verificaciones aprobadas.
- Carga: cada escenario tuvo 500 solicitudes, diez confirmadas, 490 rechazadas,
  cero pendientes y cero cupos disponibles; 1004 comprobaciones aprobadas.
- Configuraciones: una API/un worker y tres API/dos workers; se observaron las tres
  API detrás del gateway y se restauró la configuración inicial.

No afirmar que escalar siempre acelera todo. Son dos ejecuciones locales y las
métricas HTTP incluyen consultas de seguimiento, no solo admisiones. No garantizan
rendimiento de producción ni orden estricto entre participantes.

## Preguntas probables y respuestas cortas

**¿Por qué 202 y no 200 confirmada?** Se aceptó una solicitud durable, pero el worker
 todavía debe decidir si obtiene cupo. Se consulta el recurso para el estado final.

**¿Por qué outbox?** Evita tener que confirmar por separado MySQL y RabbitMQ en la
misma solicitud. El relay puede recuperar lo que falta publicar desde la base.

**¿Se pueden duplicar mensajes?** Sí, la entrega es al menos una vez. El procesamiento
es idempotente para no repetir el descuento o devolución de cupo.

**¿Idempotency-Key es lo mismo que el bloqueo del worker?** No. La clave identifica
reintentos HTTP de una misma operación; el worker protege el efecto ante reentregas
de mensajes de esa reserva.

**¿Por qué dos bases?** MySQL mantiene el servicio compartido; PostgreSQL pertenece
al cliente Aula. Separarlas evita que el servicio dependa del esquema de cada tenant.

**¿Un tenant es un alumno?** No. El tenant es la organización que consume la API con
su clave. El alumno es una persona autenticada dentro de Aula.

**¿Qué evita acceder a otra reserva?** El filtro de tenant en la API y la comprobación
de participante/rol en Aula. Un identificador difícil de adivinar no reemplaza permisos.

**¿Qué pasa si RabbitMQ está caído?** El outbox conserva cambios pendientes de publicación.
La decisión se demora hasta recuperar transporte y consumidores; 202 no promete inmediatez.

**¿Qué pasa si cae el worker después de actualizar?** Con commit hecho y sin ack,
RabbitMQ reentrega. El worker ve el estado ya decidido y no repite el efecto.

**¿La réplica reemplaza automáticamente al primario?** No. El failover es manual.
La replicación semisíncrona puede degradar a asíncrona por timeout; no prometemos
RPO cero ante cualquier falla. Una réplica tampoco reemplaza backups.

**¿Por qué un solo relay?** Secuencia el feed y publica desde el outbox. Escalar ese
secuenciador requiere coordinación adicional; esta versión no lo implementa.

**¿Qué pasa al reiniciar Aula?** Las sesiones en memoria se pierden y hay que volver
a iniciar sesión. No se implementó almacenamiento distribuido de sesiones.

**¿Cuántas particiones hay al escalar workers?** En la prueba comparten una cola de
comandos. Dos workers no significan dos particiones ni orden global estricto.

**¿Qué demuestra el test de caída?** Continuidad de las operaciones ensayadas con
PostgreSQL detenido y reconstrucción posterior desde el feed. No demuestra caída
del host completo ni failover automático de MySQL.

**¿Qué queda antes de entregar?** Ensayar la demo y la explicación de ambos,
revisar el CI del commit definitivo y publicar/verificar la versión final.

## Cómo practicar sin memorizar todo

Primero explicar el recorrido con tus palabras. Después abrir `reservar.js` y
seguir sus seis pasos. Luego explicar seguridad y recuperación. Por último,
mostrar las evidencias y sus límites. Cada integrante debe poder repetir ese
recorrido y ubicar estos archivos, aunque se dividan los minutos de exposición.
