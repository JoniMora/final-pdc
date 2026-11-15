# Entrega 5 — Seguridad y confiabilidad

Módulo 5 — Seguridad y confiabilidad en entornos distribuidos.

| | |
|---|---|
| **Grupo N°** | 15 |
| **Integrantes** | Jonathan Mora Colodrero · María Constanza Gigli |
| **Tag / Release** | `v5-seguridad` |
| **Fecha de entrega** | 14/11/2026 |
| **Certificación de la cátedra** | `Entrega5-Seguridad.pdf`, completada con el texto de la [última sección](#texto-de-la-certificación) y entregada por separado (no se versiona) |
| **Informe de amenazas** | [`amenazas.md`](amenazas.md) |
| **Evidencias** | [`evidencias/`](evidencias/README.md): ejecución del 14/11/2026 sobre volúmenes nuevos |

## Checklist de la entrega

| Requisito | Cumple | Justificación breve / evidencia |
|---|---|---|
| Hay autenticación de usuarios implementada | ☑ Sí | **Personas:** login en Aula con contraseñas scrypt con sal, sesión del lado del servidor en una cookie `HttpOnly; Secure; SameSite=Strict`, CSRF, error idéntico para un usuario inexistente y bloqueo por fuerza bruta. **Tenants:** clave de API de 256 bits (la base guarda su hash), rotable. **Operador:** clave propia para `/admin`. [seguridad-aula](evidencias/seguridad-aula.txt) · [seguridad-api](evidencias/seguridad-api.txt) |
| Hay autorización / control de acceso (no todos pueden todo) | ☑ Sí | En Aula, el administrador crea materias y gestiona inscripciones; el alumno opera solo lo propio (`403` al crear o suplantar, `404` ante una reserva ajena). En el servicio, permisos por clave declarados en el contrato y aplicados por la API desde esa declaración (`403`), `/admin` solo para el operador, aislamiento entre tenants (`404`) y límite de tasa por tenant (`429`). [seguridad-aula](evidencias/seguridad-aula.txt) · [seguridad-api](evidencias/seguridad-api.txt) · [05](evidencias/05-carga.txt) |
| La comunicación entre componentes está cifrada en tránsito (HTTPS/TLS) | ☑ Sí | TLS 1.2 o superior en todos los saltos, con una CA local y verificación de identidad en cada cliente: HTTPS (navegador → Aula, clientes → Traefik → cada instancia de la API, notificador → webhooks), AMQPS, MySQL con `require_secure_transport`, replicación con `SOURCE_SSL` y PostgreSQL. El texto plano se rechaza en cada protocolo y una captura muestra el tráfico cifrado. Ver [cifrado](#cifrado-en-tránsito). [cifrado](evidencias/cifrado.txt) · [captura](evidencias/captura-trafico.txt) |
| Hay un mecanismo de replicación o recuperación ante fallos implementado y probado | ☑ Sí | Réplica semisíncrona con failover por script: el primario cae con una ráfaga en curso y el sistema retoma la escritura en 1,8 s, sin perder ninguna reserva admitida ni confirmada (RPO = 0). Matriz de fallos sobre nueve componentes con las invariantes verificadas, y contingencia y reconciliación de Aula (escenario +1). Ver [recuperación](#recuperación-ante-fallos). [fallos](evidencias/fallos/resumen.md) |
| Se incluyó un informe corto de amenazas (qué se protegió y de qué) | ☑ Sí | [`amenazas.md`](amenazas.md): activos y fronteras de confianza, amenazas STRIDE por flujo con su mitigación y la evidencia de cada una, y los riesgos que quedan. |

## Identidades y permisos

Hay tres identidades distintas, cada una con su credencial y su alcance:

| Quién | Cómo se autentica | Qué puede hacer | Dónde se aplica |
|---|---|---|---|
| Persona de Aula (administrador o alumno) | Usuario y contraseña → sesión | Administrador: crear materias, inscribir a cualquiera, ver la reconciliación. Alumno: inscribirse a sí mismo, ver y cancelar lo propio | Aula ([`seguridad.js`](../../reserva-cupos/clientes/aula/src/seguridad.js)), en cada pedido |
| Tenant (Aula, otros sistemas) | Clave de API | Lo que permiten sus permisos (`actividades:escribir`, `reservas:escribir`, `lectura`, `cambios:leer`), solo sobre sus recursos y hasta su límite de tasa | API ([`acceso.js`](../../reserva-cupos/servicios/api/src/acceso.js)), con los permisos tomados del contrato |
| Operador de la plataforma | Clave de operador (la API recibe solo su hash) | Alta de tenants, permisos, webhook, límite, estado y rotación de claves | API, rutas `/admin/v1` |

El servicio sigue sin conocer a los usuarios finales: autentica tenants. Las personas las autentica el tenant; Aula, el cliente de referencia, lo hace con sus propios roles. Las identidades de Aula están en un archivo de solo lectura (solo hashes) y no en PostgreSQL: el login sigue funcionando cuando `aula-db` cae.

## Cifrado en tránsito

| Enlace | Protocolo | El cliente verifica | El texto plano |
|---|---|---|---|
| Navegador → Aula | HTTPS | Certificado `aula` (CA local) | Sin respuesta |
| Aula y clientes → Traefik | HTTPS | Certificado `traefik`; también para un nombre desconocido | `404`, sin datos |
| Traefik → cada instancia de la API | HTTPS | Certificado `api` (`serversTransport`) | La API no atiende HTTP |
| Notificador → receptor del tenant | HTTPS + HMAC | Certificado del receptor | La URL `http://` va a la DLQ |
| Relay, worker, notificador → RabbitMQ | AMQPS 5671 | Certificado `rabbitmq` | 5672 cerrado |
| Servicios → MySQL primario | TLS | CA y nombre `mysql-primary` | `require_secure_transport` |
| Réplica → primario | TLS | `SOURCE_SSL_VERIFY_SERVER_CERT` | Idem |
| Aula → aula-db | TLS | CA y nombre `aula-db` | `pg_hba` lo rechaza |
| Traefik → Docker | Proxy del socket en una red interna | — | Solo lecturas; una escritura recibe `403` |

La CA y los certificados los genera `node scripts/sistema.js preparar` en `seguridad/local/`, fuera de Git; la clave de la CA no se monta en ningún contenedor. El CI genera las suyas en cada corrida.

## Recuperación ante fallos

Cada escenario detiene un componente con una ráfaga de reservas en curso. El cliente de la ráfaga reintenta como uno correcto (misma `Idempotency-Key`), y al final se verifica por la API pública que haya exactamente tantas confirmadas como cupos, ninguna pendiente, ningún participante con dos reservas activas y `cupos_disponibles` coherente. Resumen de la ejecución ([detalle por escenario](evidencias/fallos/resumen.md)):

| Componente detenido | Efecto observado | Garantía verificada | Recuperación |
|---|---|---|---|
| worker | La admisión sigue respondiendo `202`; las decisiones esperan | Comandos durables; 10 confirmadas, 0 duplicadas | 7,2 s hasta 0 pendientes |
| relay | La admisión sigue; los comandos quedan en el outbox | Outbox transaccional, nada se pierde | 7,1 s |
| rabbitmq | La admisión sigue; relay, worker y notificador se reinician hasta reconectar | Outbox y colas durables | 19,7 s |
| notificador | Las decisiones no se demoran; 100 webhooks esperan en la cola | Al volver se entregan; Aula = servicio | 2,7 s |
| una instancia de la API (SIGKILL, con dos) | Las solicitudes en curso reciben `502`/`504` y se reintentan | Sin reservas perdidas ni duplicadas | peor caso 4,9 s para un cliente |
| mysql-replica | Una espera de hasta 10,7 s (plazo semisíncrono) y luego replicación asíncrona | Las escrituras siguen; la réplica se pone al día | 12,2 s |
| aula-db, con 500 alumnos inscribiéndose (+1) | Aula en contingencia: catálogo desde el feed, inscripciones directo a la API | 10/490/0 duplicadas; aula-db = servicio | 12,1 s |
| Aula y aula-db (el servidor del tenant) | Los webhooks agotan los reintentos y van a la DLQ | Aula se reconstruye desde el feed | 16,9 s |
| mysql-primary (failover) | Escrituras `503` hasta la promoción (1,6 s) | **RPO = 0**: 0 de 300 admitidas y 0 de 21 confirmadas perdidas | **RTO 1,8 s** |

**Failover del primario.** El script termina el primario con SIGKILL y lo deja aislado (detenido, para que no vuelva como un segundo primario). Espera a que la réplica aplique todo lo recibido, la promueve y le pasa el alias de red `mysql-primary`. Los clientes no cambian su configuración: el nombre que usan resuelve ahora a la réplica, cuyo certificado también es válido para ese nombre. La replicación semisíncrona `AFTER_SYNC` garantiza que toda escritura confirmada al cliente ya estaba en la réplica, y lo verifica la prueba: ninguna reserva admitida ni confirmada antes de la caída falta después.

**Contingencia de Aula (escenario +1).** 500 alumnos se inscriben por Aula en una materia de 10 cupos y `aula-db` cae a mitad de la ráfaga. Aula sigue inscribiendo (las inscripciones van a la API, el catálogo sale del feed y el login no depende de PostgreSQL). Al volver, un ciclo aplica `/v1/cambios` desde su propio punto de control y la base de Aula termina igual al estado del servicio.

## Decisiones y límites

Respecto del plan de la Entrega 5 (issues #30 a #44):

- **Sesiones del lado del servidor en lugar de JWT.** Se pueden revocar: el logout y la desactivación de una persona tienen efecto inmediato, algo que un JWT no permite sin una lista de revocación.
- **Rol "administrador" en lugar de "docente".** Gestiona las inscripciones de todos, no solo materias. Un alumno que intenta ver una reserva ajena recibe `404` y no `403`: así no se entera de que existe.
- **Los permisos se aplican desde el contrato.** La API lee el `security` de cada operación en vez de tener una lista propia, así que el permiso documentado y el aplicado no pueden diferir.
- **TLS siempre, en un solo `docker-compose.yml`.** Un overlay opcional dejaba el compose base con Aula inutilizable y las pruebas de carga sin cifrar, y requería Compose 2.24.4 para `!override`.
- **El certificado de la réplica también vale para `mysql-primary`.** Sin eso, la verificación de identidad que exigen los clientes rompería el failover.
La matriz de fallos, Schemathesis y k6 (en el CI y en local) encontraron seis problemas que se corrigieron antes de esta ejecución:

- **Aula terminaba si `aula-db` caía con una conexión en uso.** La conexión tomada del pool emitía un error sin manejador; se perdían las sesiones y el alumno veía `401` en plena contingencia. Ahora la transacción registra la pérdida, falla la operación y descarta la conexión.
- **Sin plazos de Traefik hacia la API,** una solicitud en curso en una instancia caída esperaba indefinidamente. Ahora: 3 s para conectar y 15 s de respuesta, y el cliente reintenta.
- **El `/health` de la API se encolaba detrás del pool de MySQL** mientras el primario esperaba a la réplica, y Traefik sacaba de servicio a la única instancia. Ahora responde en 1 s como máximo.
- **La administración aceptaba `https://Ï` como `format: uri`** (modo rápido de validación de formatos). Ahora la API valida los formatos según su RFC.
- **Con `aula-db` caída, Aula intentaba la base en cada inscripción.** En el runner del CI, cientos de resoluciones del nombre de un contenedor detenido demoraban las llamadas a la API ("fetch failed"). Ahora, después de un fallo, Aula va directo a contingencia y el ciclo de reconciliación hace de sonda para detectar la vuelta de la base.
- **El límite de tasa se aplicaba después de buscar la clave en MySQL,** así que un tenant que inunda la API le costaba a la base una consulta por solicitud rechazada; con 1.800 solicitudes por segundo apareció una respuesta que no era `429`. Ahora, con el balde de esa clave vacío, el `429` se responde antes de consultar la base.

Límites declarados (detalle en el [informe de amenazas](amenazas.md#riesgos-que-quedan)): las contraseñas de la infraestructura siguen en el repositorio; no hay TLS mutuo; el límite de tasa y las sesiones de Aula son por instancia (pasan a Redis en la Entrega 6); el failover se ejecuta a pedido y volver a la topología con réplica requiere recrear el entorno.

## Cómo reproducir

Desde `reserva-cupos`, con Docker, Node.js 22 y OpenSSL:

```shell
docker compose down -v                      # si viene de otra entrega
node scripts/sistema.js preparar            # CA, certificados, identidades y clave del operador
node scripts/sistema.js levantar            # todo con TLS y la réplica configurada
node scripts/sistema.js seguridad           # suites de API, Aula y cifrado
node scripts/sistema.js fallos              # matriz completa; el failover va último
```

Las demás pruebas (Schemathesis, k6 y oasdiff) y el detalle de cada comando están en el [README de ejecución](../../reserva-cupos/README.md#pruebas) y en las [evidencias](evidencias/README.md).

## Texto de la certificación

Versión corta de cada celda de la columna *Justificación breve / evidencia*, para `Entrega5-Seguridad.pdf`:

1. **Autenticación de usuarios:** Login de personas en Aula (scrypt con sal), sesión del servidor en cookie HttpOnly/Secure, CSRF y bloqueo por fuerza bruta. Tenants y operador: claves de 256 bits. Ev. seguridad-aula/api.
2. **Autorización / control de acceso:** Aula: roles administrador y alumno; el alumno opera solo lo propio (403/404). API: permisos por clave del contrato (403), /admin solo del operador, aislamiento entre tenants (404) y límite de tasa (429). Ev. seguridad-aula/api, 05.
3. **Cifrado en tránsito:** TLS 1.2+ en todos los saltos, CA local y verificación de identidad: HTTPS (navegador, Traefik-API, webhooks), AMQPS, MySQL y su replicación, PostgreSQL. Texto plano rechazado; captura del tráfico. Ev. cifrado, captura-trafico.
4. **Replicación o recuperación probada:** Réplica semisíncrona y failover por script con una ráfaga en curso: RTO 1,8 s y RPO 0 (0 de 300 reservas perdidas). Matriz de 9 fallos con invariantes verificadas y contingencia de Aula con aula-db caída (escenario +1). Ev. fallos/resumen.
5. **Informe de amenazas:** docs/entrega-5/amenazas.md: activos y fronteras de confianza, amenazas STRIDE por flujo con su mitigación y evidencia, y los riesgos que quedan.

**Evidencia adicional (links):** informe de amenazas en `https://github.com/JoniMora/final-pdc/blob/v5-seguridad/docs/entrega-5/amenazas.md` y prueba de recuperación ante fallos en `https://github.com/JoniMora/final-pdc/blob/v5-seguridad/docs/entrega-5/evidencias/fallos/resumen.md`. Funcionan una vez publicado el tag `v5-seguridad`.
