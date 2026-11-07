USE reservas;

-- Tenant del cliente de referencia. La clave (solo para desarrollo local)
-- está en docker-compose.yml; acá se guarda únicamente su hash SHA-256.
INSERT INTO tenants (id, nombre, api_key_hash)
VALUES (
           '01a1542d-7ee2-7d8b-b3b3-40474b8dec7e',
           'Aula',
           UNHEX('7ec107cf99435eb6b546889e4cd55c5fbefe61477ff9e1a8c40ce76ddf4b4fff')
       );
