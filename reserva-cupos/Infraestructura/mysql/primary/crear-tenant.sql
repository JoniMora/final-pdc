-- Alta de un tenant. Uso (desde reserva-cupos):
--   docker compose exec mysql-primary mysql -uroot -proot_local_2026 reservas -e "SET @nombre = 'Mi tenant'; SOURCE /crear-tenant.sql"
--
-- Con webhook (opcional), se indica además la URL del receptor:
--   ... -e "SET @nombre = 'Mi tenant'; SET @webhook_url = 'https://tenant.ejemplo/webhooks'; SOURCE /crear-tenant.sql"
--
-- La clave se genera con 256 bits aleatorios y se muestra una sola vez:
-- la base guarda únicamente su hash SHA-256. El secreto del webhook son 32
-- bytes aleatorios y se muestra una sola vez, en hexadecimal (64
-- caracteres): la clave del HMAC son esos bytes, no el texto
-- (contrato/openapi.yaml, sección webhooks). La clave de API va en la
-- última columna.

SET @clave = CONCAT('rc_', LOWER(HEX(RANDOM_BYTES(32))));
SET @secreto = IF(@webhook_url IS NULL, NULL, RANDOM_BYTES(32));
SET @id = UUID();

INSERT INTO tenants (id, nombre, api_key_hash, webhook_url, webhook_secret)
VALUES (@id, @nombre, UNHEX(SHA2(@clave, 256)), @webhook_url, @secreto);

SELECT @id AS tenant_id,
       @nombre AS nombre,
       LOWER(HEX(@secreto)) AS webhook_secreto,
       @clave AS clave_api;

SET @clave = NULL;
SET @secreto = NULL;
SET @webhook_url = NULL;
