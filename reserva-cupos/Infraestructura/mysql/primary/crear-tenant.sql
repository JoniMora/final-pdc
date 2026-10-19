-- Alta de un tenant. Uso (desde reserva-cupos):
--   docker compose exec mysql-primary mysql -uroot -proot_local_2026 reservas -e "SET @nombre = 'Mi tenant'; SOURCE /crear-tenant.sql"
--
-- La clave se genera con 256 bits aleatorios y se muestra una sola vez:
-- la base guarda únicamente su hash SHA-256.

SET @clave = CONCAT('rc_', LOWER(HEX(RANDOM_BYTES(32))));
SET @id = UUID();

INSERT INTO tenants (id, nombre, api_key_hash)
VALUES (@id, @nombre, UNHEX(SHA2(@clave, 256)));

SELECT @id AS tenant_id,
       @nombre AS nombre,
       @clave AS clave_api;

SET @clave = NULL;
