# Continuar E6 sin copiar bloques largos

Todo quedo en `entrega-6-final`. No se crearon ramas, commits, tags ni
releases durante esta preparacion. Los cambios nuevos estan en el proyecto
local y tambien son visibles desde IntelliJ.

## Que esta comprobado

- Las corridas anteriores de N=1 y N=4 aprobaron 500 admisiones y el
  resultado 10 / 490 / 0. La idempotencia y el orden por actividad pasaron.
- La comparacion anterior a Redis midio 1,43x de mejora en procesamiento
  con varias actividades. No se presenta como una medicion del codigo nuevo.
- Durante esta preparacion pasaron **107 pruebas locales**. El registro
  esta en `evidencias/verificacion-local.json` y las salidas TAP en
  `evidencias/verificacion/`.
- Los archivos Compose, los scripts y el YAML de CI fueron validados
  sintacticamente. Eso no reemplaza levantar los contenedores.

## Primer comando al volver

Con Docker Desktop iniciado, desde `C:\Users\mcons\Documents\final-pdc`:

```powershell
node reserva-cupos/scripts/verificar-e6.js todo
```

Usar solo el entorno de desarrollo y no enviar reservas manualmente durante
la verificacion. El comando instala las dependencias desde los archivos lock,
ejecuta las pruebas locales y genera los certificados nuevos de Redis y del
receptor de pruebas, compila imagenes y ejecuta todo en secuencia. No borra
volumenes. Si detecta que la replica ya fue promovida a primario, se detiene
en vez de levantar dos primarios.

Si falla un paso, no volver a ejecutar toda la secuencia sin revisar su
archivo de error. El runner muestra la ruta y guarda lo realizado. Para
repetir solo un requisito:

```powershell
node reserva-cupos/scripts/verificar-e6.js circuito
node reserva-cupos/scripts/verificar-e6.js redis
node reserva-cupos/scripts/verificar-e6.js carga
node reserva-cupos/scripts/verificar-e6.js fallos
```

Los escenarios tienen limites de espera. No hay bucles de monitoreo que
deban cancelarse a mano ni claves que deban copiarse. El escenario de fallos
detiene deliberadamente una API y un worker y restaura los servicios al
terminar; no usarlo mientras otra persona usa esta misma instalacion.

## Lo que todavia NO esta validado

No hubo acceso al motor Docker en esta preparacion: la tuberia del motor rechazo
la conexion incluso con permiso de escritura al repositorio. Por eso no se
ejecutaron las nuevas integraciones de circuitos, Redis, multitenant, rampa
y fallos. No existen evidencias aprobadas de esas corridas hasta que se
ejecute el comando anterior o termine el nuevo job de CI.

Tambien faltan las capturas de los paneles nuevos de Grafana, grabar la
ejecucion de fallos como pide #50 y revisar los resultados de GitHub Actions.
Si los paneles no se actualizan en Grafana, se conserva el script existente
`scripts/recargar-grafana.js`, que usa las credenciales locales del usuario
sin guardarlas en Git. No se intento adivinar ni cambiar esa contraseña.

## Subir cambios separados

La lista exacta esta en `commits.json`. Para verla:

```powershell
node reserva-cupos/scripts/preparar-commit-e6.js --listar
```

Para preparar solo un grupo, por ejemplo el primero:

```powershell
node reserva-cupos/scripts/preparar-commit-e6.js 0
```

Ese comando exige la rama `entrega-6-final`, no permite mezclar un staging
anterior, agrega exclusivamente los archivos de ese grupo y ejecuta
`git diff --cached --check`. Muestra el comando de commit propuesto, pero
**no hace commit ni push**. Revisar el diff y ejecutar lo que muestra;
repetir con el grupo siguiente. No usar `git add .`.

Los archivos de diagnosticos fallidos anteriores se conservan sin agregar
automaticamente. Sirven para investigacion, no se presentan como pruebas
aprobadas. No se borraron ni purgaron los mensajes existentes en DLQ.

## Cierre y release

Solo despues de aprobar Docker y CI, revisar el PR con el compañero y
confirmar el cierre de la entrega 5 (#44). Completar las capturas, grabacion
y conclusiones, y luego crear la release `v6-escalabilidad` sobre el commit
aprobado. No mover tags publicados ni declarar cerrados #47-#51 por tener
el codigo preparado. La integracion final `v7-final` sigue siendo otra etapa.
