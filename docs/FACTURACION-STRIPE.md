# TOG Platform — Facturación y Sincronización de Licencia con Stripe

> Documento técnico de la integración entre **pagos (Stripe)** y **licencias (TOG Platform)**. El flujo de licenciamiento puro está en `MODULOS.md`; la arquitectura modular está en `ARQUITECTURA-MODULAR.md`. Este doc los conecta.

---

## 1. Principios

1. **La licencia siempre es local y offline-first.** Roberto puede operar meses sin internet.
2. **Stripe nunca toca la app de escritorio.** Toda la lógica sensible de pago vive en un backend que tú controlas.
3. **El backend es la única fuente de verdad sobre el estado de la suscripción.** La app consulta, pero no decide.
4. **El grace period es generoso.** Un fallo de pago no apaga el sistema al día siguiente.

---

## 2. Arquitectura

```
┌─────────────┐    1. pagar     ┌──────────┐    2. pago OK    ┌──────────────┐
│ App TOG     │ ──────────────▶ │ Stripe   │ ───────────────▶ │  Webhook     │
│ (Roberto)   │                 │ Checkout │                  │  tu backend  │
└─────────────┘                 └──────────┘                  └──────────────┘
       │                                                           │
       │ 3. abrir                                                   │
       │    checkout           ┌──────────────────────┐             │
       │ ◀──────────────────── │  POST /checkout-sess │             │
       │                       │  (tu backend crea    │             │
       │                       │   Stripe session)    │             │
       │                       └──────────────────────┘             │
       │                                                           │
       │ 6. descargar nueva                                       │
       │    licencia                                              ▼
       │ ◀────────────────────────────────────────────────  ┌───────────────┐
       │                                                     │ actualizar DB │
       │                                                     │ + firmar      │
       │                                                     │ licencia     │
       │                                                     └───────────────┘
       │
       │ 7. validar firma RSA → activar módulo
```

**Componentes:**

| Componente | Stack sugerido | Costo mensual aprox |
|------------|---------------|---------------------|
| App TOG Admin | Electron + React (existente) | $0 |
| Backend admin | Node.js + Express o Fastify | $0 (Vercel/ Railway free tier) |
| Base de datos | Postgres (Supabase/Neon free tier) | $0 |
| Stripe | — | ~2.9% + $0.30 por transacción |
| Notificaciones email | Resend | $0 hasta 100 emails/día |

**Costo fijo estimado al inicio**: $0 hasta ~50 clientes activos.

---

## 3. Modelo de datos del backend

```sql
-- Empresas clientes
CREATE TABLE empresas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre          TEXT NOT NULL,
  rif             TEXT UNIQUE NOT NULL,
  email_contacto  TEXT NOT NULL,
  stripe_customer_id TEXT UNIQUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Licencias emitidas (historial completo, no solo la actual)
CREATE TABLE licencias (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      UUID NOT NULL REFERENCES empresas(id),
  modules         TEXT[] NOT NULL,         -- ['comercializador', 'distribuidor']
  max_usuarios    INT  DEFAULT 1,
  max_sucursales  INT  DEFAULT 1,
  issued_at       TIMESTAMPTZ NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  motivo_revocado TEXT,
  firma_rsa       TEXT NOT NULL,           -- base64 de la firma
  emitida_por     TEXT                     -- 'auto-stripe' | 'manual:admin@...'
);

-- Suscripciones de Stripe
CREATE TABLE suscripciones (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id              UUID NOT NULL REFERENCES empresas(id),
  stripe_subscription_id  TEXT UNIQUE NOT NULL,
  stripe_price_id         TEXT NOT NULL,
  estado                  TEXT NOT NULL,    -- active | past_due | canceled | unpaid
  current_period_end      TIMESTAMPTZ,
  cancel_at_period_end    BOOLEAN DEFAULT FALSE,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- Eventos de webhook (auditoría + idempotencia)
CREATE TABLE webhook_events (
  stripe_event_id  TEXT PRIMARY KEY,        -- idempotencia: si llega 2 veces, ignoramos
  tipo             TEXT NOT NULL,
  payload          JSONB NOT NULL,
  procesado_en     TIMESTAMPTZ DEFAULT NOW()
);
```

La **licencia activa** de una empresa es la fila en `licencias` con `revoked_at IS NULL` y `expires_at > NOW()` de mayor `issued_at`.

---

## 4. Endpoints del backend

| Método | Ruta | Auth | Propósito |
|--------|------|------|-----------|
| `POST` | `/api/empresas` | admin | Crear empresa (CRM manual, alta inicial) |
| `GET`  | `/api/empresas/:id/licencia` | apiKey | App consulta su licencia actual |
| `POST` | `/api/checkout-session` | apiKey | Crear sesión Stripe para comprar módulo |
| `POST` | `/api/portal-session` | apiKey | Devolver URL del Customer Portal de Stripe |
| `POST` | `/api/webhook/stripe` | firma Stripe | Recibir eventos de Stripe |
| `GET`  | `/api/admin/empresas` | admin | Panel admin (futuro) |

La app usa una `apiKey` por instalación (generada la primera vez, almacenada cifrada localmente). El admin usa OAuth contra tu propio SSO o auth básica con 2FA.

---

## 5. Flujo: Roberto compra un módulo nuevo

### 5.1 Online (con tarjeta)

```
1. Roberto en TOG Admin → Configuración → Licencia → Catálogo de módulos
2. Click en "Contratar Distribuidor ($25/mes)"
3. App llama POST /api/checkout-session con { modulo: 'distribuidor', apiKey }
4. Backend verifica empresa, crea (o reutiliza) Stripe Customer
5. Backend llama stripe.checkout.sessions.create({
     customer: cus_id,
     mode: 'subscription',
     line_items: [{ price: price_id_distribuidor, quantity: 1 }],
     success_url: 'tog-admin://licencia/actualizada',
     cancel_url: 'tog-admin://licencia/cancelada',
     metadata: { empresa_id, modulo }
   })
6. Backend responde { url }
7. App abre la URL en el navegador default (shell.openExternal)
8. Roberto paga con tarjeta
9. Stripe redirige a tog-admin://licencia/actualizada
10. App captura el deep link, llama GET /api/empresas/:id/licencia
11. Backend devuelve la nueva licencia firmada
12. App valida firma RSA localmente
13. App guarda licencia, aplica módulos nuevos, notifica al usuario
14. Módulo activo. Sin reinstalar. Sin reiniciar Windows. (Solo el proceso de la app.)
```

### 5.2 Offline (sin tarjeta / sin internet)

```
1. Roberto te llama: "quiero Distribuidor"
2. Tú abres tu panel admin, eliges la empresa, agregas 'distribuidor'
3. Backend emite licencia nueva, la firma
4. Te muestra la clave en pantalla (texto + QR con la clave)
5. Tú la mandas por WhatsApp o la imprimes
6. Roberto abre TOG Admin → Config → Licencia → "Cargar clave manual"
7. Pega el texto o escanea QR
8. App valida firma RSA localmente
9. Módulo activo
```

> El modo offline **es ciudadano de primera**, no un fallback vergonzoso. Muchos clientes en LATAM prefieren transferencia bancaria o pago móvil y no tarjeta. Sopórtalo nativamente.

---

## 6. Webhooks de Stripe (lo importante)

| Evento | Acción del backend |
|--------|--------------------|
| `checkout.session.completed` | Si metadata.modulo existe, crear/renovar licencia con ese módulo |
| `invoice.payment_succeeded` | Renovar `expires_at` por N meses, actualizar `current_period_end` |
| `invoice.payment_failed` | Marcar suscripción `past_due`; **NO** revocar licencia todavía (grace period) |
| `customer.subscription.updated` | Reflejar cambios de plan / cancelación |
| `customer.subscription.deleted` | Marcar `cancel_at_period_end = true`; licencia sigue válida hasta `current_period_end` |
| `customer.subscription.deleted` + período vencido | Revocar licencia (programado vía job diario) |

**Idempotencia**: la tabla `webhook_events` con PK `stripe_event_id` impide procesar el mismo evento dos veces.

**Verificación de firma**: SIEMPRE `stripe.webhooks.constructEvent()` con `STRIPE_WEBHOOK_SECRET`. NUNCA confiar en el body sin verificar.

---

## 7. Grace period

Un fallo de tarjeta **no apaga la app al día siguiente**. Política recomendada:

| Día desde el fallo | Acción |
|--------------------|--------|
| 0 | Pago falla. Suscripción queda `past_due`. Email al cliente. |
| 3 | Email recordatorio + notificación in-app |
| 7 | Banner en app: "Tu pago falló. Actualiza tu método antes del día 14." |
| 14 | Licencia pasa a estado `payment_failed`. App sigue funcionando **en modo lectura** (consulta, reportes, exportar) pero bloquea escritura (no se pueden crear ventas/compras). |
| 30 | Licencia revocada. App exige activación. |

Estos números son **configurables por el admin** (no hardcoded). Te dan margen para casos humanos ("se fue la luz, no pude actualizar la tarjeta").

---

## 8. Cómo se firma la licencia

El backend tiene una **clave privada RSA-2048** (¡en variables de entorno, NUNCA en el código!). La clave pública está **embebida en el código de TOG Admin** (ya está en `license.ts`).

```ts
// Backend: tools/sign-license.ts
import crypto from 'node:crypto'
import fs from 'node:fs'

const PRIVATE_KEY = fs.readFileSync(process.env.LICENSE_PRIVATE_KEY_PATH!, 'utf8')

export function signLicense(payload: Omit<LicensePayload, 'signature'>): string {
  const json = JSON.stringify(payload, Object.keys(payload).sort())
  const sign = crypto.createSign('RSA-SHA256')
  sign.update(json)
  sign.end()
  return sign.sign(PRIVATE_KEY, 'base64')
}

// Devuelve: base64(JSON.stringify(payload)) + '.' + signature
export function encodeLicense(payload: Omit<LicensePayload, 'signature'>): string {
  const signature = signLicense(payload)
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${signature}`
}
```

En la app (ya implementado, expandir):

```ts
// src/main/services/license.ts (existente, completar)
import crypto from 'node:crypto'
import fs from 'node:fs'

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
...
-----END PUBLIC KEY-----`

export function verifyLicense(licenseString: string): LicensePayload | null {
  const [body, signature] = licenseString.split('.')
  if (!body || !signature) return null

  const payload: LicensePayload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))

  const verify = crypto.createVerify('RSA-SHA256')
  verify.update(JSON.stringify(payload, Object.keys(payload).sort()))
  verify.end()

  if (!verify.verify(PUBLIC_KEY, signature, 'base64')) return null

  // Anti-tampering: fecha del sistema no retrocedió
  // (ya implementado)
  return payload
}
```

**Importante**: la clave pública embebida **debe ser exactamente la misma** que emparejaste con la privada en el backend. Si rotás la clave, hay que actualizar TOG Admin.

---

## 9. Seguridad

| Riesgo | Mitigación |
|--------|-----------|
| `STRIPE_SECRET_KEY` se filtra | Variables de entorno, nunca en código. Rotar si se filtra. |
| Licencia firmada es interceptada y reusada | La licencia lleva `empresa.rif` + (opcional) fingerprint del PC. Si dos PCs distintos usan la misma licencia con la misma `rif`, válido. Si PCs distintos de empresas distintas, fraude. |
| Cliente modifica el `.exe` para bypassear validación | `license.ts` ya tiene anti-tampering básico. Mejorar con checksums firmados del binario. No es perfecto, pero sube el costo. |
| Cliente paga y no recibe licencia | Webhook → DB → API idempotente. Si pasa >5 min y no se actualizó, "Sincronizar" fuerza pull. |
| Cliente no paga pero sigue usando | Backend revoca, próxima vez que la app sincroniza (o cada N días) la licencia cae. Sin internet, el cliente puede seguir indefinidamente offline — es el costo de ser offline-first. Mitigable con check-in obligatorio cada 30 días. |

---

## 10. Configuración inicial (lo que tienes que hacer una vez)

### En Stripe Dashboard
1. Crear cuenta (si no tienes).
2. Crear un **Product** por edición (`Tog Admin Starter`, `Tog Admin Professional`, etc.) y un **Product** por cada módulo addon.
3. Crear un **Price** recurrente (mensual) por cada uno.
4. Guardar los `price_id` en variables de entorno del backend.
5. Configurar el **Webhook endpoint** apuntando a `https://tu-backend.com/api/webhook/stripe`. Eventos a escuchar: los listados arriba.
6. Guardar el **Webhook Signing Secret** (`whsec_...`) en variable de entorno.

### En tu backend
1. Crear proyecto Node (Express/Fastify).
2. Variables de entorno mínimas:
   ```
   DATABASE_URL=postgres://...
   STRIPE_SECRET_KEY=sk_live_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   LICENSE_PRIVATE_KEY_PATH=/secrets/license_private.pem
   ADMIN_API_KEY=...
   ```
3. Generar par RSA:
   ```bash
   openssl genrsa -out license_private.pem 2048
   openssl rsa -in license_private.pem -pubout -out license_public.pem
   ```
4. Copiar `license_public.pem` al código de TOG Admin (reemplazar la actual).
5. Desplegar en Vercel/Railway/Fly.io.

### En TOG Admin
1. Reemplazar `PUBLIC_KEY` en `src/main/services/license.ts` con la nueva clave pública.
2. Agregar endpoint de sincronización en `Config → Licencia → Sincronizar` que llama a `GET /api/empresas/:id/licencia`.
3. Manejar el deep link `tog-admin://licencia/actualizada` (registrar protocolo en NSIS installer).

---

## 11. Costos y comisiones

**Stripe cobra** (a septiembre 2025, verificar siempre):
- 2.9% + $0.30 por cargo de tarjeta exitoso (USA).
- Variaciones por país. Venezuela suele ir por ~3.9% + comisión fija mayor** porque las tarjetas son internacionales.

**Tu margen**, si cobras $25/mes por Distribuidor:
- Ingreso: $25.00
- Costo Stripe: ~$1.50
- Costo backend (amortizado por cliente): ~$0.10
- **Margen neto: ~$23.40/cliente/mes**

A 10 clientes en Distribuidor: **$234/mes pasivos**. A 50: **$1170/mes pasivos**. La escalabilidad del modelo es el punto.

---

## 12. Roadmap de implementación

| Sprint | Qué |
|--------|-----|
| 0 (1 sem) | Crear backend mínimo (Express + Postgres), endpoint `GET /licencia` que devuelve JSON firmado |
| 1 (2 sem) | TOG Admin → Config → Licencia → botón "Sincronizar" que descarga la licencia |
| 2 (2 sem) | Stripe Checkout para 1 módulo (Distribuidor). Webhook básico. |
| 3 (1 sem) | Grace period + emails (Resend). |
| 4 (2 sem) | Customer Portal link + cambio de tarjeta. |
| 5 (2 sem) | Panel admin web mínimo (lista de empresas, ver suscripción, revocar). |

**Total MVP**: ~10 semanas para tener Roberto pagando con tarjeta y recibiendo su módulo automáticamente.

---

## 13. Lo que NO hace este flujo (y lo que sí necesita)

| NO hace | Sí necesita |
|---------|-------------|
| No genera facturas fiscales (SENIAT, SUNAT, etc.) | Eso es un proyecto aparte con un proveedor de facturación electrónica por país. |
| No cobra en moneda local automáticamente | Por ahora Stripe cobra en USD. Multi-moneda es una mejora futura. |
| No hace retención de impuestos del servicio | Depende de tu país. Consulta con tu contador. |
| No gestiona métodos de pago manuales (transferencia) | El modo offline los soporta vía clave manual, pero no hay dashboard para ti. Un CRUD básico de "pago manual registrado" es trivial de añadir. |

---

## 14. Documentos relacionados

- `MODULOS.md` — catálogo de módulos, ediciones, pricing.
- `ARQUITECTURA-MODULAR.md` — cómo se monta el ModuleLoader.
- `auto-license-stripe.md` — borrador original de este flujo (referencia histórica).