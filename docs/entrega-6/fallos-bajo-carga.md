# Fallos parciales bajo carga — #50

Estado: prueba automatica preparada, sin ejecutar en Docker. La grabacion
de la ejecucion y las evidencias resultantes estan pendientes. No se declara
cerrado el issue.

```powershell
node reserva-cupos/scripts/verificar-e6.js fallos
```

La prueba requiere el entorno de cuatro particiones actualizado y sin
reservas ni comandos pendientes de una corrida anterior. Realiza lo siguiente:

1. Escala la API a cuatro instancias y crea un tenant de prueba.
2. Inicia una rafaga k6 de 500 solicitudes para 10 cupos.
3. Espera una marca emitida al comenzar la carga real y detiene una API.
4. Detecta la cola que tiene comandos de esa actividad y detiene su worker.
5. Tras tres segundos reinicia el worker y la API.
6. Espera el resultado de k6 y comprueba MySQL: 10 confirmadas, 490
   rechazadas, cero pendientes, cero participantes duplicados y cupos no
   negativos.
7. Exporta las series de Prometheus y un HTML con marcas temporales de
   detencion y recuperacion. Restaura el numero inicial de APIs en `finally`.

La API cliente reintenta errores de red, 429, 502, 503 y 504 con exactamente
la misma `Idempotency-Key` y cuerpo. Un reintento puede responder 200 si la
primera escritura ya estaba confirmada: no es una reserva adicional.
La prueba normal sin fallos sigue exigiendo 202 en todas las admisiones.

Durante esta prueba, `docker-compose.fallos-e6.yml` agrega a Traefik
reintentos de transporte solo al POST de admision de reserva,
que exige clave de idempotencia. No se agregan reintentos automaticos a
altas de actividades, tenants o rotaciones, porque no son idempotentes.
Los errores HTTP siguen siendo tratados por el cliente k6: el middleware
de retry de Traefik no se usa como sustituto de esa logica.

El consumidor es exclusivo por particion, con prefetch uno y ack despues
del commit. Al morir el worker, RabbitMQ reentrega lo no confirmado y la
logica idempotente del worker evita descontar el cupo otra vez. No se cambia
la declaracion de las colas existentes, evitando un error de argumentos
incompatibles al actualizar una instalacion con volumenes.

Archivos que se generaran en `evidencias/fallos-bajo-carga/`:

- `k6.txt`: salida capturada de la carga.
- `resultado.json`: invariantes, instantes de fallo y series de Prometheus.
- `informe.html`: grafico con lineas de fallo y recuperacion.

No se ejecuta esta falla en la demo en vivo. Todavia hay que ejecutar y
grabar el escenario y revisar el grafico. Un archivo de codigo o un reporte
vacio no constituyen evidencia de aceptacion.
