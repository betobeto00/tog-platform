# Changelog — tog-platform (License Backend)

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Crixto payment flow** (canonical provider, replaces Stripe):
  - `docs/FACTURACION-CRIXTO.md`: canonical payment documentation
  - 3 license paths operational: manual script, admin panel, online Crixto
  - Payment intent API: `/payment/omniserv-intent` (HMAC-signed return URLs)
  - Payment endpoints: `/payment/create`, `/payment/confirm`, `/payment/verify`, `/payment/payment-status`
  - Device management: `/payment/device`, `/payment/audit`
  - Admin operations: `/payment/revoke`, manual payment confirmation
  - Anti-replay HMAC security on all payment flows
  - Pending payment reconciliation job (24h TTL)
  - Device change auditing with 24h cooldown
- 2FA backend (Phases 28-35):
  - TOTP: secret generation, activation, verification (±1 step tolerance)
  - Step-up authentication for sensitive operations
  - Backup codes (10 unique, single-use, hashed storage)
  - Rate limiting: 5 attempts → 15min lockout, 6th/minute → 429 + Retry-After
  - Audit logging in `two_factor_logs` table
  - Email change requires step-up verification
- Security hardening:
  - Progressive auth lockout (5→10→30 attempts, 24h cleanup)
  - Input validation: Zod schemas .max(128), email homoglyph filter
  - CSP headers, CORS localhost only in dev
  - Required env var validation at startup (exit on missing)
  - HTTP error responses sanitized (no internal messages)
  - Encrypted storage: AES-256-GCM for secrets
- New env vars (see .env.example):
  - PAYMENT_HMAC_SECRET, PAYMENT_HMAC_WINDOW_SECONDS
  - PAYMENT_CONFIRM_MAX_PER_MINUTE
  - PENDING_PAYMENT_TTL_HOURS, DEVICE_CHANGE_COOLDOWN_HOURS
  - SECURITY_ALERT_EMAIL, SITE_URL
  - Rate limiting config vars

### Changed
- **Payment provider: Stripe → Crixto** (complete migration):
  - AGENTS.md: removed Stripe env vars and smoke test; added Crixto endpoints
  - README.md: all Stripe refs → Crixto; 8 new payment endpoints documented
  - .env.example: removed STRIPE_* vars; added Crixto/payment security vars
  - docs/MODULOS.md: license activation "En espera (Stripe)" → "Online automático (operativo) (Crixto)"
  - docs/ARQUITECTURA-MODULAR.md: Sync online 🟡 → ✅; FACTURACION-CRIXTO.md reference
  - docs/INTERCONEXION-RED.md, MISION-VISION.md: Stripe doc refs → Crixto
  - scripts/qa-sync.ts: STRIPE_SECRET_KEY → JWT_SECRET + PAYMENT_HMAC_SECRET
- Database schema: added `two_factor_logs`, payment reconciliation fields
- License activation: max_pcs now from `emitirLicenciaConModulos` (server-side)

### Removed
- `docs/FACTURACION-STRIPE.md` (Stripe integration design)
- `scripts/stripe-smoke.mjs` (Stripe test script with test card 4242)
- `src/stripe.js`, `src/stripe.test.js`, `src/stripe-e2e.test.js` (all Stripe code)
- Stripe webhook handling, grace period logic
- STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_*, LICENSE_GRACE_DAYS env vars

### Security
- Guard tests asserting Stripe routes return 404 (`server.test.js`)
- Guard test asserting no Stripe code in server.js (`security.test.js`)
- HMAC anti-replay on payment confirm/verify
- Payment amount verification (409 if registered ≠ expected)
- Device fingerprint binding with transfer audit trail
- Encrypted TOTP secrets in DB (never plaintext)
- Backup codes hashed, single-use
- Step-up tokens: httpOnly cookie, 10min TTL, rate-limited

## [0.1.0] - 2026-09-01
### Added
- Initial license backend with RSA-signed licenses
- Manual license emission via admin script
- Company registration with international identity (ISO 3166-1 alpha-2 + document)
- SQLite database with schema migrations