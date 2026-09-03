// E2E del webhook de Stripe SIN red: se emula el evento firmado con la firma
// HMAC correcta y se verifica que la licencia de la empresa se emite/actualiza
// con el módulo comprado, de forma idempotente (mismo evento = sin duplicados).

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpDir = mkdtempSync(join(tmpdir(), 'tog-platform-stripe-'))
process.env.TOG_PLATFORM_DATA = join(tmpDir, 'data')
process.env.ADMIN_API_KEY = 'stripe-admin-key'
process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_1234567890'
process.env.STRIPE_PRICE_DISTRIBUIDOR = 'price_distribuidor'

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const keyPath = join(tmpDir, 'private.pem')
writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
process.env.LICENSE_PRIVATE_KEY_PATH = keyPath

const SECRET = 'whsec_test_1234567890'

let server
let base = ''
let empresa // { id, api_key }

function firmaPara(rawBody, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${rawBody}`).digest('hex')
  return `t=${t},v1=${v1}`
}

async function enviarWebhook(evento) {
  const raw = JSON.stringify(evento)
  const res = await fetch(base + '/api/webhook/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': firmaPara(raw) },
    body: raw,
  })
  return { status: res.status, json: await res.json() }
}

before(async () => {
  const { startServer } = await import('./server.js')
  server = startServer({ port: 0 })
  await new Promise((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${server.address().port}`

  const created = await fetch(base + '/api/empresas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': 'stripe-admin-key' },
    body: JSON.stringify({ nombre: 'Distribuidora Global SRL', pais: 'AR', documento: '30-99999999-9', email_contacto: 'ventas@global.com.ar' }),
  })
  assert.equal(created.status, 201)
  empresa = await created.json()
})

after(async () => {
  server?.close()
  const { closeDatabase } = await import('./db.js')
  closeDatabase()
  rmSync(tmpDir, { recursive: true, force: true })
})

test('webhook rechaza firma inválida', async () => {
  const raw = JSON.stringify({ id: 'evt_mal', type: 'ping' })
  const res = await fetch(base + '/api/webhook/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=firma-invalida' },
    body: raw,
  })
  assert.equal(res.status, 400)
})

test('checkout.session.completed emite licencia con el módulo comprado y crea suscripción', async () => {
  const evento = {
    id: 'evt_checkout_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_1',
        client_reference_id: String(empresa.id),
        customer: 'cus_global',
        subscription: 'sub_global_1',
        metadata: { modulo: 'distribuidor' },
      },
    },
  }
  const res = await enviarWebhook(evento)
  assert.equal(res.status, 200)
  assert.equal(res.json.received, true)
  assert.equal(res.json.duplicado, false)

  // La empresa ya puede sincronizar: la licencia activa incluye distribuidor
  const activa = await fetch(base + `/api/empresas/${empresa.id}/licencia`, {
    headers: { 'x-api-key': empresa.api_key },
  })
  assert.equal(activa.status, 200)
  const { licencia } = await activa.json()
  assert.ok((licencia.modules || []).includes('distribuidor'))
  assert.ok(licencia.firma, 'la licencia emitida por Stripe debe estar firmada')
  assert.ok(licencia.expira >= new Date().toISOString().split('T')[0], 'debe expirar en el futuro')

  // Suscripción activa asociada
  const { db } = await import('./db.js')
  const sub = db.prepare('SELECT * FROM suscripciones WHERE empresa_id = ?').get(empresa.id)
  assert.ok(sub, 'debe existir la suscripción')
  assert.equal(sub.estado, 'active')
  assert.equal(sub.stripe_subscription_id, 'sub_global_1')
})

test('el mismo evento duplicado NO vuelve a emitir licencia (idempotencia)', async () => {
  const evento = {
    id: 'evt_checkout_1', // mismo id que el anterior
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_1',
        client_reference_id: String(empresa.id),
        customer: 'cus_global',
        subscription: 'sub_global_1',
        metadata: { modulo: 'distribuidor' },
      },
    },
  }
  const res = await enviarWebhook(evento)
  assert.equal(res.status, 200)
  assert.equal(res.json.duplicado, true)

  const { db } = await import('./db.js')
  const conteo = db.prepare('SELECT COUNT(*) AS n FROM licencias WHERE empresa_id = ?').get(empresa.id)
  assert.equal(conteo.n, 1, 'debe seguir habiendo una sola licencia')
})

test('un segundo módulo comprado suma módulos a la licencia (sin duplicados)', async () => {
  process.env.STRIPE_PRICE_PRODUCTOR = 'price_productor'
  const evento = {
    id: 'evt_checkout_2',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_2',
        client_reference_id: String(empresa.id),
        customer: 'cus_global',
        subscription: 'sub_global_2',
        metadata: { modulo: 'productor' },
      },
    },
  }
  const res = await enviarWebhook(evento)
  assert.equal(res.status, 200)

  const activa = await fetch(base + `/api/empresas/${empresa.id}/licencia`, {
    headers: { 'x-api-key': empresa.api_key },
  })
  const { licencia } = await activa.json()
  assert.deepEqual(licencia.modules, ['distribuidor', 'productor'])
})

test('customer.subscription.deleted marca la suscripción como cancelada', async () => {
  const evento = {
    id: 'evt_cancel_1',
    type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_global_1' } },
  }
  const res = await enviarWebhook(evento)
  assert.equal(res.status, 200)

  const { db } = await import('./db.js')
  const sub = db.prepare("SELECT estado FROM suscripciones WHERE stripe_subscription_id = 'sub_global_1'").get()
  assert.equal(sub.estado, 'cancelado')
})
