-- Migración repetible para volúmenes existentes; no borra registros.
BEGIN;
ALTER TABLE materias ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE punto_control ADD COLUMN IF NOT EXISTS ultima_secuencia_feed BIGINT NOT NULL DEFAULT 0;
GRANT UPDATE ON TABLE materias TO aula_app;
COMMIT;
