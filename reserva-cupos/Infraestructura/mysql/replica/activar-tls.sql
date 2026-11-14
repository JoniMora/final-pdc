-- Cambia solo el transporte del canal existente. Conserva GTID y datos.
STOP REPLICA;
CHANGE REPLICATION SOURCE TO
    SOURCE_SSL = 1,
    SOURCE_SSL_CA = '/tls/ca.crt',
    SOURCE_SSL_VERIFY_SERVER_CERT = 1;
START REPLICA;
