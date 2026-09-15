# AGENTS.md — Instrucciones para asistentes AI en tog-platform

> Este archivo es específico de **tog-platform** (backend de licencias).
> Para el contexto global del ecosistema (tog-admin, tog-platform, landing-page)
> y el skill `omnimargen-experto`, leé el `AGENTS.md` del workspace raíz y
> `.agents/skills/omnimargen-experto/SKILL.md`.

## Qué es este repo

Backend de licencias del ecosistema TOG: alta de empresas (país + documento
internacional) y emisión de licencias RSA firmadas que activan módulos en
TOG Admin (offline-first). **No** contiene UI ni app desktop.

## Stack y reglas

- Node ≥22.5, ESM (`"type": "module"`), **una sola dependencia runtime: `pg`**.
- Base de datos dual en `src/db.js` (capa de datos) + `src/schema.sql` (esquema):
  **Postgres/Supabase en producción** (si hay `DATABASE_URL`) y **SQLite en dev/tests**
  (si no la hay). Detalle, transacciones y queries portables: `docs/SUPABASE.md`.
  Decisión del ecosistema: `../docs/DECISION_BASE_DE_DATOS.md`.
- Tests con `node:test` (`npm test` corre `src/*.test.js`).
- Responder en español. Commits en inglés, una línea, imperativo.
- NO commitear sin que el usuario lo pida. NUNCA commitear secretos
  (`.env`, claves RSA privadas, `ADMIN_API_KEY`). `.env.example` sí se commitea.
- Este repo NO usa graphify ni grafo de conocimiento: para preguntas de código
  usá el código real y `docs/`.

## Estructura

```
src/
├── server.js     # HTTP server (rutas + pagos) — entry point (npm start / dev)
├── db.js         # Capa Postgres/SQLite (empresas, licencias, pagos, users) + withTransaction
├── schema.sql    # Esquema de la DB
├── vendedores.js # Vinculación empresa↔vendedor y comisiones (tablas de la landing)
├── sign.js       # Firma/verificación RSA de licencias
└── *.test.js     # Suites node:test (server, account, security, vendedores)
supabase/migrations/  # RLS + tablas de vendedores (aplicar a mano en Supabase)
docs/             # MODULOS.md, ARQUITECTURA-MODULAR.md, FACTURACION-CRIXTO.md, SUPABASE.md, bitácoras
```

## Comandos

| Comando | Para qué |
|---|---|
| `npm start` | Servidor en `http://localhost:3001` (requiere `LICENSE_PRIVATE_KEY_PATH`) |
| `npm run dev` | `node --watch src/server.js` |
| `npm test` | Suite de integración (`node --test src/*.test.js`) — correr antes de entregar |
| `npm run test:sign` | Autotest de firma RSA |

## Env vars

Obligatorias: `ADMIN_API_KEY`, `JWT_SECRET`, `PAYMENT_HMAC_SECRET`.
Producción: `DATABASE_URL` (Postgres de Supabase) — si falta, el backend corre en
SQLite efímero y **pierde datos en cada deploy** (no hay chequeo que lo impida
porque los tests corren sin ella).
Opcionales: `PORT`, `LICENSE_PRIVATE_KEY_PATH`, `TOG_PLATFORM_DATA`,
`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, `RESEND_API_KEY`, `INVOICE_FROM`,
`SECURITY_ALERT_EMAIL`, `SITE_URL`, `PAYMENT_HMAC_WINDOW_SECONDS`,
`PAYMENT_CONFIRM_MAX_PER_MINUTE`, `PENDING_PAYMENT_TTL_HOURS`,
`DEVICE_CHANGE_COOLDOWN_HOURS`. Ver `.env.example`, `docs/SUPABASE.md` y
`docs/FACTURACION-CRIXTO.md`.

**No hay Stripe.** El único proveedor de pago es Crixto; si algo vuelve a
mencionar Stripe (código, env, docs) es un error: bórralo.

## Endpoints

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/api/health` | — | Estado DB + clave de firma |
| POST | `/api/empresas` | `X-Admin-Key` | Alta de empresa → genera `api_key` (`pais` ISO 3166-1 + `documento` libre) |
| GET | `/api/admin/empresas` | `X-Admin-Key` | Listado de empresas |
| POST | `/api/empresas/:id/licencias` | `X-Admin-Key` | Emite licencia firmada `{cliente, expira, modules?, max_pcs?}`. `max_pcs` 1–20 habilita el módulo Red Local en tog-admin |
| GET | `/api/empresas/:id/licencia` | `X-Api-Key` | Licencia activa (botón "Sincronizar" de TOG Admin) |
| POST | `/api/payment/omniserv-intent` | `X-Api-Key` | Intención de pago OmniServ → URL de retorno firmada |
| GET | `/api/empresas/:id/payment-status` | `X-Api-Key` | Estado del pago (polling de OmniServ, 10 req/min) |
| GET | `/api/payment/confirm` | firma HMAC+ts | Retorno del proveedor: confirma y emite licencia |
| GET | `/api/payment/verify` | firma HMAC+ts | Verificación desde la landing (idempotente) |
| GET | `/api/admin/jobs/verify-pending-payments` | `X-Admin-Key` | Expira pendientes viejos y lista conciliaciones |
| POST | `/api/admin/pagos/:id/confirmar` | `X-Admin-Key` | Confirmación manual tras verificar el cobro |
| POST | `/api/admin/empresas/:id/revocar-licencia` | `X-Admin-Key` | Revoca las licencias vigentes |
| POST | `/api/admin/empresas/:id/dispositivo` | `X-Admin-Key` | Cambia el dispositivo autorizado (razón + auditoría) |
| GET | `/api/admin/empresas/:id/audit/dispositivo` | `X-Admin-Key` | Historial de cambios de dispositivo |

## Estado del proyecto (importante)

- **HOY (operativo):** los 3 caminos de licencia — manual (script), panel admin
  y pago online con Crixto → licencia automática.
- **Seguridad de pagos:** firma HMAC con anti-replay, validación de monto
  esperado, rate limiting, auditoría de cambios de dispositivo y conciliación
  manual de pagos dudosos. Ver `docs/FACTURACION-CRIXTO.md`.
- **En pausa:** 2FA y panel admin web (Parte C del roadmap). No construyas
  infraestructura especulativa.

## Fuentes

`README.md` (flujo + endpoints) · `docs/MODULOS.md` (catálogo de módulos) ·
`docs/ARQUITECTURA-MODULAR.md` · `docs/FACTURACION-CRIXTO.md` (pagos) ·
`docs/CONVERSACION-*.md` (bitácoras de diseño, históricas).
