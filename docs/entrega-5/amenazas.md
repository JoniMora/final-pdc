# Informe corto de amenazas — Entrega 5

## Activos y fronteras

Se protegen credenciales de personas y tenant, sesiones, datos de inscripción,
cupos y proyección local. Fronteras: navegador/Aula, Aula/gateway/API,
procesos/broker y bases, notificador/receptor y host/volúmenes. El host y el
operador de Docker son de confianza; este entorno no resiste un administrador
del equipo comprometido.

| Amenaza | Control implementado | Evidencia prevista o prueba |
|---|---|---|
| Acceso sin identidad o contraseña incorrecta | scrypt con sal, sesión aleatoria y error uniforme. | Tests de seguridad y login por HTTPS. |
| Suplantar alumno o acceder a reserva ajena (IDOR) | Identidad de sesión, filtros y comprobación de propiedad en servidor. | Backend real con API simulada e integración de dos alumnos. |
| Escalada de privilegios | Rol leído del archivo de identidades, no del cuerpo; middleware administrador. | Alumno recibe 403 al crear materia. |
| Robo por script o fijación de sesión | Cookie HttpOnly/Secure/Strict; token nuevo al login; invalidación al logout y expiración. | Tests HTTP y validación de atributos de cookie. |
| CSRF | Token por sesión y control de Origin en escrituras. | Escritura sin token u origen ajeno rechazada. |
| Fuerza bruta y costo de derivación | Límite por IP y tamaño de contraseña; sin contraseñas en logs. | Tests 429 tras superar el límite. No cubre ataques distribuidos. |
| Espionaje/MITM en red | TLS por enlace con CA y comprobación de identidad. Servicios de datos rechazan tráfico plano. | Test TLS real positivo/negativo; integración por protocolo. |
| Falsificación o repetición de webhook | HMAC, ventana temporal y aplicación por versión, heredados de entrega 4; se añade HTTPS. | Tests existentes de firma y versión. |
| SSRF | Resolución validada y lista local de destinos permitidos, heredadas de entrega 4; HTTPS obligatorio. | Tests existentes del notificador. |
| Pérdida/duplicación durante caída | Outbox, ack tras commit, worker idempotente y feed con checkpoint transaccional. | Tests de rollback/repetición y recuperación en Docker. |
| Eventos atrasados o webhook fuera de orden | Upsert por versión y cursor independiente del feed. | Tests de aplicación y saltos legítimos. |
| Filtrar claves por Git | Directorio local ignorado y montaje solo de archivos requeridos. | git check-ignore y revisión del diff antes de publicar. |

## Amenazas residuales y límites

- El almacenamiento de identidades es un archivo administrado y protegido por
  los permisos del host, no un proveedor de identidad. No hay MFA, recuperación
  de contraseña ni autoservicio. Las contraseñas aleatorias de demostración se
  escriben en un archivo local ignorado que debe tratarse como secreto.
- Aula tiene una sola instancia y sesiones en memoria. Reiniciar invalida sesiones;
  el límite de login no es global. No se afirma defensa completa contra DoS.
- Los puertos se restringen a localhost, pero eso no autentica a otros usuarios
  del equipo. Las credenciales de infraestructura existentes son de desarrollo.
- Se autentica el servidor TLS; no hay certificados de cliente. La CA y las claves
  generadas son locales, sin rotación automática ni autoridad pública.
- El socket de Docker montado en Traefik es una frontera privilegiada: `:ro` en
  el montaje no equivale a filtrar las operaciones de la API del daemon.
- Todos los componentes comparten el usuario de RabbitMQ heredado de entrega 4.
  La autorización por proceso está separada en MySQL, no por vhost AMQP.
- Un solo host, failover MySQL manual y fallback semisíncrono a asíncrono por
  timeout. No se promete pérdida cero ante cualquier fallo ni recuperación de
  destrucción completa de volúmenes. Replicación y reconciliación no son backups.
- La API pública conserva su autenticación de tenant; los roles de personas se
  aplican en Aula. Un poseedor de la clave del tenant tiene autoridad sobre él.

## Estado

La corrida de integración del 14/11/2026 aprobó las 20 comprobaciones registradas
en evidencias/integracion.txt. Las pruebas locales y sus omisiones están documentadas
por separado. Los resultados corresponden a los escenarios probados, no a una
garantía de seguridad o recuperación ante todos los ataques y fallos posibles.
