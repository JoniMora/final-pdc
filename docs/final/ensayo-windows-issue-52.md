# Issue #52: ensayo Windows aprobado

Entorno: Windows, PowerShell en IntelliJ, Docker Desktop con almacenamiento en disco externo.
Fuente: salida de terminal aportada por la usuaria. No ejecutado por el agente.

## Arranque desde volúmenes vacíos

Comando: node scripts/sistema.js restaurar --confirmar --particiones 4
Resultado: completado en una ejecución, sin reintentar demo.

 ✔ Container reserva-cupos-infra-worker-p3-1 Removed                                     15.0s
 ✔ Container reserva-cupos-infra-worker-p2-1 Removed                                     12.8s
 ✔ Container reserva-cupos-infra-eventos-1   Removed                                      8.6s
 ✔ Container reserva-cupos-infra-worker-p1-1 Removed                                     15.9s
 ✔ Container reserva-cupos-infra-grafana-1   Removed                                     18.0s
 ✔ Container reserva-cupos-infra-canchas-1   Removed                                      8.4s
 ✔ Container reserva-cupos-infra-relay-1     Removed                                     11.0s
 ✔ Container reserva-cupos-infra-aula-1      Removed                                     19.4s
Réplica: canal configurado con TLS.
Réplica: conectada al primario por TLS y aplicando.
OK: Grafana termina de inicializar su base
Grafana: acceso del admin verificado por HTTPS; no hace falta cambiar la contraseña.
OK: la API responde por Traefik y ve MySQL
OK: Aula responde
OK: replicación semisincrónica activa
OK: 4 partición(es) de comandos enlazada(s)
OK: Prometheus recolecta todos sus destinos (9 destinos)
OK: tenant de la demo creado
OK: tenant de Canchas creado (límite 500/s)
OK: Canchas responde y lee su feed
OK: tenant de Eventos creado (límite 20/s)
OK: Eventos responde y lee su feed
Listo para la demo:

## Recorrido posterior

Comando: node pruebas/final/recorrido.js
Salida aportada por la usuaria después del arranque anterior:

OK: No se accede a materias sin sesión
OK: Administrador y alumno se autentican por HTTPS
OK: El alumno no puede crear materias
OK: El administrador crea una materia de un cupo
OK: La primera reserva se confirma y consume el cupo
OK: La segunda reserva se rechaza sin sobreasignar
OK: El alumno cancela su reserva y se devuelve el cupo
OK: El lugar liberado puede asignarse a otro participante
Recorrido final aprobado.

## Correcciones verificadas

- Margen de inicialización de ambos MySQL de 8 minutos y espera global de 1800 segundos.
- Diagnóstico de RabbitMQ como usuario rabbitmq, después de que exista la cookie.
- Grafana espera su base y verifica autenticación HTTPS antes de intentar sincronizar la contraseña.

Alcance: arranque y recorrido en Windows con volúmenes vacíos; certificados y credenciales existentes conservados. No certifica la generación desde una carpeta de seguridad vacía ni el ensayo completo de fallos de la demo.
