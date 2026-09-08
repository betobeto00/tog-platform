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

// Emite (o renueva) la licencia de una empresa sumando/renovando un módulo.
function emitirLicencia(empresa, { modulo, por, meses = 1 }) {
  if (!privateKey) throw new Error('Clave privada no configurada para firmar la licencia')
  const conjunto = new Set([...modulosDeUltimaLicencia(empresa.id), modulo])
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

  // GET /api/admin/empresas  (admin) — listado
  if (method === 'GET' && path === '/api/admin/empresas') {
    if (!requireAdmin(req, res)) return
    const rows = db.prepare('SELECT id, nombre, pais, documento, email_contacto, created_at FROM empresas ORDER BY created_at DESC').all()
    return json(res, 200, { empresas: rows })
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
      return json(res, 409, { success: false, error: `Error al registrar: ${err.message}` })
    }
  }

  // GET /api/payment/confirm — confirmación de pago desde Crixto
  if (method === 'GET' && path === '/api/payment/confirm') {
    const empresaId = url.searchParams.get('empresa_id')
    if (!empresaId) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(paginaSimple('Error', 'Falta el ID de empresa'))
      return
    }

    try {
      db.prepare('UPDATE empresas SET payment_status = ?, payment_confirmed_at = datetime(\'now\') WHERE id = ?')
        .run('confirmed', Number(empresaId))
      
      // Emitir licencia automática
      const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(Number(empresaId))
      if (empresa && privateKey) {
        emitirLicencia(empresa, { modulo: 'omniserv', por: 'crixto:auto' })
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(paginaSimple('✅ Pago Confirmado', 'Tu licencia ha sido activada. Vuelve a la app y presiona "Verificar Pago".'))
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(paginaSimple('Error', 'Error al procesar el pago. Contacta soporte.'))
    }
    return
  }

  // GET /api/empresas/:id/payment-status — verificar estado de pago
  const paymentStatusMatch = path.match(/^\/api\/empresas\/(\d+)\/payment-status$/)
  if (method === 'GET' && paymentStatusMatch) {
    const empresa = requireEmpresa(req, res)
    if (!empresa) return

    const empresaId = Number(paymentStatusMatch[1])
    const emp = db.prepare('SELECT payment_status FROM empresas WHERE id = ?').get(empresaId)
    
    return json(res, 200, { 
      success: true, 
      payment_confirmed: emp?.payment_status === 'confirmed' 
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