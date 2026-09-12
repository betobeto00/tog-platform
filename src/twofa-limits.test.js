// Límite de intentos 2FA por minuto (5 por usuario, configurable con
// TWOFA_MAX_ATTEMPTS_PER_MINUTE). Archivo aparte porque la configuración es por
// proceso: aquí SÍ se quiere que el límite actúe.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { totpCode } from './totp.js'

const tmpDir = mkdtempSync(join(tmpdir(), 'tog-platform-2fa-limits-'))
process.env.TOG_PLATFORM_DATA = join(tmpDir, 'data')
process.env.ADMIN_API_KEY = 'test-admin-key'
process.env.PAYMENT_HMAC_SECRET = 'test-hmac-secret'
process.env.JWT_SECRET = 'test-jwt-secret-de-32-caracteres-o-mas'
process.env.RATE_LIMIT_MAX = '5000'
process.env.TWOFA_MAX_ATTEMPTS_PER_MINUTE = '5'
// Alto a propósito: aquí se prueba el límite por minuto, no el bloqueo.
process.env.TWOFA_MAX_FALLOS = '999'

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

test('el 6º intento de verificación en un minuto responde 429 + Retry-After', async () => {
  const registro = await post('/api/auth/register', {
    email: 'limites@omnimargen.site',
    password: 'secreto123',
    nombre: 'Usuario Límites',
    pais: 'VE',
    documento: 'J-77777777-7',
  })
  assert.equal(registro.status, 201)
  const auth = { Authorization: `Bearer ${registro.json.token}` }

  const setup = await post('/api/2fa/setup/totp', {}, auth)
  const secreto = setup.json.secret
  const activado = await post('/api/2fa/verify/totp', { codigo: totpCode(secreto) }, auth)
  assert.equal(activado.status, 200)

  // El contador es por usuario y lo comparten TODAS las verificaciones 2FA
  // (la activación de arriba ya gastó 1 de los 5 del minuto).
  for (let intento = 1; intento <= 4; intento++) {
    const res = await post('/api/2fa/step-up', { codigo: totpCode(secreto) }, auth)
    assert.equal(res.status, 200, `intento ${intento} debería pasar`)
  }

  // El 6º intento del minuto ya no pasa.
  const limitado = await post('/api/2fa/step-up', { codigo: totpCode(secreto) }, auth)
  assert.equal(limitado.status, 429)
  assert.match(limitado.json.error, /demasiados intentos/i)
  assert.ok(Number(limitado.headers['retry-after']) >= 1, 'debe indicar cuándo reintentar')
})
