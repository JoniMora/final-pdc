# Informe de amenazas — Entrega 5

Qué se protegió, de qué y con qué evidencia. Se usa STRIDE: **S**uplantación, **T**ampering (alteración), **R**epudio, **I**nformation disclosure (fuga de información), **D**enegación de servicio y **E**levación de privilegios.

## Qué se protege y dónde están las fronteras

**Activos.** Los cupos y las reservas de cada tenant (la invariante: nunca más confirmadas que cupos y nunca dos reservas activas del mismo participante), las claves de API, la clave del operador, los secretos de webhook, las contraseñas y sesiones de las personas de Aula, y la proyección local de Aula.

**Fronteras de confianza.**

1. Navegador → Aula: las personas.
2. Sistema del tenant → Traefik → API: los tenants, por internet.
3. Operador → `/admin/v1`.
4. Componentes del servicio → MySQL y RabbitMQ, y réplica → primario: la red interna.
5. Notificador → receptor del tenant: webhooks hacia URLs que elige el tenant.
6. Aula → aula-db: la red del tenant.
7. Traefik → Docker.
8. El equipo anfitrión y el repositorio.

**Supuesto.** El anfitrión y su administrador son de confianza. Quien controla Docker en ese equipo controla todo el entorno; esta entrega no lo resiste ni lo pretende.

## Amenazas y mitigaciones

| Flujo | STRIDE | Amenaza | Mitigación | Evidencia |
|---|---|---|---|---|
| 1 | S | Entrar a Aula sin cuenta o adivinando contraseñas | Contraseñas scrypt con sal aleatoria; error idéntico para un usuario inexistente (también se calcula el hash); 10 fallos por IP bloquean 15 min (los logins correctos no cuentan) | [seguridad-aula](evidencias/seguridad-aula.txt) · pruebas de `clientes/aula` |
| 1 | S, E | Robar o fijar la sesión | Token aleatorio de 256 bits en cookie `HttpOnly; Secure; SameSite=Strict`; token nuevo en cada login; el servidor guarda su hash; logout y vencimiento a la hora la invalidan | [seguridad-aula](evidencias/seguridad-aula.txt) |
| 1 | T | Que otro sitio haga escribir al navegador de la víctima (CSRF) | Token CSRF por sesión en cada escritura y control de `Origin` | [seguridad-aula](evidencias/seguridad-aula.txt) |
| 1 | E | Un alumno que crea materias, inscribe a otro o cancela una reserva ajena | Rol leído del archivo de identidades en cada pedido (no del cliente); el participante sale de la sesión; la propiedad se verifica en el servidor; una reserva ajena responde `404` | [seguridad-aula](evidencias/seguridad-aula.txt) · `rutas-seguras.test.js` |
| 1 | I | Que un alumno vea quiénes más se inscribieron | El detalle de la materia filtra los inscriptos por la identidad de la sesión | [seguridad-aula](evidencias/seguridad-aula.txt) |
| 2 | S | Usar la API sin clave o con una robada después de detectarlo | Clave de 256 bits (la base guarda su SHA-256); el operador la rota y la anterior deja de autenticar en el mismo momento; un tenant se puede desactivar | [seguridad-api](evidencias/seguridad-api.txt) |
| 2 | I | Que un tenant lea o modifique datos de otro | El tenant sale siempre de la clave, nunca de la ruta ni del cuerpo; un recurso ajeno responde `404`, igual que uno inexistente; el feed se filtra por tenant | [seguridad-api](evidencias/seguridad-api.txt) |
| 2 | E | Una clave usada más allá de lo que necesita (por ejemplo, un tablero de solo lectura que reserva) | Permisos por clave, declarados por operación en el contrato y aplicados por la API leyendo esa declaración; sin el permiso, `403` | [seguridad-api](evidencias/seguridad-api.txt) · `acceso.test.js` |
| 2 | D | Un tenant que satura la API y deja sin servicio a los demás | Límite de tasa por clave (token bucket) con `429` y `Retry-After`. Con el balde vacío, el `429` se responde sin consultar MySQL, así la inundación no le cuesta a la base. El límite de un tenant no consume el de otro | [seguridad-api](evidencias/seguridad-api.txt) · [carga](evidencias/05-carga.txt) |
| 2 | I, T | Leer o alterar pedidos en la red | HTTPS hasta Traefik y de Traefik a cada instancia de la API, con verificación del certificado (`api`) y TLS 1.2 o superior | [cifrado](evidencias/cifrado.txt) · [captura](evidencias/captura-trafico.txt) |
| 3 | E | Que un tenant dé de alta tenants o cambie permisos | `/admin/v1` exige la clave del operador, distinta de cualquier clave de tenant: una clave de tenant recibe `403`; en la base, solo el usuario `admin_app` puede escribir la tabla de tenants | [seguridad-api](evidencias/seguridad-api.txt) |
| 3 | I | Filtrar credenciales desde la administración | La clave y el secreto del webhook se muestran una sola vez, al crearlos o rotarlos; la consulta no los devuelve; la API recibe solo el hash de la clave del operador | [seguridad-api](evidencias/seguridad-api.txt) |
| 4 | I, T | Espiar o alterar el tráfico con las bases o el broker | MySQL con `require_secure_transport` y clientes que verifican la CA y el nombre; replicación con `SOURCE_SSL` y verificación del primario; RabbitMQ solo AMQPS (5672 cerrado) | [cifrado](evidencias/cifrado.txt) |
| 4 | E | Un componente comprometido que escribe donde no debe | Un usuario de MySQL por componente con permisos por columna (Entrega 2); la API no puede cambiar cupos ni estados | Entrega 2 · `02-usuarios.sql` |
| 5 | S, T | Webhooks falsificados o reinyectados | HMAC-SHA256 con secreto de 32 bytes por tenant, comparación en tiempo constante y ventana de 5 minutos; además viajan por HTTPS | [seguridad-api](evidencias/seguridad-api.txt) · pruebas del notificador y de Aula |
| 5 | E, I | SSRF: usar el notificador para alcanzar la red interna o los metadatos de una nube | Validación de la IP al conectar (también IPv6 y DNS rebinding); lista de destinos internos permitidos; HTTPS obligatorio. El destino rechazado va a la DLQ sin conexión | [seguridad-api](evidencias/seguridad-api.txt) |
| 5 | D | Un receptor lento que retiene al notificador | Plazo total de 5 s por entrega, reintentos escalonados y DLQ; el evento sigue en el feed | Entrega 4 · [tenant](evidencias/fallos/tenant.txt) |
| 6 | I, T | Espiar la base de Aula | PostgreSQL con TLS y `pg_hba` que rechaza conexiones de red sin cifrar; Aula verifica el certificado de aula-db | [cifrado](evidencias/cifrado.txt) |
| 7 | E | Traefik comprometido que usa el socket de Docker para crear contenedores privilegiados | Traefik no monta el socket: consulta un proxy que solo permite leer contenedores, eventos y la versión, en una red interna sin salida; una escritura responde `403` | [cifrado](evidencias/cifrado.txt) |
| 7 | I | Panel de Traefik expuesto | Solo por HTTPS y publicado en `127.0.0.1`; es de lectura | [cifrado](evidencias/cifrado.txt) |
| 8 | I | Claves privadas o credenciales en Git | La CA, las claves de cada servicio, las contraseñas de Aula y la clave del operador se generan en `seguridad/local/` (excluido de Git); la clave de la CA no se monta en ningún contenedor; el CI genera las suyas en cada corrida | `.gitignore` · `preparar-seguridad.js` |
| 4, 2 | D | Caída de un componente que corta el servicio o pierde reservas | Outbox transaccional, colas durables, worker idempotente, reintentos idempotentes, réplica semisíncrona con failover por script y reconciliación por feed | [matriz de fallos](evidencias/fallos/resumen.md) |
| Todos | R | Que un tenant o una persona niegue una operación | Cada cambio de estado queda en la tabla `cambios` con su tenant, versión y hora, y se expone en el feed; los registros de cada componente identifican el tenant y el evento | Feed `/v1/cambios` |

## Riesgos que quedan

- **Contraseñas de la infraestructura en el repositorio.** Las de MySQL, RabbitMQ y PostgreSQL, y la clave y el secreto de webhook de Aula, siguen en `docker-compose.yml` y en los scripts iniciales, como desde la Entrega 2. Las conexiones van cifradas, pero quien lea el repositorio y llegue a la red interna podría usarlas. Moverlas a secretos generados (como ya se hace con los certificados) queda pendiente.
- **Sin TLS mutuo.** Cada servidor se autentica con su certificado y cada cliente, con credenciales. Un proceso en la red interna con una contraseña válida puede conectarse.
- **CA local, sin rotación ni revocación.** Los certificados duran un año y se regeneran borrando `seguridad/local/`.
- **Límite de tasa y sesiones por instancia.** Con N instancias de la API, el límite efectivo es hasta N veces el configurado; las sesiones de Aula se pierden al reiniciarla. Pasan a Redis en la Entrega 6. No hay defensa contra una denegación de servicio distribuida ni contra ataques a la red del equipo.
- **Identidades de Aula en un archivo.** No hay alta por autoservicio, recuperación de contraseña ni segundo factor; las contraseñas de demostración están en `accesos-locales.txt`, que hay que tratar como secreto.
- **Usuario compartido en RabbitMQ.** Todos los componentes usan el mismo usuario del broker; la separación de permisos está en MySQL, no por vhost.
- **Failover a pedido, en un solo equipo.** No hay detección automática ni un tercer nodo que decida; volver a la topología con réplica requiere recrear el entorno. Replicación y reconciliación no son copias de seguridad: no protegen de un borrado intencional ni de la pérdida del equipo.
- **El poseedor de una clave de tenant tiene toda la autoridad que dan sus permisos.** El servicio no distingue qué persona del tenant hizo cada pedido: eso lo resuelve el tenant (en Aula, con sus roles).

Las pruebas demuestran los escenarios que se ejecutaron, no la ausencia de otros ataques o fallas.

> **Entrega 6.** El límite de tasa pasó a Redis y es global entre instancias de la API (el riesgo del límite por instancia queda resuelto; las sesiones de Aula siguen en memoria). Redis, Prometheus y Grafana agregan fronteras nuevas: sus amenazas, mitigaciones y riesgos están en [Seguridad de los componentes nuevos](../entrega-6/README.md#seguridad-de-los-componentes-nuevos).
