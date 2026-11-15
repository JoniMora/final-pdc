# Paso inicial: integrar la base corregida de E5

Fecha: 15/11/2026. Preparación local, sin publicación ni merge remoto.

- Rama original preservada: `entrega-6-final`, commit `36844c1`.
- Base incorporada: `origin/entrega-5-seguridad`, commit `c1b2c3b`.
- Rama de revisión local: `codex/integrar-base-e5`.
- Se preservan los commits de ambos integrantes mediante merge local, sin rebase ni force-push.

## Resolución de conflictos

- README raíz y de aplicación: se conserva la documentación de E5 corregida y se enlaza E6 como pendiente.
- CI: se conserva la suite nueva y la matriz de fallos; recorrido y escalado corren antes del failover, que cambia la topología.
- API: se conservan permisos, administración, límite de tasa y validación nuevos; el pool de salud independiente usa el helper TLS compartido.
- La suite antigua de seguridad y su evidencia E5 eliminadas por la PR #58 no se restauran. La corrección de espera se traslada a `pruebas/seguridad/aula.js`.
- La carga usa el compose único y crea tenants por administración, con límite alto; no utiliza el SQL de alta retirado.
- Las evidencias antiguas de E6 se conservan como antecedentes, no como ejecución de esta integración.

## Validación local

- Sintaxis de API, recorrido, carga y suite Aula: correcta.
- Compose y YAML del CI: válidos.
- API: 12 pruebas aprobadas.
- Aula: 21 aprobadas, 5 omitidas (requieren Prism), ninguna fallida.
- Los avisos de whitespace del diff completo provienen de evidencias y archivos incorporados desde E5; se conserva la salida original.

No se ejecutó aquí el recorrido Docker, carga ni matriz de fallos de la versión integrada.
No se borraron volúmenes ni se modificaron certificados locales.

## Antes de publicar

Coordinar el cierre del PR #58. Después, revisar esta integración y actualizar
el PR #59 conforme al flujo acordado. No mergear ni publicar un tag de E6 como
si los issues #45 a #51 estuvieran completos. El Project determina responsables
y orden de ejecución. El próximo requerimiento técnico se trata por separado.
