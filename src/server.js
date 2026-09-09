import http from 'node:http'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { db, getActiveLicense } from './db.js'
import { signLicense, loadPrivateKey, MODULE_IDS } from './sign.js'
import { createCheckoutSession, createStripeCustomer, verifyStripeWebhook } from './stripe.js'

const PORT = Number(process.env.PORT || 3001)
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'dev-admin-key'
const PRIVATE_KEY_PATH = process.env.LICENSE_PRIVATE_KEY_PATH || './keys/private.key'
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || ''
const STRIPE_DOMAIN = (process.env.STRIPE_DOMAIN || `http://localhost:${PORT}`).replace(/\/+$/, '')
// Módulos que se pueden comprar por suscripción (el Comercializador es la base)
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

// Días de gracia por impago antes de revocar la licencia (modo lectura offline)
const GRACE_DAYS = Number(process.env.LICENSE_GRACE_DAYS || 14)

let privateKey = null
try {
  // Primero intentar desde variable de entorno (para Railway)
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

function requireAdmin(req, res) {
  if (req.headers['x-admin-key'] !== ADMIN_API_KEY) {
    json(res, 401, { success: false, error: 'X-Admin-Key inválida' })
    return false
  }
  return true
}

function requireEmpresa(req, res) {
  const apiKey = req.headers['x-api-key']
  if (!apiKey) {
    json(res, 401, { success: false, error: 'Falta X-Api-Key' })
    return null
  }
  const empresa = db.prepare('SELECT * FROM empresas WHERE api_key = ?').get(apiKey)
  if (!empresa) {
    json(res, 401, { success: false, error: 'Api key desconocida' })
    return null
  }
  return empresa
}

// ---------- cuenta web: password (scrypt) + tokens (HMAC-SHA256) ----------
// Cero dependencias: scrypt y HMAC son módulos built-in de node:crypto.

const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret'

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

function requireUser(req, res) {
  const auth = req.headers['authorization'] || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const payload = verifyToken(token)
  if (!payload?.uid) {
    json(res, 401, { success: false, error: 'Token inválido o expirado' })
    return null
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid)
  if (!user) {
    json(res, 401, { success: false, error: 'Usuario no encontrado' })
    return null
  }
  return user
}

// ---------- precios del carrito de compras ----------
// TOG base: 15$/mes · 40$/3 meses · 150$/año. Cada módulo adicional +3$/mes.
// OmniServ: 3$/mes (botón único, no pasa por el carrito).

const PRECIOS_TOG = { mensual: 15, trimestral: 40, anual: 150 }
const EXTRA_MODULO_MENSUAL = 3
const MESES_POR_PERIODO = { mensual: 1, trimestral: 3, anual: 12 }
// Módulos vendibles como extra sobre la base Comercializador (en orden canónico)
const MODULOS_EXTRA = MODULE_IDS.filter((m) => m !== 'comercializador' && m !== 'omniserv')

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

// ---------- rutas ----------

function paginaSimple(title, body) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:sans-serif;max-width:560px;margin:80px auto;text-align:center"><h1>${title}</h1><p>${body}</p></body></html>`
}

// Módulos de la licencia más reciente (aunque esté revocada) para preservar
// las compras acumuladas al re-emitir.
function modulosDeUltimaLicencia(empresaId) {
  const ultima = db
    .prepare('SELECT modules FROM licencias WHERE empresa_id = ? ORDER BY issued_at DESC, id DESC LIMIT 1')
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

// Emite (o renueva) la licencia de una empresa con un conjunto de módulos
// (suma a los acumulados de la última licencia, preservando compras previas).
function emitirLicenciaConModulos(empresa, { modulos, por, meses = 1 }) {
  if (!privateKey) throw new Error('Clave privada no configurada para firmar la licencia')
  const conjunto = new Set([...modulosDeUltimaLicencia(empresa.id), ...modulos])
  const ordenados = MODULE_IDS.filter((m) => conjunto.has(m))
  const license = signLicense(privateKey, {
    cliente: empresa.nombre,
    expira: plusMonths(new Date(), meses),
    modules: ordenados,
  })
  db.prepare(
    `INSERT INTO licencias
       (empresa_id, modules, max_usuarios, max_sucursales, issued_at, expires_at, payload_json, emitida_por)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(empresa.id, JSON.stringify(license.modules || []), 1, 1, license.emitida, license.expira, JSON.stringify(license), por)
  return license
}

// Compatibilidad: emite sumando un solo módulo (flujo Stripe y Crixto OmniServ).
function emitirLicencia(empresa, { modulo, por, meses = 1 }) {
  return emitirLicenciaConModulos(empresa, { modulos: [modulo], por, meses })
}

// ---------- facturas / recibos ----------

// Número de factura secuencial por año: F-2026-0001, F-2026-0002, …
function generarNroFactura() {
  const year = new Date().getFullYear()
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM pagos WHERE nro_factura IS NOT NULL AND substr(nro_factura, 3, 4) = ?")
    .get(String(year))
  const siguiente = Number(row?.n || 0) + 1
  return `F-${year}-${String(siguiente).padStart(4, '0')}`
}

// HTML autocontenido e imprimible del recibo/factura de un pago confirmado.
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

// Grace period vencido sin pago → 'cancelado_impago' y revocación de la licencia.
// Se ejecuta antes de servir una licencia (y en cada webhook) para no depender
// de un cron.
function revocarImpagosVencidos() {
  const hoy = new Date().toISOString().split('T')[0]
  const vencidas = db
    .prepare("SELECT id, empresa_id FROM suscripciones WHERE estado = 'impago' AND grace_ends_at IS NOT NULL AND grace_ends_at < ?")
    .all(hoy)
  if (!vencidas.length) return
  db.exec('BEGIN')
  try {
    for (const s of vencidas) {
      db.prepare("UPDATE suscripciones SET estado = 'cancelado_impago', updated_at = datetime('now') WHERE id = ?").run(s.id)
      db.prepare(
        "UPDATE licencias SET revoked_at = datetime('now'), motivo_revocado = 'impago:grace-period' WHERE empresa_id = ? AND revoked_at IS NULL"
      ).run(s.empresa_id)
    }
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // sin transacción activa
    }
    throw err
  }
}

// Procesa checkout.session.completed: activa el módulo comprado emitiendo una
// licencia nueva (módulos acumulados + comprado) con 1 mes de vigencia.
function procesarCheckout(event) {
  const session = event?.data?.object || {}
  const modulo = session?.metadata?.modulo
  if (!MODULOS_COMPRABLES.includes(modulo)) {
    throw new Error(`Módulo no comprable en checkout: ${modulo}`)
  }
  const empresaId = Number(session?.client_reference_id)
  const empresa = empresaId
    ? db.prepare('SELECT * FROM empresas WHERE id = ?').get(empresaId)
    : db.prepare('SELECT * FROM empresas WHERE stripe_customer_id = ?').get(session?.customer)
  if (!empresa) throw new Error('Empresa no encontrada para el checkout')
  if (session?.customer) {
    db.prepare('UPDATE empresas SET stripe_customer_id = ? WHERE id = ?').run(session.customer, empresa.id)
  }
  emitirLicencia(empresa, { modulo, por: `stripe:${event.id}` })

  const subId = session?.subscription ? String(session.subscription) : null
  if (subId) {
    db.prepare(
      `INSERT INTO suscripciones (empresa_id, stripe_subscription_id, stripe_price_id, estado, failed_at, grace_ends_at)
       VALUES (?, ?, ?, 'active', NULL, NULL)
       ON CONFLICT(stripe_subscription_id) DO UPDATE SET estado = 'active', failed_at = NULL, grace_ends_at = NULL, updated_at = datetime('now')`
    ).run(empresa.id, subId, priceIdFor(modulo))
  }
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname
  const method = req.method

  // GET /api/health
  if (method === 'GET' && path === '/api/health') {
    return json(res, 200, { ok: true, db: true, firmando: !!privateKey, tiempo: new Date().toISOString() })
  }

  // GET /api/time — hora del servidor (para validar contra manipulación de fecha local)
  if (method === 'GET' && path === '/api/time') {
    return json(res, 200, { server_time: Date.now(), iso: new Date().toISOString() })
  }

  // POST /api/empresas  (admin) — alta inicial de empresa, genera api_key
  // Identificación internacional: pais (ISO 3166-1 alpha-2) + documento de
  // registro/tributario (RIF, EIN, NIT, CUIT, CNPJ, VAT…). Un mismo número en
  // países distintos es válido; duplicado solo dentro del mismo país.
  if (method === 'POST' && path === '/api/empresas') {
    if (!requireAdmin(req, res)) return
    const body = await readBody(req)
    const nombre = typeof body?.nombre === 'string' ? body.nombre.trim() : ''
    const pais = (typeof body?.pais === 'string' ? body.pais.trim().toUpperCase() : 'VE') || 'VE'
    // Canónico en mayúsculas: los documentos tributarios/registrales no distinguen caja
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
      const result = db
        .prepare('INSERT INTO empresas (nombre, pais, documento, email_contacto, api_key) VALUES (?, ?, ?, ?, ?)')
        .run(nombre, pais, documento, emailContacto, apiKey)
      return json(res, 201, { success: true, id: result.lastInsertRowid, api_key: apiKey })
    } catch (err) {
      return json(res, 409, { success: false, error: `Documento duplicado para el país ${pais}: ${err.message}` })
    }
  }

  // GET /api/admin/empresas  (admin) — listado (incluye vínculo de dispositivo)
  if (method === 'GET' && path === '/api/admin/empresas') {
    if (!requireAdmin(req, res)) return
    const rows = db.prepare('SELECT id, nombre, pais, documento, email_contacto, device_fingerprint, payment_status, created_at FROM empresas ORDER BY created_at DESC').all()
    return json(res, 200, { empresas: rows })
  }

  // POST /api/admin/empresas/:id/dispositivo  (admin) — transferencia de licencia a otro teléfono
  // { device_fingerprint: null }     → desvincula: el próximo teléfono que reclame la licencia queda vinculado
  // { device_fingerprint: "<hash>" } → vincula directamente al dispositivo indicado
  const dispositivoMatch = path.match(/^\/api\/admin\/empresas\/(\d+)\/dispositivo$/)
  if (method === 'POST' && dispositivoMatch) {
    if (!requireAdmin(req, res)) return
    const empresaId = Number(dispositivoMatch[1])
    if (!db.prepare('SELECT id FROM empresas WHERE id = ?').get(empresaId)) {
      return json(res, 404, { success: false, error: 'Empresa no encontrada' })
    }
    const body = await readBody(req)
    const nuevo = typeof body?.device_fingerprint === 'string' ? body.device_fingerprint.trim() : null
    if (nuevo === '') {
      return json(res, 400, { success: false, error: 'device_fingerprint debe ser un hash no vacío o null (para desvincular)' })
    }
    db.prepare('UPDATE empresas SET device_fingerprint = ? WHERE id = ?').run(nuevo, empresaId)
    const row = db.prepare('SELECT id, device_fingerprint FROM empresas WHERE id = ?').get(empresaId)
    return json(res, 200, { success: true, empresa_id: row.id, device_fingerprint: row.device_fingerprint })
  }

  // POST /api/empresas/register  (público) — registro de cliente desde la app
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

    // Verificar si ya existe una empresa con ese país y documento
    const existente = db.prepare('SELECT id, api_key, nombre, email_contacto, payment_status, device_fingerprint FROM empresas WHERE pais = ? AND documento = ?').get(pais, documento)
    if (existente) {
      // Licencia de un solo dispositivo: si los mismos datos vienen de otro
      // teléfono, no se revela la api_key (aquí es donde se bypaseaba la licencia).
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
      const result = db
        .prepare('INSERT INTO empresas (nombre, pais, documento, email_contacto, api_key, device_fingerprint, payment_status) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(nombre, pais, documento, emailContacto, apiKey, deviceFingerprint, 'pending')
      return json(res, 201, { 
        success: true, 
        data: { 
          id: result.lastInsertRowid, 
          api_key: apiKey 
        } 
      })
    } catch (err) {
      return json(res, 500, { success: false, error: `Error al registrar: ${err.message}` })
    }
  }

  // GET /api/payment/confirm — confirmación de pago desde Crixto.
  // 1) ?payment_id=X (carrito TOG desde la landing) → confirma ese pago, emite
  //    la licencia con los módulos del carrito y genera la factura.
  // 2) ?empresa_id=X (deep link OmniServ) → flujo histórico: marca el pago de
  //    la empresa y emite licencia omniserv (1 mes).
  // 3) sin parámetros (URL fija del panel de Crixto) → página genérica de éxito.
  if (method === 'GET' && path === '/api/payment/confirm') {
    const paymentId = url.searchParams.get('payment_id')
    const empresaId = url.searchParams.get('empresa_id')
    const extra = [...url.searchParams.entries()].filter(([k]) => k !== 'payment_id' && k !== 'empresa_id')
    const providerRef = extra.length ? extra.map(([k, v]) => `${k}=${v}`).join('&') : null

    try {
      // Carrito TOG: confirmar el pago exacto (idempotente)
      if (paymentId) {
        const pago = db.prepare('SELECT * FROM pagos WHERE id = ?').get(Number(paymentId))
        if (!pago) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(paginaSimple('Error', 'Pago no encontrado'))
          return
        }
        const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(pago.empresa_id)
        if (!empresa) throw new Error('Empresa del pago no encontrada')
        if (pago.estado !== 'confirmed') {
          const nroFactura = generarNroFactura()
          db.prepare("UPDATE pagos SET estado = 'confirmed', paid_at = datetime('now'), nro_factura = ?, provider_ref = COALESCE(?, provider_ref) WHERE id = ?")
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
            emitirLicenciaConModulos(empresa, { modulos, por: `crixto:${pago.id}`, meses })
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(
            paginaSimple(
              '✅ Pago Confirmado',
              `Tu licencia fue activada (factura ${nroFactura}). <a href="/api/pagos/${pago.id}/factura">Ver recibo y factura</a> · vuelve a <a href="https://omnimargen.site/cuenta">tu cuenta</a>.`,
            ),
          )
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(paginaSimple('✅ Pago Confirmado', 'Este pago ya había sido confirmado.'))
        }
        return
      }

      // OmniServ (deep link con empresa_id): mantener el flujo histórico
      if (empresaId) {
        db.prepare("UPDATE empresas SET payment_status = 'confirmed', payment_confirmed_at = datetime('now') WHERE id = ?")
          .run(Number(empresaId))
        const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(Number(empresaId))
        if (empresa && privateKey) {
          emitirLicencia(empresa, { modulo: 'omniserv', por: 'crixto:auto', meses: 1 })
        }
        if (empresa) {
          db.prepare(
            "INSERT INTO pagos (user_id, empresa_id, concepto, detalle, monto, moneda, estado, provider, nro_factura, paid_at) VALUES (NULL, ?, 'omniserv:mensual', ?, 3, 'USD', 'confirmed', 'crixto', ?, datetime('now'))"
          ).run(empresa.id, JSON.stringify({ producto: 'omniserv', periodo: 'mensual', modulos: ['omniserv'], desglose: [{ modulo: 'OmniServ — mensual', precio: 3 }] }), generarNroFactura())
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(paginaSimple('✅ Pago Confirmado', 'Tu licencia ha sido activada. Vuelve a la app y presiona "Verificar Pago".'))
        return
      }

      // URL fija del panel de Crixto: página genérica (la confirmación real la
      // hace la landing vía el payment_id del formulario).
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(paginaSimple('✅ Pago exitoso', 'Gracias por tu pago. Vuelve a <a href="https://omnimargen.site/cuenta">tu cuenta OmniMargen</a> para ver tus servicios activos y tus facturas.'))
      return
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(paginaSimple('Error', 'Error al procesar el pago. Contacta soporte.'))
    }
    return
  }

  // POST /api/auth/register — alta de cuenta web (email + contraseña).
  // Crea/vincula la empresa por identidad internacional (pais + documento).
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
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
      return json(res, 409, { success: false, error: 'Ya existe una cuenta con ese email' })
    }

    let empresa = null
    if (documento) {
      empresa = db.prepare('SELECT * FROM empresas WHERE pais = ? AND documento = ?').get(pais, documento)
      if (!empresa) {
        const apiKey = crypto.randomBytes(16).toString('hex')
        const result = db
          .prepare('INSERT INTO empresas (nombre, pais, documento, email_contacto, api_key) VALUES (?, ?, ?, ?, ?)')
          .run(nombre, pais, documento, email, apiKey)
        empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(result.lastInsertRowid)
      }
    }

    const result = db
      .prepare('INSERT INTO users (email, password_hash, nombre, pais, documento, telefono, empresa_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(email, hashPassword(password), nombre, pais, documento, telefono || null, empresa?.id || null)
    const user = db.prepare('SELECT id, email, nombre, pais, documento, telefono, empresa_id, created_at FROM users WHERE id = ?').get(result.lastInsertRowid)
    return json(res, 201, { success: true, token: signToken({ uid: user.id }), user })
  }

  // POST /api/auth/login — iniciar sesión con email + contraseña
  if (method === 'POST' && path === '/api/auth/login') {
    const body = await readBody(req)
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email)
    if (!user || !verifyPassword(password, user.password_hash)) {
      return json(res, 401, { success: false, error: 'Email o contraseña incorrectos' })
    }
    const { password_hash, ...publico } = user
    return json(res, 200, { success: true, token: signToken({ uid: user.id }), user: publico })
  }

  // GET /api/user/profile — datos de la cuenta, empresa vinculada, licencia y pagos
  if (method === 'GET' && path === '/api/user/profile') {
    const user = requireUser(req, res)
    if (!user) return
    const empresa = user.empresa_id ? db.prepare('SELECT * FROM empresas WHERE id = ?').get(user.empresa_id) : null
    const licencia = empresa ? getActiveLicense(empresa.id) : null
    const host = req.headers.host ? `https://${req.headers.host}` : ''
    const pagos = db
      .prepare('SELECT id, concepto, monto, moneda, estado, nro_factura, paid_at, created_at FROM pagos WHERE user_id = ? ORDER BY id DESC LIMIT 50')
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

  // POST /api/payment/create — carrito CRIXTO: crea el pago y devuelve el monto
  // y la URL de retorno (el formulario de la landing programa amount_cx con ese monto).
  if (method === 'POST' && path === '/api/payment/create') {
    const user = requireUser(req, res)
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

    const empresa = user.empresa_id ? db.prepare('SELECT * FROM empresas WHERE id = ?').get(user.empresa_id) : null
    if (!empresa) return json(res, 400, { success: false, error: 'Vincula tu cuenta a una empresa (país + documento) para comprar' })

    const desglose = [{ modulo: `TOG Admin (base ${periodo})`, precio: PRECIOS_TOG[periodo] }]
    for (const m of modulos) desglose.push({ modulo: `Módulo ${m}`, precio: EXTRA_MODULO_MENSUAL * MESES_POR_PERIODO[periodo] })

    const result = db
      .prepare("INSERT INTO pagos (user_id, empresa_id, concepto, detalle, monto, moneda, estado, provider) VALUES (?, ?, ?, ?, ?, 'USD', 'pending', 'crixto')")
      .run(user.id, empresa.id, `tog:${periodo}`, JSON.stringify({ producto: 'tog', periodo, modulos: ['comercializador', ...modulos], desglose }), monto)
    const pagoId = result.lastInsertRowid

    const successUrl = `${req.headers.host ? 'https://' + req.headers.host : 'http://localhost:3001'}/api/payment/confirm?payment_id=${pagoId}`
    return json(res, 201, {
      success: true,
      payment_id: pagoId,
      monto,
      moneda: 'USD',
      periodo,
      modulos: ['comercializador', ...modulos],
      success_url: successUrl,
      cancel_url: 'https://omnimargen.site/precios?pago=cancelado',
    })
  }

  // GET /api/pagos/:id/factura — recibo/factura HTML imprimible
  const facturaMatch = path.match(/^\/api\/pagos\/(\d+)\/factura$/)
  if (method === 'GET' && facturaMatch) {
    const pago = db.prepare('SELECT * FROM pagos WHERE id = ?').get(Number(facturaMatch[1]))
    if (!pago || pago.estado !== 'confirmed') {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(paginaSimple('No encontrada', 'Esta factura no existe o el pago aún no fue confirmado.'))
      return
    }
    const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(pago.empresa_id)
    const user = pago.user_id ? db.prepare('SELECT * FROM users WHERE id = ?').get(pago.user_id) : null
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(htmlFactura(pago, empresa, user))
    return
  }

  // GET /api/empresas/:id/payment-status — verificar estado de pago
  const paymentStatusMatch = path.match(/^\/api\/empresas\/(\d+)\/payment-status$/)
  if (method === 'GET' && paymentStatusMatch) {
    const empresa = requireEmpresa(req, res)
    if (!empresa) return

    // Se usa la empresa autenticada por api_key (no el id de la URL) para no
    // filtrar el estado de pago de otras empresas (IDOR).
    return json(res, 200, {
      success: true,
      payment_confirmed: empresa.payment_status === 'confirmed'
    })
  }

  // POST /api/empresas/:id/licencias  (admin) — emisión manual de licencia
  const licenciasMatch = path.match(/^\/api\/empresas\/(\d+)\/licencias$/)
  if (method === 'POST' && licenciasMatch) {
    if (!requireAdmin(req, res)) return
    if (!privateKey) return json(res, 500, { success: false, error: 'Clave privada no configurada' })
    const empresaId = Number(licenciasMatch[1])
    const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(empresaId)
    if (!empresa) return json(res, 404, { success: false, error: 'Empresa no encontrada' })

    const body = await readBody(req)
    const { cliente, expira, machine_id = null, modules = null, max_pcs = null } = body || {}
    if (!cliente || !expira) return json(res, 400, { success: false, error: 'cliente y expira son requeridos' })

    let license
    try {
      license = signLicense(privateKey, { cliente, expira, machineId: machine_id, modules, maxPcs: max_pcs })
    } catch (err) {
      return json(res, 400, { success: false, error: err.message })
    }

    db.prepare(
      `INSERT INTO licencias
         (empresa_id, modules, max_usuarios, max_sucursales, issued_at, expires_at, payload_json, emitida_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'manual:admin')`
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

  // GET /api/empresas/:id/licencia  (api_key de la empresa) — licencia activa para "Sincronizar"
  const licenciaMatch = path.match(/^\/api\/empresas\/(\d+)\/licencia$/)
  if (method === 'GET' && licenciaMatch) {
    const empresa = requireEmpresa(req, res)
    if (!empresa) return
    try {
      revocarImpagosVencidos()
    } catch (err) {
      console.error('[licencia] error al barrer impagos vencidos', err.message)
    }
    
    // Licencia de un solo dispositivo (OmniServ): el teléfono SIEMPRE envía su
    // fingerprint en el header x-device-fingerprint. TOG Admin no lo envía y no
    // debe afectarse: el control solo aplica cuando el header viene en la petición.
    const deviceFingerprint = String(req.headers['x-device-fingerprint'] || url.searchParams.get('device_fingerprint') || '').trim()
    if (deviceFingerprint) {
      if (!empresa.device_fingerprint) {
        // Primer dispositivo que reclama la licencia: queda vinculado (atómico;
        // si otro teléfono lo reclamó en paralelo, gana el primero).
        const claimed = db
          .prepare('UPDATE empresas SET device_fingerprint = ? WHERE id = ? AND device_fingerprint IS NULL')
          .run(deviceFingerprint, empresa.id)
        if (claimed.changes === 0) {
          const ahora = db.prepare('SELECT device_fingerprint FROM empresas WHERE id = ?').get(empresa.id)
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

    const licencia = getActiveLicense(empresa.id)
    if (!licencia) {
      const sub = db.prepare('SELECT estado FROM suscripciones WHERE empresa_id = ? ORDER BY id DESC LIMIT 1').get(empresa.id)
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

  // POST /api/checkout-session  (api_key) — Stripe: suscripción de un módulo
  if (method === 'POST' && path === '/api/checkout-session') {
    const empresa = requireEmpresa(req, res)
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
        db.prepare('UPDATE empresas SET stripe_customer_id = ? WHERE id = ?').run(customerId, empresa.id)
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
      return json(res, 502, { success: false, error: err.message })
    }
  }

  // GET /checkout/success|cancel — página de retorno del checkout
  if (method === 'GET' && path.startsWith('/checkout/')) {
    const exito = path.includes('success')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(
      exito
        ? paginaSimple('✅ Pago exitoso', 'Tu módulo quedó activado. Vuelve a TOG Admin y presiona “Sincronizar” en Config → Licencia.')
        : paginaSimple('Pago cancelado', 'Puedes reintentar el pago cuando quieras. No se te cobró nada.'),
    )
    return
  }

  // POST /api/webhook/stripe — eventos idempotentes (webhook_events por stripe_event_id)
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
      return json(res, 400, { success: false, error: err.message })
    }
    let event
    try {
      event = JSON.parse(raw)
    } catch {
      return json(res, 400, { success: false, error: 'Payload del webhook no es JSON válido' })
    }

    let resultado
    try {
      db.exec('BEGIN')
      const yaProcesado = db.prepare('SELECT 1 FROM webhook_events WHERE stripe_event_id = ?').get(event.id)
      if (yaProcesado) {
        resultado = { duplicado: true }
      } else {
        if (event.type === 'checkout.session.completed') {
          procesarCheckout(event)
        } else if (event.type === 'customer.subscription.deleted') {
          const sub = event?.data?.object
          if (sub?.id) {
            db.prepare("UPDATE suscripciones SET estado = 'cancelado', cancel_at_period_end = 1 WHERE stripe_subscription_id = ?").run(String(sub.id))
          }
        } else if (event.type === 'invoice.payment_failed') {
          const invoice = event?.data?.object
          const subId = invoice?.subscription ? String(invoice.subscription) : null
          if (subId) {
            // Entra en grace period: la licencia sigue sirviéndose hasta grace_ends_at
            db.prepare(
              "UPDATE suscripciones SET estado = 'impago', failed_at = datetime('now'), grace_ends_at = ?, updated_at = datetime('now') WHERE stripe_subscription_id = ?"
            ).run(plusDays(new Date(), GRACE_DAYS), subId)
          }
        } else if (event.type === 'invoice.payment_succeeded') {
          const invoice = event?.data?.object
          const subId = invoice?.subscription ? String(invoice.subscription) : null
          if (subId) {
            const sub = db
              .prepare('SELECT empresa_id, stripe_price_id FROM suscripciones WHERE stripe_subscription_id = ?')
              .get(subId)
            if (sub) {
              db.prepare(
                "UPDATE suscripciones SET estado = 'active', failed_at = NULL, grace_ends_at = NULL, cancel_at_period_end = 0, updated_at = datetime('now') WHERE stripe_subscription_id = ?"
              ).run(subId)
              const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(sub.empresa_id)
              const modulo = moduloDePriceId(sub.stripe_price_id)
              if (empresa && modulo) {
                // Renovación mensual: re-emite la licencia (módulos acumulados + 1 mes)
                emitirLicencia(empresa, { modulo, por: `stripe:${event.id}` })
              }
            }
          }
        }
        // customer.subscription.updated y otros eventos: se registran y se ignoran en el MVP
        db.prepare('INSERT INTO webhook_events (stripe_event_id, tipo, payload) VALUES (?, ?, ?)').run(event.id, event.type, JSON.stringify(event))
        resultado = { duplicado: false }
      }
      db.exec('COMMIT')
      return json(res, 200, { received: true, ...resultado })
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // sin transacción activa
      }
      console.error('[webhook] error procesando evento', event?.type, err.message)
      return json(res, 500, { success: false, error: err.message })
    }
  }

  return json(res, 404, { success: false, error: 'Ruta no encontrada' })
}

/**
 * Arranca el servidor HTTP. Exportado para poder levantarlo en tests
 * (puerto 0 = efímero) o desde otros procesos sin escuchar al importar.
 */
export function startServer({ port = PORT } = {}) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err)
      json(res, 500, { success: false, error: err.message })
    })
  })

  server.listen(port, () => {
    const addr = server.address()
    const actualPort = addr && typeof addr === 'object' ? addr.port : port
    console.log(`🚀 TOG Platform backend escuchando en http://localhost:${actualPort}`)
  })
  return server
}

// Arranque directo: `node src/server.js` (no al ser importado por tests u otros módulos)
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  startServer()
}