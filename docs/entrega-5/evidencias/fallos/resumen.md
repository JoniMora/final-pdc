# Matriz de fallos — resumen

Ejecución: 2026-11-15T00:23:50.229Z · `node pruebas/fallos/matriz.js`

| Componente | Efecto observado | Garantía verificada | Recuperación | Resultado | Detalle |
|---|---|---|---|---|---|
| worker | Admisión con 202; decisiones en espera (194 pendientes) | Comandos durables en RabbitMQ; 10 confirmadas, 0 duplicadas | 7.2 s | Aprobado | [worker.txt](worker.txt) |
| relay | Admisión con 202; los comandos quedan en el outbox (178 pendientes) | Outbox transaccional; nada se pierde al volver | 7.1 s | Aprobado | [relay.txt](relay.txt) |
| rabbitmq | Admisión con 202; relay, worker y notificador se reinician hasta reconectar (195 pendientes) | Outbox y colas durables; 10 confirmadas, 0 duplicadas | 19.7 s | Aprobado | [rabbitmq.txt](rabbitmq.txt) |
| notificador | Decisiones sin demora; 100 webhooks esperan en la cola | Webhooks entregados al volver; proyección de Aula = servicio | 2.7 s | Aprobado | [notificador.txt](notificador.txt) |
| api | Solicitudes en curso en la instancia caída: 502/504 (502×17, 504×10); el resto, atendido por la otra | Sin reservas perdidas ni duplicadas (reintento idempotente) | peor caso 4.9 s para un cliente | Aprobado | [api.txt](api.txt) |
| mysql-replica | Una espera de hasta 10.7 s (timeout semisíncrono) y luego replicación asíncrona | Escrituras confirmadas; la réplica se pone al día al volver | 12.2 s | Aprobado | [mysql-replica.txt](mysql-replica.txt) |
| aula-db | Aula en contingencia: catálogo desde el feed, inscripciones directo a la API | 10/490/0 duplicadas; aula-db = servicio tras reconciliar | 12.1 s | Aprobado | [aula-db.txt](aula-db.txt) |
| tenant | Webhooks agotan reintentos y van a webhooks.dlq | Aula reconstruida desde el feed; nada perdido | 16.9 s | Aprobado | [tenant.txt](tenant.txt) |
| mysql-primary | Escrituras rechazadas (503) hasta la promoción; 54 reintentos del cliente | RPO = 0 (300 admitidas, 21 confirmadas antes de la caída, ninguna perdida) | RTO 1.8 s | Aprobado | [mysql-primary.txt](mysql-primary.txt) |
