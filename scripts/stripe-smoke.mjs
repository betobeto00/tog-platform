#!/usr/bin/env node
/**
 * Smoke de Stripe en MODO TEST (pago real con tarjeta de prueba).
 *
 * Qué hace:
 *   1. Valida las claves de Stripe (sk_test / whsec) y levanta el backend local.
 *   2. Crea (si hace falta) el producto + precio de suscripción del módulo y una
 *      empresa de prueba en el backend.
 *   3. Crea una Checkout Session real vía el endpoint del backend.
 *   4. Te pide pagar la URL con la tarjeta de prueba  4242 4242 4242 4242.
 *   5. Espera a que Stripe confirme el pago y emula el webhook firmado contra el
 *      backend local (en producción lo envía Stripe a tu endpoint HTTPS).
 *   6. Verifica que la empresa ya puede sincronizar la licencia con el módulo.
 *
 * Requiere (modo test):
 *   STRIPE_SECRET_KEY=sk_test_...   STRIPE_WEBHOOK_SECRET=whsec_...
 * Opcional:
 *   STRIPE_PRICE_DISTRIBUIDOR       (si ya creaste el precio en el dashboard)
 *   LICENSE_PRIVATE_KEY_PATH        (default: ../tog-admin/keys/private.key)
 *   ADMIN_API_KEY                   (default: dev-admin-key)
 * Uso: node scripts/stripe-smoke.mjs
 */
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLATFORM = path.resolve(HERE, '..')
const STRIPE_API = 'https://api.stripe.com'
const MODULO = 'distribuidor'

// ---- utilidades ----------------------------------------------------------

function cargarEnvArchivo() {
  // dotenv mínimo: no agregamos dependencias
  const envPath = path.join(PLATFORM, '.env')
  if (!fs.existsSync(envPath)) return
  for (const linea of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
  }
}

async function stripeGet(ruta) {
  const res = await fetch(`${STRIPE_API}${ruta}`, { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } })
  if (!res.ok) throw new Error(`Stripe GET ${ruta} → ${res.status}`)
  return res.json()
}

async function stripePost(ruta, form) {
  const res = await fetch(`${STRIPE_API}${ruta}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Stripe POST ${ruta} → ${res.status}: ${body?.error?.message || ''}`)
  return body
}

function firmarWebhook(rawBody) {
  const t = Math.floor(Date.now() / 1000)
  const v1 = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${rawBody}`).digest('hex')
  return `t=${t},v1=${v1}`
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms))

async function esperarHealth(url, child) {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${url}/api/health`)
      if (res.ok) return
    } catch {
      // aún arrancando
    }
    if (child?.exitCode != null) throw new Error(`El backend terminó antes de arrancar (código ${child.exitCode})`)
    await esperar(250)
  }
  throw new Error('El backend local no respondió en /api/health')
}

// ---- flujo principal -----------------------------------------------------

async function main() {
  cargarEnvArchivo()

  const secret = process.env.STRIPE_SECRET_KEY || ''
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || ''
  if (!secret.startsWith('sk_test_')) {
    console.error('❌ Falta STRIPE_SECRET_KEY (modo test: sk_test_…).')
    console.error('   Pruébalo así (o en un .env local):')
    console.error('   STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... node scripts/stripe-smoke.mjs')
    process.exit(1)
  }
  if (!webhookSecret) {
    console.error('❌ Falta STRIPE_WEBHOOK_SECRET (whsec_…, pestaña Webhooks del dashboard).')
    process.exit(1)
  }

  // 0. Validar la clave de Stripe con una llamada real
  await stripeGet('/v1/customers?limit=1')
  console.log('✔  Clave de Stripe (test) válida')

  // 1. Levantar el backend local
  const port = Number(process.env.SMOKE_PORT || 3111)
  const keyDefault = path.resolve(PLATFORM, '..', 'tog-admin', 'keys', 'private.key')
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: PLATFORM,
    env: {
      ...process.env,
      PORT: String(port),
      ADMIN_API_KEY: process.env.ADMIN_API_KEY || 'dev-admin-key',
      LICENSE_PRIVATE_KEY_PATH: process.env.LICENSE_PRIVATE_KEY_PATH || keyDefault,
      TOG_PLATFORM_DATA: path.join(PLATFORM, 'data-smoke'),
      STRIPE_DOMAIN: `http://localhost:${port}`,
    },
    stdio: 'inherit',
  })
  const base = `http://localhost:${port}`
  try {
    await esperarHealth(base, child)

    // 2. Precio del módulo (crear en modo test si no está configurado)
    let priceId = process.env.STRIPE_PRICE_DISTRIBUIDOR || ''
    if (!priceId) {
      const producto = await stripePost('/v1/products', { name: 'TOG Platform — Módulo Distribuidor (test)', metadata: { modulo: MODULO } })
      const precio = await stripePost('/v1/prices', {
        product: producto.id,
        currency: 'usd',
        unit_amount: '2500',
        recurring: { interval: 'month' },
        metadata: { modulo: MODULO },
      })
      priceId = precio.id
      console.log(`✔  Precio creado en modo test: ${priceId}`)
      console.log(`   ⤷ para reutilizarlo, exporta STRIPE_PRICE_DISTRIBUIDOR=${priceId}`)
    } else {
      console.log(`✔  Usando precio configurado: ${priceId}`)
    }

    // 3. Empresa de prueba en el backend
    const sufijo = Date.now().toString(36)
    const empresaRes = await fetch(`${base}/api/empresas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': process.env.ADMIN_API_KEY || 'dev-admin-key' },
      body: JSON.stringify({ nombre: `Smoke Test ${sufijo}`, pais: 'US', documento: `EIN-99-${sufijo.toUpperCase()}`, email_contacto: 'smoke@example.com' }),
    })
    if (empresaRes.status !== 201) throw new Error(`No se pudo crear la empresa (${empresaRes.status})`)
    const empresa = await empresaRes.json()
    console.log(`✔  Empresa de prueba creada (id ${empresa.id})`)

    // 4. Checkout Session real
    const checkout = await fetch(`${base}/api/checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': empresa.api_key },
      body: JSON.stringify({ modulo: MODULO }),
    })
    if (checkout.status !== 201) throw new Error(`Checkout falló (${checkout.status}): ${JSON.stringify(await checkout.json())}`)
    const { url } = await checkout.json()
    const sessionId = new URL(url).pathname.split('/').pop().split('#')[0]
    console.log('\n💳  Abre esta URL y paga con la tarjeta de prueba:')
    console.log(`    ${url}`)
    console.log('    Tarjeta: 4242 4242 4242 4242 · cualquier fecha futura · CVC cualquiera')
    console.log('    Esperando el pago (hasta 5 minutos)…\n')

    // 5. Esperar confirmación de Stripe
    let session = null
    for (let i = 0; i < 100; i++) {
      session = await stripeGet(`/v1/checkout/sessions/${sessionId}`)
      if (session.payment_status === 'paid' && session.status === 'complete') break
      await esperar(3000)
    }
    if (!session || session.payment_status !== 'paid') {
      console.error('⏰  Tiempo de espera agotado. Cuando pagues, reanuda con:')
      console.error(`    node scripts/stripe-smoke.mjs --resume ${sessionId} --empresa ${empresa.id} --apikey ${empresa.api_key}`)
      process.exit(2)
    }
    console.log('✔  Pago confirmado por Stripe (payment_status=paid)')

    // 6. Emular el webhook firmado (mismo contenido que enviaría Stripe)
    const evento = {
      id: `evt_smoke_${sufijo}`,
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: session.id,
          client_reference_id: session.client_reference_id,
          customer: session.customer,
          subscription: session.subscription,
          metadata: session.metadata || {},
        },
      },
    }
    const raw = JSON.stringify(evento)
    const wh = await fetch(`${base}/api/webhook/stripe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': firmarWebhook(raw) },
      body: raw,
    })
    const whBody = await wh.json().catch(() => ({}))
    if (wh.status !== 200) throw new Error(`Webhook rechazado (${wh.status}): ${JSON.stringify(whBody)}`)

    // 7. Verificación final: la empresa sincroniza la licencia con el módulo
    const activa = await fetch(`${base}/api/empresas/${empresa.id}/licencia`, { headers: { 'x-api-key': empresa.api_key } })
    if (activa.status !== 200) throw new Error(`La licencia no quedó activa (${activa.status})`)
    const { licencia } = await activa.json()
    if (!(licencia.modules || []).includes(MODULO)) throw new Error('La licencia no incluye el módulo comprado')
    console.log('\n✅ Stripe smoke OK: pago real (test) → webhook → licencia firmada con el módulo Distribuidor.')
    console.log(`   Empresa: id=${empresa.id} · api_key=${empresa.api_key} · expira ${licencia.expira}`)
  } finally {
    child.kill()
    try {
      fs.rmSync(path.join(PLATFORM, 'data-smoke'), { recursive: true, force: true })
    } catch {
      // el cierre de la DB se maneja al terminar el proceso
    }
  }
}

main().catch((err) => {
  console.error('\n❌ Stripe smoke FALLÓ:', err?.message || err)
  process.exit(1)
})
