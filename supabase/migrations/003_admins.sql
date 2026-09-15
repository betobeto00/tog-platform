-- FASE 9 — Dashboard global del admin de OmniMargen.
-- Aplicar después de 001_rls_policies.sql y 002_vendedores_auth.sql.
--
-- POR QUÉ: el panel global necesitaba cuentas propias, separadas de las de
-- vendedor. Un vendedor nunca debe poder actuar como admin, así que la sesión
-- viaja en otra cookie (omv_admin), se firma con otro secreto
-- (ADMIN_SESSION_SECRET) y se valida contra esta tabla, no contra `vendedores`.
--
-- La contraseña Y la clave de administración se guardan hasheadas con scrypt
-- (landing-page/src/lib/admin-auth.ts). Nunca en texto plano.
--
-- Aplicar con: `supabase db push` o pegando este SQL en el SQL Editor.

CREATE TABLE IF NOT EXISTS admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  -- Segundo factor obligatorio, por cuenta (no una env var compartida).
  admin_key_hash TEXT NOT NULL,
  nombre VARCHAR(100) NOT NULL,
  rol VARCHAR(20) NOT NULL DEFAULT 'admin',
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  ultimo_login TIMESTAMPTZ,
  intentos_fallidos INTEGER NOT NULL DEFAULT 0,
  bloqueado_hasta TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sólo estos dos roles existen; cualquier otro valor es un error de carga.
ALTER TABLE admins DROP CONSTRAINT IF EXISTS admins_rol_check;
ALTER TABLE admins ADD CONSTRAINT admins_rol_check CHECK (rol IN ('admin', 'super_admin'));

CREATE INDEX IF NOT EXISTS idx_admins_email ON admins(email);

-- Auditoría de cada acción del panel. Sin políticas para `anon`/`authenticated`:
-- sólo service_role (que ignora RLS) escribe y lee acá.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id BIGSERIAL PRIMARY KEY,
  admin_id UUID REFERENCES admins(id) ON DELETE SET NULL,
  admin_email VARCHAR(255),
  accion VARCHAR(60) NOT NULL,
  entidad VARCHAR(60),
  entidad_id TEXT,
  detalle JSONB,
  ip VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_admin ON admin_audit_log(admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_accion ON admin_audit_log(accion, created_at DESC);

-- Una fila de auditoría nunca se modifica.
CREATE OR REPLACE RULE admin_audit_log_no_update AS
  ON UPDATE TO admin_audit_log DO INSTEAD NOTHING;

CREATE OR REPLACE RULE admin_audit_log_no_delete AS
  ON DELETE TO admin_audit_log DO INSTEAD NOTHING;

ALTER TABLE admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;

-- El backend (service_role) es el único camino: no se crean políticas para
-- `anon`, así que un cliente con la anon key no puede leer ni escribir nada.
DROP POLICY IF EXISTS admins_service_role_all ON admins;
CREATE POLICY admins_service_role_all ON admins
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS admin_audit_service_role_all ON admin_audit_log;
CREATE POLICY admin_audit_service_role_all ON admin_audit_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Alta del primer admin:
--   INSERT INTO admins (email, password_hash, admin_key_hash, nombre, rol)
--   VALUES ('tu@email', 'scrypt$...', 'scrypt$...', 'Tu Nombre', 'super_admin');
-- Los hashes se generan con hashPassword() de landing-page/src/lib/admin-auth.ts
-- (o `node -e "console.log(require('./src/lib/admin-auth').hashPassword('...'))"`).
