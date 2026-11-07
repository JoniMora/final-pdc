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
