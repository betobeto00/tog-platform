-- Esquema del backend TOG Platform (SQLite, modelado sobre docs/FACTURACION-STRIPE.md)
-- Adaptado de UUIDs/Postgres a INTEGER/SQLite para el MVP sin infraestructura.

-- Identificación internacional de la empresa: pais (ISO 3166-1 alpha-2) +
-- documento de registro/tributario libre (RIF, EIN, NIT, CUIT, CNPJ, VAT…).
-- El mismo número en países distintos son empresas distintas.
CREATE TABLE IF NOT EXISTS empresas (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre             TEXT NOT NULL,
  pais               TEXT NOT NULL DEFAULT 'VE',
  documento          TEXT NOT NULL,
  email_contacto     TEXT NOT NULL,
  api_key            TEXT UNIQUE NOT NULL,
  stripe_customer_id TEXT UNIQUE,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (pais, documento)
);

-- Historial completo de licencias emitidas (no solo la actual)
CREATE TABLE IF NOT EXISTS licencias (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id      INTEGER NOT NULL REFERENCES empresas(id),
  modules         TEXT NOT NULL DEFAULT '[]',          -- JSON array: ['distribuidor', ...]
  max_usuarios    INTEGER DEFAULT 1,
  max_sucursales  INTEGER DEFAULT 1,
  issued_at       TEXT NOT NULL,                        -- ISO (emitida en el JSON de la licencia)
  expires_at      TEXT NOT NULL,                        -- YYYY-MM-DD (expira del JSON)
  revoked_at      TEXT,
  motivo_revocado TEXT,
  payload_json    TEXT NOT NULL,                        -- JSON completo de la licencia (con firma), listo para la app
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
  -- Grace period por impago: estado 'impago' + fecha límite (14 días);
  -- al vencer sin pago la suscripción pasa a 'cancelado_impago' y se revoca la licencia.
  failed_at              TEXT,
  grace_ends_at          TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Auditoría de webhooks (idempotencia: mismo evento procesado una sola vez)
CREATE TABLE IF NOT EXISTS webhook_events (
  stripe_event_id TEXT PRIMARY KEY,
  tipo            TEXT NOT NULL,
  payload         TEXT NOT NULL,
  procesado_en    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_licencias_empresa ON licencias(empresa_id);
CREATE INDEX IF NOT EXISTS idx_licencias_activa ON licencias(empresa_id, revoked_at, expires_at);