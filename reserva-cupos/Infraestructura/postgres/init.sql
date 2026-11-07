CREATE USER aula_app
    WITH PASSWORD 'aula_local_2026';

-- Modelo propio de Aula: cada materia referencia una actividad del servicio.
CREATE TABLE materias (
                          id UUID PRIMARY KEY,
                          actividad_id CHAR(36) NOT NULL UNIQUE,
                          nombre VARCHAR(200) NOT NULL,
                          cupo INTEGER NOT NULL,
                          creado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

GRANT CONNECT ON DATABASE aula TO aula_app;
GRANT USAGE ON SCHEMA public TO aula_app;
GRANT SELECT, INSERT ON TABLE materias TO aula_app;

-- Proyección local de las inscripciones, alimentada por las respuestas de
-- la API y por los webhooks. Una fila solo se actualiza con una versión
-- mayor: los eventos repetidos o atrasados no cambian nada.
CREATE TABLE inscripciones (
                               reserva_id CHAR(36) PRIMARY KEY,
                               actividad_id CHAR(36) NOT NULL,
                               alumno VARCHAR(128) NOT NULL,
                               estado VARCHAR(20) NOT NULL,
                               version BIGINT NOT NULL CHECK (version >= 1),
                               actualizado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX ix_inscripciones_actividad ON inscripciones (actividad_id, estado);

-- Última secuencia recibida por webhook. La reconciliación desde el feed
-- (Entrega 5) agrega su propio punto de control.
CREATE TABLE punto_control (
                               id SMALLINT PRIMARY KEY CHECK (id = 1),
                               ultima_secuencia_webhook BIGINT NOT NULL DEFAULT 0,
                               actualizado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO punto_control (id) VALUES (1);

GRANT SELECT, INSERT, UPDATE ON TABLE inscripciones TO aula_app;
GRANT SELECT, UPDATE ON TABLE punto_control TO aula_app;
