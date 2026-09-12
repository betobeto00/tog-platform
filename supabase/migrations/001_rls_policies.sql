-- RLS para el backend TOG Platform en Supabase/Postgres.
--
-- POR QUÉ IMPORTA: en Supabase el esquema `public` es alcanzable por PostgREST
-- con la **anon key**. Una tabla con RLS deshabilitado (o con una política
-- permisiva sin `TO`) queda expuesta a cualquiera que tenga esa key pública.
--
-- Reglas de este archivo:
--   1. TODAS las tablas del backend tienen RLS habilitado.
--   2. Las políticas son explícitas para `service_role` (el backend), nunca
--      `USING (true)` sin destinatario: eso abriría las tablas a `anon`.
--   3. El backend NO debe usar la anon key: conecta con el connection string
--      (rol owner) o con la service_role key.
--
-- Aplicar con: `supabase db push` o pegando el SQL en el SQL Editor.
-- Si el backend arranca y detecta tablas sin RLS, lo avisa en el log.

-- ---------------------------------------------------------------------------
-- Empresas y licencias
-- ---------------------------------------------------------------------------
ALTER TABLE empresas ENABLE ROW LEVEL SECURITY;
ALTER TABLE licencias ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE pagos ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Auditoría de dispositivos (Fase 24)
-- ---------------------------------------------------------------------------
ALTER TABLE device_fingerprint_audit ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2FA (Fases 28-33): secretos TOTP (cifrados) y códigos de respaldo (hasheados)
-- ---------------------------------------------------------------------------
ALTER TABLE two_factor_auth ENABLE ROW LEVEL SECURITY;
ALTER TABLE two_factor_backup_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE two_factor_logs ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Políticas: sólo el backend (service_role)
-- ---------------------------------------------------------------------------
CREATE POLICY service_all_empresas ON empresas FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_all_licencias ON licencias FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_all_users ON users FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_all_password_resets ON password_resets FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_all_pagos ON pagos FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_all_device_audit ON device_fingerprint_audit FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_all_2fa_auth ON two_factor_auth FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_all_2fa_backup ON two_factor_backup_codes FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_all_2fa_logs ON two_factor_logs FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Verificación rápida: no debe devolver ninguna fila
-- ---------------------------------------------------------------------------
-- SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--  WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT relrowsecurity;
