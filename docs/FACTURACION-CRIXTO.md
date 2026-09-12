# TOG Platform — Facturación con Crixto y seguridad de pagos

> Documento canónico del flujo de cobro online. **El único proveedor de pago del
> ecosistema es Crixto** (pago móvil, transferencia, Zelle en USD).
> Stripe se evaluó en el pasado y **se descartó**: no queda código, tests ni
> documentación de Stripe en el repositorio.
>
> Flujo de licenciamiento puro: `MODULOS.md`. Arquitectura modular:
> `ARQUITECTURA-MODULAR.md`. Seguridad general: `../../SECURITY.md`.

---

## 1. Los 3 caminos de licencia

| Camino | Origen | Método | Automatización |
|--------|--------|--------|----------------|
| 1 | Administrador | Script offline (`license.key`) firmado RSA | Manual |
| 2 | Administrador | `POST /api/empresas/:id/licencias` (panel admin) | Manual |
| 3 | Cliente | Carrito / compra en la web → Crixto → licencia firmada | Automática (con conciliación) |

El camino 3 nunca reemplaza a los otros dos: la licencia sigue siendo local y
offline-first, y el backend es la única fuente de verdad del pago.

---

## 2. Flujo de cobro (carrito web)

```
Landing /precios
  │  1. POST /api/cuenta/payment          (proxy con cookie httpOnly)
  ▼
tog-platform  POST /api/payment/create
  │  · calcula el monto en el servidor (nunca lo manda el cliente)
  │  · crea el pago en estado `pending`
  │  · firma { payment_id, monto, empresa_id, timestamp } con HMAC-SHA256
  ▼
  │  2. responde { payment_id, monto, hmac, timestamp, success_url }
  ▼
Landing → form POST a https://crixto.io/cgi/buy-cart  (target=_blank)
  │  success_url = https://omnimargen.site/api/cuenta/verify?payment_id=…&hmac=…&ts=…
  ▼
Cliente paga en Crixto
  │
  ├─▶ 3a. Redirect del proveedor → /api/payment/confirm?payment_id=…&hmac=…&ts=…
  │         (firma verificada + monto recomputado → confirma y emite licencia)
  │
  └─▶ 3b. La landing llama /api/cuenta/verify → GET /api/payment/verify?…
            (misma verificación; idempotente si ya estaba confirmada)
```

En ambos casos el backend:

1. Verifica la **firma HMAC** con ventana anti-replay (§3).
2. **Recomputa el monto esperado** desde `pagos.detalle` y lo compara con el
   monto registrado (§4). Si no coincide → `409` + alerta de seguridad.
3. Confirma el pago, genera el número de factura `F-YYYY-NNNN`, emite la
   licencia RSA y envía la factura por email (Resend).

### OmniServ (flujo por dispositivo, sin cuenta web)

La app Android no tiene carrito web: pide una **intención de pago** firmada.

```
GET /api/user/profile (JWT) → api_key de la empresa
POST /api/payment/omniserv-intent  (X-Api-Key)
  → { payment_id, monto: 3, hmac, timestamp, success_url }
App → Crixto (universal link o deeplink app-prod.crixto.org) con ese success_url
App → polling GET /api/empresas/:id/payment-status (backoff exponencial)
  → al confirmarse: GET /api/empresas/:id/licencia → licencia firmada
```

> ⚠️ **Cambio de comportamiento (Fase 23):** el redirect histórico
> `/api/payment/confirm?empresa_id=N` **ya no confirma nada**. Permitía emitir
> una licencia con sólo conocer el id de una empresa, sin pago ni firma. Fue
> reemplazado por `/api/payment/omniserv-intent`. Las versiones de la app
> anteriores a este cambio deben actualizarse.

---

## 3. Firma HMAC y anti-replay (Fase 23)

```js
signPaymentHmac(paymentId, monto, empresaId, timestamp = Date.now())
// → { hmac: HMAC-SHA256(`${paymentId}:${monto}:${empresaId}:${timestamp}`), timestamp }
```

Reglas de verificación (`verifyPaymentHmac`):

| Regla | Valor |
|---|---|
| Formato | `hmac` debe ser 64 hex minúsculas; `ts` numérico positivo |
| Comparación | `crypto.timingSafeEqual` (sin filtrar tiempo) |
| Ventana | `PAYMENT_HMAC_WINDOW_SECONDS` (default **86400** = 24 h) |
| Reloj adelantado | se toleran 60 s (`PAYMENT_HMAC_CLOCK_SKEW_SECONDS`) |
| Firma vieja/futura | se rechaza con `403` + alerta de seguridad |

La ventana es amplia **a propósito**: un pago móvil puede confirmarse horas
después de generar la intención. Acotarla con `PAYMENT_HMAC_WINDOW_SECONDS=900`
si el flujo de cobro es inmediato.

Además, cada pago tiene su propio límite de intentos:
`PAYMENT_CONFIRM_MAX_PER_MINUTE` (default 10) tanto en `/verify` como en
`/confirm`; el redirect responde `429` con página simple y la API responde
`429` + `Retry-After`.

### Alcance real de la firma (importante)

El HMAC prueba que **quien confirma conoce la firma emitida al crear la
intención**; no es una prueba criptográfica de que Crixto cobró, porque Crixto
no publica webhook ni API de estado de pagos. Por eso:

- Todo pago confirmado **sin referencia del proveedor** (`provider_ref IS NULL`)
  queda listado por el job de conciliación para revisión humana.
- Si una revisión detecta fraude, el admin revoca la licencia
  (`POST /api/admin/empresas/:id/revocar-licencia`).

---

## 4. Validación de monto (Fase 25)

`montoEsperadoDePago(pago)` recomputa el precio desde `pagos.detalle`:

- `producto: 'omniserv'` → `OMNISERV_MENSUAL` (3 USD).
- `producto: 'tog'` → `totalCarrito(periodo, modulos)`
  (base por periodo + 3 USD/mes por módulo extra, deduplicado).
- Detalle desconocido o periodo inválido → `null` ⇒ el pago se **rechaza**
  (fail-closed, nunca se confirma "a ciegas").

Si `|monto_registrado − monto_esperado| > 0.005` → `409 Monto inconsistente con
el plan seleccionado`, log `[seguridad]` y email a `SECURITY_ALERT_EMAIL`.

---

## 5. Conciliación de pagos pendientes (Fase 27)

Crixto no ofrece (a la fecha de este documento) webhook ni API pública de
estado, así que la conciliación es asistida y manual:

| Endpoint | Auth | Qué hace |
|---|---|---|
| `GET /api/admin/jobs/verify-pending-payments` | `X-Admin-Key` | Expira los pagos `pending` más viejos que `PENDING_PAYMENT_TTL_HOURS` (default 24 h) y lista los `confirmed` sin `provider_ref` |
| `POST /api/admin/pagos/:id/confirmar` | `X-Admin-Key` | Confirma a mano un pago verificado en Crixto (`{ motivo, referencia }`). Valida el monto antes de emitir |
| `POST /api/admin/empresas/:id/revocar-licencia` | `X-Admin-Key` | Revoca todas las licencias vigentes de la empresa (`{ motivo }`) |

El job **nunca** emite licencias: si duda, deja el pago pendiente o expirado.
Ejecutarlo periódicamente (cron del panel admin o manualmente antes de
facturar). Consulta sugerida:

```bash
curl -H "X-Admin-Key: $ADMIN_API_KEY" \
  https://tog-platform-production.up.railway.app/api/admin/jobs/verify-pending-payments
```

---

## 6. Device fingerprint: cambio auditado (Fase 24)

`POST /api/admin/empresas/:id/dispositivo` (`{ device_fingerprint, razon }`):

- `razon` obligatoria (5–200 caracteres).
- `device_fingerprint` debe ser hash hexadecimal (16–128) o `null` para desvincular.
- **Enfriamiento**: máximo 1 cambio por empresa cada
  `DEVICE_CHANGE_COOLDOWN_HOURS` (default 24 h) → si no, `429`.
- Se registra en `device_fingerprint_audit`: hash de la admin key usada (nunca la
  key), email del admin si llega en `X-Admin-Email`, fingerprint anterior/nuevo,
  razón, IP y user-agent.
- Se envía email al `email_contacto` de la empresa avisando del cambio.
- Auditoría consultable: `GET /api/admin/empresas/:id/audit/dispositivo`.

> Limitación conocida: la autenticación de admin es una API key compartida, por
> lo que `X-Admin-Email` es informativo (no verificado). La trazabilidad real es
> el hash de la key. Migrar a usuarios admin con 2FA está en el roadmap (Parte C).

---

## 7. Rate limiting

| Ámbito | Límite | Configurable |
|---|---|---|
| Global por IP | 60 req/min | `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` |
| `/api/empresas/:id/payment-status` | 10 req/min por empresa | — (429 + `Retry-After`) |
| `/api/payment/verify` y `/api/payment/confirm` | 10 req/min por pago | `PAYMENT_CONFIRM_MAX_PER_MINUTE` |
| `/api/payment/omniserv-intent` | 10 req/min por empresa | — |

La app Android respeta `Retry-After` y usa backoff exponencial 5 s → 30 s
(40 intentos máximos) en el polling de pago.

---

## 8. Variables de entorno

| Variable | Obligatoria | Default | Para qué |
|---|---|---|---|
| `ADMIN_API_KEY` | ✅ | — | Endpoints de admin |
| `JWT_SECRET` | ✅ | — | Tokens de la cuenta web |
| `PAYMENT_HMAC_SECRET` | ✅ | — | Firma HMAC de pagos (`openssl rand -hex 32`) |
| `LICENSE_PRIVATE_KEY_PATH` | — | `./keys/private.key` | Firma RSA de licencias |
| `PAYMENT_HMAC_WINDOW_SECONDS` | — | `86400` | Ventana anti-replay |
| `PAYMENT_CONFIRM_MAX_PER_MINUTE` | — | `10` | Intentos de confirmación por pago |
| `PENDING_PAYMENT_TTL_HOURS` | — | `24` | Antigüedad para expirar pendientes |
| `DEVICE_CHANGE_COOLDOWN_HOURS` | — | `24` | Enfriamiento de cambio de dispositivo |
| `RESEND_API_KEY` | — | — | Facturas por email |
| `INVOICE_FROM` | — | `OmniMargen <facturas@mail.omnimargen.site>` | Remitente |
| `SECURITY_ALERT_EMAIL` | — | — | Destino de alertas de seguridad |
| `SITE_URL` | — | `https://omnimargen.site` | Redirects de retorno |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | — | `60` / `60000` | Límite global por IP |

Ver `.env.example` (sin valores reales).

---

## 9. Facturas

- Numeración `F-YYYY-NNNN` (secuencial por año).
- HTML imprimible: `GET /api/pagos/:id/factura` (sólo pagos confirmados).
- Email automático al confirmar el pago (Resend). Si `RESEND_API_KEY` no está
  configurado, la factura se genera igual y sólo no se envía.
- Pendiente (nice-to-have): PDF server-side (hoy se imprime desde el navegador).

---

## 10. Documentos relacionados

- `MODULOS.md` — catálogo de módulos y precios.
- `ARQUITECTURA-MODULAR.md` — cómo se monta el ModuleLoader.
- `../../SECURITY.md` — política de seguridad del ecosistema.
- `../../ROADMAP_SEGURIDAD.md` — hallazgos y plan (Parte C: pagos y 2FA).
