CREATE USER aula_app
    WITH PASSWORD 'aula_local_2026';

CREATE TABLE comprobaciones (
                                id UUID PRIMARY KEY,
                                texto VARCHAR(1000) NOT NULL,
                                creado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

GRANT CONNECT ON DATABASE aula TO aula_app;
GRANT USAGE ON SCHEMA public TO aula_app;
GRANT SELECT, INSERT ON TABLE comprobaciones TO aula_app;