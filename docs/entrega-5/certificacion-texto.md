# Texto para completar la plantilla de Entrega 5

Grupo: 15. Integrantes: Jonathan Mora Colodrero y María Constanza Gigli.
Versión de entrega: v5-seguridad (publicar el tag antes de entregar el enlace).
Fecha de las pruebas: 14/11/2026. Usar la fecha efectiva al entregar.

| Requisito | Cumple | Justificación |
|---|---|---|
| Autenticación de usuarios | Sí | Login con contraseña scrypt y sesión opaca; rechazo de contraseña incorrecta y logout probado. |
| Autorización/control de acceso | Sí | Administrador y alumno; controles del servidor impiden crear materias o suplantar, consultar y cancelar reservas ajenas. |
| Comunicación cifrada en tránsito | Sí | HTTPS, AMQPS, TLS en MySQL/PostgreSQL y canal de replicación; CA local y validación de certificados. Tráfico plano de bases rechazado. |
| Replicación o recuperación implementada y probada | Sí | Réplica MySQL activa con TLS y recuperación de Aula desde el feed después de detener PostgreSQL; reservas durante la caída y proyección recuperada. |
| Informe corto de amenazas | Sí | docs/entrega-5/amenazas.md: amenazas, controles, pruebas y límites residuales. |

Evidencias: docs/entrega-5/evidencias/integracion.txt (20 comprobaciones aprobadas)
y pruebas-locales.txt (49 aprobadas, 5 omitidas por Prism).

Enlace después de publicar la versión:
https://github.com/JoniMora/final-pdc/blob/v5-seguridad/docs/entrega-5/README.md

La nota y la sección de corrección corresponden al docente.
