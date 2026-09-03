// Tests unitarios de los helpers de Stripe (sin red real): firma HMAC de
// webhooks y construcción de la Checkout Session.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createCheckoutSession, createStripeCustomer, verifyStripeWebhook, StripeError } from './stripe.js'

const SECRET = 'whsec_test_1234567890'

function firmaPara(rawBody, secret = SECRET, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  return `t=${t},v1=${v1}`
}

test('verifyStripeWebhook: acepta firma válida y rechaza inválidas', () => {
  const raw = JSON.stringify({ id: 'evt_1', type: 'ping' })
  assert.equal(typeof verifyStripeWebhook({ secret: SECRET, rawBody: raw, signatureHeader: firmaPara(raw) }), 'number')

  // firma con otra clave
  const otra = firmaPara(raw, 'whsec_otra')
  assert.throws(() => verifyStripeWebhook({ secret: SECRET, rawBody: raw, signatureHeader: otra }), StripeError)

  // payload manipulado después de firmar
  const manipulada = raw.replace('ping', 'x')
  assert.throws(() => verifyStripeWebhook({ secret: SECRET, rawBody: manipulada, signatureHeader: firmaPara(raw) }), StripeError)

  // sin encabezado
  assert.throws(() => verifyStripeWebhook({ secret: SECRET, rawBody: raw, signatureHeader: '' }), StripeError)

  // sin secret configurado
  assert.throws(() => verifyStripeWebhook({ secret: '', rawBody: raw, signatureHeader: firmaPara(raw) }), StripeError)
})

test('createCheckoutSession: envía suscripción con precio, cliente, metadata y client_reference_id', async () => {
  let llamada
  const fetchImpl = async (url, init) => {
    llamada = { url, init }
    return { ok: true, status: 200, json: async () => ({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }) }
  }
  const sesion = await createCheckoutSession({
    secretKey: 'sk_test_x',
    priceId: 'price_distribuidor',
    customer: 'cus_123',
    clientReferenceId: 7,
    metadata: { modulo: 'distribuidor' },
    successUrl: 'http://localhost:3001/checkout/success',
    cancelUrl: 'http://localhost:3001/checkout/cancel',
    fetchImpl,
  })
  assert.equal(sesion.id, 'cs_test_1')
  assert.equal(llamada.url, 'https://api.stripe.com/v1/checkout/sessions')
  assert.equal(llamada.init.headers.Authorization, 'Bearer sk_test_x')
  const body = llamada.init.body
  // URLSearchParams codifica los corchetes de los índices de Stripe
  assert.match(body, /mode=subscription/)
  assert.match(body, /line_items%5B0%5D%5Bprice%5D=price_distribuidor/)
  assert.match(body, /customer=cus_123/)
  assert.match(body, /client_reference_id=7/)
  assert.match(body, /metadata%5Bmodulo%5D=distribuidor/)
})

test('createStripeCustomer: envía email y nombre', async () => {
  let body = ''
  const fetchImpl = async (_url, init) => {
    body = init.body
    return { ok: true, status: 200, json: async () => ({ id: 'cus_nuevo' }) }
  }
  const customer = await createStripeCustomer({ secretKey: 'sk_test_x', email: 'a@b.com', name: 'Empresa', fetchImpl })
  assert.equal(customer.id, 'cus_nuevo')
  assert.match(body, /email=a%40b\.com/)
  assert.match(body, /name=Empresa/)
})

test('stripeRequest: propaga el error de la API y falta de secretKey', async () => {
  const fetchImpl = async () => ({ ok: false, status: 402, json: async () => ({ error: { message: 'La tarjeta fue rechazada' } }) })
  await assert.rejects(
    () => createStripeCustomer({ secretKey: 'sk_test_x', email: 'a@b.com', name: 'X', fetchImpl }),
    /La tarjeta fue rechazada/,
  )
  await assert.rejects(() => createCheckoutSession({ priceId: 'p', successUrl: 'x', cancelUrl: 'x' }), StripeError)
})
