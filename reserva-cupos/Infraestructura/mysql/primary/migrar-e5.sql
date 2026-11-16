USE reservas;

-- Agrega permisos y límites conservando los tenants existentes.
ALTER TABLE tenants
    ADD COLUMN scopes SET(
        'actividades:escribir',
        'reservas:escribir',
        'lectura',
        'cambios:leer'
    ) NOT NULL DEFAULT
        'actividades:escribir,reservas:escribir,lectura,cambios:leer',
    ADD COLUMN limite_por_segundo INT NULL,
    ADD COLUMN limite_rafaga INT NULL,
    ADD CONSTRAINT chk_tenant_limite CHECK (
        (limite_por_segundo IS NULL AND limite_rafaga IS NULL)
        OR (limite_por_segundo > 0 AND limite_rafaga > 0)
    );

-- Usuario de desarrollo que utiliza la API de administración.
CREATE USER 'admin_app'@'%'
    IDENTIFIED BY 'admin_local_2026';

GRANT SELECT, INSERT ON reservas.tenants
    TO 'admin_app'@'%';

GRANT UPDATE (
          api_key_hash,
          activo,
          webhook_url,
          webhook_secret,
          scopes,
          limite_por_segundo,
          limite_rafaga
          ) ON reservas.tenants
          TO 'admin_app'@'%';

-- Actualiza solamente la configuración del tenant Aula.
UPDATE tenants
SET webhook_url = 'https://aula:3001/webhooks/reservas',
    limite_por_segundo = 500,
    limite_rafaga = 1500
WHERE id = '01a1542d-7ee2-7d8b-b3b3-40474b8dec7e';