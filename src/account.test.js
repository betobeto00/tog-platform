// Tests de la cuenta web + carrito CRIXTO + confirmación de pago + facturas.
// Entorno aislado: TOG_PLATFORM_DATA temporal + clave RSA al vuelo (igual que server.test.js).

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpDir = mkdtempSync(join(tmpdir(), 'tog-platform-account-'))
process.env.TOG_PLATFORM_DATA = join(tmpDir, 'data')
process.env.ADMIN_API_KEY = 'test-admin-key'

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const keyPath = join(tmpDir, 'private.pem')
writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
process.env.LICENSE_PRIVATE_KEY_PATH = keyPath

let server
let base = ''
let token = null
let userId = null

before(async () => {
  const { startServer } = await import('./server.js')
  server = startServer({ port: 0 })
  await new Promise((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  server?.close()
  const { closeDatabase } = await import('./db.js')
  closeDatabase()
  rmSync(tmpDir, { recursive: true, force: true })
})

async function post(path, body, headers = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

async function get(path, headers = {}) {
  const res = await fetch(base + path, { headers })
  return { status: res.status, text: await res.text() }
}

async function getJson(path, headers = {}) {
  const res = await fetch(base + path, { headers })
  return { status: res.status, json: await res.json() }
}

function verifySignature(licencia) {
  const { firma, ...payload } = licencia
  const verifier = crypto.createVerify('SHA256')
  verifier.update(JSON.stringify(payload))
  return verifier.verify(publicKey, firma, 'base64')
}

const cuenta = {
  email: 'cliente@agromaiz.com',
  password: 'secreto123',
  nombre: 'AgroMaíz C.A.',
  pais: 'VE',
  documento: 'J-12345678-9',
  telefono: '+584121234567',
}

test('register: crea la cuenta, la empresa vinculada y devuelve token', async () => {
  const res = await post('/api/auth/register', cuenta)
  assert.equal(res.status, 201)
  assert.equal(res.json.success, true)
  assert.ok(res.json.token, 'debe devolver un token')
  assert.equal(res.json.user.email, cuenta.email)
  assert.equal(res.json.user.password_hash, undefined, 'nunca exponer el hash')
  token = res.json.token
  userId = res.json.user.id
})

test('register: valida email, contraseña y duplicados', async () => {
  const emailInvalido = await post('/api/auth/register', { ...cuenta, email: 'no-es-email' })
  assert.equal(emailInvalido.status, 400)

  const passwordCorto = await post('/api/auth/register', { ...cuenta, email: 'otro@x.com', password: '123' })
  assert.equal(passwordCorto.status, 400)

  const duplicado = await post('/api/auth/register', cuenta)
  assert.equal(duplicado.status, 409)
})

test('login: acepta credenciales correctas y rechaza incorrectas', async () => {
  const ok = await post('/api/auth/login', { email: cuenta.email, password: cuenta.password })
  assert.equal(ok.status, 200)
  assert.ok(ok.json.token)

  const malPassword = await post('/api/auth/login', { email: cuenta.email, password: 'incorrecta' })
  assert.equal(malPassword.status, 401)

  const sinToken = await get('/api/user/profile')
  assert.equal(sinToken.status, 401)
})

test('payment/create: requiere token y una empresa vinculada', async () => {
  const sinToken = await post('/api/payment/create', { periodo: 'mensual', modulos: [] })
  assert.equal(sinToken.status, 401)

  // Cuenta sin empresa (sin documento)
  const sinEmpresa = await post('/api/auth/register', {
    email: 'sin-empresa@x.com', password: 'secreto123', nombre: 'Solo Persona',
  })
  const r = await post('/api/payment/create', { periodo: 'mensual', modulos: [] }, {
    Authorization: `Bearer ${sinEmpresa.json.token}`,
  })
  assert.equal(r.status, 400)
})

test('payment/create: calcula el monto del carrito según periodo y módulos', async () => {
  const auth = { Authorization: `Bearer ${token}` }

  const base = await post('/api/payment/create', { periodo: 'mensual', modulos: [] }, auth)
  assert.equal(base.status, 201)
  assert.equal(base.json.monto, 15)
  assert.equal(base.json.periodo, 'mensual')
  assert.deepEqual(base.json.modulos, ['comercializador'])
  assert.match(base.json.success_url, /payment_id=\d+/)

  const conExtra = await post('/api/payment/create', { periodo: 'mensual', modulos: ['distribuidor'] }, auth)
  assert.equal(conExtra.status, 201)
  assert.equal(conExtra.json.monto, 18)

  const trimestral = await post('/api/payment/create', { periodo: 'trimestral', modulos: ['distribuidor', 'restaurant'] }, auth)
  assert.equal(trimestral.status, 201)
  assert.equal(trimestral.json.monto, 40 + 2 * 9)

  const anual = await post('/api/payment/create', { periodo: 'anual', modulos: ['distribuidor'] }, auth)
  assert.equal(anual.status, 201)
  assert.equal(anual.json.monto, 150 + 36)

  const periodoInvalido = await post('/api/payment/create', { periodo: 'quincenal', modulos: [] }, auth)
  assert.equal(periodoInvalido.status, 400)

  const moduloInvalido = await post('/api/payment/create', { periodo: 'mensual', modulos: ['nave-espacial'] }, auth)
  assert.equal(moduloInvalido.status, 400)
})

test('confirm: ?payment_id confirma, emite licencia con los módulos del carrito y genera factura', async () => {
  const auth = { Authorization: `Bearer ${token}` }
  const creado = await post('/api/payment/create', { periodo: 'mensual', modulos: ['distribuidor'] }, auth)
  const paymentId = creado.json.payment_id

  const confirm = await get(`/api/payment/confirm?payment_id=${paymentId}`)
  assert.equal(confirm.status, 200)
  assert.match(confirm.text, /Pago Confirmado/)
  assert.match(confirm.text, /factura F-\d{4}-\d{4}/)

  const profile = await get('/api/user/profile', auth)
  const body = JSON.parse(profile.text)
  assert.equal(body.success, true)
  assert.equal(body.user.email, cuenta.email)
  assert.ok(body.empresa.api_key, 'la cuenta debe exponer la api_key de su empresa')
  assert.deepEqual(body.licencia_activa.modules, ['comercializador', 'distribuidor'])
  assert.equal(verifySignature(body.licencia_activa), true, 'la licencia emitida por el carrito debe ser válida')
  const pagoConfirmado = body.pagos.find((p) => p.id === paymentId)
  assert.ok(pagoConfirmado, 'el pago creado debe aparecer en el perfil')
  assert.equal(pagoConfirmado.estado, 'confirmed')
  assert.match(pagoConfirmado.nro_factura, /^F-\d{4}-\d{4}$/)

  // Idempotencia: confirmar de nuevo no emite otra licencia
  const deNuevo = await get(`/api/payment/confirm?payment_id=${paymentId}`)
  assert.match(deNuevo.text, /ya había sido confirmado/)

  const profile2 = await get('/api/user/profile', auth)
  const confirmados = JSON.parse(profile2.text).pagos.filter((p) => p.estado === 'confirmed')
  assert.equal(confirmados.length, 1, 'seguir con un solo pago confirmado')
})

test('payment/verify: valida HMAC y confirma el pago, rechaza HMAC inválido', async () => {
  const auth = { Authorization: `Bearer ${token}` }

  // Crear un nuevo pago pendiente
  const creado = await post('/api/payment/create', { periodo: 'mensual', modulos: ['restaurant'] }, auth)
  assert.equal(creado.status, 201)
  const { payment_id: pid, monto, hmac, empresa_id } = creado.json
  assert.ok(hmac, 'debe devolver un hmac')

  // HMAC inválido → 403
  const mala = await getJson(`/api/payment/verify?payment_id=${pid}&hmac=badbadbad`)
  assert.equal(mala.status, 403)
  assert.equal(mala.json.success, false)

  // Sin parámetros → 400
  const sinParams = await getJson('/api/payment/verify')
  assert.equal(sinParams.status, 400)

  // Payment_id inexistente → 404
  const fantasma = await getJson(`/api/payment/verify?payment_id=999999&hmac=${hmac}`)
  assert.equal(fantasma.status, 404)

  // HMAC correcto → confirma el pago
  const ok = await getJson(`/api/payment/verify?payment_id=${pid}&hmac=${hmac}`)
  assert.equal(ok.status, 200)
  assert.equal(ok.json.success, true)
  assert.match(ok.json.nro_factura, /^F-\d{4}-\d{4}$/)

  // Idempotencia: confirmar de nuevo → 200 con mensaje
  const deNuevo = await getJson(`/api/payment/verify?payment_id=${pid}&hmac=${hmac}`)
  assert.equal(deNuevo.status, 200)
  assert.equal(deNuevo.json.success, true)
  assert.match(deNuevo.json.message, /ya confirmado/)
})

test('factura: /api/pagos/:id/factura devuelve HTML imprimible con los datos del pago', async () => {
  const auth = { Authorization: `Bearer ${token}` }
  const profile = await get('/api/user/profile', auth)
  const pagos = JSON.parse(profile.text).pagos
  const pago = pagos.find((p) => p.estado === 'confirmed' && p.nro_factura)
  assert.ok(pago, 'debe haber al menos un pago confirmado con factura')

  const factura = await get(`/api/pagos/${pago.id}/factura`)
  assert.equal(factura.status, 200)
  assert.match(factura.text, /Factura N°/)
  assert.match(factura.text, new RegExp(pago.nro_factura))
  assert.match(factura.text, /PAGADO/)
  assert.match(factura.text, /AgroMaíz/)
  assert.match(factura.text, /Módulo/)
  assert.match(factura.text, /\$\d+\.\d{2}/)
})

test('confirm por empresa_id (OmniServ): mantiene el flujo histórico y registra el pago', async () => {
  const adminHeaders = { 'x-admin-key': 'test-admin-key' }
  const empresa = await post('/api/empresas', {
    nombre: 'Kiosco Doña Rosa', pais: 'VE', documento: 'V-11222333', email_contacto: 'rosa@kiosco.com',
  }, adminHeaders)
  const empresaId = empresa.json.id

  const confirm = await get(`/api/payment/confirm?empresa_id=${empresaId}`)
  assert.equal(confirm.status, 200)
  assert.match(confirm.text, /Verificar Pago/)

  const status = await get(`/api/empresas/${empresaId}/payment-status`, {
    'x-api-key': empresa.json.api_key,
  })
  assert.equal(JSON.parse(status.text).payment_confirmed, true)

  const licencia = await get(`/api/empresas/${empresaId}/licencia`, {
    'x-api-key': empresa.json.api_key,
  })
  assert.equal(JSON.parse(licencia.text).licencia.modules.includes('omniserv'), true)
})

test('confirm sin parámetros: página genérica de éxito (URL fija del panel de Crixto)', async () => {
  const res = await get('/api/payment/confirm')
  assert.equal(res.status, 200)
  assert.match(res.text, /Pago exitoso/)
})

test('forgot + reset-password: cambia la contraseña con un token válido', async () => {
  const token = 'reset-' + crypto.randomBytes(16).toString('hex')
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')

  const forgot = await post('/api/auth/forgot', { email: cuenta.email, token_hash: tokenHash })
  assert.equal(forgot.status, 200)

  const malFormato = await post('/api/auth/forgot', { email: cuenta.email, token_hash: 'no-es-hash' })
  assert.equal(malFormato.status, 400)

  const tokenInvalido = await post('/api/auth/reset-password', { token: 'no-existe', password: 'NuevaPass123' })
  assert.equal(tokenInvalido.status, 400)

  const passwordCorta = await post('/api/auth/reset-password', { token, password: '123' })
  assert.equal(passwordCorta.status, 400)

  const ok = await post('/api/auth/reset-password', { token, password: 'NuevaPass123' })
  assert.equal(ok.status, 200)

  const reusado = await post('/api/auth/reset-password', { token, password: 'OtraPass123' })
  assert.equal(reusado.status, 400, 'el token ya no debe servir')

  const nuevoLogin = await post('/api/auth/login', { email: cuenta.email, password: 'NuevaPass123' })
  assert.equal(nuevoLogin.status, 200)

  const emailInexistente = await post('/api/auth/forgot', { email: 'nadie@x.com', token_hash: 'a'.repeat(64) })
  assert.equal(emailInexistente.status, 200, 'respuesta genérica para no revelar si el email existe')
})