SET SESSION sql_log_bin = 0;

INSTALL PLUGIN rpl_semi_sync_replica
    SONAME 'semisync_replica.so';

SET PERSIST rpl_semi_sync_replica_enabled = ON;

-- Se aplicarán al arrancar el servidor definitivo,
-- después de completar su inicialización.
SET PERSIST_ONLY read_only = ON;
SET PERSIST_ONLY super_read_only = ON;

SET SESSION sql_log_bin = 1;