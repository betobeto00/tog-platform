// Tests de integración de 2FA (Fases 28-30 y 33): setup → activación →
// step-up para operaciones sensibles → códigos de respaldo → bloqueo →
// desactivación. Entorno aislado: TOG_PLATFORM_DATA temporal + clave RSA al vuelo.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { totpCode } from './totp.js'

const tmpDir = mkdtempSync(join(tmpdir(), 'tog-platform-2fa-'))
process.env.TOG_PLATFORM_DATA = join(tmpDir, 'data')
process.env.ADMIN_API_KEY = 'test-admin-key'
process.env.PAYMENT_HMAC_SECRET = 'test-hmac-secret'
process.env.JWT_SECRET = 'test-jwt-secret-de-32-caracteres-o-mas'
process.env.TWO_FACTOR_ENC_KEY = 'clave-de-cifrado-2fa-para-tests'
process.env.RATE_LIMIT_MAX = '5000'
// Este archivo prueba el FLUJO completo: los límites de intentos tienen sus
// propios archivos (twofa-limits.test.js y twofa-lockout.test.js), que corren en
// procesos separados con su propia configuración.
process.env.TWOFA_MAX_ATTEMPTS_PER_MINUTE = '100'
// Este flujo incluye fallos a propósito (códigos malos, código reusado…), que
// en producción contarían para el bloqueo: aquí el bloqueo tiene su propio test.
process.env.TWOFA_MAX_FALLOS = '100'

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const keyPath = join(tmpDir, 'private.pem')
writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
process.env.LICENSE_PRIVATE_KEY_PATH = keyPath

let server
let base = ''

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
    body: JSON.stringify(body ?? {}),
  })
  return { status: res.status, json: await res.json(), headers: Object.fromEntries(res.headers) }
}

async function getJson(path, headers = {}) {
  const res = await fetch(base + path, { headers })
  return { status: res.status, json: await res.json() }
}

async function registrar(nombre, email) {
  const res = await post('/api/auth/register', {
    email,
    password: 'secreto123',
    nombre,
    pais: 'VE',
    documento: `J-${Math.floor(Math.random() * 1e9)}-9`,
  })
  assert.equal(res.status, 201, 'el registro debe funcionar')
  return { token: res.json.token, userId: res.json.user.id, email }
}

const auth = (token, extra = {}) => ({ Authorization: `Bearer ${token}`, ...extra })

const usuarioA = { email: 'dosfactores.a@omnimargen.site', nombre: 'Cliente 2FA' }
let sesionA = null
let secretoA = null
let codigosRespaldoA = []

test('2FA: el status inicial dice "desactivado"', async () => {
  sesionA = await registrar(usuarioA.nombre, usuarioA.email)
  const res = await getJson('/api/2fa/status', auth(sesionA.token))
  assert.equal(res.status, 200)
  assert.equal(res.json.success, true)
  assert.equal(res.json.enabled, false)
  assert.equal(res.json.pending, false)
  assert.equal(res.json.backup_codes_disponibles, 0)
})

test('2FA setup: genera secreto pendiente, otpauth_uri y NO activa todavía', async () => {
  const sinToken = await post('/api/2fa/setup/totp')
  assert.equal(sinToken.status, 401)

  const res = await post('/api/2fa/setup/totp', {}, auth(sesionA.token))
  assert.equal(res.status, 201)
  assert.match(res.json.secret, /^[A-Z2-7]{32}$/)
  assert.match(res.json.otpauth_uri, /^otpauth:\/\/totp\//)
  assert.equal(res.json.digits, 6)
  assert.equal(res.json.step, 30)
  secretoA = res.json.secret

  const estado = await getJson('/api/2fa/status', auth(sesionA.token))
  assert.equal(estado.json.pending, true)
  assert.equal(estado.json.enabled, false, 'no se activa hasta verificar un código')
})

test('2FA: el secreto se guarda cifrado en la base de datos (nunca en claro)', async () => {
  const { db } = await import('./db.js')
  const fila = await db.prepare('SELECT secret FROM two_factor_auth WHERE user_id = $1').get(sesionA.userId)
  assert.ok(fila, 'debe existir la fila de 2FA')
  assert.match(fila.secret, /^enc:v1:/)
  assert.ok(!fila.secret.includes(secretoA), 'el secreto no debe estar en claro')
})

test('2FA activación: código incorrecto → 401, código correcto → 200 con 10 códigos de respaldo', async () => {
  const incorrecto = await post('/api/2fa/verify/totp', { codigo: '000000' }, auth(sesionA.token))
  assert.equal(incorrecto.status, 401)
  assert.equal(incorrecto.json.success, false)

  const ok = await post('/api/2fa/verify/totp', { codigo: totpCode(secretoA) }, auth(sesionA.token))
  assert.equal(ok.status, 200)
  assert.equal(ok.json.backup_codes.length, 10)
  codigosRespaldoA = ok.json.backup_codes

  const estado = await getJson('/api/2fa/status', auth(sesionA.token))
  assert.equal(estado.json.enabled, true)
  assert.equal(estado.json.backup_codes_disponibles, 10)

  // Los códigos de respaldo se guardan hasheados, no en claro.
  const { db } = await import('./db.js')
  const filas = await db.prepare('SELECT code_hash FROM two_factor_backup_codes WHERE user_id = $1').all(sesionA.userId)
  assert.equal(filas.length, 10)
  for (const fila of filas) {
    assert.match(fila.code_hash, /^[a-f0-9]{64}$/)
    assert.ok(!codigosRespaldoA.includes(fila.code_hash))
  }

  // Volver a pedir setup con 2FA ya activo → 409.
  const repetido = await post('/api/2fa/setup/totp', {}, auth(sesionA.token))
  assert.equal(repetido.status, 409)
})

test('2FA step-up: el token sirve para la operación sensible pero NO autentica la sesión', async () => {
  // Sin step-up, la operación sensible se rechaza con un código claro.
  const sinToken = await post('/api/user/change-email', { email: 'nuevo@omnimargen.site' }, auth(sesionA.token))
  assert.equal(sinToken.status, 401)
  assert.equal(sinToken.json.code, 'TWOFA_REQUIRED')

  // Un código TOTP inválido no emite token.
  const malo = await post('/api/2fa/step-up', { codigo: '111111' }, auth(sesionA.token))
  assert.equal(malo.status, 401)

  const stepUp = await post('/api/2fa/step-up', { codigo: totpCode(secretoA) }, auth(sesionA.token))
  assert.equal(stepUp.status, 200)
  const twofaToken = stepUp.json.twofa_token
  assert.ok(twofaToken)

  // El token de step-up NO es un token de sesión (no debe abrir /api/user/profile).
  const comoSesion = await getJson('/api/user/profile', auth(twofaToken))
  assert.equal(comoSesion.status, 401, 'un token de step-up no puede autenticar la sesión')

  // Con el step-up, la operación sensible pasa.
  const cambio = await post(
    '/api/user/change-email',
    { email: 'dosfactores.a+nuevo@omnimargen.site' },
    auth(sesionA.token, { 'x-2fa-token': twofaToken }),
  )
  assert.equal(cambio.status, 200)
  assert.equal(cambio.json.email, 'dosfactores.a+nuevo@omnimargen.site')

  // Y el email viejo ya no puede loguear.
  const loginViejo = await post('/api/auth/login', { email: usuarioA.email, password: 'secreto123' })
  assert.equal(loginViejo.status, 401)
  usuarioA.email = cambio.json.email
})

test('2FA step-up: un email ya usado por otro se rechaza', async () => {
  const stepUp = await post('/api/2fa/step-up', { codigo: totpCode(secretoA) }, auth(sesionA.token))
  const otro = await registrar('Otro Cliente', 'dosfactores.otro@omnimargen.site')
  assert.ok(otro.token)

  const choque = await post(
    '/api/user/change-email',
    { email: 'dosfactores.otro@omnimargen.site' },
    auth(sesionA.token, { 'x-2fa-token': stepUp.json.twofa_token }),
  )
  assert.equal(choque.status, 409)
})

test('2FA recuperación: un código de respaldo sirve una sola vez', async () => {
  const primero = await post('/api/2fa/step-up', { backup_code: codigosRespaldoA[0] }, auth(sesionA.token))
  assert.equal(primero.status, 200)
  assert.equal(primero.json.backup_codes_disponibles, 9)

  const reusado = await post('/api/2fa/step-up', { backup_code: codigosRespaldoA[0] }, auth(sesionA.token))
  assert.equal(reusado.status, 401, 'un código de respaldo no puede reutilizarse')

  const inventado = await post('/api/2fa/step-up', { backup_code: 'AAAA-BBBB-CCCC' }, auth(sesionA.token))
  assert.equal(inventado.status, 401)
})

test('2FA regenerar códigos: requiere step-up e invalida los anteriores', async () => {
  const sinStepUp = await post('/api/2fa/backup-codes', {}, auth(sesionA.token))
  assert.equal(sinStepUp.status, 401)
  assert.equal(sinStepUp.json.code, 'TWOFA_REQUIRED')

  const stepUp = await post('/api/2fa/step-up', { codigo: totpCode(secretoA) }, auth(sesionA.token))
  const nuevos = await post('/api/2fa/backup-codes', {}, auth(sesionA.token, { 'x-2fa-token': stepUp.json.twofa_token }))
  assert.equal(nuevos.status, 200)
  assert.equal(nuevos.json.backup_codes.length, 10)
  assert.notDeepEqual(nuevos.json.backup_codes, codigosRespaldoA)

  const viejo = await post('/api/2fa/step-up', { backup_code: codigosRespaldoA[1] }, auth(sesionA.token))
  assert.equal(viejo.status, 401, 'los códigos anteriores ya no deben servir')
  codigosRespaldoA = nuevos.json.backup_codes
})

test('2FA desactivación: exige contraseña + código, y luego deja de exigir step-up', async () => {
  const malaPassword = await post(
    '/api/2fa/disable',
    { password: 'incorrecta', codigo: totpCode(secretoA) },
    auth(sesionA.token),
  )
  assert.equal(malaPassword.status, 401)

  const malCodigo = await post('/api/2fa/disable', { password: 'secreto123', codigo: '000000' }, auth(sesionA.token))
  assert.equal(malCodigo.status, 401)

  const ok = await post('/api/2fa/disable', { password: 'secreto123', codigo: totpCode(secretoA) }, auth(sesionA.token))
  assert.equal(ok.status, 200)

  const estado = await getJson('/api/2fa/status', auth(sesionA.token))
  assert.equal(estado.json.enabled, false)
  assert.equal(estado.json.pending, false)

  // Sin 2FA, la operación sensible ya no pide step-up.
  const cambio = await post('/api/user/change-email', { email: usuarioA.email }, auth(sesionA.token))
  assert.equal(cambio.status, 400, 'debe fallar por "mismo email", no por 2FA')

  const stepUp = await post('/api/2fa/step-up', { codigo: '123456' }, auth(sesionA.token))
  assert.equal(stepUp.status, 409, 'sin 2FA no hay step-up posible')
})

test('2FA: los eventos quedan auditados en two_factor_logs', async () => {
  const { db } = await import('./db.js')
  const filas = await db
    .prepare('SELECT action, success FROM two_factor_logs WHERE user_id = $1 ORDER BY id')
    .all(sesionA.userId)
  const acciones = filas.map((f) => f.action)
  for (const esperada of ['setup', 'enable', 'verify', 'recovery', 'backup_codes', 'disable', 'change_email']) {
    assert.ok(acciones.includes(esperada), `falta el evento ${esperada} en la auditoría`)
  }
  // Hubo intentos fallidos registrados (código incorrecto, código de respaldo reusado).
  assert.ok(filas.some((f) => Number(f.success) === 0), 'los fallos también deben registrarse')
})


