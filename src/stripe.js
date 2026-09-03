// Helpers mínimos de Stripe SIN SDK: la API de Stripe es REST + JSON y la
// firma de webhooks es HMAC-SHA256 estándar. Todo con módulos built-in de Node
// y `fetch` inyectable para poder probar sin red.

import crypto from 'node:crypto'

const STRIPE_API = 'https://api.stripe.com'

export class StripeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'StripeError'
  }
}

export async function stripeRequest(path, { secretKey, form = {}, fetchImpl = globalThis.fetch }) {
  if (!secretKey) throw new StripeError('Stripe no configurado (STRIPE_SECRET_KEY)')
  const res = await fetchImpl(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form).toString(),
  })
  let body = {}
  try {
    body = await res.json()
  } catch {
    body = {}
  }
  if (!res.ok) throw new StripeError(body?.error?.message || `Stripe respondió con estado ${res.status}`)
  return body
}

/**
 * Crea una Checkout Session (modo suscripción) para un módulo.
 * metadata.modulo + client_reference_id (id de empresa) permiten asociar el
 * pago con la empresa en el webhook, sin depender de expand de Stripe.
 */
export async function createCheckoutSession({
  secretKey,
  priceId,
  customer,
  metadata = {},
  clientReferenceId,
  successUrl,
  cancelUrl,
  fetchImpl,
}) {
  const form = {
    mode: 'subscription',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    ...(customer ? { customer } : {}),
    ...(clientReferenceId ? { client_reference_id: String(clientReferenceId) } : {}),
    success_url: successUrl,
    cancel_url: cancelUrl,
  }
  for (const [key, value] of Object.entries(metadata || {})) {
    form[`metadata[${key}]`] = String(value)
  }
  return stripeRequest('/v1/checkout/sessions', { secretKey, form, fetchImpl })
}

export async function createStripeCustomer({ secretKey, email, name, fetchImpl }) {
  return stripeRequest('/v1/customers', { secretKey, form: { email, name }, fetchImpl })
}

/**
 * Verifica la firma de un webhook de Stripe (header `t=...,v1=...`, HMAC-SHA256
 * sobre `t + "." + rawBody`). Devuelve el timestamp `t` si es válida.
 */
export function verifyStripeWebhook({ secret, rawBody, signatureHeader }) {
  if (!secret) throw new StripeError('Webhook de Stripe no configurado (STRIPE_WEBHOOK_SECRET)')
  if (!signatureHeader || typeof rawBody !== 'string' || !rawBody) {
    throw new StripeError('Encabezado de firma del webhook ausente')
  }
  const parts = {}
  for (const chunk of signatureHeader.split(',')) {
    const idx = chunk.indexOf('=')
    if (idx > 0) parts[chunk.slice(0, idx).trim()] = chunk.slice(idx + 1).trim()
  }
  const t = parts.t
  const v1 = parts.v1
  if (!t || !v1) throw new StripeError('Encabezado de firma del webhook inválido')

  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  const a = Buffer.from(v1)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new StripeError('Firma del webhook inválida')
  }
  return Number(t)
}
