import http from 'node:http'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { db, getActiveLicense } from './db.js'
import { signLicense, loadPrivateKey } from './sign.js'

const PORT = Number(process.env.PORT || 3001)
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'dev-admin-key'
const PRIVATE_KEY_PATH = process.env.LICENSE_PRIVATE_KEY_PATH || './keys/private.key'

let privateKey = null
try {
  privateKey = loadPrivateKey(PRIVATE_KEY_PATH)
  console.log(`🔑 Clave privada cargada desde ${PRIVATE_KEY_PATH}`)
} catch (err) {
  console.warn(`⚠️  No se pudo cargar la clave privada (${PRIVATE_KEY_PATH}): ${err.message}`)
  console.warn('   La emisión de licencias no estará disponible hasta configurar LICENSE_PRIVATE_KEY_PATH')
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

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname
  const method = req.method

  // GET /api/health
  if (method === 'GET' && path === '/api/health') {
    return json(res, 200, { ok: true, db: true, firmando: !!privateKey, tiempo: new Date().toISOString() })
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

  // POST /api/empresas/:id/licencias  (admin) — emisión manual de licencia
  const licenciasMatch = path.match(/^\/api\/empresas\/(\d+)\/licencias$/)
  if (method === 'POST' && licenciasMatch) {
    if (!requireAdmin(req, res)) return
    if (!privateKey) return json(res, 500, { success: false, error: 'Clave privada no configurada' })
    const empresaId = Number(licenciasMatch[1])
    const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(empresaId)
    if (!empresa) return json(res, 404, { success: false, error: 'Empresa no encontrada' })

    const body = await readBody(req)
    const { cliente, expira, machine_id = null, modules = null } = body || {}
    if (!cliente || !expira) return json(res, 400, { success: false, error: 'cliente y expira son requeridos' })

    let license
    try {
      license = signLicense(privateKey, { cliente, expira, machineId: machine_id, modules })
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
    const licencia = getActiveLicense(empresa.id)
    if (!licencia) return json(res, 404, { success: false, error: 'Sin licencia activa' })
    return json(res, 200, { success: true, licencia: JSON.parse(licencia.payload_json) })
  }

  // POST /api/checkout-session  (api_key) — Stripe pendiente
  if (method === 'POST' && path === '/api/checkout-session') {
    const empresa = requireEmpresa(req, res)
    if (!empresa) return
    return json(res, 501, { success: false, error: 'Checkout con tarjeta pendiente: usar emisión manual (pagos por transferencia/pago móvil)' })
  }

  // POST /api/webhook/stripe — pendiente (verificación de firma al activarse)
  if (method === 'POST' && path === '/api/webhook/stripe') {
    return json(res, 501, { success: false, error: 'Webhook de Stripe pendiente de configuración' })
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