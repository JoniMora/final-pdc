# Evidencias de integración final

Ejecuciones locales del 14/11/2026. Los archivos registran resultados reales;
no equivalen a un ensayo oral ni al resultado del próximo CI.

| Archivo | Qué acredita |
|---|---|
| [01-recorrido.txt](01-recorrido.txt) | Ocho verificaciones del recorrido autenticado: permisos, cupo, rechazo, cancelación y reasignación. |
| [02-carga-escalado.txt](02-carga-escalado.txt) | Dos ráfagas de 500 solicitudes, con 1 API/1 worker y 3 API/2 workers; balanceo y restauración de instancias. |
| [03-seguridad-recuperacion.txt](03-seguridad-recuperacion.txt) | Veinte verificaciones de seguridad y recuperación, repetidas sobre la integración final. |

Para reproducirlas desde la raíz, con el entorno TLS preparado y levantado:

```powershell
node reserva-cupos/pruebas/final/recorrido.js
node reserva-cupos/pruebas/final/carga-escalado.js
node reserva-cupos/scripts/entrega5.js pruebas
Copy-Item -LiteralPath docs/entrega-5/evidencias/integracion.txt -Destination docs/entrega-6/evidencias/03-seguridad-recuperacion.txt
```

Ejecutar por separado y revisar cada resultado. Las pruebas crean datos de ensayo;
la de seguridad detiene temporalmente PostgreSQL y la de carga cambia el número
de instancias y lo restaura al terminar. No ejecutarlas durante una demo ajena.
No publicar accesos locales, claves de tenant ni claves privadas TLS.
