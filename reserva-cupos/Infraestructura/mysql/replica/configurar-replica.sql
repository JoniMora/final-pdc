-- Configura la réplica una vez por instalación (scripts/sistema.js lo hace
-- al levantar). Desde la Entrega 5 el canal va cifrado: el primario exige
-- TLS y la réplica verifica que su certificado sea de mysql-primary.
CHANGE REPLICATION SOURCE TO
    SOURCE_HOST = 'mysql-primary',
    SOURCE_PORT = 3306,
    SOURCE_USER = 'replicador',
    SOURCE_PASSWORD = 'replica_local_2026',
    SOURCE_AUTO_POSITION = 1,
    SOURCE_SSL = 1,
    SOURCE_SSL_CA = '/tls/ca.crt',
    SOURCE_SSL_VERIFY_SERVER_CERT = 1;

START REPLICA;
