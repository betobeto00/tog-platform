import http from 'node:http'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { db, getActiveLicense, closeDatabase, NOW } from './db.js'
import { signLicense, loadPrivateKey, MODULE_IDS } from './sign.js'
import {
  cifrar,
  descifrar,
  generateBackupCodes,
  generateTOTPSecret,
  hashBackupCode,
  otpauthUri,
  verifyTOTP,
} from './totp.js'

const PORT = Number(process.env.PORT || 3001)
const PRIVATE_KEY_PATH = process.env.LICENSE_PRIVATE_KEY_PATH || './keys/private.key'
const SITE_URL = (process.env.SITE_URL || 'https://omnimargen.site').replace(/\/+$/, '')

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
const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const INVOICE_FROM = process.env.INVOICE_FROM || 'OmniMargen <facturas@mail.omnimargen.site>'
const SECURITY_ALERT_EMAIL = process.env.SECURITY_ALERT_EMAIL || ''

// ---------- Parámetros de seguridad de pagos y dispositivos ----------

// Ventana anti-replay del HMAC de pagos (segundos). Amplia por defecto porque
// un pago móvil puede confirmarse horas después de generar la intención; un
// HMAC viejo siempre se rechaza. Acotarla con PAYMENT_HMAC_WINDOW_SECONDS si
// el flujo de cobro es inmediato.
const PAYMENT_HMAC_WINDOW_SECONDS = Number(process.env.PAYMENT_HMAC_WINDOW_SECONDS || 86400)
const PAYMENT_HMAC_CLOCK_SKEW_SECONDS = 60
// Máximo de intentos de confirmación/verificación de un mismo pago por minuto.
const PAYMENT_CONFIRM_MAX_PER_MINUTE = Number(process.env.PAYMENT_CONFIRM_MAX_PER_MINUTE || 10)

// Única fuente de verdad del precio mensual de OmniServ.
const OMNISERV_MENSUAL = 3

// Un pago pendiente más viejo que esto se expira en el job de conciliación.
const PENDING_PAYMENT_TTL_HOURS = Number(process.env.PENDING_PAYMENT_TTL_HOURS || 24)
// Enfriamiento entre cambios de device_fingerprint de una misma empresa.
const DEVICE_CHANGE_COOLDOWN_HOURS = Number(process.env.DEVICE_CHANGE_COOLDOWN_HOURS || 24)

function plusMonths(baseDate, months) {
  const d = new Date(baseDate)
  d.setMonth(d.getMonth() + months)
  return d.toISOString().split('T')[0]
}

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Key, X-Admin-Email, X-Api-Key, X-Device-Fingerprint')
  res.setHeader('Access-Control-Max-Age', '86400')
}

// ---------- Rate limiting ----------

const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000) // 1 minuto
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 60)                 // 60 requests por minuto por IP
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

// ---------- Rate limiting por clave (rutas sensibles) ----------

const scopedLimitMap = new Map()

/**
 * Límite de solicitudes por clave lógica (IP, empresa, usuario…).
 * Devuelve `{ allowed, retryAfterSec }` para poder responder 429 + Retry-After,
 * que es lo que la app Android respeta al hacer polling.
 */
function rateLimit(clave, { max, windowMs }) {
  const ahora = Date.now()
  if (scopedLimitMap.size > 5000) {
    for (const [k, v] of scopedLimitMap) {
      if (ahora - v.start > windowMs) scopedLimitMap.delete(k)
    }
  }
  let entry = scopedLimitMap.get(clave)
  if (!entry || ahora - entry.start > windowMs) {
    entry = { start: ahora, count: 0 }
    scopedLimitMap.set(clave, entry)
  }
  entry.count++
  if (entry.count > max) {
    const retryAfterSec = Math.max(1, Math.ceil((entry.start + windowMs - ahora) / 1000))
    return { allowed: false, retryAfterSec }
  }
  return { allowed: true, retryAfterSec: 0 }
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

function json(res, status, payload, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(payload, null, 2))
}

/** Respuesta 429 homogénea: incluye Retry-After para que el cliente espere. */
function demasiadasSolicitudes(res, retryAfterSec, mensaje = 'Demasiadas solicitudes. Intenta de nuevo en un momento.') {
  return json(res, 429, { success: false, error: mensaje }, { 'Retry-After': String(retryAfterSec) })
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
  // Un token de step-up (`purpose: '2fa'`) NO autentica la sesión: sólo sirve
  // para autorizar una operación sensible puntual.
  if (!payload?.uid || payload.purpose) {
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

// ---------- 2FA: TOTP (RFC 6238) ----------
//
// La primitiva criptográfica (TOTP/HOTP y cifrado en reposo de los secretos)
// vive en `totp.js`, que se testea contra los vectores de las RFCs sin tocar la
// base de datos. Aquí queda la configuración y lo que depende de la DB.

const TOTP_STEP_SECONDS = Number(process.env.TOTP_STEP_SECONDS || 30)
const TOTP_DIGITS = Number(process.env.TOTP_DIGITS || 6)
// ±1 paso (± 30 s) para tolerar el desfase de reloj del teléfono.
const TOTP_WINDOW = Number(process.env.TOTP_WINDOW || 1)
const TOTP_ISSUER = process.env.TOTP_ISSUER || 'OmniMargen'
const TWOFA_BACKUP_CODE_COUNT = Number(process.env.TWOFA_BACKUP_CODE_COUNT || 10)
const TWOFA_MAX_ATTEMPTS_PER_MINUTE = Number(process.env.TWOFA_MAX_ATTEMPTS_PER_MINUTE || 5)
const TWOFA_MAX_FALLOS = Number(process.env.TWOFA_MAX_FALLOS || 5)
const TWOFA_LOCKOUT_MINUTES = Number(process.env.TWOFA_LOCKOUT_MINUTES || 15)
const TWOFA_STEPUP_TTL_SECONDS = Number(process.env.TWOFA_STEPUP_TTL_SECONDS || 600)
const TWOFA_ALERTA_FALLOS_POR_IP = Number(process.env.TWOFA_ALERTA_FALLOS_POR_IP || 10)

const OPCIONES_TOTP = { step: TOTP_STEP_SECONDS, digits: TOTP_DIGITS, window: TOTP_WINDOW }

/**
 * Material para cifrar los secretos 2FA en reposo. Se prefiere
 * `TWO_FACTOR_ENC_KEY`; si no está se deriva de `JWT_SECRET` (ya obligatorio),
 * para no exigir configuración extra.
 * ⚠️ Rotar el material usado invalida los secretos guardados: los usuarios
 * tendrían que volver a enrolar 2FA.
 */
function material2FA() {
  return process.env.TWO_FACTOR_ENC_KEY || JWT_SECRET
}

/** Verifica un código TOTP contra el secreto (cifrado) de un usuario. */
function verificarCodigoTOTP(secretoCifrado, codigo) {
  try {
    return verifyTOTP(descifrar(secretoCifrado, material2FA()), codigo, OPCIONES_TOTP)
  } catch (err) {
    // Secreto indescifrable (p. ej. se rotó la clave de cifrado): se rechaza.
    console.error('[2fa] no se pudo descifrar el secreto:', err?.message || err)
    return false
  }
}

// ---------- estado, logs y límites de 2FA ----------

async function getTwoFactor(userId) {
  return db.prepare('SELECT * FROM two_factor_auth WHERE user_id = $1 AND method = $2').get(userId, 'totp')
}

async function estadoDosFactores(userId) {
  const fila = await getTwoFactor(userId)
  if (!fila) {
    return { enabled: false, pending: false, method: null, confirmed_at: null, last_used_at: null, backup_codes_disponibles: 0 }
  }
  const codigos = await db
    .prepare('SELECT COUNT(*) AS n FROM two_factor_backup_codes WHERE user_id = $1 AND used_at IS NULL')
    .get(userId)
  return {
    enabled: Number(fila.verified) === 1,
    pending: Number(fila.verified) !== 1,
    method: fila.method,
    confirmed_at: fila.confirmed_at || null,
    last_used_at: fila.last_used_at || null,
    backup_codes_disponibles: Number(codigos?.n || 0),
  }
}

async function logTwoFactor({ userId, action, success, ip, userAgent, detalle = null }) {
  try {
    await db
      .prepare('INSERT INTO two_factor_logs (user_id, action, method, success, ip_address, user_agent, detalle) VALUES ($1, $2, $3, $4, $5, $6, $7)')
      .run(userId, action, 'totp', success ? 1 : 0, ip || null, String(userAgent || '').slice(0, 200) || null, detalle)
  } catch (err) {
    console.error('[2fa] no se pudo registrar el log:', err?.message || err)
  }
}

function haceMinutos(minutos) {
  return new Date(Date.now() - minutos * 60_000).toISOString().replace('T', ' ').slice(0, 19)
}

async function contarFallos2FA(userId, minutos) {
  const fila = await db
    .prepare('SELECT COUNT(*) AS n FROM two_factor_logs WHERE user_id = $1 AND success = 0 AND created_at >= $2')
    .get(userId, haceMinutos(minutos))
  return Number(fila?.n || 0)
}

/**
 * Límite de intentos: N por minuto y bloqueo temporal tras M fallos en la
 * ventana. Devuelve null si se puede seguir, o { error, retryAfterSec }.
 */
async function limiteYBloqueo2FA(userId) {
  const limite = rateLimit(`2fa:${userId}`, { max: TWOFA_MAX_ATTEMPTS_PER_MINUTE, windowMs: 60_000 })
  if (!limite.allowed) {
    return { error: 'Demasiados intentos seguidos. Espera un minuto.', retryAfterSec: limite.retryAfterSec }
  }
  const fallos = await contarFallos2FA(userId, TWOFA_LOCKOUT_MINUTES)
  if (fallos >= TWOFA_MAX_FALLOS) {
    return {
      error: `Verificación bloqueada por ${TWOFA_LOCKOUT_MINUTES} minutos tras ${TWOFA_MAX_FALLOS} intentos fallidos.`,
      retryAfterSec: TWOFA_LOCKOUT_MINUTES * 60,
    }
  }
  return null
}

/** Alerta (una sola vez por ráfaga) si hay muchos fallos desde la misma IP. */
async function alertaFallos2FAPorIP(ip) {
  if (!ip) return
  const fila = await db
    .prepare('SELECT COUNT(*) AS n FROM two_factor_logs WHERE success = 0 AND ip_address = $1 AND created_at >= $2')
    .get(ip, haceMinutos(15))
  const fallos = Number(fila?.n || 0)
  if (fallos === TWOFA_ALERTA_FALLOS_POR_IP) {
    await sendSecurityAlert('Fallos repetidos de verificación 2FA', `ip=${ip} fallos_en_15min=${fallos}`)
  }
}

async function consumirBackupCode(userId, codigo) {
  const hash = Buffer.from(hashBackupCode(codigo, material2FA()), 'utf8')
  const filas = await db
    .prepare('SELECT id, code_hash FROM two_factor_backup_codes WHERE user_id = $1 AND used_at IS NULL')
    .all(userId)
  const coincidencia = filas.find((f) => {
    const almacenado = Buffer.from(String(f.code_hash), 'utf8')
    return almacenado.length === hash.length && crypto.timingSafeEqual(almacenado, hash)
  })
  if (!coincidencia) return false
  await db.prepare(`UPDATE two_factor_backup_codes SET used_at = ${NOW} WHERE id = $1`).run(coincidencia.id)
  return true
}

/**
 * Guardia de operaciones sensibles: si el usuario tiene 2FA activo, exige un
 * token de step-up válido (header `x-2fa-token`), emitido por `/api/2fa/step-up`.
 * Devuelve false y responde 401 si falta.
 */
async function requiereStepUp(user, req, res) {
  const fila = await getTwoFactor(user.id)
  if (!fila || Number(fila.verified) !== 1) return true
  const payload = verifyToken(String(req.headers['x-2fa-token'] || ''))
  if (!payload?.uid || payload.uid !== user.id || payload.purpose !== '2fa') {
    json(res, 401, { success: false, code: 'TWOFA_REQUIRED', error: 'Esta operación requiere verificación 2FA' })
    return false
  }
  return true
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

// ---------- HMAC para pagos (firmado + anti-replay) ----------
//
// La firma cubre `paymentId:monto:empresaId:timestamp`. Sin timestamp, un HMAC
// filtrado servía para siempre; con ventana de tiempo sólo vale durante N
// segundos y un replay de un HMAC viejo se rechaza.

function signPaymentHmac(paymentId, monto, empresaId, timestamp = Date.now()) {
  const data = `${paymentId}:${monto}:${empresaId}:${timestamp}`
  return {
    hmac: crypto.createHmac('sha256', PAYMENT_HMAC_SECRET).update(data).digest('hex'),
    timestamp,
  }
}

function verifyPaymentHmac(
  paymentId,
  monto,
  empresaId,
  hmac,
  timestamp,
  windowSeconds = PAYMENT_HMAC_WINDOW_SECONDS,
) {
  if (typeof hmac !== 'string' || !/^[a-f0-9]{64}$/.test(hmac)) return false
  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || ts <= 0) return false
  const ageMs = Date.now() - ts
  if (ageMs > windowSeconds * 1000) return false // HMAC vencido (anti-replay)
  if (ageMs < -PAYMENT_HMAC_CLOCK_SKEW_SECONDS * 1000) return false // reloj del cliente adelantado
  const { hmac: expected } = signPaymentHmac(paymentId, monto, empresaId, ts)
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hmac))
}

/** URL de retorno firmada que se entrega al proveedor de pago. */
function urlConfirmacionFirmada(pagoId, monto, empresaId, host) {
  const { hmac, timestamp } = signPaymentHmac(pagoId, monto, empresaId)
  const base = host ? `https://${host}` : `http://localhost:${PORT}`
  const params = new URLSearchParams({ payment_id: String(pagoId), hmac, ts: String(timestamp) })
  return `${base}/api/payment/confirm?${params.toString()}`
}

function parseDetalle(detalle) {
  try {
    const parsed = JSON.parse(detalle || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Monto que *debería* tener el pago según lo que se compró (recomputado desde
 * el detalle, nunca desde lo que diga el cliente).
 * Devuelve null si el detalle no permite recomputarlo → el pago se rechaza.
 */
function montoEsperadoDePago(pago) {
  const detalle = parseDetalle(pago.detalle)
  if (detalle.producto === 'omniserv') return OMNISERV_MENSUAL
  if (detalle.producto === 'tog') {
    const extras = Array.isArray(detalle.modulos)
      ? [...new Set(detalle.modulos.filter((m) => MODULOS_EXTRA.includes(m)))]
      : []
    return totalCarrito(detalle.periodo, extras)
  }
  return null
}

/** Alerta de seguridad: siempre al log; por email si SECURITY_ALERT_EMAIL existe. */
async function sendSecurityAlert(subject, mensaje) {
  console.error(`[seguridad] ${subject} — ${mensaje}`)
  if (!SECURITY_ALERT_EMAIL) return
  await sendEmail({
    to: SECURITY_ALERT_EMAIL,
    subject: `⚠️ Seguridad OmniMargen — ${subject}`,
    html: `<pre style="font-family:monospace;white-space:pre-wrap">${subject}\n\n${mensaje}</pre>`,
  }).catch(() => {})
}

/**
 * Confirma un pago: factura + licencia + email.
 * Sólo debe llamarse después de validar firma, monto y estado.
 */
async function confirmarPago(pago, { providerRef = null, por = `crixto:${pago.id}` } = {}) {
  const empresa = await db.prepare('SELECT * FROM empresas WHERE id = $1').get(pago.empresa_id)
  if (!empresa) throw new Error('Empresa del pago no encontrada')

  const nroFactura = await generarNroFactura()
  await db.prepare(
    `UPDATE pagos SET estado = 'confirmed', paid_at = ${NOW}, nro_factura = $1, provider_ref = COALESCE($2, provider_ref) WHERE id = $3`
  ).run(nroFactura, providerRef, pago.id)

  const detalle = parseDetalle(pago.detalle)
  // El estado de pago de la empresa sólo lo controla la compra de OmniServ
  // (es lo que consulta la app Android); una compra de TOG Admin no lo altera.
  if (detalle.producto === 'omniserv') {
    await db.prepare(
      `UPDATE empresas SET payment_status = 'confirmed', payment_confirmed_at = ${NOW} WHERE id = $1`
    ).run(empresa.id)
  }

  const modulos = Array.isArray(detalle.modulos) && detalle.modulos.length ? detalle.modulos : ['comercializador']
  const meses = MESES_POR_PERIODO[detalle.periodo] || 1
  if (privateKey) {
    await emitirLicenciaConModulos(empresa, { modulos, por, meses })
  }

  const pagoConfirmado = await db.prepare('SELECT * FROM pagos WHERE id = $1').get(pago.id)
  const user = pago.user_id ? await db.prepare('SELECT * FROM users WHERE id = $1').get(pago.user_id) : null
  sendInvoiceEmail(pagoConfirmado, empresa, user)
  return { nroFactura, empresa, pago: pagoConfirmado }
}

/**
 * Validaciones comunes antes de confirmar un pago.
 * Devuelve `{ ok: true }`, `{ ok: true, yaConfirmado: true, nroFactura }`
 * o `{ ok: false, status, error }`.
 */
async function validarPagoParaConfirmar(pago, { hmac, ts, windowSeconds, origen }) {
  if (!verifyPaymentHmac(pago.id, pago.monto, pago.empresa_id, hmac, ts, windowSeconds)) {
    await sendSecurityAlert(
      'Firma de pago inválida o vencida',
      `origen=${origen} pago=${pago.id} empresa=${pago.empresa_id}`,
    )
    return { ok: false, status: 403, error: 'Firma de pago inválida o vencida' }
  }

  const esperado = montoEsperadoDePago(pago)
  if (esperado == null || Math.abs(Number(pago.monto) - esperado) > 0.005) {
    await sendSecurityAlert(
      'Monto de pago inconsistente',
      `origen=${origen} pago=${pago.id} empresa=${pago.empresa_id} registrado=${pago.monto} esperado=${esperado}`,
    )
    return { ok: false, status: 409, error: 'Monto inconsistente con el plan seleccionado' }
  }

  if (pago.estado === 'confirmed') {
    return { ok: true, yaConfirmado: true, nroFactura: pago.nro_factura }
  }
  if (pago.estado !== 'pending') {
    return { ok: false, status: 409, error: `Pago en estado '${pago.estado}' — no se puede confirmar` }
  }
  return { ok: true, yaConfirmado: false }
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

/**
 * Revoca todas las licencias vigentes de una empresa (devolución, fraude,
 * cancelación manual…). Devuelve cuántas se revocaron.
 */
async function revocarLicencia(empresaId, { motivo = 'revocada:admin' } = {}) {
  const result = await db.prepare(
    `UPDATE licencias SET revoked_at = ${NOW}, motivo_revocado = $1 WHERE empresa_id = $2 AND revoked_at IS NULL`
  ).run(motivo, empresaId)
  return result.changes
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

function html2FAEstado(user, activado) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${activado ? '2FA activado' : '2FA desactivado'}</title></head>
<body style="font-family:sans-serif;max-width:560px;margin:40px auto;color:#222">
<h1 style="color:${activado ? '#16a34a' : '#dc2626'}">${activado ? 'Verificación en dos pasos ACTIVADA' : 'Verificación en dos pasos DESACTIVADA'}</h1>
<p>Hola <strong>${user.nombre || 'Usuario'}</strong>,</p>
<p>${activado
    ? 'Tu cuenta ahora pide un código de tu app de autenticación para las operaciones sensibles (cambio de email, regenerar códigos de respaldo y desactivar 2FA).'
    : 'Tu cuenta ya NO pide código adicional para las operaciones sensibles.'}</p>
<p><strong>Si no fuiste tú,</strong> cambiá tu contraseña y escribinos a soporte@omnimargen.site de inmediato.</p>
<p style="color:#666;margin-top:32px;font-size:13px">OmniMargen — omnimargen.site</p>
</body></html>`
}

async function send2FAEstadoEmail(user, activado) {
  if (!user?.email) return
  await sendEmail({
    to: user.email,
    subject: activado ? 'Verificación en dos pasos activada — OmniMargen' : 'Verificación en dos pasos desactivada — OmniMargen',
    html: html2FAEstado(user, activado),
  })
}

function htmlEmailCambiado(anterior, nuevo) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Tu email cambió</title></head>
<body style="font-family:sans-serif;max-width:560px;margin:40px auto;color:#222">
<h1 style="color:#d97706">Tu email de acceso cambió</h1>
<p>El email de tu cuenta OmniMargen pasó de <strong>${anterior}</strong> a <strong>${nuevo}</strong>.</p>
<p><strong>Si no fuiste tú,</strong> escribinos ahora a soporte@omnimargen.site: alguien podría tener acceso a tu cuenta.</p>
<p style="color:#666;margin-top:32px;font-size:13px">OmniMargen — omnimargen.site</p>
</body></html>`
}

function htmlDeviceChange(empresa, fingerprintNuevo, razon) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Cambio de dispositivo autorizado</title></head>
<body style="font-family:sans-serif;max-width:560px;margin:40px auto;color:#222">
<h1 style="color:#d97706">Se cambió el dispositivo de tu licencia</h1>
<p>Hola,</p>
<p>El dispositivo autorizado de <strong>${empresa.nombre}</strong> (${empresa.pais} · ${empresa.documento}) acaba de cambiar.</p>
<div style="border:1px solid #ddd;border-radius:8px;padding:12px 16px;margin:16px 0">
  <p style="margin:4px 0"><strong>Fecha:</strong> ${new Date().toLocaleString('es-VE', { timeZone: 'UTC' })} UTC</p>
  <p style="margin:4px 0"><strong>Dispositivo nuevo:</strong> ${fingerprintNuevo ?? '— (desvinculado) —'}</p>
  <p style="margin:4px 0"><strong>Motivo declarado:</strong> ${razon}</p>
</div>
<p><strong>Si no solicitaste este cambio,</strong> responde a este correo de inmediato: alguien podría estar intentando activar tu licencia en otro equipo.</p>
<p style="color:#666;margin-top:32px;font-size:13px">OmniMargen — omnimargen.site · soporte@omnimargen.site</p>
</body></html>`
}

async function sendDeviceChangeEmail(empresa, fingerprintNuevo, razon) {
  if (!empresa?.email_contacto) return
  await sendEmail({
    to: empresa.email_contacto,
    subject: 'Se cambió el dispositivo autorizado de tu licencia — OmniMargen',
    html: htmlDeviceChange(empresa, fingerprintNuevo, razon),
  })
}

let lastRenewalReminderDay = ''
async function enviarRecordatoriosRenovacion() {
  const hoy = new Date().toISOString().split('T')[0]
  if (lastRenewalReminderDay === hoy) return
  lastRenewalReminderDay = hoy
  const en7dias = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]
  const en3dias = new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0]
  const porVencer = await db.prepare(
    `SELECT l.empresa_id, l.expires_at, e.nombre, e.email_contacto
     FROM licencias l JOIN empresas e ON e.id = l.empresa_id
     WHERE l.revoked_at IS NULL AND l.expires_at IN ($1, $2)`
  ).all(en7dias, en3dias)
  for (const lic of porVencer) {
    if (!lic.email_contacto) continue
    const diasRestantes = Math.ceil((new Date(lic.expires_at) - Date.now()) / 86400000)
    const user = await db.prepare('SELECT nombre FROM users WHERE empresa_id = $1 LIMIT 1').get(lic.empresa_id)
    await sendEmail({
      to: lic.email_contacto,
      subject: `Tu licencia vence en ${diasRestantes} día${diasRestantes === 1 ? '' : 's'} — OmniMargen`,
      html: htmlRenewalReminder(user || { nombre: lic.email_contacto }, { nombre: lic.nombre, fecha_expiracion: lic.expires_at }, diasRestantes),
    }).catch(() => {})
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

  // POST /api/admin/empresas/:id/dispositivo (admin) — cambia el dispositivo
  // autorizado. Queda auditado (cuándo, por qué, desde qué IP y con qué key) y
  // se avisa por email al dueño; con enfriamiento de 24h por empresa.
  const dispositivoMatch = path.match(/^\/api\/admin\/empresas\/(\d+)\/dispositivo$/)
  if (method === 'POST' && dispositivoMatch) {
    if (!(await requireAdmin(req, res))) return
    const empresaId = Number(dispositivoMatch[1])
    const empresa = await db.prepare('SELECT * FROM empresas WHERE id = $1').get(empresaId)
    if (!empresa) {
      return json(res, 404, { success: false, error: 'Empresa no encontrada' })
    }

    const body = await readBody(req)
    const nuevo = typeof body?.device_fingerprint === 'string' ? body.device_fingerprint.trim() : null
    const razon = typeof body?.razon === 'string' ? body.razon.trim() : ''
    if (nuevo === '') {
      return json(res, 400, { success: false, error: 'device_fingerprint debe ser un hash no vacío o null (para desvincular)' })
    }
    if (nuevo !== null && !/^[a-fA-F0-9]{16,128}$/.test(nuevo)) {
      return json(res, 400, { success: false, error: 'device_fingerprint debe ser un hash hexadecimal de 16 a 128 caracteres' })
    }
    if (razon.length < 5 || razon.length > 200) {
      return json(res, 400, { success: false, error: 'razon es requerida (5–200 caracteres): justifica el cambio' })
    }

    const limiteFecha = new Date(Date.now() - DEVICE_CHANGE_COOLDOWN_HOURS * 3600_000).toISOString().replace('T', ' ').slice(0, 19)
    const ultimo = await db
      .prepare('SELECT id, created_at FROM device_fingerprint_audit WHERE empresa_id = $1 AND created_at >= $2 ORDER BY id DESC LIMIT 1')
      .get(empresaId, limiteFecha)
    if (ultimo) {
      return json(res, 429, {
        success: false,
        error: `Ya se cambió el dispositivo de esta empresa hace menos de ${DEVICE_CHANGE_COOLDOWN_HOURS}h. Intenta más tarde o contacta soporte.`,
        ultimo_cambio: ultimo.created_at,
      })
    }

    await db.prepare('UPDATE empresas SET device_fingerprint = $1 WHERE id = $2').run(nuevo, empresaId)

    const adminEmail = String(req.headers['x-admin-email'] || '').trim().slice(0, 120)
    const adminKeyHash = crypto.createHash('sha256').update(String(req.headers['x-admin-key'] || '')).digest('hex').slice(0, 16)
    await db.prepare(
      `INSERT INTO device_fingerprint_audit
         (empresa_id, admin_key_hash, admin_email, fingerprint_antiguo, fingerprint_nuevo, razon, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`
    ).run(
      empresaId,
      adminKeyHash,
      adminEmail || null,
      empresa.device_fingerprint,
      nuevo,
      razon,
      ip,
      String(req.headers['user-agent'] || '').slice(0, 200),
    )

    console.log(`[admin] device_fingerprint de empresa ${empresaId} cambiado — ${razon}`)
    sendDeviceChangeEmail(empresa, nuevo, razon).catch(() => {})

    const row = await db.prepare('SELECT id, device_fingerprint FROM empresas WHERE id = $1').get(empresaId)
    return json(res, 200, { success: true, empresa_id: row.id, device_fingerprint: row.device_fingerprint })
  }

  // POST /api/empresas/:id/rebind — el propio cliente re-vincula su dispositivo.
  // Misma lógica que el endpoint admin pero autenticado con x-api-key (no admin key).
  const rebindMatch = path.match(/^\/api\/empresas\/(\d+)\/rebind$/)
  if (method === 'POST' && rebindMatch) {
    const empresa = await requireEmpresa(req, res)
    if (!empresa) return
    const empresaId = Number(rebindMatch[1])
    if (empresa.id !== empresaId) {
      return json(res, 403, { success: false, error: 'No autorizado para rebind de otra empresa' })
    }

    const body = await readBody(req)
    const nuevo = typeof body?.device_fingerprint === 'string' ? body.device_fingerprint.trim() : ''
    if (!nuevo || !/^[a-fA-F0-9]{16,128}$/.test(nuevo)) {
      return json(res, 400, { success: false, error: 'device_fingerprint requerido (hex 16-128 chars)' })
    }

    const limiteFecha = new Date(Date.now() - DEVICE_CHANGE_COOLDOWN_HOURS * 3600_000).toISOString().replace('T', ' ').slice(0, 19)
    const ultimo = await db
      .prepare('SELECT id, created_at FROM device_fingerprint_audit WHERE empresa_id = $1 AND created_at >= $2 ORDER BY id DESC LIMIT 1')
      .get(empresaId, limiteFecha)
    if (ultimo) {
      return json(res, 429, {
        success: false,
        error: `Ya se cambió el dispositivo hace menos de ${DEVICE_CHANGE_COOLDOWN_HOURS}h. Intenta más tarde.`,
        ultimo_cambio: ultimo.created_at,
      })
    }

    const antiguo = empresa.device_fingerprint
    await db.prepare('UPDATE empresas SET device_fingerprint = $1 WHERE id = $2').run(nuevo, empresaId)

    await db.prepare(
      `INSERT INTO device_fingerprint_audit
         (empresa_id, admin_key_hash, admin_email, fingerprint_antiguo, fingerprint_nuevo, razon, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`
    ).run(
      empresaId,
      null,
      empresa.email_contacto || null,
      antiguo,
      nuevo,
      'Re-vinculación desde el cliente',
      ip,
      String(req.headers['user-agent'] || '').slice(0, 200),
    )

    console.log(`[rebind] empresa ${empresaId}: ${antiguo || '(sin previo)'} → ${nuevo}`)
    sendDeviceChangeEmail(empresa, nuevo, 'Re-vinculación desde el cliente').catch(() => {})

    return json(res, 200, { success: true, empresa_id: empresaId, device_fingerprint: nuevo })
  }

  // GET /api/admin/empresas/:id/audit/dispositivo (admin)
  const auditDispositivoMatch = path.match(/^\/api\/admin\/empresas\/(\d+)\/audit\/dispositivo$/)
  if (method === 'GET' && auditDispositivoMatch) {
    if (!(await requireAdmin(req, res))) return
    const empresaId = Number(auditDispositivoMatch[1])
    const cambios = await db
      .prepare('SELECT id, admin_email, admin_key_hash, fingerprint_antiguo, fingerprint_nuevo, razon, ip_address, created_at FROM device_fingerprint_audit WHERE empresa_id = $1 ORDER BY id DESC LIMIT 100')
      .all(empresaId)
    return json(res, 200, { success: true, empresa_id: empresaId, cambios })
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

  // GET /api/payment/confirm — retorno firmado del proveedor de pago (Crixto).
  // La URL la generamos nosotros al crear la intención y viaja firmada con
  // hmac + ts: sin firma válida (o con firma vencida) no se confirma nada.
  if (method === 'GET' && path === '/api/payment/confirm') {
    const paymentId = Number(url.searchParams.get('payment_id'))
    const hmac = url.searchParams.get('hmac') || ''
    const ts = url.searchParams.get('ts') || ''
    const extra = [...url.searchParams.entries()].filter(([k]) => !['payment_id', 'hmac', 'ts'].includes(k))
    const providerRef = extra.length ? extra.map(([k, v]) => `${k}=${v}`).join('&') : null

    try {
      if (!paymentId || !hmac || !ts) {
        res.writeHead(302, { Location: `${SITE_URL}/pago-cancelado` })
        res.end()
        return
      }

      const limite = rateLimit(`confirm:${paymentId}`, {
        max: PAYMENT_CONFIRM_MAX_PER_MINUTE,
        windowMs: 60_000,
      })
      if (!limite.allowed) {
        res.writeHead(429, { 'Retry-After': String(limite.retryAfterSec), 'Content-Type': 'text/html; charset=utf-8' })
        res.end(paginaSimple('Demasiados intentos', 'Espera un momento y vuelve a intentar la confirmación del pago.'))
        return
      }

      const pago = await db.prepare('SELECT * FROM pagos WHERE id = $1').get(paymentId)
      if (!pago) {
        res.writeHead(302, { Location: `${SITE_URL}/pago-cancelado` })
        res.end()
        return
      }

      const validacion = await validarPagoParaConfirmar(pago, { hmac, ts, origen: 'redirect' })
      if (!validacion.ok) {
        console.error(`[payment/confirm] pago ${paymentId} rechazado: ${validacion.error}`)
        res.writeHead(302, { Location: `${SITE_URL}/pago-cancelado` })
        res.end()
        return
      }

      if (!validacion.yaConfirmado) {
        await confirmarPago(pago, { providerRef })
      }

      res.writeHead(302, { Location: `${SITE_URL}/pago-exitoso` })
      res.end()
    } catch (err) {
      console.error('[payment/confirm]', err)
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

  // GET /api/2fa/status (JWT)
  if (method === 'GET' && path === '/api/2fa/status') {
    const user = await requireUser(req, res)
    if (!user) return
    return json(res, 200, { success: true, ...(await estadoDosFactores(user.id)) })
  }

  // POST /api/2fa/setup/totp (JWT) — genera un secreto pendiente (no activa nada)
  if (method === 'POST' && path === '/api/2fa/setup/totp') {
    const user = await requireUser(req, res)
    if (!user) return

    const limite = rateLimit(`2fa-setup:${user.id}`, { max: 5, windowMs: 60_000 })
    if (!limite.allowed) return demasiadasSolicitudes(res, limite.retryAfterSec)

    const actual = await getTwoFactor(user.id)
    if (actual && Number(actual.verified) === 1) {
      return json(res, 409, { success: false, error: '2FA ya está activo. Desactívalo antes de reconfigurarlo.' })
    }

    const secret = generateTOTPSecret()
    // Se reemplaza cualquier setup pendiente: todavía no verificaba nada.
    await db.prepare('DELETE FROM two_factor_auth WHERE user_id = $1').run(user.id)
    await db
      .prepare("INSERT INTO two_factor_auth (user_id, method, secret, verified) VALUES ($1, 'totp', $2, 0)")
      .run(user.id, cifrar(secret, material2FA()))
    await logTwoFactor({ userId: user.id, action: 'setup', success: 1, ip, userAgent: req.headers['user-agent'] })

    return json(res, 201, {
      success: true,
      method: 'totp',
      secret,
      digits: TOTP_DIGITS,
      step: TOTP_STEP_SECONDS,
      otpauth_uri: otpauthUri({
        secret,
        email: user.email,
        issuer: TOTP_ISSUER,
        digits: TOTP_DIGITS,
        step: TOTP_STEP_SECONDS,
      }),
      mensaje: 'Carga la clave en tu app de autenticación y confirmá con el código de 6 dígitos.',
    })
  }

  // POST /api/2fa/verify/totp (JWT) — activa 2FA y entrega los códigos de respaldo (una sola vez)
  if (method === 'POST' && path === '/api/2fa/verify/totp') {
    const user = await requireUser(req, res)
    if (!user) return

    const bloqueo = await limiteYBloqueo2FA(user.id)
    if (bloqueo) {
      return json(res, 429, { success: false, error: bloqueo.error }, { 'Retry-After': String(bloqueo.retryAfterSec) })
    }

    const fila = await getTwoFactor(user.id)
    if (!fila) return json(res, 409, { success: false, error: 'No hay un setup de 2FA pendiente' })
    if (Number(fila.verified) === 1) return json(res, 409, { success: false, error: '2FA ya está activo' })

    const body = await readBody(req)
    const ok = verificarCodigoTOTP(fila.secret, body?.codigo)
    await logTwoFactor({ userId: user.id, action: 'enable', success: ok ? 1 : 0, ip, userAgent: req.headers['user-agent'] })
    if (!ok) {
      await alertaFallos2FAPorIP(ip)
      return json(res, 401, { success: false, error: 'Código inválido' })
    }

    const codigos = generateBackupCodes(TWOFA_BACKUP_CODE_COUNT)
    await db.exec('BEGIN')
    try {
      await db
        .prepare(`UPDATE two_factor_auth SET verified = 1, confirmed_at = ${NOW}, last_used_at = ${NOW} WHERE user_id = $1`)
        .run(user.id)
      await db.prepare('DELETE FROM two_factor_backup_codes WHERE user_id = $1').run(user.id)
      for (const codigo of codigos) {
        await db
          .prepare('INSERT INTO two_factor_backup_codes (user_id, code_hash) VALUES ($1, $2)')
          .run(user.id, hashBackupCode(codigo, material2FA()))
      }
      await db.exec('COMMIT')
    } catch (err) {
      try {
        await db.exec('ROLLBACK')
      } catch {}
      throw err
    }

    send2FAEstadoEmail(user, true).catch(() => {})
    return json(res, 200, {
      success: true,
      backup_codes: codigos,
      mensaje: '2FA activado. Guarda estos códigos: no se vuelven a mostrar.',
    })
  }

  // POST /api/2fa/step-up (JWT) — código TOTP o de respaldo → token de corta vida
  if (method === 'POST' && path === '/api/2fa/step-up') {
    const user = await requireUser(req, res)
    if (!user) return

    const bloqueo = await limiteYBloqueo2FA(user.id)
    if (bloqueo) {
      return json(res, 429, { success: false, error: bloqueo.error }, { 'Retry-After': String(bloqueo.retryAfterSec) })
    }

    const fila = await getTwoFactor(user.id)
    if (!fila || Number(fila.verified) !== 1) {
      return json(res, 409, { success: false, error: '2FA no está activo' })
    }

    const body = await readBody(req)
    const usarRespaldo = Boolean(body?.backup_code)
    const ok = usarRespaldo
      ? await consumirBackupCode(user.id, body.backup_code)
      : verificarCodigoTOTP(fila.secret, body?.codigo)
    await logTwoFactor({
      userId: user.id,
      action: usarRespaldo ? 'recovery' : 'verify',
      success: ok ? 1 : 0,
      ip,
      userAgent: req.headers['user-agent'],
    })
    if (!ok) {
      await alertaFallos2FAPorIP(ip)
      return json(res, 401, { success: false, error: usarRespaldo ? 'Código de respaldo inválido o ya usado' : 'Código inválido' })
    }

    await db.prepare(`UPDATE two_factor_auth SET last_used_at = ${NOW} WHERE user_id = $1`).run(user.id)
    const estado = await estadoDosFactores(user.id)
    return json(res, 200, {
      success: true,
      twofa_token: signToken({ uid: user.id, purpose: '2fa' }, TWOFA_STEPUP_TTL_SECONDS),
      expira_en_segundos: TWOFA_STEPUP_TTL_SECONDS,
      backup_codes_disponibles: estado.backup_codes_disponibles,
    })
  }

  // POST /api/2fa/disable (JWT) — exige contraseña + código (TOTP o de respaldo)
  if (method === 'POST' && path === '/api/2fa/disable') {
    const user = await requireUser(req, res)
    if (!user) return

    const bloqueo = await limiteYBloqueo2FA(user.id)
    if (bloqueo) {
      return json(res, 429, { success: false, error: bloqueo.error }, { 'Retry-After': String(bloqueo.retryAfterSec) })
    }

    const fila = await getTwoFactor(user.id)
    if (!fila || Number(fila.verified) !== 1) {
      return json(res, 409, { success: false, error: '2FA no está activo' })
    }

    const body = await readBody(req)
    if (!verifyPassword(String(body?.password || ''), user.password_hash)) {
      await logTwoFactor({
        userId: user.id,
        action: 'disable',
        success: 0,
        ip,
        userAgent: req.headers['user-agent'],
        detalle: 'contraseña incorrecta',
      })
      return json(res, 401, { success: false, error: 'Contraseña incorrecta' })
    }

    const ok = body?.backup_code
      ? await consumirBackupCode(user.id, body.backup_code)
      : verificarCodigoTOTP(fila.secret, body?.codigo)
    await logTwoFactor({ userId: user.id, action: 'disable', success: ok ? 1 : 0, ip, userAgent: req.headers['user-agent'] })
    if (!ok) {
      await alertaFallos2FAPorIP(ip)
      return json(res, 401, { success: false, error: 'Código 2FA inválido' })
    }

    await db.exec('BEGIN')
    try {
      await db.prepare('DELETE FROM two_factor_auth WHERE user_id = $1').run(user.id)
      await db.prepare('DELETE FROM two_factor_backup_codes WHERE user_id = $1').run(user.id)
      await db.exec('COMMIT')
    } catch (err) {
      try {
        await db.exec('ROLLBACK')
      } catch {}
      throw err
    }

    send2FAEstadoEmail(user, false).catch(() => {})
    return json(res, 200, { success: true, message: '2FA desactivado' })
  }

  // POST /api/2fa/backup-codes (JWT) — regenera los códigos (requiere step-up)
  if (method === 'POST' && path === '/api/2fa/backup-codes') {
    const user = await requireUser(req, res)
    if (!user) return
    if (!(await requiereStepUp(user, req, res))) return

    const fila = await getTwoFactor(user.id)
    if (!fila || Number(fila.verified) !== 1) {
      return json(res, 409, { success: false, error: '2FA no está activo' })
    }

    const codigos = generateBackupCodes(TWOFA_BACKUP_CODE_COUNT)
    await db.prepare('DELETE FROM two_factor_backup_codes WHERE user_id = $1').run(user.id)
    for (const codigo of codigos) {
      await db
        .prepare('INSERT INTO two_factor_backup_codes (user_id, code_hash) VALUES ($1, $2)')
        .run(user.id, hashBackupCode(codigo, material2FA()))
    }
    await logTwoFactor({ userId: user.id, action: 'backup_codes', success: 1, ip, userAgent: req.headers['user-agent'] })
    return json(res, 200, {
      success: true,
      backup_codes: codigos,
      mensaje: 'Los códigos anteriores ya no sirven.',
    })
  }

  // POST /api/user/change-email (JWT) — operación sensible: con 2FA exige step-up
  if (method === 'POST' && path === '/api/user/change-email') {
    const user = await requireUser(req, res)
    if (!user) return
    if (!(await requiereStepUp(user, req, res))) return

    const body = await readBody(req)
    const nuevo = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(nuevo)) {
      return json(res, 400, { success: false, error: 'Email inválido' })
    }
    if (nuevo === user.email) {
      return json(res, 400, { success: false, error: 'Es el mismo email que ya tienes' })
    }
    const existente = await db.prepare('SELECT id FROM users WHERE email = $1').get(nuevo)
    if (existente && Number(existente.id) !== Number(user.id)) {
      return json(res, 409, { success: false, error: 'Ese email ya está en uso' })
    }

    await db.prepare(`UPDATE users SET email = $1, updated_at = ${NOW} WHERE id = $2`).run(nuevo, user.id)
    await logTwoFactor({
      userId: user.id,
      action: 'change_email',
      success: 1,
      ip,
      userAgent: req.headers['user-agent'],
      detalle: `email_anterior=${user.email}`,
    })
    // Aviso al email viejo: si no fuiste tú, hay que reaccionar ya.
    sendEmail({
      to: user.email,
      subject: 'Tu email de OmniMargen cambió',
      html: htmlEmailCambiado(user.email, nuevo),
    }).catch(() => {})

    return json(res, 200, { success: true, email: nuevo })
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

    const { hmac, timestamp } = signPaymentHmac(pagoId, monto, empresa.id)
    return json(res, 201, {
      success: true,
      payment_id: pagoId,
      monto,
      moneda: 'USD',
      periodo,
      modulos: ['comercializador', ...modulos],
      hmac,
      timestamp,
      success_url: urlConfirmacionFirmada(pagoId, monto, empresa.id, req.headers.host),
      cancel_url: `${SITE_URL}/pago-cancelado`,
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

    const { hmac, timestamp } = signPaymentHmac(pagoId, monto, empresa.id)
    return json(res, 201, {
      success: true,
      payment_id: pagoId,
      monto,
      moneda: 'USD',
      hmac,
      timestamp,
      success_url: urlConfirmacionFirmada(pagoId, monto, empresa.id, req.headers.host),
      cancel_url: `${SITE_URL}/pago-cancelado`,
    })
  }

  // POST /api/payment/omniserv-intent (api_key) — intención de pago de OmniServ
  // para el flujo por dispositivo (sin cuenta web). Devuelve la URL de retorno
  // firmada: el redirect de Crixto ya no puede confirmar pagos por sí solo.
  if (method === 'POST' && path === '/api/payment/omniserv-intent') {
    const empresa = await requireEmpresa(req, res)
    if (!empresa) return

    const limite = rateLimit(`intent:${empresa.id}`, { max: 10, windowMs: 60_000 })
    if (!limite.allowed) return demasiadasSolicitudes(res, limite.retryAfterSec)

    const monto = OMNISERV_MENSUAL
    const result = await db
      .prepare("INSERT INTO pagos (user_id, empresa_id, concepto, detalle, monto, moneda, estado, provider) VALUES (NULL, $1, 'omniserv:mensual', $2, $3, 'USD', 'pending', 'crixto') RETURNING id")
      .run(
        empresa.id,
        JSON.stringify({
          producto: 'omniserv',
          periodo: 'mensual',
          modulos: ['omniserv'],
          desglose: [{ modulo: 'OmniServ — mensual', precio: monto }],
        }),
        monto,
      )
    const pagoId = result.lastInsertRowid

    const { hmac, timestamp } = signPaymentHmac(pagoId, monto, empresa.id)
    return json(res, 201, {
      success: true,
      payment_id: pagoId,
      monto,
      moneda: 'USD',
      hmac,
      timestamp,
      success_url: urlConfirmacionFirmada(pagoId, monto, empresa.id, req.headers.host),
      cancel_url: `${SITE_URL}/pago-cancelado`,
    })
  }

  // GET /api/payment/verify — verifica firma + monto esperado y confirma el pago
  if (method === 'GET' && path === '/api/payment/verify') {
    const paymentId = Number(url.searchParams.get('payment_id'))
    const hmac = url.searchParams.get('hmac') || ''
    const ts = url.searchParams.get('ts') || ''

    if (!paymentId || !hmac || !ts) {
      return json(res, 400, { success: false, error: 'Parámetros payment_id, hmac y ts requeridos' })
    }

    const limite = rateLimit(`verify:${paymentId}`, { max: PAYMENT_CONFIRM_MAX_PER_MINUTE, windowMs: 60_000 })
    if (!limite.allowed) return demasiadasSolicitudes(res, limite.retryAfterSec)

    const pago = await db.prepare('SELECT * FROM pagos WHERE id = $1').get(paymentId)
    if (!pago) {
      return json(res, 404, { success: false, error: 'Pago no encontrado' })
    }

    const validacion = await validarPagoParaConfirmar(pago, { hmac, ts, origen: 'api' })
    if (!validacion.ok) {
      return json(res, validacion.status, { success: false, error: validacion.error })
    }
    if (validacion.yaConfirmado) {
      return json(res, 200, { success: true, message: 'Pago ya confirmado', nro_factura: validacion.nroFactura })
    }

    try {
      const { nroFactura } = await confirmarPago(pago)
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

    // Límite propio de este endpoint: lo consume el polling de OmniServ.
    const limite = rateLimit(`payment-status:${empresa.id}`, { max: 10, windowMs: 60_000 })
    if (!limite.allowed) return demasiadasSolicitudes(res, limite.retryAfterSec)

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
      return json(res, 404, { success: false, error: 'Sin licencia activa' })
    }
    return json(res, 200, { success: true, licencia: JSON.parse(licencia.payload_json) })
  }

  // GET /api/admin/jobs/verify-pending-payments (admin)
  // Job de conciliación de pagos. Crixto no publica webhook ni API de estado,
  // así que: (1) expira los pendientes viejos y (2) lista los pagos confirmados
  // sin referencia del proveedor para revisión manual.
  if (method === 'GET' && path === '/api/admin/jobs/verify-pending-payments') {
    if (!(await requireAdmin(req, res))) return

    const horas = Number(url.searchParams.get('horas')) || PENDING_PAYMENT_TTL_HOURS
    const limiteFecha = new Date(Date.now() - horas * 3600_000).toISOString().replace('T', ' ').slice(0, 19)

    const vencidos = await db
      .prepare("SELECT id, empresa_id, monto, concepto FROM pagos WHERE estado = 'pending' AND created_at < $1")
      .all(limiteFecha)
    for (const p of vencidos) {
      await db.prepare("UPDATE pagos SET estado = 'expired' WHERE id = $1 AND estado = 'pending'").run(p.id)
    }

    const sinReferencia = await db
      .prepare("SELECT id, empresa_id, monto, concepto, paid_at FROM pagos WHERE estado = 'confirmed' AND provider_ref IS NULL ORDER BY id DESC LIMIT 100")
      .all()

    if (vencidos.length) console.log(`[job] ${vencidos.length} pago(s) pendiente(s) expirados (> ${horas}h)`)
    return json(res, 200, {
      success: true,
      expirados: vencidos.length,
      confirmados_sin_referencia: sinReferencia,
      mensaje: 'Verifica en Crixto los pagos listados y confirma manualmente los que sí fueron cobrados.',
    })
  }

  // POST /api/admin/pagos/:id/confirmar (admin) — conciliación manual
  const confirmarManualMatch = path.match(/^\/api\/admin\/pagos\/(\d+)\/confirmar$/)
  if (method === 'POST' && confirmarManualMatch) {
    if (!(await requireAdmin(req, res))) return
    const pagoId = Number(confirmarManualMatch[1])
    const body = await readBody(req)
    const motivo = typeof body?.motivo === 'string' ? body.motivo.trim() : ''
    const referencia = typeof body?.referencia === 'string' ? body.referencia.trim() : null
    if (motivo.length < 5) {
      return json(res, 400, { success: false, error: 'motivo es requerido (mínimo 5 caracteres)' })
    }

    const pago = await db.prepare('SELECT * FROM pagos WHERE id = $1').get(pagoId)
    if (!pago) return json(res, 404, { success: false, error: 'Pago no encontrado' })
    if (pago.estado !== 'pending') {
      return json(res, 409, { success: false, error: `Pago en estado '${pago.estado}' — no se puede confirmar` })
    }

    const esperado = montoEsperadoDePago(pago)
    if (esperado == null || Math.abs(Number(pago.monto) - esperado) > 0.005) {
      await sendSecurityAlert(
        'Monto de pago inconsistente (conciliación manual)',
        `pago=${pagoId} registrado=${pago.monto} esperado=${esperado}`,
      )
      return json(res, 409, { success: false, error: 'Monto inconsistente con el plan seleccionado' })
    }

    try {
      const { nroFactura } = await confirmarPago(pago, { providerRef: referencia, por: `manual:conciliacion (${motivo})` })
      console.log(`[admin] pago ${pagoId} confirmado manualmente: ${motivo}`)
      return json(res, 200, { success: true, nro_factura: nroFactura })
    } catch (err) {
      console.error('[admin/pagos/confirmar]', err)
      return json(res, 500, { success: false, error: 'Error al confirmar el pago' })
    }
  }

  // POST /api/admin/empresas/:id/revocar-licencia (admin)
  const revocarMatch = path.match(/^\/api\/admin\/empresas\/(\d+)\/revocar-licencia$/)
  if (method === 'POST' && revocarMatch) {
    if (!(await requireAdmin(req, res))) return
    const empresaId = Number(revocarMatch[1])
    const body = await readBody(req)
    const motivo = typeof body?.motivo === 'string' ? body.motivo.trim() : ''
    if (motivo.length < 5) {
      return json(res, 400, { success: false, error: 'motivo es requerido (mínimo 5 caracteres)' })
    }
    const revocadas = await revocarLicencia(empresaId, { motivo: `admin:${motivo}` })
    if (!revocadas) return json(res, 404, { success: false, error: 'La empresa no tiene licencias vigentes' })
    return json(res, 200, { success: true, licencias_revocadas: revocadas })
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
