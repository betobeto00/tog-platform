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
-- CREACIÓN DE TABLAS: Sistema de Vendedores (FASE 1)
-- Ejecutar una sola vez. Si ya existen, los CREATE TABLE son idempotentes
-- mediante "IF NOT EXISTS" o se harán vía el panel de Supabase.
-- ---------------------------------------------------------------------------

-- Table: vendedores
CREATE TABLE IF NOT EXISTS vendedores (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  usuario_id UUID REFERENCES auth.users(id),
  email VARCHAR(255) UNIQUE NOT NULL,
  nombre VARCHAR(100) NOT NULL,
  apellido VARCHAR(100) NOT NULL,
  documento VARCHAR(50) NOT NULL,
  nacionalidad VARCHAR(5) NOT NULL,
  latitud DECIMAL(10, 8),
  longitud DECIMAL(11, 8),
  direccion TEXT,
  ciudad VARCHAR(100),
  estado VARCHAR(100),
  pais VARCHAR(5),
  telegram_chat_id BIGINT,
  telegram_username VARCHAR(100),
  telegram_verificado BOOLEAN DEFAULT FALSE,
  crixto_cuenta_id VARCHAR(100),
  crixto_verificado BOOLEAN DEFAULT FALSE,
  activo BOOLEAN DEFAULT TRUE,
  id_vendedor VARCHAR(20) UNIQUE NOT NULL,
  comision_porcentaje DECIMAL(5,2) DEFAULT 30.00,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table: vendedor_zonas
CREATE TABLE IF NOT EXISTS vendedor_zonas (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  vendedor_id UUID REFERENCES vendedores(id),
  zona_nombre VARCHAR(100) NOT NULL,
  pais VARCHAR(5),
  estado VARCHAR(100),
  ciudad VARCHAR(100),
  es_exclusiva BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table: vendedor_clientes
CREATE TABLE IF NOT EXISTS vendedor_clientes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  vendedor_id UUID REFERENCES vendedores(id),
  cliente_empresa VARCHAR(255) NOT NULL,
  cliente_email VARCHAR(255),
  cliente_telefono VARCHAR(50),
  cliente_ubicacion TEXT,
  licencia_id VARCHAR(100),
  licencia_estado VARCHAR(20),
  licencia_modulos JSONB,
  licencia_expira TIMESTAMPTZ,
  monto_mensual DECIMAL(10,2),
  commission_status VARCHAR(20) DEFAULT 'pendiente',
  registrado_en TIMESTAMPTZ DEFAULT NOW()
);

-- Table: vendedor_comisiones
CREATE TABLE IF NOT EXISTS vendedor_comisiones (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  vendedor_id UUID REFERENCES vendedores(id),
  cliente_id UUID REFERENCES vendedor_clientes(id),
  monto DECIMAL(10,2) NOT NULL,
  moneda VARCHAR(3) DEFAULT 'USD',
  periodo VARCHAR(7),
  estado VARCHAR(20) DEFAULT 'pendiente',
  fecha_pago TIMESTAMPTZ,
  comprobante_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table: vendedor_visitas
CREATE TABLE IF NOT EXISTS vendedor_visitas (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  vendedor_id UUID REFERENCES vendedores(id),
  cliente_documento VARCHAR(50),
  cliente_empresa VARCHAR(255),
  ubicacion_lat DECIMAL(10, 8),
  ubicacion_lon DECIMAL(11, 8),
  notas TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- HABILITAR RLS y POLÍTICAS (contenidas abajo)
-- ---------------------------------------------------------------------------
ALTER TABLE vendedores ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendedor_zonas ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendedor_clientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendedor_comisiones ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendedor_visitas ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Políticas: sólo el backend (service_role)
-- ---------------------------------------------------------------------------
CREATE POLICY service_all_vendedores ON vendedores FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_all_vendedor_zonas ON vendedor_zonas FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_all_vendedor_clientes ON vendedor_clientes FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_all_vendedor_comisiones ON vendedor_comisiones FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_all_vendedor_visitas ON vendedor_visitas FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Índices para performance
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_vendedores_id_vendedor ON vendedores(id_vendedor);
CREATE INDEX IF NOT EXISTS idx_vendedores_email ON vendedores(email);
CREATE INDEX IF NOT EXISTS idx_vendedores_activo ON vendedores(activo);
CREATE INDEX IF NOT EXISTS idx_vendedor_zonas_vendedor ON vendedor_zonas(vendedor_id);
CREATE INDEX IF NOT EXISTS idx_vendedor_clientes_vendedor ON vendedor_clientes(vendedor_id);
CREATE INDEX IF NOT EXISTS idx_vendedor_clientes_empresa ON vendedor_clientes(cliente_empresa);
CREATE INDEX IF NOT EXISTS idx_vendedor_comisiones_vendedor ON vendedor_comisiones(vendedor_id);
CREATE INDEX IF NOT EXISTS idx_vendedor_visitas_vendedor ON vendedor_visitas(vendedor_id);

-- ---------------------------------------------------------------------------
-- Verificación rápida: no debe devolver ninguna fila (tablas sin RLS)
-- ---------------------------------------------------------------------------
-- SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--  WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT relrowsecurity;

