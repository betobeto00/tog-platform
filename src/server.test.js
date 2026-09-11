// Tests de integración del backend de licencias TOG Platform.
// Usa solo módulos built-in de Node (node:test + fetch) — sin dependencias.
// Cada ejecución usa un directorio temporal (TOG_PLATFORM_DATA) y una clave
// RSA generada al vuelo, para no tocar datos ni secretos reales.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// --- entorno aislado (antes de importar server.js/db.js) ---
const tmpDir = mkdtempSync(join(tmpdir(), 'tog-platform-'))
process.env.TOG_PLATFORM_DATA = join(tmpDir, 'data')
process.env.ADMIN_API_KEY = 'test-admin-key'
process.env.PAYMENT_HMAC_SECRET = 'test-hmac-secret'
process.env.JWT_SECRET = 'test-jwt-secret'

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const keyPath = join(tmpDir, 'private.pem')
writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
process.env.LICENSE_PRIVATE_KEY_PATH = keyPath

let server
let base = ''
let adminHeaders = {}
let empresa = null // { id, api_key }

before(async () => {
  const { startServer } = await import('./server.js')
  server = startServer({ port: 0 })
  await new Promise((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${server.address().port}`
  adminHeaders = { 'x-admin-key': 'test-admin-key' }
})

after(async () => {
  server?.close()
  // Cerrar SQLite antes de borrar el directorio temporal (WAL mantiene el archivo abierto)
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

function verifySignature(licencia) {
  const { firma, ...payload } = licencia
  const verifier = crypto.createVerify('SHA256')
  verifier.update(JSON.stringify(payload))
  return verifier.verify(publicKey, firma, 'base64')
}

test('GET /api/health reporta DB y clave de firma disponibles', async () => {
  const res = await fetch(base + '/api/health')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.firmando, true)
})

test('endpoints de admin y empresa rechazan sin credenciales', async () => {
  const sinKey = await post('/api/empresas', { nombre: 'X', documento: 'J-1', email_contacto: 'x@x.com' })
  assert.equal(sinKey.status, 401)

  const licenciaSinKey = await post('/api/empresas/1/licencias', { cliente: 'X', expira: '2099-12-31' })
  assert.equal(licenciaSinKey.status, 401)

  const listado = await fetch(base + '/api/admin/empresas')
  assert.equal(listado.status, 401)
})

test('alta de empresa: crea con api_key, rechaza documento duplicado en el mismo país', async () => {
  const created = await post(
    '/api/empresas',
    { nombre: 'AgroMaíz C.A.', pais: 'VE', documento: 'J-12345678-9', email_contacto: 'admin@agromaiz.com' },
    adminHeaders,
  )
  assert.equal(created.status, 201)
  assert.ok(created.json.api_key, 'debe devolver api_key')
  empresa = { id: created.json.id, api_key: created.json.api_key }

  const duplicado = await post(
    '/api/empresas',
    { nombre: 'Otra', pais: 've', documento: 'j-12345678-9', email_contacto: 'otra@x.com' }, // normaliza a VE / mayúsculas
    adminHeaders,
  )
  assert.equal(duplicado.status, 409)

  const sinDocumento = await post('/api/empresas', { nombre: 'Sin documento' }, adminHeaders)
  assert.equal(sinDocumento.status, 400)

  const paisInvalido = await post(
    '/api/empresas',
    { nombre: 'X', pais: 'Venezuela', documento: 'J-1', email_contacto: 'x@x.com' },
    adminHeaders,
  )
  assert.equal(paisInvalido.status, 400)

  const list = await fetch(base + '/api/admin/empresas', { headers: adminHeaders })
  assert.equal(list.status, 200)
  const { empresas } = await list.json()
  assert.equal(empresas.length, 1)
  assert.equal(empresas[0].pais, 'VE')
  assert.equal(empresas[0].documento, 'J-12345678-9')
})

test('identidad internacional: mismo documento en países distintos son empresas distintas', async () => {
  const us = await post(
    '/api/empresas',
    { nombre: 'Corn Flakes LLC', pais: 'US', documento: '12-3456789', email_contacto: 'ops@cornflakes.com' },
    adminHeaders,
  )
  assert.equal(us.status, 201)

  const ar = await post(
    '/api/empresas',
    { nombre: 'Copos de Maíz S.A.', pais: 'AR', documento: '12-3456789', email_contacto: 'ventas@copos.com.ar' },
    adminHeaders,
  )
  assert.equal(ar.status, 201)
  assert.notEqual(us.json.id, ar.json.id)

  const usDeNuevo = await post(
    '/api/empresas',
    { nombre: 'Otra LLC', pais: 'US', documento: '12-3456789', email_contacto: 'otra@cornflakes.com' },
    adminHeaders,
  )
  assert.equal(usDeNuevo.status, 409)
})

test('emisión manual de licencia: firma RSA válida y consultable por la empresa', async () => {
  const res = await post(
    `/api/empresas/${empresa.id}/licencias`,
    { cliente: 'AgroMaíz C.A.', expira: '2099-12-31', modules: ['distribuidor'] },
    adminHeaders,
  )
  assert.equal(res.status, 201)
  assert.equal(res.json.success, true)

  const licencia = res.json.licencia
  assert.deepEqual(licencia.modules, ['distribuidor'])
  assert.ok(licencia.firma, 'la licencia debe incluir firma')
  assert.equal(verifySignature(licencia), true, 'la firma debe verificarse con la clave pública')

  // La empresa consulta su licencia activa con su api_key
  const activa = await fetch(base + `/api/empresas/${empresa.id}/licencia`, {
    headers: { 'x-api-key': empresa.api_key },
  })
  assert.equal(activa.status, 200)
  const { licencia: activaLic } = await activa.json()
  assert.equal(activaLic.cliente, 'AgroMaíz C.A.')
  assert.equal(verifySignature(activaLic), true)
})

test('licencia: api_key desconocida → 401, empresa sin licencia → 404', async () => {
  const desconocida = await fetch(base + `/api/empresas/${empresa.id}/licencia`, {
    headers: { 'x-api-key': 'clave-inexistente' },
  })
  assert.equal(desconocida.status, 401)

  const creada = await post(
    '/api/empresas',
    { nombre: 'Sin Licencia', pais: 'PE', documento: '20-99999999-9', email_contacto: 'nuevo@x.com' },
    adminHeaders,
  )
  assert.equal(creada.status, 201)

  const sinLicencia = await fetch(base + `/api/empresas/${creada.json.id}/licencia`, {
    headers: { 'x-api-key': creada.json.api_key },
  })
  assert.equal(sinLicencia.status, 404)
})

test('emisión manual acepta max_pcs y lo incluye firmado en la licencia', async () => {
  const res = await post(
    `/api/empresas/${empresa.id}/licencias`,
    { cliente: 'MultiPC S.A.', expira: '2099-12-31', modules: ['distribuidor'], max_pcs: 5 },
    adminHeaders,
  )
  assert.equal(res.status, 201)
  assert.equal(res.json.licencia.max_pcs, 5)
  assert.equal(verifySignature(res.json.licencia), true, 'max_pcs queda cubierto por la firma')

  const invalido = await post(
    `/api/empresas/${empresa.id}/licencias`,
    { cliente: 'X', expira: '2099-12-31', max_pcs: 99 },
    adminHeaders,
  )
  assert.equal(invalido.status, 400)
})

test('emisión manual valida campos y módulos desconocidos', async () => {
  const sinCampos = await post(
    `/api/empresas/${empresa.id}/licencias`,
    { cliente: 'Solo cliente' },
    adminHeaders,
  )
  assert.equal(sinCampos.status, 400)

  const moduloRaro = await post(
    `/api/empresas/${empresa.id}/licencias`,
    { cliente: 'X', expira: '2099-12-31', modules: ['nave-espacial'] },
    adminHeaders,
  )
  assert.equal(moduloRaro.status, 400)

  const fechaInvalida = await post(
    `/api/empresas/${empresa.id}/licencias`,
    { cliente: 'X', expira: '31-12-2099' },
    adminHeaders,
  )
  assert.equal(fechaInvalida.status, 400)
})

test('emisión manual acepta los nuevos módulos administracion y rrhh', async () => {
  const res = await post(
    `/api/empresas/${empresa.id}/licencias`,
    { cliente: 'Contable Plus S.A.', expira: '2099-12-31', modules: ['administracion', 'rrhh'] },
    adminHeaders,
  )
  assert.equal(res.status, 201)
  const licencia = res.json.licencia
  // La emisión manual firma los modules tal cual se envían (el orden canónico
  // de MODULE_IDS solo aplica al flujo de compra por suscripción)
  assert.deepEqual(licencia.modules, ['administracion', 'rrhh'])
  assert.equal(verifySignature(licencia), true, 'la firma debe cubrir los nuevos módulos')
})

test('checkout y webhook devuelven 503 cuando Stripe no está configurado', async () => {
  const checkout = await post('/api/checkout-session', { modulo: 'distribuidor' }, {
    'x-api-key': empresa.api_key,
  })
  assert.equal(checkout.status, 503)
  assert.match(checkout.json.error, /no configurado/i)

  const moduloInvalido = await post('/api/checkout-session', { modulo: 'base' }, {
    'x-api-key': empresa.api_key,
  })
  assert.equal(moduloInvalido.status, 400)

  const webhook = await post('/api/webhook/stripe', { tipo: 'checkout.session.completed' })
  assert.equal(webhook.status, 503)
})

test('rutas desconocidas devuelven 404', async () => {
  const res = await fetch(base + '/api/no-existe')
  assert.equal(res.status, 404)
})

// --- Licencia de un solo dispositivo (OmniServ) ---

const TELEFONO_A = 'a'.repeat(64)
const TELEFONO_B = 'b'.repeat(64)
let empresaOmniserv = null // { id, api_key }

function registerEmpresa(body) {
  return post('/api/empresas/register', body)
}

function licenciaConFingerprint(empresaId, apiKey, fingerprint) {
  const headers = { 'x-api-key': apiKey }
  if (fingerprint) headers['x-device-fingerprint'] = fingerprint
  return fetch(base + `/api/empresas/${empresaId}/licencia`, { headers })
}

test('registro desde la app: device_fingerprint es requerido y queda vinculado', async () => {
  const sinFp = await registerEmpresa({
    nombre: 'Kiosco Doña Rosa', pais: 'VE', documento: 'V-11222333',
    email_contacto: 'rosa@kiosco.com',
  })
  assert.equal(sinFp.status, 400)
  assert.match(sinFp.json.error, /device_fingerprint/i)

  const ok = await registerEmpresa({
    nombre: 'Kiosco Doña Rosa', pais: 'VE', documento: 'V-11222333',
    email_contacto: 'rosa@kiosco.com', device_fingerprint: TELEFONO_A,
  })
  assert.equal(ok.status, 201)
  assert.ok(ok.json.data.api_key)
  empresaOmniserv = { id: ok.json.data.id, api_key: ok.json.data.api_key }
})

// Se emite licencia a la empresa de OmniServ para los tests siguientes
// (el flujo Crixto automático lo hace al confirmar el pago)
test('setup: emisión manual de licencia para la empresa OmniServ', async () => {
  const res = await post(
    `/api/empresas/${empresaOmniserv.id}/licencias`,
    { cliente: 'Kiosco Doña Rosa', expira: '2099-12-31', modules: ['omniserv'] },
    adminHeaders,
  )
  assert.equal(res.status, 201)
})

test('mismo país+documento desde otro teléfono → 403 DEVICE_MISMATCH (no revela api_key)', async () => {
  const otroTelefono = await registerEmpresa({
    nombre: 'Kiosco Doña Rosa', pais: 'VE', documento: 'V-11222333',
    email_contacto: 'rosa@kiosco.com', device_fingerprint: TELEFONO_B,
  })
  assert.equal(otroTelefono.status, 403)
  assert.equal(otroTelefono.json.code, 'DEVICE_MISMATCH')
  assert.equal(otroTelefono.json.api_key, undefined)
})

test('mismo teléfono (reinstalación de la app) → recupera su registro', async () => {
  const mismo = await registerEmpresa({
    nombre: 'Kiosco Doña Rosa', pais: 'VE', documento: 'V-11222333',
    email_contacto: 'rosa@kiosco.com', device_fingerprint: TELEFONO_A,
  })
  assert.equal(mismo.status, 200)
  assert.equal(mismo.json.already_registered, true)
  assert.equal(mismo.json.data.api_key, empresaOmniserv.api_key)
})

test('GET /licencia: fingerprint correcto → 200, incorrecto → 403', async () => {
  const ok = await licenciaConFingerprint(empresaOmniserv.id, empresaOmniserv.api_key, TELEFONO_A)
  assert.equal(ok.status, 200)
  const { licencia } = await ok.json()
  assert.deepEqual(licencia.modules, ['omniserv'])

  const otra = await licenciaConFingerprint(empresaOmniserv.id, empresaOmniserv.api_key, TELEFONO_B)
  assert.equal(otra.status, 403)
  assert.equal((await otra.json()).code, 'DEVICE_MISMATCH')
})

test('GET /licencia sin header sigue funcionando (TOG Admin no envía fingerprint)', async () => {
  const res = await fetch(base + `/api/empresas/${empresaOmniserv.id}/licencia`, {
    headers: { 'x-api-key': empresaOmniserv.api_key },
  })
  assert.equal(res.status, 200)
})

test('primer dispositivo que reclama la licencia queda vinculado', async () => {
  // Empresa creada por admin (flujo TOG Admin clásico): sin fingerprint aún
  const creada = await post(
    '/api/empresas',
    { nombre: 'Solo Teléfono S.A.', pais: 'CO', documento: '900123456', email_contacto: 'solo@tel.co' },
    adminHeaders,
  )
  assert.equal(creada.status, 201)
  const nueva = { id: creada.json.id, api_key: creada.json.api_key }

  const emision = await post(
    `/api/empresas/${nueva.id}/licencias`,
    { cliente: 'Solo Teléfono S.A.', expira: '2099-12-31', modules: ['omniserv'] },
    adminHeaders,
  )
  assert.equal(emision.status, 201)

  // Sin header aún no se vincula nada (compatible con tog-admin)
  const sinHeader = await fetch(base + `/api/empresas/${nueva.id}/licencia`, {
    headers: { 'x-api-key': nueva.api_key },
  })
  assert.equal(sinHeader.status, 200)

  // Primer teléfono que la reclama: queda vinculado
  const primero = await licenciaConFingerprint(nueva.id, nueva.api_key, TELEFONO_A)
  assert.equal(primero.status, 200)

  // Otro teléfono con la misma api_key: rechazado
  const segundo = await licenciaConFingerprint(nueva.id, nueva.api_key, TELEFONO_B)
  assert.equal(segundo.status, 403)
  assert.equal((await segundo.json()).code, 'DEVICE_MISMATCH')
})

test('transferencia de dispositivo: admin desvincula y el nuevo teléfono queda vinculado', async () => {
  const desvincular = await post(
    `/api/admin/empresas/${empresaOmniserv.id}/dispositivo`,
    { device_fingerprint: null },
    adminHeaders,
  )
  assert.equal(desvincular.status, 200)
  assert.equal(desvincular.json.device_fingerprint, null)

  // El teléfono B (antes rechazado) ahora puede reclamar la licencia
  const nuevo = await licenciaConFingerprint(empresaOmniserv.id, empresaOmniserv.api_key, TELEFONO_B)
  assert.equal(nuevo.status, 200)

  // Y el teléfono A (el anterior) queda rechazado
  const viejo = await licenciaConFingerprint(empresaOmniserv.id, empresaOmniserv.api_key, TELEFONO_A)
  assert.equal(viejo.status, 403)

  // La transferencia requiere admin
  const sinAdmin = await post(`/api/admin/empresas/${empresaOmniserv.id}/dispositivo`, { device_fingerprint: null })
  assert.equal(sinAdmin.status, 401)
})

test('payment-status usa la empresa autenticada por api_key, no el id de la URL', async () => {
  const res = await fetch(base + `/api/empresas/${empresaOmniserv.id}/payment-status`, {
    headers: { 'x-api-key': empresa.api_key },
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  // empresa (AgroMaíz) no tiene pago confirmado aunque la URL apunte a otra empresa
  assert.equal(body.payment_confirmed, false)
})
