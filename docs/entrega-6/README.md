# Entrega 6 — Patrones y escalabilidad (en preparación)

Grupo 15: Jonathan Mora Colodrero y María Constanza Gigli.

## Base de trabajo

La rama `entrega-6-final` integra la entrega 5 corregida
(commit `c1b2c3b` de la PR #58) con los avances de la PR #59. Es una
integración local para revisión, no un merge de GitHub ni una entrega aprobada.

La E6 corresponde a patrones y escalabilidad; la integración final se cierra
por separado. Versiones previstas: `v6-escalabilidad` y `v7-final`.
Ver [revisión del PR #59](https://github.com/JoniMora/final-pdc/pull/59).

## Requerimientos y validacion

| Issue | Trabajo | Estado en esta integración |
|---|---|---|
| [#45](https://github.com/JoniMora/final-pdc/issues/45) | Métricas, Prometheus y Grafana | Base verificada; nuevos paneles y scraping de todos los workers preparados para validar |
| [#46](https://github.com/JoniMora/final-pdc/issues/46) | Particionado por actividad y pruebas N=1/4 | Criterios comprobados localmente; pendiente CI y revision. Ver [resultados](particionado.md) |
| [#47](https://github.com/JoniMora/final-pdc/issues/47) | Circuit Breaker por tenant en el notificador | Integracion Docker y Aula real aprobadas: ciclo completo y once entregas recuperadas. [Detalle](circuit-breaker.md) |
| [#48](https://github.com/JoniMora/final-pdc/issues/48) | Redis, límite global, caché y curva 1/2/4 API | Redis real, invalidacion, curva de lecturas y curva POST repetida aprobados en Docker. [Detalle](redis.md) |
| [#49](https://github.com/JoniMora/final-pdc/issues/49) | Escenarios k6, métricas de admisión y gráficos | Caliente, multitenant y rampa aprobados; reportes HTML generados. Capturas pendientes. [Detalle](carga.md) |
| [#50](https://github.com/JoniMora/final-pdc/issues/50) | Fallos parciales bajo carga con gráficos | Ejecucion Docker aprobada; invariantes y grafico registrados. Grabacion enlazada; pendiente revision del contenido y acceso. [Detalle](fallos-bajo-carga.md) |
| [#51](https://github.com/JoniMora/final-pdc/issues/51) | Documento de patrones, evidencias y release | Evidencias locales revisadas; falta CI completo, capturas, grabacion, revision y release |

El orden de asignación debe confirmarse en el Project. Las dependencias están
expresadas en cada issue. No se cierra un issue por haber agregado documentación
si faltan sus pruebas y criterios de aceptación.

## Documento de patrones

Ver [problema, patrón, código y evidencia](patrones.md). Este aporte documental
no cierra #51 por si solo. Ver [resultados y pendientes de cierre](cierre-validacion.md).

## Avances conservados

- Recorrido funcional HTTPS en `pruebas/final/recorrido.js`.
- La prueba preliminar de escalado ahora delega en la curva 1/2/4 APIs con
  Redis. No se levantan dos consumidores de una misma particion.
- Control de respuestas HTTP y JSON en la ráfaga de k6.
- Pool MySQL exclusivo para salud, usando las opciones TLS compartidas de E5.
- Corrección de la carrera del feed trasladada a `pruebas/seguridad/aula.js`:
  esperar la inscripción persistida, no únicamente modo normal.

El tenant de carga se crea ahora mediante `scripts/sistema.js tenant`, con
límite alto, sin SQL de alta ni contraseña root escrita en ese script.
El Compose base usa TLS y Redis. Los archivos adicionales seleccionan
cuatro particiones y los receptores o reintentos especificos de pruebas.

## Continuar la verificacion

Ver [pasos pendientes y comandos por requisito](continuar.md). La verificacion
local ejecutada durante esta preparacion aprobo **107 pruebas**. Eso no
publica una release. Ademas, el 17/11/2026 aprobaron por separado circuito,
Redis, carga caliente, multitenant, rampa y fallos en Docker; ver
[indice de evidencias](evidencias/README.md). La primera ejecucion de `todo`
fallo y no se presenta como una corrida completa aprobada.

```powershell
node reserva-cupos/scripts/verificar-e6.js todo
```

El comando conserva datos, termina al primer error y deja un archivo con
su causa. Las pruebas de fallos restauran los servicios que detienen; no
se usan borrados de volumenes en el entorno local.

## Uso actual

Seguir [el README de la aplicación](../../reserva-cupos/README.md) y la
[entrega 5 corregida](../entrega-5/README.md). Desde la raíz:

```powershell
node reserva-cupos/scripts/sistema.js preparar
node reserva-cupos/scripts/sistema.js levantar
node reserva-cupos/scripts/sistema.js seguridad
```

La base corregida cambia la inicialización de las bases. Si una instalación
proviene de la versión antigua, revisar la instrucción de volúmenes nuevos del
README de E5 y respaldar antes los datos que se deseen conservar. La integración
local de Git no ha borrado volúmenes ni migrado el Docker de los integrantes.

## Evidencias y material adelantado

Las [evidencias del 14/11](evidencias/README.md) pertenecen a la base anterior.
Se conservan como antecedentes y deben repetirse con la base corregida antes de
acreditar esta versión. No demuestran cumplimiento de todos los issues de E6.

El [guion de demo](demo.md) y la [guía de defensa](defensa.md) son borradores
adelantados del cierre final; requieren actualización al terminar los issues.
La certificación final está pendiente; no se declara E6 completa.
