-- Esquema del backend TOG Platform (SQLite + PostgreSQL compatible)
-- SQLite: INTEGER PRIMARY KEY AUTOINCREMENT, datetime('now'), INTEGER para booleanos
-- Postgres: SERIAL, NOW(), BOOLEAN — SQLite ignora tipos no estándar y trata todo como TEXT/INTEGER

CREATE TABLE IF NOT EXISTS empresas (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre             TEXT NOT NULL,
  pais               TEXT NOT NULL DEFAULT 'VE',
  documento          TEXT NOT NULL,
  email_contacto     TEXT NOT NULL,
  api_key            TEXT UNIQUE NOT NULL,
  device_fingerprint TEXT,
  payment_status     TEXT DEFAULT 'pending',
  payment_confirmed_at TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (pais, documento)
);

CREATE TABLE IF NOT EXISTS licencias (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id      INTEGER NOT NULL REFERENCES empresas(id),
  modules         TEXT NOT NULL DEFAULT '[]',
  max_usuarios    INTEGER DEFAULT 1,
  max_sucursales  INTEGER DEFAULT 1,
  issued_at       TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  revoked_at      TEXT,
  motivo_revocado TEXT,
  payload_json    TEXT NOT NULL,
  emitida_por     TEXT NOT NULL DEFAULT 'manual:admin'
);

-- Auditoría de cambios del dispositivo autorizado (device_fingerprint).
-- El admin se autentica con una API key compartida, así que guardamos el hash
-- de la key usada (nunca la key) y, si el cliente la envía, su email.
CREATE TABLE IF NOT EXISTS device_fingerprint_audit (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id          INTEGER NOT NULL REFERENCES empresas(id),
  admin_key_hash      TEXT NOT NULL,
  admin_email         TEXT,
  fingerprint_antiguo TEXT,
  fingerprint_nuevo   TEXT,
  razon               TEXT NOT NULL,
  ip_address          TEXT,
  user_agent          TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_device_audit_empresa ON device_fingerprint_audit(empresa_id, created_at);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  nombre        TEXT NOT NULL,
  pais          TEXT NOT NULL DEFAULT 'VE',
  documento     TEXT NOT NULL DEFAULT '',
  telefono      TEXT,
  empresa_id    INTEGER REFERENCES empresas(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- 2FA (TOTP + códigos de respaldo)
--
-- El secreto TOTP y los hashes de los códigos de respaldo se guardan CIFRADOS
-- (AES-256-GCM, ver server.js → `cifrar`/`descifrar`): si la DB se filtra, los
-- secretos no sirven. El código de respaldo en claro sólo existe en pantalla,
-- una vez.
--
-- ⚠️ En Supabase/Postgres estas tablas deben tener RLS habilitado (ver
-- supabase/migrations/001_rls_policies.sql): el esquema `public` es alcanzable
-- con la anon key si RLS está apagado.
-- ============================================================================

CREATE TABLE IF NOT EXISTS two_factor_auth (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  method       TEXT NOT NULL DEFAULT 'totp',
  secret       TEXT NOT NULL,
  verified     INTEGER NOT NULL DEFAULT 0,
  confirmed_at TEXT,
  last_used_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, method)
);

CREATE TABLE IF NOT EXISTS two_factor_backup_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  code_hash  TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS two_factor_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id),
  action     TEXT NOT NULL,
  method     TEXT,
  success    INTEGER NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  detalle    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_2fa_backup_user ON two_factor_backup_codes(user_id, used_at);
CREATE INDEX IF NOT EXISTS idx_2fa_logs_user ON two_factor_logs(user_id, created_at);

CREATE TABLE IF NOT EXISTS password_resets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT UNIQUE NOT NULL,
  expira     TEXT NOT NULL,
  usado      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pagos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id),
  empresa_id  INTEGER NOT NULL REFERENCES empresas(id),
  concepto    TEXT NOT NULL,
  detalle     TEXT NOT NULL DEFAULT '[]',
  monto       REAL NOT NULL,
  moneda      TEXT NOT NULL DEFAULT 'USD',
  estado      TEXT NOT NULL DEFAULT 'pending',
  provider    TEXT NOT NULL DEFAULT 'crixto',
  provider_ref TEXT,
  nro_factura TEXT UNIQUE,
  paid_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pagos_user ON pagos(user_id);
CREATE INDEX IF NOT EXISTS idx_pagos_empresa ON pagos(empresa_id);
CREATE INDEX IF NOT EXISTS idx_pagos_estado ON pagos(estado);
CREATE INDEX IF NOT EXISTS idx_licencias_empresa ON licencias(empresa_id);
CREATE INDEX IF NOT EXISTS idx_licencias_activa ON licencias(empresa_id, revoked_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_pagos_pendientes ON pagos(estado, created_at);
