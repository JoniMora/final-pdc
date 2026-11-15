CREATE USER aula_app
    WITH PASSWORD 'aula_local_2026';

-- Modelo propio de Aula: cada materia referencia una actividad del servicio.
CREATE TABLE materias (
                          id UUID PRIMARY KEY,
                          actividad_id CHAR(36) NOT NULL UNIQUE,
                          nombre VARCHAR(200) NOT NULL,
                          cupo INTEGER NOT NULL,
                          -- Versión de la actividad: la reconciliación aplica solo
                          -- una instantánea más nueva (Entrega 5).
                          version BIGINT NOT NULL DEFAULT 0,
                          creado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

GRANT CONNECT ON DATABASE aula TO aula_app;
GRANT USAGE ON SCHEMA public TO aula_app;
GRANT SELECT, INSERT, UPDATE ON TABLE materias TO aula_app;

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

-- Puntos de control: la última secuencia recibida por webhook y la última
-- aplicada desde el feed. Son independientes: los webhooks pueden llegar
-- fuera de orden, así que su máximo no sirve para retomar el feed.
CREATE TABLE punto_control (
                               id SMALLINT PRIMARY KEY CHECK (id = 1),
                               ultima_secuencia_webhook BIGINT NOT NULL DEFAULT 0,
                               ultima_secuencia_feed BIGINT NOT NULL DEFAULT 0,
                               actualizado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO punto_control (id) VALUES (1);

GRANT SELECT, INSERT, UPDATE ON TABLE inscripciones TO aula_app;
GRANT SELECT, UPDATE ON TABLE punto_control TO aula_app;
