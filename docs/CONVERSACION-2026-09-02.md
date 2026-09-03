# Bitácora de Conversación — 2026-09-02

> Continuación de [`CONVERSACION-2025-09-01.md`](./CONVERSACION-2025-09-01.md). Resumen de la sesión: cierre del módulo Distribuidor en TOG Admin, verificación del backend de licencias, internacionalización de la identidad de empresa y sincronización de licencia desde la app.

---

## 0. Contexto de arranque

Los tres repos son **hermanos** bajo `/omnimargen` (cada uno es su propio repo Git):

```
/omnimargen/landing-page   ← marketing OmniMargen (limpio, sin cambios)
/omnimargen/tog-admin      ← código del producto (branch fix/license-modularization)
/omnimargen/tog-platform   ← visión + backend de licencias
```

## 1. Módulo Distribuidor (tog-admin) — terminado y commiteado

Se cerró el WIP del módulo Distribuidor iniciado en la sesión anterior:

- Migración `015_distribuidor`: tablas `clientes`, `pedidos`, `pedido_detalles`, `remitos`, `listas_precio` (+ índices).
- Handlers IPC por dominio en `src/main/modules/distribuidor/` (CRUD de clientes con `checkPermissionOrFail` + validación zod + gate por módulo activo de la licencia).
- Permisos nuevos (`distribuidor_clientes_view/edit`, `distribuidor_pedidos_view/edit`), categoría **Distribuidor** en `permissions.ts`, `PermissionsModal` y tests.
- UI: rutas `/clientes` y `/pedidos`, entrada en Sidebar con gating por módulo activo (`useActiveModules`), `ClientesPage` (CRUD completo) y `PedidosPage` (placeholder “en construcción”), i18n es/en sin textos hardcodeados.
- Pruebas nuevas para permisos, validaciones (`clienteCreateSchema`) y normalización de módulos. **`npm run typecheck:all` y `npm test` en verde.**

**Commit:** `e14e7e0` — *feat(distribuidor): add Distributor module with clientes CRUD, license gating and i18n*

## 2. Backend de licencias (tog-platform) — verificado

- `server.js` ahora exporta `startServer({ port })` (arranque directo con guard de `import.meta.url`) → testeable sin escuchar al importar.
- `db.js` exporta `closeDatabase()` y activa `busy_timeout`.
- Suite de integración **`node:test` sin dependencias** (`npm test`): salud, auth, alta de empresa, emisión manual con verificación RSA real, consulta de la empresa, validaciones, 501 de Stripe.
- Smoke end-to-end manual contra la clave privada real de TOG Admin: empresa internacional + licencia firmada + descarga vía api_key.

**Commit:** `1dd8f75` — *feat: backend de licencias verificable con tests de integración*

## 3. Decisión de producto: mercado internacional

**Requerimiento del usuario:** el mercado no es solo Venezuela. Cualquiera puede descargar el software, contactar por WhatsApp, pagar y recibir licencia desde el exterior. Por lo tanto **la identificación de la empresa no puede ser solo el RIF**: debe ser un documento de registro/tributario con convención internacional.

**Decisión implementada:**

- La empresa se identifica por **`pais` (ISO 3166-1 alpha-2, default `VE`) + `documento`** libre: RIF (VE), EIN (US), RFC (MX), NIT (CO), CUIT (AR), CNPJ (BR), VAT (UE)…
- Unicidad por **`(pais, documento)`**: el mismo número en países distintos son empresas distintas; duplicados solo dentro del mismo país.
- Canonicalización: `pais` y `documento` en mayúsculas.
- API: `POST /api/empresas` acepta `nombre`, `pais` (opcional), `documento`, `email_contacto`. `GET /api/admin/empresas` devuelve `pais`/`documento`.
- Mismo criterio aplicado al registro de clientes del módulo Distribuidor en la app: `clientes.rif` → `clientes.documento` (migración `016_clientes_documento`), etiquetas e i18n neutrales.

**Commits:** `4b9ad53` (backend), `756d861` (clientes de la app)

## 4. Sincronizar licencia desde TOG Admin ↔ TOG Platform

Flujo completo del roadmap (sprint 1) implementado:

1. Canal IPC **pre-auth** `license:sync` (funciona desde la pantalla de bloqueo, sin sesión).
2. Servicio puro `src/main/services/license-sync.ts` (fetch + guardado inyectados) con timeout de 10 s, mensajes claros y validación de entrada; la licencia descargada pasa por la validación RSA local antes de guardarse (`saveLicense`).
3. UI reutilizable `LicenseSyncForm` (URL del servidor + ID de empresa + API Key, recordadas en localStorage) integrada en **Config → Licencia** y en la pantalla de **LicenseGate**.
4. Evento `tog:license-updated` → el Sidebar/`useActiveModules` refresca los módulos en vivo tras sincronizar o importar.
5. `license:sync` se agregó a `PREAUTH_CHANNELS` (en `ipc-channels.ts` **y** en el espejo `api-client.ts`) + tests del servicio (éxito, errores HTTP, red caída, timeout, validación, guardado rechazado).

**Tests:** tog-admin 136 ✓ · tog-platform 9 ✓.

**Commit:** `0050871` — *feat: sincronizar licencia desde TOG Platform (botón en Config y bloqueo)*

## 5. QA del flujo de sincronización

- Se extrajo la cripto de licencia a un módulo puro (`src/main/services/license-crypto.ts`: clave pública embebida + `verifyLicenseSignature`), con tests unitarios (firma válida, manipulación, clave equivocada).
- **`scripts/qa-sync.ts`** (tog-admin): levanta el backend real con `keys/private.key`, verifica que la pública embebida es su pareja, crea una empresa internacional, emite licencia con Distribuidor y valida la descarga con la misma función de la app. **Verde.**
- Pasos manuales en Electron documentados en `docs/QA-SYNC.md`.
- Commit `caa4971`.

## 6. Pedidos del módulo Distribuidor (CRUD completo)

- Handlers IPC con validación zod, numeración secuencial (`configuracion.pedido_numero`), transiciones de estado validadas (pendiente → despachado/entregado/anulado; despachado → entregado) y catálogo de productos del Core sin requerir permiso de inventario.
- `PedidosPage` completa (crear con renglones, listar, despachar, entregar, anular) + i18n es/en. Tablas ya existían (migración 015).
- Commit `b09b833`. **Tests tog-admin: 144 ✓**

## 7. Stripe Checkout MVP en el backend

- Sin SDK: helpers en `src/stripe.js` (REST con `fetch` inyectable + verificación HMAC-SHA256 del webhook), cero dependencias.
- `POST /api/checkout-session` crea la suscripción con el módulo pedido; el webhook **`checkout.session.completed`** emite una licencia nueva (módulos actuales ∪ comprado) con 1 mes de vigencia, crea la suscripción y registra el evento (idempotente vía `webhook_events`). `customer.subscription.deleted` marca la suscripción cancelada.
- Sin credenciales Stripe → responde 503 con mensaje claro. Páginas de retorno `/checkout/success|cancel`.
- Env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_DOMAIN`, `STRIPE_PRICE_<MODULO>` (ver `.env.example`).
- **Tests tog-platform: 18 ✓** (firma HMAC, construcción de sesión, e2e del webhook sin red: activación de módulo, idempotencia, suma de módulos, cancelación).

## 8. Grace period de 14 días por impago

- `invoice.payment_failed` → suscripción **`impago`** con `grace_ends_at = +14 días` (`LICENSE_GRACE_DAYS` configurable). Durante la gracia la licencia sigue sirviéndose (offline-first).
- Al vencer sin pago (barrido perezoso antes de servir licencias y en cada webhook): suscripción **`cancelado_impago`** y **revocación** de la licencia (`revoked_at` + motivo). El sync de la app recibe **402** con mensaje claro.
- `invoice.payment_succeeded` → suscripción `active` y **re-emisión** de la licencia (módulos acumulados + 1 mes): renueva el ciclo mensual y reactiva tras impago.
- Test e2e completo de la vida del grace period. **Tests tog-platform: 19 ✓**

## 9. Pendientes / próximos pasos

- **Stripe en producción**: crear productos/precios en el dashboard, configurar el webhook y probar un pago real de punta a punta. Harness listo: `npm run smoke:stripe` (levanta el backend, crea precio + empresa, muestra el checkout y verifica la activación tras pagar con la tarjeta 4242…). Solo requiere `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` de prueba.
- Despliegue del backend (hoy corre local con `node src/server.js`; necesitará HTTPS para el webhook).
- QA manual en Electron del flujo “Config → Licencia → Sincronizar” contra un backend local (checklist en `docs/QA-SYNC.md`).
- Pruebas unitarias de handlers del Distribuidor (clientes y pedidos) con DB en memoria — **159 tests tog-admin ✓**.

## 10. Decisión de alcance (anti-overengineering)

**Preocupación del usuario:** miedo al overengineering tras construir el bloque de Stripe (checkout + webhooks + grace period + smoke), que es la parte más pesada y **no tiene aún un cliente que pague online**.

**Decisión (elegida por el usuario):** no tocar código — el bloque queda commiteado y testeado — pero **marcar prioridades en docs**:

1. **Flujo HOY (v1, manual):** WhatsApp/transferencia → `POST /api/empresas` + emisión manual de licencia → el cliente **Sincroniza** (o importa `.key`). Sin servidor público, sin Stripe, sin HTTPS. Ver sección “Qué es HOY… y qué está EN ESPERA” en el README.
2. **En espera:** Stripe Checkout + webhooks + grace period + harness `smoke:stripe`. Implementado y probado (19 tests), pero **en pausa** hasta que exista un cliente que pague online; requiere definir el modelo de cobro (suscripción vs. pago único) y desplegar con HTTPS.

**Criterio para el futuro:** no invertir en más infraestructura de cobro/nube hasta que el flujo manual tenga clientes reales pagando; automatizar solo cuando ese dolor aparezca.
- Considerar hostname/máquina: la licencia hoy no fija `machineId` cuando se emite desde el backend (null), igual que el flujo manual actual.
- Portal de gestión de suscripción (Stripe Customer Portal) para que Roberto cancele/actualice su plan.
