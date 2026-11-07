CREATE DATABASE reservas
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_bin;

USE reservas;

CREATE TABLE tenants (
                         id CHAR(36) NOT NULL,
                         nombre VARCHAR(120) NOT NULL,
                         api_key_hash BINARY(32) NOT NULL,
                         activo BOOLEAN NOT NULL DEFAULT TRUE,
                         webhook_url VARCHAR(2048) NULL,
                         webhook_secret VARBINARY(32) NULL,
                         creado_en TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

                         PRIMARY KEY (id),
                         UNIQUE KEY uq_tenant_api_key (api_key_hash)
) ENGINE=InnoDB;

CREATE TABLE actividades (
                             id CHAR(36) NOT NULL,
                             tenant_id CHAR(36) NOT NULL,
                             nombre VARCHAR(200) NOT NULL,
                             capacidad INT NOT NULL,
                             cupos_disponibles INT NOT NULL,
                             estado ENUM('abierta', 'cerrada') NOT NULL DEFAULT 'abierta',
                             metadata JSON NULL,
                             version BIGINT NOT NULL DEFAULT 1,
                             creado_en TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

                             PRIMARY KEY (id),

                             UNIQUE KEY uq_actividad_tenant (tenant_id, id),

                             CONSTRAINT fk_actividad_tenant
                                 FOREIGN KEY (tenant_id)
                                     REFERENCES tenants(id),

                             CONSTRAINT chk_capacidad
                                 CHECK (capacidad > 0),

                             CONSTRAINT chk_cupos
                                 CHECK (
                                     cupos_disponibles >= 0
                                         AND cupos_disponibles <= capacidad
                                     ),

                             CONSTRAINT chk_actividad_version
                                 CHECK (version >= 1)
) ENGINE=InnoDB;

CREATE TABLE reservas (
                          id CHAR(36) NOT NULL,
                          tenant_id CHAR(36) NOT NULL,
                          actividad_id CHAR(36) NOT NULL,
                          participante_id VARCHAR(128) NOT NULL,

                          estado ENUM(
                              'pendiente',
                              'confirmada',
                              'rechazada',
                              'cancelada',
                              'fallida'
                              ) NOT NULL DEFAULT 'pendiente',

                          idempotency_key VARCHAR(128) NOT NULL,
                          request_hash BINARY(32) NOT NULL,
                          metadata JSON NULL,
                          version BIGINT NOT NULL DEFAULT 1,
                          creado_en TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

                          participante_activo VARCHAR(128)
                              GENERATED ALWAYS AS (
                                 CASE
                                     WHEN estado IN ('pendiente', 'confirmada')
                                         THEN participante_id
                                     ELSE NULL
                                     END
                                 ) STORED,

                          PRIMARY KEY (id),

                          UNIQUE KEY uq_reserva_idempotencia (
                              tenant_id,
                              idempotency_key
                              ),

                          UNIQUE KEY uq_participante_activo (
                              tenant_id,
                              actividad_id,
                              participante_activo
                              ),

                          KEY ix_reservas_estado (
                              tenant_id,
                              actividad_id,
                              estado
                              ),

                          CONSTRAINT fk_reserva_actividad
                              FOREIGN KEY (tenant_id, actividad_id)
                                  REFERENCES actividades(tenant_id, id),

                          CONSTRAINT chk_reserva_version
                              CHECK (version >= 1)
) ENGINE=InnoDB;

CREATE TABLE cambios (
                         id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                         tenant_id CHAR(36) NOT NULL,
                         entidad ENUM('actividad', 'reserva') NOT NULL,
                         entidad_id CHAR(36) NOT NULL,
                         tipo VARCHAR(50) NOT NULL,
                         version BIGINT NOT NULL,
                         snapshot JSON NOT NULL,

                         secuencia BIGINT UNSIGNED NULL,
                         publicado_comando BOOLEAN NOT NULL DEFAULT FALSE,
                         publicado_webhook BOOLEAN NOT NULL DEFAULT FALSE,

                         creado_en TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

                         PRIMARY KEY (id),

                         UNIQUE KEY uq_cambio_secuencia (secuencia),

                         KEY ix_feed_tenant (tenant_id, secuencia),

                         KEY ix_comandos_pendientes (publicado_comando, id),

                         KEY ix_webhooks_pendientes (publicado_webhook, id),

                         CONSTRAINT fk_cambio_tenant
                             FOREIGN KEY (tenant_id)
                                 REFERENCES tenants(id),

                         CONSTRAINT chk_cambio_version
                             CHECK (version >= 1)
) ENGINE=InnoDB;