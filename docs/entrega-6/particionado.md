# Comandos particionados por actividad — #46

**Problema.** Con una sola cola de comandos, todas las actividades esperan detrás de la más demandada; y varios workers sobre la misma cola reparten los comandos de una actividad entre sí, sin orden.

**Patrón.** *Competing consumers* con particiones por clave: N colas detrás de un exchange de hash consistente (`x-consistent-hash`) cuya clave de enrutamiento es el `actividad_id`. Cada actividad cae siempre en la misma partición y cada partición tiene un único worker, así que las actividades se procesan en paralelo y cada una conserva su orden.

## Implementación

- `compartido/src/particiones.js` valida `COMANDOS_PARTICIONES` (1 a 32) y `WORKER_PARTICION`, y nombra las colas `reservas.comandos.0` a `N-1`.
- `servicios/relay/src/configurar-colas.js` declara las N colas y las enlaza al exchange con el mismo peso. Si encuentra colas de una configuración anterior con más particiones (por ejemplo, al bajar de 4 a 1), las desenlaza y reenvía sus comandos pendientes al exchange, que los manda a la partición que ahora les corresponde. Corre antes de que el relay publique, así que esos comandos quedan delante de los nuevos de su actividad.
- `servicios/worker/src/main.js` consume su partición como **consumidor exclusivo** (`exclusive: true`): un segundo worker sobre la misma cola es rechazado. `prefetch(1)` y `ack` después del commit.
- El relay barre las N colas para republicar pendientes.
- `docker-compose.particiones.yml` levanta cuatro particiones (`worker`, `worker-p1`, `worker-p2` y `worker-p3`). El Compose base usa una.
- El contrato AsyncAPI 1.1.0 describe las N particiones y el consumidor exclusivo.

## N=1 frente a N=4

`node pruebas/final/particiones.js <N>`: 8 actividades de 10 cupos, 40 reservas por actividad (320 en total), 64 conexiones. Antes de cargar, verifica los enlaces (exactamente N, todos con peso 1) y que cada partición tenga un solo consumidor. Mide desde la primera admisión hasta que las 320 reservas están decididas. Las dos corridas usan el mismo código, el mismo equipo y la misma sesión.

| Particiones | Tiempo hasta decidir las 320 | Decisiones/s | p95 de admisión del cliente | Resultado |
|---:|---:|---:|---:|---|
| 1 | 11,15 s | 28,69 | 4744 ms | 10 confirmadas y 30 rechazadas en cada actividad |
| 4 | 9,70 s | 32,98 | 4757 ms | 10 confirmadas y 30 rechazadas en cada actividad |

Con cuatro particiones, las 320 reservas se deciden en 9,7 s contra 11,2 s con una: 33 contra 29 decisiones por segundo (1,15 veces). La mejora es chica porque la mitad del tiempo es la admisión, que dura lo mismo en las dos (4,9 y 4,8 s) porque la limita el commit del primario. Después de la última admisión, con cuatro particiones las decisiones terminan en 4,8 s y con una en 6,3 s: ahí está la ganancia del paralelismo entre actividades. Es una corrida por configuración, así que muestra la tendencia, no un factor de escala.

[N=1](evidencias/multi-particiones-n1.json) · [N=4](evidencias/multi-particiones-n4.json) · [colas en Grafana](evidencias/23-colas-rabbitmq.png)

## Orden por actividad

Para cada actividad, la prueba compara el orden de los comandos en el outbox con el de las decisiones persistidas, y exige que las primeras 10 sean las confirmadas. Las 8 actividades conservaron el orden con N=1 y con N=4.

El orden es por actividad, no global: dos actividades en particiones distintas se deciden en paralelo.

## Bajar de 4 a 1 partición

`node pruebas/final/reducir-particiones.js`: con cuatro particiones, detiene los workers de las particiones 1 a 3, admite 40 reservas en 8 actividades (los comandos de las actividades que caen en esas particiones quedan esperando) y recrea el relay con una partición. [Resultado](evidencias/particiones-reduccion.json):

- 35 de los 40 comandos quedaron esperando en las colas 1 (15) y 2 (20); la 3 no tenía.
- Al arrancar con una partición, el relay desenlazó las colas 1 a 3 y reenvió exactamente esos 35 comandos al exchange, una vez cada uno.
- Solo quedó enlazada `reservas.comandos.0`, y su worker confirmó las 40 reservas: ningún comando quedó varado.

La primera corrida de esta prueba encontró que, vaciando las colas de a una, los comandos de la cola 1 caían en la 2 o la 3, todavía enlazadas, y se volvían a mover (60 reenvíos para 35 comandos). Ahora el relay desenlaza todas antes de vaciarlas.

## Idempotencia con cuatro particiones

`node scripts/diagnosticar-carga.js --duplicados`: 20 pedidos simultáneos con la misma `Idempotency-Key` dan un `202` y 19 `200`; 20 del mismo participante con claves distintas, un `202` y 19 `409`; quedan exactamente 2 reservas. [k6](evidencias/diagnostico-2026-11-20T04-43-47-531Z/k6.txt)

## Límites

- Cambiar N con tráfico en curso puede desordenar una actividad mientras dura el cambio: sus comandos viejos siguen en la cola anterior y los nuevos van a la nueva. Se cambia con la carga detenida.
- Todas las particiones comparten el primario: más particiones aceleran las decisiones mientras el worker sea el cuello, no la admisión (ver [carga](carga.md#por-qué-más-api-no-admiten-más)).
- Una actividad muy demandada sigue en una sola partición: el particionado reparte actividades, no la carga de una.
