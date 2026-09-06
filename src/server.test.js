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
