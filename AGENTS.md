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

- Node ≥22.5, ESM (`"type": "module"`), **cero dependencias runtime**.
- SQLite: `src/db.js` (capa de datos) + `src/schema.sql` (esquema).
- Tests con `node:test` (`npm test` corre `src/*.test.js`).
- Responder en español. Commits en inglés, una línea, imperativo.
- NO commitear sin que el usuario lo pida. NUNCA commitear secretos
  (`.env`, claves RSA privadas, `ADMIN_API_KEY`). `.env.example` sí se commitea.
- Este repo NO usa graphify ni grafo de conocimiento: para preguntas de código
  usá el código real y `docs/`.

## Estructura

```
src/
├── server.js     # HTTP server (rutas) — entry point (npm start / dev)
├── db.js         # Capa SQLite (empresas, licencias, suscripciones)
├── schema.sql    # Esquema de la DB
├── sign.js       # Firma/verificación RSA de licencias
├── stripe.js     # Checkout + webhooks (EN ESPERA de uso productivo)
└── *.test.js     # Suites node:test (server, stripe, sign)
docs/             # MODULOS.md, ARQUITECTURA-MODULAR.md, FACTURACION-STRIPE.md, bitácoras
```

## Comandos

| Comando | Para qué |
|---|---|
| `npm start` | Servidor en `http://localhost:3001` (requiere `LICENSE_PRIVATE_KEY_PATH`) |
| `npm run dev` | `node --watch src/server.js` |
| `npm test` | Suite de integración (`node --test src/*.test.js`) — correr antes de entregar |
| `npm run test:sign` | Autotest de firma RSA |
| `npm run smoke:stripe` | Pago real en modo test de Stripe (tarjeta 4242) |

## Env vars

`PORT`, `ADMIN_API_KEY`, `LICENSE_PRIVATE_KEY_PATH`, `TOG_PLATFORM_DATA`
(+ `STRIPE_SECRET_KEY`, `STRIPE_PRICE_<MODULO>`, `STRIPE_WEBHOOK_SECRET` solo
para Stripe). Ver `.env.example`.

## Endpoints

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/api/health` | — | Estado DB + clave de firma |
| POST | `/api/empresas` | `X-Admin-Key` | Alta de empresa → genera `api_key` (`pais` ISO 3166-1 + `documento` libre) |
| GET | `/api/admin/empresas` | `X-Admin-Key` | Listado de empresas |
| POST | `/api/empresas/:id/licencias` | `X-Admin-Key` | Emite licencia firmada `{cliente, expira, modules?, max_pcs?}`. `max_pcs` 1–20 habilita el módulo Red Local en tog-admin |
| GET | `/api/empresas/:id/licencia` | `X-Api-Key` | Licencia activa (botón "Sincronizar" de TOG Admin) |
| POST | `/api/checkout-session` | `X-Api-Key` | Stripe Checkout de módulo |
| POST | `/api/webhook/stripe` | firma | Webhook idempotente |

## Estado del proyecto (importante)

- **HOY (operativo):** flujo manual — alta de empresa + emisión + “Sincronizar”
  en la app. Es lo único que se mantiene operando.
- **EN ESPERA:** Stripe Checkout + webhooks + grace period están implementados y
  testeado en `src/`, pero NO se expanden ni se priorizan hasta que exista un
  cliente que quiera pagar online. No construyas infraestructura especulativa.

## Fuentes

`README.md` (flujo + endpoints) · `docs/MODULOS.md` (catálogo de módulos) ·
`docs/ARQUITECTURA-MODULAR.md` · `docs/FACTURACION-STRIPE.md` ·
`docs/CONVERSACION-*.md` (bitácoras de diseño).
