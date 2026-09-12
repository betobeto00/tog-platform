import http from 'node:http'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { db, getActiveLicense, closeDatabase, NOW } from './db.js'
import { signLicense, loadPrivateKey, MODULE_IDS } from './sign.js'
import { createCheckoutSession, createStripeCustomer, verifyStripeWebhook } from './stripe.js'

const PORT = Number(process.env.PORT || 3001)
const PRIVATE_KEY_PATH = process.env.LICENSE_PRIVATE_KEY_PATH || './keys/private.key'
const STRIPE_DOMAIN = (process.env.STRIPE_DOMAIN || `http://localhost:${PORT}`).replace(/\/+$/, '')

// --- Validación de secrets obligatorios ---
const REQUIRED_ENV = {
  ADMIN_API_KEY: process.env.ADMIN_API_KEY,
  PAYMENT_HMAC_SECRET: process.env.PAYMENT_HMAC_SECRET,
  JWT_SECRET: process.env.JWT_SECRET,
}
const missing = Object.entries(REQUIRED_ENV).filter(([, v]) => !v).map(([k]) => k)
if (missing.length > 0) {
  console.error(`\n❌ Falta variable de entorno obligatoria: ${missing.join(', ')}`)
  console.error('   Define las env vars antes de arrancar el servidor.')
  process.exit(1)
}

const ADMIN_API_KEY = REQUIRED_ENV.ADMIN_API_KEY
const PAYMENT_HMAC_SECRET = REQUIRED_ENV.PAYMENT_HMAC_SECRET
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || ''
const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const INVOICE_FROM = process.env.INVOICE_FROM || 'OmniMargen <facturas@omnimargen.site>'
const MODULOS_COMPRABLES = MODULE_IDS.filter((m) => m !== 'comercializador')

function priceIdFor(modulo) {
  return process.env[`STRIPE_PRICE_${String(modulo).toUpperCase()}`] || ''
}

function plusMonths(baseDate, months) {
  const d = new Date(baseDate)
  d.setMonth(d.getMonth() + months)
  return d.toISOString().split('T')[0]
}

function plusDays(baseDate, days) {
  const d = new Date(baseDate)
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

const GRACE_DAYS = Number(process.env.LICENSE_GRACE_DAYS || 14)

let privateKey = null
try {
  if (process.env.LICENSE_PRIVATE_KEY) {
    privateKey = process.env.LICENSE_PRIVATE_KEY
    console.log('🔑 Clave privada cargada desde variable de entorno')
  } else {
    privateKey = loadPrivateKey(PRIVATE_KEY_PATH)
    console.log(`🔑 Clave privada cargada desde ${PRIVATE_KEY_PATH}`)
  }
} catch (err) {
  console.warn(`⚠️  No se pudo cargar la clave privada: ${err.message}`)
  console.warn('   La emisión de licencias no estará disponible hasta configurar LICENSE_PRIVATE_KEY')
}

// ---------- CORS ----------

const isDev = process.env.NODE_ENV !== 'production'
const ALLOWED_ORIGINS = [
  'https://omnimargen.site',
  'https://www.omnimargen.site',
  ...(isDev ? ['http://localhost:3000', 'http://localhost:3001'] : []),
]

function setCorsHeaders(res, origin) {
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Key, X-Api-Key, Stripe-Signature')
  res.setHeader('Access-Control-Max-Age', '86400')
}

// ---------- Rate limiting ----------

const RATE_LIMIT_WINDOW_MS = 60_000 // 1 minuto
const RATE_LIMIT_MAX = 60            // 60 requests por minuto por IP
const rateLimitMap = new Map()
let rateLimitCleanupTimer = null

function cleanupRateLimit() {
  const now = Date.now()
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.start > RATE_LIMIT_WINDOW_MS) rateLimitMap.delete(ip)
  }
  if (rateLimitMap.size === 0 && rateLimitCleanupTimer) {
    clearInterval(rateLimitCleanupTimer)
    rateLimitCleanupTimer = null
  }
}

function isRateLimited(ip) {
  const now = Date.now()
  let entry = rateLimitMap.get(ip)
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW_MS) {
    entry = { start: now, count: 0 }
    rateLimitMap.set(ip, entry)
  }
  entry.count++
  if (!rateLimitCleanupTimer) {
    rateLimitCleanupTimer = setInterval(cleanupRateLimit, RATE_LIMIT_WINDOW_MS)
  }
  return entry.count > RATE_LIMIT_MAX
}

// ---------- utilidades ----------

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        resolve(null)
      }
    })
  })
}

function readRawBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
  })
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload, null, 2))
}

async function requireAdmin(req, res) {
  if (req.headers['x-admin-key'] !== ADMIN_API_KEY) {
    json(res, 401, { success: false, error: 'X-Admin-Key inválida' })
    return false
  }
  return true
}

async function requireEmpresa(req, res) {
  const apiKey = req.headers['x-api-key']
  if (!apiKey) {
    json(res, 401, { success: false, error: 'Falta X-Api-Key' })
    return null
  }
  const empresa = await db.prepare('SELECT * FROM empresas WHERE api_key = $1').get(apiKey)
  if (!empresa) {
    json(res, 401, { success: false, error: 'Api key desconocida' })
    return null
  }
  return empresa
}

// ---------- cuenta web: password (scrypt) + tokens (HMAC-SHA256) ----------

const JWT_SECRET = REQUIRED_ENV.JWT_SECRET

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `scrypt$${salt}$${hash}`
}

function verifyPassword(password, stored) {
  const [algo, salt, hash] = String(stored || '').split('$')
  if (algo !== 'scrypt' || !salt || !hash) return false
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex')
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(hash, 'hex'))
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url')
}

function signToken(payload, expiresInSec = 7 * 24 * 3600) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + expiresInSec }))
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${signature}`
}

function verifyToken(token) {
  if (typeof token !== 'string') return null
  const [header, body, signature] = token.split('.')
  if (!header || !body || !signature) return null
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url')
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

async function requireUser(req, res) {
  const auth = req.headers['authorization'] || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const payload = verifyToken(token)
  if (!payload?.uid) {
    json(res, 401, { success: false, error: 'Token inválido o expirado' })
    return null
  }
  const user = await db.prepare('SELECT * FROM users WHERE id = $1').get(payload.uid)
  if (!user) {
    json(res, 401, { success: false, error: 'Usuario no encontrado' })
    return null
  }
  return user
}

// ---------- precios del carrito de compras ----------

const PRECIOS_TOG = { mensual: 15, trimestral: 40, anual: 150 }
const EXTRA_MODULO_MENSUAL = 3
const MESES_POR_PERIODO = { mensual: 1, trimestral: 3, anual: 12 }
const MODULOS_EXTRA = MODULE_IDS.filter((m) => m !== 'comercializador' && m !== 'omniserv' && m !== 'rrhh')

function precioModulosExtra(periodo, modulos) {
  const meses = MESES_POR_PERIODO[periodo] || 1
  return modulos.length * EXTRA_MODULO_MENSUAL * meses
}

function totalCarrito(periodo, modulos) {
  const base = PRECIOS_TOG[periodo]
  if (!base) return null
  const extras = precioModulosExtra(periodo, modulos)
  return base + extras
}

// ---------- HMAC para pagos ----------

function signPaymentHmac(paymentId, monto, empresaId) {
  const data = `${paymentId}:${monto}:${empresaId}`
  return crypto.createHmac('sha256', PAYMENT_HMAC_SECRET).update(data).digest('hex')
}

function verifyPaymentHmac(paymentId, monto, empresaId, hmac) {
  if (!hmac || typeof hmac !== 'string') return false
  const expected = signPaymentHmac(paymentId, monto, empresaId)
  if (hmac.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hmac))
}

// ---------- rutas ----------

function paginaSimple(title, body) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:sans-serif;max-width:560px;margin:80px auto;text-align:center"><h1>${title}</h1><p>${body}</p></body></html>`
}

async function modulosDeUltimaLicencia(empresaId) {
  const ultima = await db
    .prepare('SELECT modules FROM licencias WHERE empresa_id = $1 ORDER BY issued_at DESC, id DESC LIMIT 1')
    .get(empresaId)
  let modulos = []
  try {
    modulos = JSON.parse(ultima?.modules || '[]')
  } catch {}
  return Array.isArray(modulos) ? modulos : []
}

function moduloDePriceId(priceId) {
  return MODULOS_COMPRABLES.find((m) => priceIdFor(m) === priceId) || null
}

async function emitirLicenciaConModulos(empresa, { modulos, por, meses = 1 }) {
  if (!privateKey) throw new Error('Clave privada no configurada para firmar la licencia')
  const conjunto = new Set([...(await modulosDeUltimaLicencia(empresa.id)), ...modulos])
  const ordenados = MODULE_IDS.filter((m) => conjunto.has(m))
  const license = signLicense(privateKey, {
    cliente: empresa.nombre,
    expira: plusMonths(new Date(), meses),
    modules: ordenados,
  })
  await db.prepare(
    `INSERT INTO licencias
       (empresa_id, modules, max_usuarios, max_sucursales, issued_at, expires_at, payload_json, emitida_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`
  ).run(empresa.id, JSON.stringify(license.modules || []), 1, 1, license.emitida, license.expira, JSON.stringify(license), por)
  return license
}

async function emitirLicencia(empresa, { modulo, por, meses = 1 }) {
  return emitirLicenciaConModulos(empresa, { modulos: [modulo], por, meses })
}

async function revocarLicencia(empresaId, { por, motivo = 'subscription_cancelled' } = {}) {
  const licencia = await db.prepare('SELECT id FROM licencias WHERE empresa_id = $1 ORDER BY issued_at DESC LIMIT 1').get(empresaId)
  if (!licencia) return null
  await db.prepare(
    `UPDATE licencias SET revoked_at = ${NOW}, motivo_revocado = $1 WHERE id = $2`
  ).run(motivo, licencia.id)
  return licencia.id
}

// ---------- facturas / recibos ----------

async function generarNroFactura() {
  const year = new Date().getFullYear()
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM pagos WHERE nro_factura IS NOT NULL AND substr(nro_factura, 3, 4) = $1")
    .get(String(year))
  const siguiente = Number(row?.n || 0) + 1
  return `F-${year}-${String(siguiente).padStart(4, '0')}`
}

function htmlFactura(pago, empresa, user) {
  let detalle = {}
  try {
    detalle = JSON.parse(pago.detalle || '{}')
  } catch {
    detalle = {}
  }
  const lineas = Array.isArray(detalle.desglose) ? detalle.desglose : []
  const periodo = detalle.periodo || pago.concepto.split(':')[1] || ''
  const fecha = new Date(pago.paid_at || pago.created_at).toLocaleString('es-VE', { timeZone: 'UTC' })
  const conceptoLabel = pago.concepto === 'omniserv:mensual' ? 'OmniServ — Suscripción mensual' : 'TOG Admin — Suscripción '
  const filas = lineas
    .map((l) => `<tr><td>${l.modulo}</td><td style="text-align:right">$${Number(l.precio).toFixed(2)}</td></tr>`)
    .join('')
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Factura ${pago.nro_factura} — OmniMargen</title>
  <style>
    body{font-family:Segoe UI,Arial,sans-serif;color:#111;max-width:720px;margin:24px auto;padding:0 16px}
    h1{font-size:22px;margin:0 0 4px}.muted{color:#666;font-size:13px}
    table{width:100%;border-collapse:collapse;margin:16px 0}
    th,td{padding:8px 10px;border-bottom:1px solid #ddd;text-align:left;font-size:14px}
    th{background:#f5f7fa}
    .total td{font-weight:700;font-size:16px;border-top:2px solid #333;border-bottom:none}
    .box{border:1px solid #ddd;border-radius:8px;padding:12px 16px;margin:12px 0}
    .badge{display:inline-block;background:#16a34a;color:#fff;padding:4px 12px;border-radius:999px;font-size:13px;font-weight:600}
    footer{margin-top:32px;font-size:12px;color:#888;text-align:center}
    @media print{body{margin:0}.noprint{display:none}}
  </style></head><body>
  <h1>🧾 OmniMargen</h1>
  <p class="muted">Factura y recibo de pago · ${conceptoLabel}${periodo}</p>
  <div class="box">
    <p><strong>Factura N°:</strong> ${pago.nro_factura}</p>
    <p><strong>Fecha de pago:</strong> ${fecha}</p>
    <p><strong>Cliente:</strong> ${empresa.nombre} (${empresa.pais} · ${empresa.documento})</p>
    ${user?.email ? `<p><strong>Email:</strong> ${user.email}</p>` : `<p><strong>Email:</strong> ${empresa.email_contacto}</p>`}
    <p><strong>Método de pago:</strong> CRIXTO · <strong>Estado:</strong> <span class="badge">PAGADO</span></p>
    ${pago.provider_ref ? `<p><strong>Referencia:</strong> ${pago.provider_ref}</p>` : ''}
  </div>
  <table>
    <thead><tr><th>Concepto</th><th style="text-align:right">Monto</th></tr></thead>
    <tbody>${filas}</tbody>
    <tr class="total"><td>Total</td><td style="text-align:right">$${Number(pago.monto).toFixed(2)} ${pago.moneda}</td></tr>
  </table>
  <p class="muted">Precios en USD. Impuestos según la legislación de tu país.</p>
  <footer>OmniMargen — omnimargen.site · soporte@omnimargen.site</footer>
  <p class="noprint" style="margin-top:16px"><a href="javascript:window.print()">Imprimir / guardar PDF</a></p>
</body></html>`
}

async function sendInvoiceEmail(pago, empresa, user) {
  if (!RESEND_API_KEY) return
  const emailDestino = user?.email || empresa?.email_contacto
  if (!emailDestino) return
  const html = htmlFactura(pago, empresa, user)
  const conceptoLabel = pago.concepto === 'omniserv:mensual' ? 'OmniServ' : 'TOG Admin'
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: INVOICE_FROM,
        to: [emailDestino],
        subject: `Factura ${pago.nro_factura} — ${conceptoLabel} · OmniMargen`,
        html,
      }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error(`[email] Resend ${res.status}: ${detail}`)
    }
  } catch (err) {
    console.error('[email] Error enviando factura:', err?.message || err)
  }
}

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY || !to) return
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: INVOICE_FROM, to: [to], subject, html }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error(`[email] Resend ${res.status}: ${detail}`)
    }
  } catch (err) {
    console.error('[email] Error enviando email:', err?.message || err)
  }
}

function htmlWelcome(user, empresa) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Bienvenido a OmniMargen</title></head>
<body style="font-family:sans-serif;max-width:560px;margin:40px auto;color:#222">
<h1 style="color:#16a34a">Bienvenido a OmniMargen</h1>
<p>Hola <strong>${user.nombre || 'Usuario'}</strong>,</p>
<p>Tu cuenta fue creada exitosamente.</p>
${empresa ? `<p><strong>Empresa:</strong> ${empresa.nombre} (${empresa.pais}-${empresa.documento})</p>
<p>Tu empresa ya está lista. Desde la app <strong>TOG Admin</strong> o <strong>OmniServ</strong> podés sincronizar tu licencia con estos datos:</p>
<ul>
  <li><strong>País:</strong> ${empresa.pais}</li>
  <li><strong>Documento:</strong> ${empresa.documento}</li>
  <li><strong>API Key:</strong> <code>${empresa.api_key}</code></li>
</ul>` : '<p>No vinculaste una empresa. Podés hacerlo más tarde desde tu cuenta.</p>'}
<p style="margin-top:24px"><a href="https://omnimargen.site/cuenta" style="background:#16a34a;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block">Ir a mi cuenta</a></p>
<p style="color:#666;margin-top:32px;font-size:13px">Si no creaste esta cuenta, podés ignorar este mensaje.</p>
</body></html>`
}

function htmlRenewalReminder(user, empresa, diasRestantes) {
  const urgenStyle = diasRestantes <= 7 ? 'color:#dc2626;font-weight:bold' : 'color:#d97706'
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Tu licencia vence pronto</title></head>
<body style="font-family:sans-serif;max-width:560px;margin:40px auto;color:#222">
<h1 style="${urgenStyle}">Tu licencia vence en ${diasRestantes} día${diasRestantes === 1 ? '' : 's'}</h1>
<p>Hola <strong>${user.nombre || 'Usuario'}</strong>,</p>
${empresa ? `<p>La licencia de <strong>${empresa.nombre}</strong> vence el <strong>${empresa.fecha_expiracion || 'próximamente'}</strong>.</p>` : ''}
<p>Para evitar la interrupción del servicio, renová tu licencia desde la app o desde tu cuenta web.</p>
<p style="margin-top:24px"><a href="https://omnimargen.site/cuenta" style="background:#16a34a;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block">Renovar ahora</a></p>
<p style="color:#666;margin-top:32px;font-size:13px">Si ya renovaste, podés ignorar este mensaje.</p>
</body></html>`
}

async function revocarImpagosVencidos() {
  const hoy = new Date().toISOString().split('T')[0]
  const vencidas = await db
    .prepare("SELECT id, empresa_id FROM suscripciones WHERE estado = 'impago' AND grace_ends_at IS NOT NULL AND grace_ends_at < $1")
    .all(hoy)
  if (!vencidas.length) return
  await db.exec('BEGIN')
  try {
    for (const s of vencidas) {
      await db.prepare(`UPDATE suscripciones SET estado = 'cancelado_impago', updated_at = ${NOW} WHERE id = $1`).run(s.id)
      await db.prepare(
        `UPDATE licencias SET revoked_at = ${NOW}, motivo_revocado = 'impago:grace-period' WHERE empresa_id = $1 AND revoked_at IS NULL`
      ).run(s.empresa_id)
    }
    await db.exec('COMMIT')
  } catch (err) {
    try {
      await db.exec('ROLLBACK')
    } catch {}
    throw err
  }
}

let lastRenewalReminderDay = ''
async function enviarRecordatoriosRenovacion() {
  const hoy = new Date().toISOString().split('T')[0]
  if (lastRenewalReminderDay === hoy) return
  lastRenewalReminderDay = hoy
  const en7dias = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]
  const en3dias = new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0]
  const porVencer = await db.prepare(
    `SELECT l.empresa_id, l.expira, e.nombre, e.email_contacto
     FROM licencias l JOIN empresas e ON e.id = l.empresa_id
     WHERE l.revoked_at IS NULL AND l.expira IN ($1, $2)`
  ).all(en7dias, en3dias)
  for (const lic of porVencer) {
    if (!lic.email_contacto) continue
    const diasRestantes = Math.ceil((new Date(lic.expira) - Date.now()) / 86400000)
    const user = await db.prepare('SELECT nombre FROM users WHERE empresa_id = $1 LIMIT 1').get(lic.empresa_id)
    await sendEmail({
      to: lic.email_contacto,
      subject: `Tu licencia vence en ${diasRestantes} día${diasRestantes === 1 ? '' : 's'} — OmniMargen`,
      html: htmlRenewalReminder(user || { nombre: lic.email_contacto }, { nombre: lic.nombre, fecha_expiracion: lic.expira }, diasRestantes),
    }).catch(() => {})
  }
}

async function procesarCheckout(event) {
  const session = event?.data?.object || {}
  const modulo = session?.metadata?.modulo
  if (!MODULOS_COMPRABLES.includes(modulo)) {
    throw new Error(`Módulo no comprable en checkout: ${modulo}`)
  }
  const empresaId = Number(session?.client_reference_id)
  const empresa = empresaId
    ? await db.prepare('SELECT * FROM empresas WHERE id = $1').get(empresaId)
    : await db.prepare('SELECT * FROM empresas WHERE stripe_customer_id = $1').get(session?.customer)
  if (!empresa) throw new Error('Empresa no encontrada para el checkout')
  if (session?.customer) {
    await db.prepare('UPDATE empresas SET stripe_customer_id = $1 WHERE id = $2').run(session.customer, empresa.id)
  }
  try {
    await emitirLicencia(empresa, { modulo, por: `stripe:${event.id}` })
  } catch (err) {
    console.error(`[webhook] emitirLicencia falló para empresa ${empresa.id}, módulo ${modulo}:`, err.message)
    throw err
  }

  const subId = session?.subscription ? String(session.subscription) : null
  if (subId) {
    await db.prepare(
      `INSERT INTO suscripciones (empresa_id, stripe_subscription_id, stripe_price_id, estado, failed_at, grace_ends_at)
       VALUES ($1, $2, $3, 'active', NULL, NULL)
       ON CONFLICT(stripe_subscription_id) DO UPDATE SET estado = 'active', failed_at = NULL, grace_ends_at = NULL, updated_at = ${NOW}`
    ).run(empresa.id, subId, priceIdFor(modulo))
  }
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname
  const method = req.method
  const origin = req.headers.origin || ''
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || ''

  // CORS
  setCorsHeaders(res, origin)

  // Preflight
  if (method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }

  // Rate limit (skip health y time)
  if (path !== '/api/health' && path !== '/api/time') {
    if (isRateLimited(ip)) {
      return json(res, 429, { success: false, error: 'Demasiadas solicitudes. Intenta de nuevo en 1 minuto.' })
    }
  }

  // GET /api/health
  if (method === 'GET' && path === '/api/health') {
    return json(res, 200, { ok: true, db: true, firmando: !!privateKey, tiempo: new Date().toISOString() })
  }

  // GET /api/time
  if (method === 'GET' && path === '/api/time') {
    return json(res, 200, { server_time: Date.now(), iso: new Date().toISOString() })
  }

  // POST /api/empresas (admin)
  if (method === 'POST' && path === '/api/empresas') {
    if (!(await requireAdmin(req, res))) return
    const body = await readBody(req)
    const nombre = typeof body?.nombre === 'string' ? body.nombre.trim() : ''
    const pais = (typeof body?.pais === 'string' ? body.pais.trim().toUpperCase() : 'VE') || 'VE'
    const documento = typeof body?.documento === 'string' ? body.documento.trim().toUpperCase() : ''
    const emailContacto = typeof body?.email_contacto === 'string' ? body.email_contacto.trim() : ''
    if (!nombre || !documento || !emailContacto) {
      return json(res, 400, { success: false, error: 'nombre, documento y email_contacto son requeridos' })
    }
    if (!/^[A-Z]{2}$/.test(pais)) {
      return json(res, 400, { success: false, error: 'pais debe ser un código ISO 3166-1 alpha-2 (ej: VE, US, AR, CO)' })
    }
    if (documento.length > 40 || nombre.length > 200) {
      return json(res, 400, { success: false, error: 'nombre (máx 200) o documento (máx 40) excede el largo permitido' })
    }
    const apiKey = crypto.randomBytes(16).toString('hex')
    try {
      const result = await db
        .prepare('INSERT INTO empresas (nombre, pais, documento, email_contacto, api_key) VALUES ($1, $2, $3, $4, $5) RETURNING id')
        .run(nombre, pais, documento, emailContacto, apiKey)
      return json(res, 201, { success: true, id: result.lastInsertRowid, api_key: apiKey })
    } catch (err) {
      return json(res, 409, { success: false, error: `Documento duplicado para el país ${pais}` })
    }
  }

  // GET /api/admin/empresas (admin)
  if (method === 'GET' && path === '/api/admin/empresas') {
    if (!(await requireAdmin(req, res))) return
    const rows = await db.prepare('SELECT id, nombre, pais, documento, email_contacto, device_fingerprint, payment_status, created_at FROM empresas ORDER BY created_at DESC').all()
    return json(res, 200, { empresas: rows })
  }

  // POST /api/admin/empresas/:id/dispositivo (admin)
  const dispositivoMatch = path.match(/^\/api\/admin\/empresas\/(\d+)\/dispositivo$/)
  if (method === 'POST' && dispositivoMatch) {
    if (!(await requireAdmin(req, res))) return
    const empresaId = Number(dispositivoMatch[1])
    if (!(await db.prepare('SELECT id FROM empresas WHERE id = $1').get(empresaId))) {
      return json(res, 404, { success: false, error: 'Empresa no encontrada' })
    }
    const body = await readBody(req)
    const nuevo = typeof body?.device_fingerprint === 'string' ? body.device_fingerprint.trim() : null
    if (nuevo === '') {
      return json(res, 400, { success: false, error: 'device_fingerprint debe ser un hash no vacío o null (para desvincular)' })
    }
    await db.prepare('UPDATE empresas SET device_fingerprint = $1 WHERE id = $2').run(nuevo, empresaId)
    const row = await db.prepare('SELECT id, device_fingerprint FROM empresas WHERE id = $1').get(empresaId)
    return json(res, 200, { success: true, empresa_id: row.id, device_fingerprint: row.device_fingerprint })
  }

  // POST /api/empresas/register (public)
  if (method === 'POST' && path === '/api/empresas/register') {
    const body = await readBody(req)
    const nombre = typeof body?.nombre === 'string' ? body.nombre.trim() : ''
    const pais = (typeof body?.pais === 'string' ? body.pais.trim().toUpperCase() : 'VE') || 'VE'
    const documento = typeof body?.documento === 'string' ? body.documento.trim().toUpperCase() : ''
    const emailContacto = typeof body?.email_contacto === 'string' ? body.email_contacto.trim() : ''
    const deviceFingerprint = typeof body?.device_fingerprint === 'string' ? body.device_fingerprint.trim() : ''

    if (!nombre || !documento || !emailContacto) {
      return json(res, 400, { success: false, error: 'nombre, documento y email_contacto son requeridos' })
    }
    if (!/^[A-Z]{2}$/.test(pais)) {
      return json(res, 400, { success: false, error: 'pais debe ser un código ISO 3166-1 alpha-2' })
    }
    if (!deviceFingerprint || deviceFingerprint.length > 128) {
      return json(res, 400, { success: false, error: 'device_fingerprint es requerido (hash SHA-256 del dispositivo)' })
    }

    const existente = await db.prepare('SELECT id, api_key, nombre, email_contacto, payment_status, device_fingerprint FROM empresas WHERE pais = $1 AND documento = $2').get(pais, documento)
    if (existente) {
      if (existente.device_fingerprint && existente.device_fingerprint !== deviceFingerprint) {
        return json(res, 403, {
          success: false,
          code: 'DEVICE_MISMATCH',
          error: 'Dispositivo no autorizado',
          message: 'Esta licencia ya está activada en otro dispositivo. Contacta soporte para transferir la licencia.',
        })
      }
      return json(res, 200, {
        success: true,
        already_registered: true,
        data: {
          id: existente.id,
          api_key: existente.api_key,
          nombre: existente.nombre,
          email_contacto: existente.email_contacto,
          payment_status: existente.payment_status
        }
      })
    }

    const apiKey = crypto.randomBytes(16).toString('hex')
    try {
      const result = await db
        .prepare('INSERT INTO empresas (nombre, pais, documento, email_contacto, api_key, device_fingerprint, payment_status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id')
        .run(nombre, pais, documento, emailContacto, apiKey, deviceFingerprint, 'pending')
      return json(res, 201, { 
        success: true, 
        data: { 
          id: result.lastInsertRowid, 
          api_key: apiKey 
        } 
      })
    } catch (err) {
      return json(res, 500, { success: false, error: 'Error al registrar empresa' })
    }
  }

  // GET /api/payment/confirm
  if (method === 'GET' && path === '/api/payment/confirm') {
    const paymentId = url.searchParams.get('payment_id')
    const empresaId = url.searchParams.get('empresa_id')
    const extra = [...url.searchParams.entries()].filter(([k]) => k !== 'payment_id' && k !== 'empresa_id')
    const providerRef = extra.length ? extra.map(([k, v]) => `${k}=${v}`).join('&') : null

    try {
      if (paymentId) {
        const pago = await db.prepare('SELECT * FROM pagos WHERE id = $1').get(Number(paymentId))
        if (!pago) {
          res.writeHead(302, { Location: 'https://omnimargen.site/pago-cancelado' })
          res.end()
          return
        }
        const empresa = await db.prepare('SELECT * FROM empresas WHERE id = $1').get(pago.empresa_id)
        if (!empresa) throw new Error('Empresa del pago no encontrada')
        if (pago.estado !== 'confirmed') {
          const nroFactura = await generarNroFactura()
          await db.prepare(`UPDATE pagos SET estado = 'confirmed', paid_at = ${NOW}, nro_factura = $1, provider_ref = COALESCE($2, provider_ref) WHERE id = $3`)
            .run(nroFactura, providerRef, pago.id)
          const detalle = (() => {
            try {
              return JSON.parse(pago.detalle || '{}')
            } catch {
              return {}
            }
          })()
          const modulos = Array.isArray(detalle.modulos) && detalle.modulos.length ? detalle.modulos : ['comercializador']
          const meses = MESES_POR_PERIODO[detalle.periodo] || 1
          if (privateKey) {
            await emitirLicenciaConModulos(empresa, { modulos, por: `crixto:${pago.id}`, meses })
          }
          const pagoConfirmado = await db.prepare('SELECT * FROM pagos WHERE id = $1').get(pago.id)
          const user = pago.user_id ? await db.prepare('SELECT * FROM users WHERE id = $1').get(pago.user_id) : null
          sendInvoiceEmail(pagoConfirmado, empresa, user)
        }
        res.writeHead(302, { Location: 'https://omnimargen.site/pago-exitoso' })
        res.end()
        return
      }

      if (empresaId) {
        await db.prepare(`UPDATE empresas SET payment_status = 'confirmed', payment_confirmed_at = ${NOW} WHERE id = $1`)
          .run(Number(empresaId))
        const empresa = await db.prepare('SELECT * FROM empresas WHERE id = $1').get(Number(empresaId))
        if (empresa && privateKey) {
          await emitirLicencia(empresa, { modulo: 'omniserv', por: 'crixto:auto', meses: 1 })
        }
        if (empresa) {
          const result = await db.prepare(
            `INSERT INTO pagos (user_id, empresa_id, concepto, detalle, monto, moneda, estado, provider, nro_factura, paid_at) VALUES (NULL, $1, 'omniserv:mensual', $2, 3, 'USD', 'confirmed', 'crixto', $3, ${NOW})`
          ).run(empresa.id, JSON.stringify({ producto: 'omniserv', periodo: 'mensual', modulos: ['omniserv'], desglose: [{ modulo: 'OmniServ — mensual', precio: 3 }] }), await generarNroFactura())
          const pago = await db.prepare('SELECT * FROM pagos WHERE id = $1').get(result.lastInsertRowid)
          const user = await db.prepare('SELECT * FROM users WHERE empresa_id = $1').get(empresa.id)
          sendInvoiceEmail(pago, empresa, user)
        }
        res.writeHead(302, { Location: 'https://omnimargen.site/pago-exitoso' })
        res.end()
        return
      }

      res.writeHead(302, { Location: 'https://omnimargen.site/pago-exitoso' })
      res.end()
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(paginaSimple('Error', 'Error al procesar el pago. Contacta soporte.'))
    }
    return
  }

  // POST /api/auth/register
  if (method === 'POST' && path === '/api/auth/register') {
    const body = await readBody(req)
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    const nombre = typeof body?.nombre === 'string' ? body.nombre.trim() : ''
    const pais = (typeof body?.pais === 'string' ? body.pais.trim().toUpperCase() : 'VE') || 'VE'
    const documento = typeof body?.documento === 'string' ? body.documento.trim().toUpperCase() : ''
    const telefono = typeof body?.telefono === 'string' ? body.telefono.trim() : ''

    if (!email || !password || !nombre) {
      return json(res, 400, { success: false, error: 'email, password y nombre son requeridos' })
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json(res, 400, { success: false, error: 'Email inválido' })
    }
    if (password.length < 6) {
      return json(res, 400, { success: false, error: 'La contraseña debe tener al menos 6 caracteres' })
    }
    if (await db.prepare('SELECT id FROM users WHERE email = $1').get(email)) {
      return json(res, 409, { success: false, error: 'Ya existe una cuenta con ese email' })
    }

    let empresa = null
    if (documento) {
      empresa = await db.prepare('SELECT * FROM empresas WHERE pais = $1 AND documento = $2').get(pais, documento)
      if (!empresa) {
        const apiKey = crypto.randomBytes(16).toString('hex')
        const result = await db
          .prepare('INSERT INTO empresas (nombre, pais, documento, email_contacto, api_key) VALUES ($1, $2, $3, $4, $5) RETURNING id')
          .run(nombre, pais, documento, email, apiKey)
        empresa = await db.prepare('SELECT * FROM empresas WHERE id = $1').get(result.lastInsertRowid)
      }
    }

    const result = await db
      .prepare('INSERT INTO users (email, password_hash, nombre, pais, documento, telefono, empresa_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id')
      .run(email, hashPassword(password), nombre, pais, documento, telefono || null, empresa?.id || null)
    const user = await db.prepare('SELECT id, email, nombre, pais, documento, telefono, empresa_id, created_at FROM users WHERE id = $1').get(result.lastInsertRowid)
    sendEmail({ to: email, subject: 'Bienvenido a OmniMargen', html: htmlWelcome(user, empresa) }).catch(() => {})
    return json(res, 201, { success: true, token: signToken({ uid: user.id }), user })
  }

  // POST /api/auth/login
  if (method === 'POST' && path === '/api/auth/login') {
    const body = await readBody(req)
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    const user = await db.prepare('SELECT * FROM users WHERE email = $1').get(email)
    if (!user || !verifyPassword(password, user.password_hash)) {
      return json(res, 401, { success: false, error: 'Email o contraseña incorrectos' })
    }
    const { password_hash, ...publico } = user
    return json(res, 200, { success: true, token: signToken({ uid: user.id }), user: publico })
  }

  // POST /api/auth/check-email (public) - check if email exists without login
  if (method === 'POST' && path === '/api/auth/check-email') {
    const body = await readBody(req)
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json(res, 400, { success: false, error: 'email inválido' })
    }
    const user = await db.prepare('SELECT id FROM users WHERE email = $1').get(email)
    return json(res, 200, { success: true, exists: !!user })
  }

  // POST /api/auth/forgot
  if (method === 'POST' && path === '/api/auth/forgot') {
    const body = await readBody(req)
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    const tokenHash = typeof body?.token_hash === 'string' ? body.token_hash.trim() : ''
    console.log(`[forgot] incoming email=${email} hash_len=${tokenHash.length}`)
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !/^[a-f0-9]{64}$/.test(tokenHash)) {
      return json(res, 400, { success: false, error: 'email y token_hash (sha256 hex) son requeridos' })
    }
    const user = await db.prepare('SELECT id FROM users WHERE email = $1').get(email)
    if (user) {
      const expira = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      await db.exec('BEGIN')
      try {
        await db.prepare('UPDATE password_resets SET usado = TRUE WHERE user_id = $1').run(user.id)
        await db.prepare('INSERT INTO password_resets (user_id, token_hash, expira) VALUES ($1, $2, $3)').run(user.id, tokenHash, expira)
        console.log(`[forgot] STORED user=${user.id} email=${email} hash=${tokenHash.slice(0, 8)}… expires=${expira}`)
        await db.exec('COMMIT')
      } catch (err) {
        try {
          await db.exec('ROLLBACK')
        } catch {}
        throw err
      }
    } else {
      console.log(`[forgot] USER NOT FOUND email=${email}`)
    }
    return json(res, 200, { success: true, email_exists: !!user, message: 'Si el email existe, recibirás un enlace para restablecer tu contraseña.' })
  }

  // POST /api/auth/reset-password
  if (method === 'POST' && path === '/api/auth/reset-password') {
    const body = await readBody(req)
    const token = typeof body?.token === 'string' ? body.token.trim() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    if (!token) return json(res, 400, { success: false, error: 'Token requerido' })
    if (password.length < 6) {
      return json(res, 400, { success: false, error: 'La contraseña debe tener al menos 6 caracteres' })
    }
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    const row = await db.prepare('SELECT id, user_id, expira, usado FROM password_resets WHERE token_hash = $1').get(tokenHash)
    console.log(`[reset] token_len=${token.length} hash=${tokenHash.slice(0, 8)}… found=${!!row} usado=${row?.usado} expira=${row?.expira}`)
    if (!row || row.usado === true || row.usado === 1) {
      return json(res, 400, { success: false, error: 'Token inválido o ya utilizado' })
    }
    if (new Date(row.expira).getTime() < Date.now()) {
      return json(res, 400, { success: false, error: 'Token expirado. Solicita un nuevo enlace.' })
    }
    await db.prepare(`UPDATE users SET password_hash = $1, updated_at = ${NOW} WHERE id = $2`).run(hashPassword(password), row.user_id)
    await db.prepare('UPDATE password_resets SET usado = TRUE WHERE id = $1').run(row.id)
    return json(res, 200, { success: true, message: 'Contraseña actualizada. Ya puedes iniciar sesión.' })
  }

  // GET /api/user/profile
  if (method === 'GET' && path === '/api/user/profile') {
    const user = await requireUser(req, res)
    if (!user) return
    const empresa = user.empresa_id ? await db.prepare('SELECT * FROM empresas WHERE id = $1').get(user.empresa_id) : null
    const licencia = empresa ? await getActiveLicense(empresa.id) : null
    const host = req.headers.host ? `https://${req.headers.host}` : ''
    const pagos = await db
      .prepare('SELECT id, concepto, monto, moneda, estado, nro_factura, paid_at, created_at FROM pagos WHERE user_id = $1 ORDER BY id DESC LIMIT 50')
      .all(user.id)
    const pagosConUrl = pagos.map((p) => ({
      ...p,
      factura_url: p.nro_factura ? `${host}/api/pagos/${p.id}/factura` : null,
    }))
    const { password_hash, ...publico } = user
    return json(res, 200, {
      success: true,
      user: publico,
      empresa: empresa ? { id: empresa.id, nombre: empresa.nombre, pais: empresa.pais, documento: empresa.documento, email_contacto: empresa.email_contacto, api_key: empresa.api_key } : null,
      licencia_activa: licencia ? JSON.parse(licencia.payload_json) : null,
      pagos: pagosConUrl,
    })
  }

  // POST /api/payment/create
  if (method === 'POST' && path === '/api/payment/create') {
    const user = await requireUser(req, res)
    if (!user) return
    const body = await readBody(req)
    const periodo = body?.periodo
    if (!PRECIOS_TOG[periodo]) {
      return json(res, 400, { success: false, error: `periodo inválido. Disponibles: ${Object.keys(PRECIOS_TOG).join(', ')}` })
    }
    const modulosRaw = Array.isArray(body?.modulos) ? body.modulos.map((m) => String(m)) : []
    const invalidos = modulosRaw.filter((m) => !MODULOS_EXTRA.includes(m))
    if (invalidos.length) {
      return json(res, 400, { success: false, error: `Módulo(s) desconocido(s): ${invalidos.join(', ')}` })
    }
    const modulos = [...new Set(modulosRaw)]
    const monto = totalCarrito(periodo, modulos)
    if (monto == null) return json(res, 400, { success: false, error: 'No se pudo calcular el monto del carrito' })

    const empresa = user.empresa_id ? await db.prepare('SELECT * FROM empresas WHERE id = $1').get(user.empresa_id) : null
    if (!empresa) return json(res, 400, { success: false, error: 'Vincula tu cuenta a una empresa (país + documento) para comprar' })

    const desglose = [{ modulo: `TOG Admin (base ${periodo})`, precio: PRECIOS_TOG[periodo] }]
    for (const m of modulos) desglose.push({ modulo: `Módulo ${m}`, precio: EXTRA_MODULO_MENSUAL * MESES_POR_PERIODO[periodo] })

    const result = await db
      .prepare("INSERT INTO pagos (user_id, empresa_id, concepto, detalle, monto, moneda, estado, provider) VALUES ($1, $2, $3, $4, $5, 'USD', 'pending', 'crixto') RETURNING id")
      .run(user.id, empresa.id, `tog:${periodo}`, JSON.stringify({ producto: 'tog', periodo, modulos: ['comercializador', ...modulos], desglose }), monto)
    const pagoId = result.lastInsertRowid

    const hmac = signPaymentHmac(pagoId, monto, empresa.id)
    const successUrl = `${req.headers.host ? 'https://' + req.headers.host : 'http://localhost:3001'}/api/payment/confirm?payment_id=${pagoId}`
    return json(res, 201, {
      success: true,
      payment_id: pagoId,
      monto,
      moneda: 'USD',
      periodo,
      modulos: ['comercializador', ...modulos],
      hmac,
      success_url: successUrl,
      cancel_url: 'https://omnimargen.site/pago-cancelado',
    })
  }

  // POST /api/payment/omniserv-payment
  if (method === 'POST' && path === '/api/payment/omniserv-payment') {
    const user = await requireUser(req, res)
    if (!user) return
    const empresa = user.empresa_id ? await db.prepare('SELECT * FROM empresas WHERE id = $1').get(user.empresa_id) : null
    if (!empresa) return json(res, 400, { success: false, error: 'Vincula tu cuenta a una empresa (país + documento) para comprar' })

    const monto = 3
    const desglose = [{ modulo: 'OmniServ — mensual', precio: monto }]

    const result = await db
      .prepare("INSERT INTO pagos (user_id, empresa_id, concepto, detalle, monto, moneda, estado, provider) VALUES ($1, $2, $3, $4, $5, 'USD', 'pending', 'crixto') RETURNING id")
      .run(user.id, empresa.id, 'omniserv:mensual', JSON.stringify({ producto: 'omniserv', periodo: 'mensual', modulos: ['omniserv'], desglose }), monto)
    const pagoId = result.lastInsertRowid

    const hmac = signPaymentHmac(pagoId, monto, empresa.id)
    const successUrl = `${req.headers.host ? 'https://' + req.headers.host : 'http://localhost:3001'}/api/payment/confirm?payment_id=${pagoId}`
    return json(res, 201, {
      success: true,
      payment_id: pagoId,
      monto,
      moneda: 'USD',
      hmac,
      success_url: successUrl,
      cancel_url: 'https://omnimargen.site/pago-cancelado',
    })
  }

  // GET /api/payment/verify — verifica HMAC y confirma el pago
  if (method === 'GET' && path === '/api/payment/verify') {
    const paymentId = Number(url.searchParams.get('payment_id'))
    const hmac = url.searchParams.get('hmac') || ''

    if (!paymentId || !hmac) {
      return json(res, 400, { success: false, error: 'Parámetros payment_id y hmac requeridos' })
    }

    const pago = await db.prepare('SELECT * FROM pagos WHERE id = $1').get(paymentId)
    if (!pago) {
      return json(res, 404, { success: false, error: 'Pago no encontrado' })
    }

    if (!verifyPaymentHmac(paymentId, pago.monto, pago.empresa_id, hmac)) {
      return json(res, 403, { success: false, error: 'HMAC inválido — posible manipulación' })
    }

    if (pago.estado === 'confirmed') {
      return json(res, 200, { success: true, message: 'Pago ya confirmado', nro_factura: pago.nro_factura })
    }

    if (pago.estado !== 'pending') {
      return json(res, 409, { success: false, error: `Pago en estado '${pago.estado}' — no se puede confirmar` })
    }

    try {
      const empresa = await db.prepare('SELECT * FROM empresas WHERE id = $1').get(pago.empresa_id)
      if (!empresa) throw new Error('Empresa del pago no encontrada')

      const nroFactura = await generarNroFactura()
      await db.prepare(`UPDATE pagos SET estado = 'confirmed', paid_at = ${NOW}, nro_factura = $1 WHERE id = $2`)
        .run(nroFactura, pago.id)

      const detalle = (() => { try { return JSON.parse(pago.detalle || '{}') } catch { return {} } })()
      const modulos = Array.isArray(detalle.modulos) && detalle.modulos.length ? detalle.modulos : ['comercializador']
      const meses = MESES_POR_PERIODO[detalle.periodo] || 1
      if (privateKey) {
        await emitirLicenciaConModulos(empresa, { modulos, por: `crixto:${pago.id}`, meses })
      }

      const pagoConfirmado = await db.prepare('SELECT * FROM pagos WHERE id = $1').get(pago.id)
      const user = pago.user_id ? await db.prepare('SELECT * FROM users WHERE id = $1').get(pago.user_id) : null
      sendInvoiceEmail(pagoConfirmado, empresa, user)

      return json(res, 200, { success: true, nro_factura: nroFactura, message: 'Pago confirmado y licencia activada' })
    } catch (err) {
      console.error('[payment/verify]', err)
      return json(res, 500, { success: false, error: 'Error al confirmar el pago' })
    }
  }

  // GET /api/pagos/:id/factura
  const facturaMatch = path.match(/^\/api\/pagos\/(\d+)\/factura$/)
  if (method === 'GET' && facturaMatch) {
    const pago = await db.prepare('SELECT * FROM pagos WHERE id = $1').get(Number(facturaMatch[1]))
    if (!pago || pago.estado !== 'confirmed') {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(paginaSimple('No encontrada', 'Esta factura no existe o el pago aún no fue confirmado.'))
      return
    }
    const empresa = await db.prepare('SELECT * FROM empresas WHERE id = $1').get(pago.empresa_id)
    const user = pago.user_id ? await db.prepare('SELECT * FROM users WHERE id = $1').get(pago.user_id) : null
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(htmlFactura(pago, empresa, user))
    return
  }

  // GET /api/empresas/:id/payment-status
  const paymentStatusMatch = path.match(/^\/api\/empresas\/(\d+)\/payment-status$/)
  if (method === 'GET' && paymentStatusMatch) {
    const empresa = await requireEmpresa(req, res)
    if (!empresa) return
    return json(res, 200, {
      success: true,
      payment_confirmed: empresa.payment_status === 'confirmed'
    })
  }

  // POST /api/empresas/:id/licencias (admin)
  const licenciasMatch = path.match(/^\/api\/empresas\/(\d+)\/licencias$/)
  if (method === 'POST' && licenciasMatch) {
    if (!(await requireAdmin(req, res))) return
    if (!privateKey) return json(res, 500, { success: false, error: 'Clave privada no configurada' })
    const empresaId = Number(licenciasMatch[1])
    const empresa = await db.prepare('SELECT * FROM empresas WHERE id = $1').get(empresaId)
    if (!empresa) return json(res, 404, { success: false, error: 'Empresa no encontrada' })

    const body = await readBody(req)
    const { cliente, expira, machine_id = null, modules = null, max_pcs = null } = body || {}
    if (!cliente || !expira) return json(res, 400, { success: false, error: 'cliente y expira son requeridos' })

    let license
    try {
      license = signLicense(privateKey, { cliente, expira, machineId: machine_id, modules, maxPcs: max_pcs })
    } catch (err) {
      return json(res, 400, { success: false, error: 'Error al firmar la licencia' })
    }

    await db.prepare(
      `INSERT INTO licencias
         (empresa_id, modules, max_usuarios, max_sucursales, issued_at, expires_at, payload_json, emitida_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual:admin')`
    ).run(
      empresaId,
      JSON.stringify(license.modules || []),
      1,
      1,
      license.emitida,
      license.expira,
      JSON.stringify(license),
    )

    return json(res, 201, { success: true, licencia: license })
  }

  // GET /api/empresas/:id/licencia (api_key)
  const licenciaMatch = path.match(/^\/api\/empresas\/(\d+)\/licencia$/)
  if (method === 'GET' && licenciaMatch) {
    const empresa = await requireEmpresa(req, res)
    if (!empresa) return
    try {
      await revocarImpagosVencidos()
    } catch (err) {
      console.error('[licencia] error al barrer impagos vencidos', err.message)
    }
    try {
      await enviarRecordatoriosRenovacion()
    } catch (err) {
      console.error('[licencia] error al enviar recordatorios de renovación', err.message)
    }
    
    const deviceFingerprint = String(req.headers['x-device-fingerprint'] || url.searchParams.get('device_fingerprint') || '').trim()
    if (deviceFingerprint) {
      if (!empresa.device_fingerprint) {
        const claimed = await db
          .prepare('UPDATE empresas SET device_fingerprint = $1 WHERE id = $2 AND device_fingerprint IS NULL')
          .run(deviceFingerprint, empresa.id)
        if (claimed.changes === 0) {
          const ahora = await db.prepare('SELECT device_fingerprint FROM empresas WHERE id = $1').get(empresa.id)
          if (ahora?.device_fingerprint !== deviceFingerprint) {
            return json(res, 403, {
              success: false,
              code: 'DEVICE_MISMATCH',
              error: 'Dispositivo no autorizado',
              message: 'Esta licencia ya está activada en otro dispositivo. Contacta soporte para transferir la licencia.',
            })
          }
        }
      } else if (deviceFingerprint !== empresa.device_fingerprint) {
        return json(res, 403, {
          success: false,
          code: 'DEVICE_MISMATCH',
          error: 'Dispositivo no autorizado',
          message: 'Esta licencia ya está activada en otro dispositivo. Contacta soporte para transferir la licencia.',
        })
      }
    }

    const licencia = await getActiveLicense(empresa.id)
    if (!licencia) {
      const sub = await db.prepare('SELECT estado FROM suscripciones WHERE empresa_id = $1 ORDER BY id DESC LIMIT 1').get(empresa.id)
      if (sub?.estado === 'cancelado_impago') {
        return json(res, 402, {
          success: false,
          error: 'Suscripción cancelada por falta de pago. Reactívala (Stripe o manual) para volver a sincronizar los módulos.',
        })
      }
      return json(res, 404, { success: false, error: 'Sin licencia activa' })
    }
    return json(res, 200, { success: true, licencia: JSON.parse(licencia.payload_json) })
  }

  // POST /api/checkout-session (api_key)
  if (method === 'POST' && path === '/api/checkout-session') {
    const empresa = await requireEmpresa(req, res)
    if (!empresa) return
    const body = await readBody(req)
    const modulo = body?.modulo
    if (!MODULOS_COMPRABLES.includes(modulo)) {
      return json(res, 400, {
        success: false,
        error: `Módulo no comprable: ${modulo}. Disponibles: ${MODULOS_COMPRABLES.join(', ')}`,
      })
    }
    const priceId = priceIdFor(modulo)
    if (!process.env.STRIPE_SECRET_KEY) {
      return json(res, 503, { success: false, error: 'Stripe no configurado (STRIPE_SECRET_KEY)' })
    }
    if (!priceId) {
      return json(res, 503, {
        success: false,
        error: `No hay precio de Stripe configurado para el módulo ${modulo} (STRIPE_PRICE_${String(modulo).toUpperCase()})`,
      })
    }
    try {
      let customerId = empresa.stripe_customer_id
      if (!customerId) {
        const customer = await createStripeCustomer({
          secretKey: process.env.STRIPE_SECRET_KEY,
          email: empresa.email_contacto,
          name: empresa.nombre,
        })
        customerId = customer.id
        await db.prepare('UPDATE empresas SET stripe_customer_id = $1 WHERE id = $2').run(customerId, empresa.id)
      }
      const session = await createCheckoutSession({
        secretKey: process.env.STRIPE_SECRET_KEY,
        priceId,
        customer: customerId,
        clientReferenceId: empresa.id,
        metadata: { modulo },
        successUrl: `${STRIPE_DOMAIN}/checkout/success?empresa=${empresa.id}&modulo=${encodeURIComponent(modulo)}`,
        cancelUrl: `${STRIPE_DOMAIN}/checkout/cancel`,
      })
      return json(res, 201, { success: true, url: session.url })
    } catch (err) {
      return json(res, 502, { success: false, error: 'Error al crear sesión de pago' })
    }
  }

  // GET /checkout/success|cancel
  if (method === 'GET' && path.startsWith('/checkout/')) {
    const exito = path.includes('success')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(
      exito
        ? paginaSimple('✅ Pago exitoso', 'Tu módulo quedó activado. Vuelve a TOG Admin y presiona "Sincronizar" en Config → Licencia.')
        : paginaSimple('Pago cancelado', 'Puedes reintentar el pago cuando quieras. No se te cobró nada.'),
    )
    return
  }

  // POST /api/webhook/stripe
  if (method === 'POST' && path === '/api/webhook/stripe') {
    if (!STRIPE_WEBHOOK_SECRET || !process.env.STRIPE_SECRET_KEY) {
      return json(res, 503, {
        success: false,
        error: 'Webhook de Stripe no configurado (STRIPE_WEBHOOK_SECRET/STRIPE_SECRET_KEY)',
      })
    }
    const raw = await readRawBody(req)
    try {
      verifyStripeWebhook({ secret: STRIPE_WEBHOOK_SECRET, rawBody: raw, signatureHeader: req.headers['stripe-signature'] })
    } catch (err) {
      return json(res, 400, { success: false, error: 'Firma del webhook inválida' })
    }
    let event
    try {
      event = JSON.parse(raw)
    } catch {
      return json(res, 400, { success: false, error: 'Payload del webhook no es JSON válido' })
    }

    let resultado
    try {
      await db.exec('BEGIN')
      const yaProcesado = await db.prepare('SELECT 1 FROM webhook_events WHERE stripe_event_id = $1').get(event.id)
      if (yaProcesado) {
        resultado = { duplicado: true }
      } else {
        if (event.type === 'checkout.session.completed') {
          await procesarCheckout(event)
        } else if (event.type === 'customer.subscription.deleted') {
          const sub = event?.data?.object
          if (sub?.id) {
            const subRecord = await db.prepare('SELECT empresa_id FROM suscripciones WHERE stripe_subscription_id = $1').get(String(sub.id))
            await db.prepare("UPDATE suscripciones SET estado = 'cancelado', cancel_at_period_end = TRUE WHERE stripe_subscription_id = $1").run(String(sub.id))
            if (subRecord?.empresa_id) {
              await revocarLicencia(subRecord.empresa_id, { por: `stripe:${event.id}`, motivo: 'subscription_cancelled' })
            }
          }
        } else if (event.type === 'invoice.payment_failed') {
          const invoice = event?.data?.object
          const subId = invoice?.subscription ? String(invoice.subscription) : null
          if (subId) {
            await db.prepare(
              `UPDATE suscripciones SET estado = 'impago', failed_at = ${NOW}, grace_ends_at = $1, updated_at = ${NOW} WHERE stripe_subscription_id = $2`
            ).run(plusDays(new Date(), GRACE_DAYS), subId)
          }
        } else if (event.type === 'invoice.payment_succeeded') {
          const invoice = event?.data?.object
          const subId = invoice?.subscription ? String(invoice.subscription) : null
          if (subId) {
            const sub = await db
              .prepare('SELECT empresa_id, stripe_price_id FROM suscripciones WHERE stripe_subscription_id = $1')
              .get(subId)
            if (sub) {
              await db.prepare(
                `UPDATE suscripciones SET estado = 'active', failed_at = NULL, grace_ends_at = NULL, cancel_at_period_end = FALSE, updated_at = ${NOW} WHERE stripe_subscription_id = $1`
              ).run(subId)
              const empresa = await db.prepare('SELECT * FROM empresas WHERE id = $1').get(sub.empresa_id)
              const modulo = moduloDePriceId(sub.stripe_price_id)
              if (empresa && modulo) {
                await emitirLicencia(empresa, { modulo, por: `stripe:${event.id}` })
              }
            }
          }
        }
        await db.prepare('INSERT INTO webhook_events (stripe_event_id, tipo, payload) VALUES ($1, $2, $3)').run(event.id, event.type, JSON.stringify(event))
        resultado = { duplicado: false }
      }
      await db.exec('COMMIT')
      return json(res, 200, { received: true, ...resultado })
    } catch (err) {
      try {
        await db.exec('ROLLBACK')
      } catch {}
      console.error('[webhook] error procesando evento', event?.type, err.message)
      return json(res, 500, { success: false, error: 'Error al procesar el evento' })
    }
  }

  return json(res, 404, { success: false, error: 'Ruta no encontrada' })
}

export function startServer({ port = PORT } = {}) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err)
      json(res, 500, { success: false, error: 'Error interno del servidor' })
    })
  })

  server.listen(port, () => {
    const addr = server.address()
    const actualPort = addr && typeof addr === 'object' ? addr.port : port
    console.log(`🚀 TOG Platform backend escuchando en http://localhost:${actualPort}`)
  })
  return server
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  startServer()
}
