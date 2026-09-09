-- Habilitar RLS en todas las tablas
ALTER TABLE empresas ENABLE ROW LEVEL SECURITY;
ALTER TABLE licencias ENABLE ROW LEVEL SECURITY;
ALTER TABLE pagos ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE suscripciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;

-- service_role: acceso total (el backend lo usa via connection string)
CREATE POLICY service_all_empresas ON empresas FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY service_all_licencias ON licencias FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY service_all_pagos ON pagos FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY service_all_password_resets ON password_resets FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY service_all_suscripciones ON suscripciones FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY service_all_users ON users FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY service_all_webhook_events ON webhook_events FOR ALL USING (true) WITH CHECK (true);
