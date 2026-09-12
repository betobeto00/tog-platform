// Bloqueo temporal de 2FA tras N fallos (Fase 33). Archivo aparte porque la
// configuración de límites es por proceso: aquí el límite por minuto se sube a
// propósito para que lo que actúe sea el bloqueo por fallos.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { totpCode } from './totp.js'

const tmpDir = mkdtempSync(join(tmpdir(), 'tog-platform-2fa-lockout-'))
process.env.TOG_PLATFORM_DATA = join(tmpDir, 'data')
process.env.ADMIN_API_KEY = 'test-admin-key'
process.env.PAYMENT_HMAC_SECRET = 'test-hmac-secret'
process.env.JWT_SECRET = 'test-jwt-secret-de-32-caracteres-o-mas'
process.env.RATE_LIMIT_MAX = '5000'
process.env.TWOFA_MAX_ATTEMPTS_PER_MINUTE = '100'
process.env.TWOFA_MAX_FALLOS = '5'
process.env.TWOFA_LOCKOUT_MINUTES = '15'

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

test('tras 5 fallos, la verificación queda bloqueada 15 minutos (aunque el próximo código sea válido)', async () => {
  const registro = await post('/api/auth/register', {
    email: 'bloqueo@omnimargen.site',
    password: 'secreto123',
    nombre: 'Usuario Bloqueo',
    pais: 'VE',
    documento: 'J-88888888-8',
  })
  assert.equal(registro.status, 201)
  const auth = { Authorization: `Bearer ${registro.json.token}` }
  const userId = registro.json.user.id

  const setup = await post('/api/2fa/setup/totp', {}, auth)
  const secreto = setup.json.secret
  assert.equal((await post('/api/2fa/verify/totp', { codigo: totpCode(secreto) }, auth)).status, 200)

  // 5 intentos fallidos: todos se rechazan y quedan auditados.
  for (let intento = 1; intento <= 5; intento++) {
    const res = await post('/api/2fa/step-up', { codigo: '000000' }, auth)
    assert.equal(res.status, 401, `intento ${intento} debería ser 401`)
  }

  // El 6º está bloqueado: ni siquiera un código válido pasa.
  const bloqueado = await post('/api/2fa/step-up', { codigo: totpCode(secreto) }, auth)
  assert.equal(bloqueado.status, 429)
  assert.match(bloqueado.json.error, /bloqueada/i)
  assert.ok(Number(bloqueado.headers['retry-after']) >= 60, 'el bloqueo dura minutos, no segundos')

  // Los 5 fallos están en la auditoría.
  const { db } = await import('./db.js')
  const fallos = await db
    .prepare('SELECT COUNT(*) AS n FROM two_factor_logs WHERE user_id = $1 AND success = 0')
    .get(userId)
  assert.equal(Number(fallos.n), 5)
})
