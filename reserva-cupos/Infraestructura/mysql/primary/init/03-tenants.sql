USE reservas;

-- Tenant del cliente de referencia. La clave (solo para desarrollo local)
-- está en docker-compose.yml; acá se guarda únicamente su hash SHA-256.
-- Desde la Entrega 4 registra además su webhook: la URL del receptor de
-- Aula y el secreto compartido con el que el notificador firma (también
-- solo para desarrollo local, en docker-compose.yml como WEBHOOK_SECRET).
--
-- Entrega 5: el webhook se entrega por HTTPS y Aula tiene un límite de tasa
-- propio, más alto que el de la plataforma, porque reenvía las solicitudes
-- de todos sus alumnos (escenario +1: 500 inscripciones simultáneas).
INSERT INTO tenants (id, nombre, api_key_hash, webhook_url, webhook_secret,
                     limite_por_segundo, limite_rafaga)
VALUES (
           '01a1542d-7ee2-7d8b-b3b3-40474b8dec7e',
           'Aula',
           UNHEX('7ec107cf99435eb6b546889e4cd55c5fbefe61477ff9e1a8c40ce76ddf4b4fff'),
           'https://aula:3001/webhooks/reservas',
           UNHEX('46cf76594518a3abd7580dce6146a6db58d2719b2602308e8f7c7dcb7024eb6d'),
           500,
           1500
       );
