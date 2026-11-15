# Evidencias previas — base anterior a las correcciones de E5

Estas ejecuciones del 14/11/2026 se conservan como antecedentes de la PR #59.
No corresponden a la integración local con `c1b2c3b` ni acreditan todos los
requerimientos de E6. No sobrescribirlas con resultados inventados.

- [01-recorrido.txt](01-recorrido.txt): recorrido autenticado previo.
- [02-carga-escalado.txt](02-carga-escalado.txt): 500 solicitudes/10 cupos en dos configuraciones; las métricas HTTP mezclan admisiones y consultas.
- [03-seguridad-recuperacion.txt](03-seguridad-recuperacion.txt): suite antigua de veinte comprobaciones, reemplazada por las suites de E5 corregida.

Para las nuevas ejecuciones usar `scripts/sistema.js seguridad` y los scripts
de `pruebas/final/`. Las nuevas pruebas deben registrar el commit y las métricas
de admisión, gráficos y escenarios exigidos por los issues #45 a #50.
