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
  stripe_customer_id TEXT UNIQUE,
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

CREATE TABLE IF NOT EXISTS suscripciones (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id             INTEGER NOT NULL REFERENCES empresas(id),
  stripe_subscription_id TEXT UNIQUE,
  stripe_price_id        TEXT,
  estado                 TEXT NOT NULL DEFAULT 'active',
  current_period_end     TEXT,
  cancel_at_period_end   INTEGER NOT NULL DEFAULT 0,
  failed_at              TEXT,
  grace_ends_at          TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhook_events (
  stripe_event_id TEXT PRIMARY KEY,
  tipo            TEXT NOT NULL,
  payload         TEXT NOT NULL,
  procesado_en    TEXT NOT NULL DEFAULT (datetime('now'))
);

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
