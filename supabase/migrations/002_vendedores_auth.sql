-- FASE 5 + auth de vendedores (aplicar en Supabase, después de 001_rls_policies.sql).
--
-- POR QUÉ: el registro de vendedores (/soy-vendedor) pedía contraseña y la
-- descartaba, y el login sólo comprobaba que el email existiera. Ahora la
-- contraseña se guarda hasheada (scrypt, ver landing-page/src/lib/vendedores-auth.ts)
-- y el login la verifica. Las políticas de 001 son sólo para service_role, así
-- que agregar la columna no abre nada nuevo.
--
-- Aplicar con: `supabase db push` o pegando este SQL en el SQL Editor.

ALTER TABLE vendedores ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Marca de la última verificación de Telegram (auditoría simple).
ALTER TABLE vendedores ADD COLUMN IF NOT EXISTS telegram_verificado_en TIMESTAMPTZ;

-- Un vendedor no puede repetir documento/nacionalidad (evita altas duplicadas
-- del mismo agente con otro email). Índice, no constraint: los datos existentes
-- pueden tener duplicados legítimos de pruebas.
CREATE INDEX IF NOT EXISTS idx_vendedores_documento ON vendedores(documento, nacionalidad);
