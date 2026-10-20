CREATE USER 'replicador'@'%'
    IDENTIFIED BY 'replica_local_2026';

GRANT REPLICATION SLAVE ON *.*
    TO 'replicador'@'%';


CREATE USER 'api_app'@'%'
    IDENTIFIED BY 'api_local_2026';

GRANT SELECT ON reservas.tenants
    TO 'api_app'@'%';

GRANT SELECT, INSERT ON reservas.actividades
    TO 'api_app'@'%';

GRANT UPDATE (nombre, estado, metadata, version)
      ON reservas.actividades
          TO 'api_app'@'%';

GRANT SELECT, INSERT ON reservas.reservas
    TO 'api_app'@'%';

GRANT SELECT, INSERT ON reservas.cambios
    TO 'api_app'@'%';


CREATE USER 'worker_app'@'%'
    IDENTIFIED BY 'worker_local_2026';

GRANT SELECT ON reservas.actividades
    TO 'worker_app'@'%';

GRANT UPDATE (cupos_disponibles, version)
      ON reservas.actividades
          TO 'worker_app'@'%';

GRANT SELECT ON reservas.reservas
    TO 'worker_app'@'%';

GRANT UPDATE (estado, version)
      ON reservas.reservas
          TO 'worker_app'@'%';

GRANT INSERT ON reservas.cambios
TO 'worker_app'@'%';


CREATE USER 'relay_app'@'%'
    IDENTIFIED BY 'relay_local_2026';

GRANT SELECT ON reservas.reservas
    TO 'relay_app'@'%';

GRANT SELECT ON reservas.cambios
    TO 'relay_app'@'%';

GRANT UPDATE (
          secuencia,
          publicado_comando,
          publicado_webhook
          )
      ON reservas.cambios
          TO 'relay_app'@'%';


CREATE USER 'notificador_app'@'%'
    IDENTIFIED BY 'notificador_local_2026';

GRANT SELECT ON reservas.tenants
    TO 'notificador_app'@'%';