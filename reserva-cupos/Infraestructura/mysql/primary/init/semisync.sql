-- La instalación del plugin es local a este servidor.
SET SESSION sql_log_bin = 0;

INSTALL PLUGIN rpl_semi_sync_source
    SONAME 'semisync_source.so';

SET PERSIST rpl_semi_sync_source_wait_point = 'AFTER_SYNC';
SET PERSIST rpl_semi_sync_source_wait_for_replica_count = 1;
SET PERSIST rpl_semi_sync_source_timeout = 10000;
SET PERSIST rpl_semi_sync_source_enabled = ON;

SET SESSION sql_log_bin = 1;