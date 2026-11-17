# Particionado por actividad — issue #46

Rama: `entrega-6-final`. Estado: criterios comprobados localmente; pendiente
de CI y revision del PR. Este informe no declara terminada toda la entrega 6.

## Implementacion

- `compartido/src/particiones.js` valida cantidad e indice de particion.
- El relay declara N colas `reservas.comandos.0` a `N-1`, enlazadas con peso
  uno al exchange de hash consistente `reservas.comandos`.
- La clave de enrutamiento es `actividad_id`: con topologia estable, todos
  los comandos de una actividad van a la misma cola.
- Cada worker consume su `WORKER_PARTICION`, con prefetch uno y confirmacion
  despues del commit. El barrido del relay revisa las N colas.
- `docker-compose.particiones.yml` configura cuatro workers separados.
  El Compose base configura uno. No se usa `--scale worker=4`.
- El secuenciador selecciona primero IDs de cambios confirmados y actualiza
  ese lote, sin el antiguo UPDATE con seleccion de pendientes incorporada.
- La API admite lotes de hasta 50 reservas mediante dos INSERT masivos en
  una transaccion: reservas y outbox. Solo responde despues del commit. Ante
  un lote fallido vuelve al procesamiento individual para aislar errores.

## Resultados de las ejecuciones

### Una actividad, 500 solicitudes y 10 cupos

| Particiones | Admisiones 202 | Confirmadas | Rechazadas | Pendientes | Cupos | p95 admision |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 500 | 10 | 490 | 0 | 0 | 7,43 s |
| 4 | 500 | 10 | 490 | 0 | 0 | 3,96 s |

Ambas ejecuciones de k6 terminaron con codigo cero y todos los checks
aprobados. Evidencias:

- [N=1](evidencias/diagnostico-2026-11-17T04-07-12-393Z/k6.txt).
- [N=4](evidencias/diagnostico-2026-11-17T03-55-55-916Z/k6.txt).
- [Idempotencia concurrente](evidencias/diagnostico-2026-11-17T03-58-42-009Z/k6.txt):
  misma clave, una admision y 19 repeticiones; mismo participante con claves
  distintas, una admision y 19 conflictos. Exactamente dos reservas.

Una actividad usa una sola particion. Estos tiempos aislados no prueban
escalabilidad ni una mejora general de latencia.

### Ocho actividades simultaneas

La misma prueba envia 40 reservas por actividad: 320 solicitudes, 10 cupos
por actividad y un maximo de 64 conexiones HTTPS del cliente.

| Particiones | Tiempo hasta completar decisiones | Decisiones/s | p95 admision cliente |
|---|---:|---:|---:|
| 1 | 67,80 s | 4,72 | 2.989 ms |
| 4 | 47,46 s | 6,74 | 5.218 ms |

Mejora observada de throughput: **1,43x**. Todas las admisiones respondieron
202 y cada actividad termino con 10 confirmadas, 30 rechazadas y cero cupos.
El throughput se calcula desde el inicio de las admisiones hasta observar
todas las decisiones persistidas; incluye la espera del procesamiento.
El p95 cliente incluye la espera de conexiones del generador y no debe
confundirse con el histograma interno de la API ni con el de k6.

La latencia de admision empeoro en N=4 en esta comparacion. Son dos
ejecuciones en la misma instalacion local, no un benchmark con repeticiones
ni intervalos de confianza. No se demuestra crecimiento lineal: los workers
comparten MySQL, almacenamiento y replicacion semisincrona.

Evidencia estructurada: [N=1](evidencias/multi-particiones-n1.json) y
[N=4](evidencias/multi-particiones-n4.json).

## Verificacion de orden

`pruebas/final/particiones.js` verifica enlaces, pesos y exactamente un
consumidor por particion antes de generar carga. Para cada actividad compara
el orden de IDs de reserva en comandos del outbox con el de sus decisiones
persistidas y verifica que las primeras diez sean confirmadas.

Las ocho actividades conservaron ese orden tanto en N=1 como en N=4.
El orden medido es el de registro en outbox, no el reloj de envio de clientes
independientes. La prueba usa topologia estable, sin cambios de particion ni
fallos inyectados; no acredita por si sola el requisito de fallos #50.

## Ejecucion y cambios de topologia

Con el entorno correspondiente ya iniciado:

```powershell
node reserva-cupos/scripts/diagnosticar-carga.js --una
node reserva-cupos/scripts/diagnosticar-carga.js
node reserva-cupos/scripts/diagnosticar-carga.js --duplicados
node reserva-cupos/pruebas/final/particiones.js 1
node reserva-cupos/pruebas/final/particiones.js 4
```

No ejecutar los escenarios simultaneamente. Para cambiar N hay que pausar
productores, drenar reservas pendientes, outbox y colas de comandos, detener
relay y workers, y ajustar enlaces antes de reanudar entradas. Al volver a
N=1 hay que retirar los enlaces 1 a 3; solo detener esos workers dejaria
mensajes en sus colas. Las colas y los volumenes no se eliminan.

Los mensajes existentes en `webhooks.dlq` se conservan y se investigan por
separado: no se purgan para conseguir que la prueba aparezca aprobada.
