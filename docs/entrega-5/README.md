# Entrega 5 — Seguridad y confiabilidad

Programación Distribuida y Componentes · Grupo 15  
Jonathan Mora Colodrero y María Constanza Gigli  
Fecha de preparación: 14/11/2026 · Rama: `entrega-5-seguridad`  
Identificador de versión de esta entrega: `v5-seguridad`.

## Estado de verificación

La prueba de integración fue ejecutada por la integrante en Docker Desktop el
14/11/2026 y terminó con **20 comprobaciones aprobadas**, incluidas recuperación
de PostgreSQL, controles de acceso y replicación con TLS. Su salida real quedó
guardada en [integracion.txt](evidencias/integracion.txt), con `Resultado: APROBADA`.

Las pruebas locales registraron **49 aprobadas, 0 fallidas y 5 omitidas** por no
estar configurado el mock Prism. También se validaron Compose y los certificados.
Estas comprobaciones no equivalen a una auditoría de seguridad ni garantizan
recuperación ante cualquier fallo; los límites están en el informe de amenazas.

## Correspondencia con la plantilla

| Requisito | Implementación | Comprobación |
|---|---|---|
| Autenticación de usuarios | Usuarios locales de Aula; contraseñas scrypt con sal aleatoria; sesiones opacas de 256 bits. | Login correcto/incorrecto, expiración, logout y backend real con API simulada. |
| Autorización | Administrador crea materias y gestiona reservas. Alumno opera solo sobre su participante. Controles en servidor. | 401 sin sesión, 403 por rol/suplantación/CSRF y 404 ante reserva ajena. |
| Cifrado en tránsito | Overlay TLS para HTTPS, AMQPS, MySQL, PostgreSQL y replicación. CA local y verificación de identidad. | TLS local positivo/negativo y comprobaciones de protocolos en integración Docker aprobadas. |
| Recuperación probada | Réplica existente y reconciliación transaccional del feed hacia PostgreSQL. | Pruebas locales de checkpoint/rollback; prueba de caída, continuidad y recuperación en integración Docker. |
| Informe de amenazas | [Informe de amenazas](amenazas.md). | Alcance, controles, pruebas y limitaciones declaradas. |

## Identidades y controles de acceso

La clave del tenant identifica a Aula frente al servicio y nunca se entrega al
navegador. No sustituye el login de personas. Las identidades de Aula se guardan
en `seguridad/local/usuarios.json`, un archivo generado y montado como solo lectura,
independiente de PostgreSQL para permitir autenticación durante su caída. Solo
contiene hashes, roles e identificadores; no contraseñas originales.

La preparación genera `admin`, `alumno1` y `alumno2`, con contraseñas aleatorias.
El archivo de accesos en texto claro es solo para la demostración local y está
excluido de Git. Se debe proteger en el equipo y no adjuntarlo a las evidencias.
El operador puede administrar las identidades en ese archivo generando hashes
mediante `hashPassword` del módulo de seguridad; no existe alta pública.

Las sesiones duran una hora, se mantienen en memoria en una sola instancia de
Aula y se pierden al reiniciar el proceso (se debe volver a iniciar sesión).
El servidor vuelve a leer el usuario en cada petición: desactivarlo o cambiar
su rol afecta las sesiones existentes. Cookie HttpOnly, Secure y SameSite=Strict;
las escrituras también exigen token CSRF y validan Origin si está presente.
Diez intentos de login por IP en quince minutos limitan el trabajo de scrypt.
Este límite es por instancia, no distribuido.

Un alumno no puede elegir otro participante en el cuerpo, consultar o cancelar
su reserva ni obtener sus nombres en el listado. Un administrador sí puede
gestionar las inscripciones del tenant. El listado de detalle conserva la
paginación de la API y no debe interpretarse como una exportación completa.

## Cifrado y límites de confianza

Se utiliza `docker-compose.yml` más `docker-compose.seguridad.yml`. El compose
base queda como referencia de la entrega 4; por sí solo no acredita seguridad.

| Enlace de red | Protección |
|---|---|
| Navegador → Aula | HTTPS directo, certificado de Aula. |
| Cliente/API y Aula → Traefik | HTTPS, certificado del gateway y CA confiable. |
| Traefik → instancias API | HTTPS con CA y nombre de servidor `api`; no termina el cifrado en el gateway. |
| Notificador → Aula | HTTPS obligatorio además de HMAC; CA local en Node. |
| Relay/worker/notificador → RabbitMQ | AMQPS 5671 con CA y nombre; listener AMQP sin TLS deshabilitado. |
| Procesos → MySQL | CA, verificación de identidad y require_secure_transport. |
| Réplica → primario | SOURCE_SSL y verificación del certificado del origen. |
| Aula → PostgreSQL | TLS con CA y nombre; pg_hba rechaza conexiones de red sin cifrar. |

La administración por socket local dentro de cada contenedor no es tráfico entre
componentes de red. No se implementa mTLS: el servidor se autentica con certificado
y el cliente con las credenciales correspondientes. La CA y claves son solo de
desarrollo; no se instalan silenciosamente en la confianza del sistema operativo.
No se monta la clave privada de la CA en ningún contenedor. El panel inseguro de
Traefik deja de publicarse en el overlay. La administración RabbitMQ publicada usa HTTPS; su listener HTTP se restringe a 127.0.0.1 dentro del contenedor, sin acceso desde otros componentes.

## Contingencia y reconciliación

Ante caída de PostgreSQL, las sesiones y el catálogo reconstruido desde el feed
permiten seguir consultando y solicitando reservas mediante la API. No se admite
si también falla MySQL o la API; se informa la indisponibilidad.

Al volver PostgreSQL, un ciclo periódico lee `/v1/cambios` desde
`ultima_secuencia_feed`, aplica las actividades de Aula y las reservas por versión,
y confirma datos y cursor en una misma transacción. Si falla, hace rollback y
repite desde el cursor anterior. La clave única y el control de versión toleran
repeticiones y eventos atrasados.

El máximo recibido por webhook no es el checkpoint del feed: los webhooks pueden
llegar fuera de orden. Un tenant también puede observar saltos legítimos de
secuencia porque el contador es global. Una página se valida como creciente,
no como consecutiva. Hay límites de lotes por ciclo para no bloquear el proceso;
la recuperación de un historial grande requiere varios ciclos.

## Ejecutar desde PowerShell o terminal de IntelliJ

Desde la raíz `final-pdc` (Docker Desktop abierto, Node 22+, Git/OpenSSL y Compose
2.24.4 o posterior):

```powershell
node reserva-cupos/scripts/entrega5.js preparar
node reserva-cupos/scripts/entrega5.js levantar
node reserva-cupos/scripts/entrega5.js migrar
node reserva-cupos/scripts/entrega5.js estado
node reserva-cupos/scripts/entrega5.js pruebas
```

Cada comando debe terminar sin errores antes de ejecutar el siguiente. La preparación
es repetible y no reemplaza certificados o credenciales existentes. La migración
agrega columnas sin borrar datos y modifica solo el transporte de la réplica y
la URL del tenant local de Aula. Para quien venga de entrega 2 se deben aplicar
primero las migraciones de tablas/tenant/índices hacia entrega 4; no basta este paso.

Abrir `https://localhost:3001`. Las contraseñas están en
`reserva-cupos/seguridad/local/accesos-locales.txt`. Para un navegador sin avisos,
confiar explícitamente en `ca.crt` mediante el administrador de certificados del
equipo (solo esta CA de desarrollo). Las pruebas usan esa CA directamente, sin
`-k` ni desactivar validación. No compartir su clave privada.

El script de pruebas crea una materia de prueba, verifica roles y propiedad,
retira únicamente la proyección de esa materia para probar reconstrucción,
detiene PostgreSQL, solicita otra reserva y lo vuelve a iniciar en un bloque
finally. No borra volúmenes. Ejecutarlo fuera de una demostración en uso.
El resultado se guarda en `evidencias/integracion.txt` con estado aprobado o fallido.

Para detener sin borrar:

```powershell
node reserva-cupos/scripts/entrega5.js detener
```

## Archivos principales

- `clientes/aula/src/seguridad.js`: hashes, sesiones, CSRF, rate limit y roles.
- `clientes/aula/src/recuperacion.js`: catálogo de contingencia y aplicación del feed.
- `Infraestructura/postgres/entrega5.sql`: migración repetible para bases actuales.
- `scripts/preparar-seguridad.js`: CA, certificados por servicio y usuarios locales.
- `docker-compose.seguridad.yml`: conexiones cifradas y montaje mínimo de claves.
- `pruebas/seguridad/integracion.js`: prueba funcional y de recuperación en Docker.
- Tests de Aula y `pruebas/seguridad/tls.test.js`: comprobaciones locales.

## Cierre de entrega

La recuperación en Docker está comprobada en la evidencia de integración.
Completar Grupo 15, fecha efectiva y enlace al informe en la plantilla del profesor;
el docente completa nota y corrección.
Finalmente hacer commit, push y crear un tag de entrega tras revisar los cambios.

