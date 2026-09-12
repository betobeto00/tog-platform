// Tests unitarios de TOTP/HOTP y del cifrado en reposo de secretos 2FA.
//
// Lo importante: se verifica contra los VECTORES DE PRUEBA de las RFC 4226
// (Apéndice D) y RFC 6238 (Apéndice B). Si estos pasan, la implementación es
// compatible con Google Authenticator / Authy (SHA-1, 6 dígitos, paso 30 s).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BACKUP_CODE_ALFABETO,
  base32Decode,
  base32Encode,
  cifrar,
  descifrar,
  generateBackupCodes,
  generateTOTPSecret,
  hashBackupCode,
  hotp,
  otpauthUri,
  totpCode,
  verifyTOTP,
} from './totp.js'

// RFC 4226/6238: el secreto de los vectores es la cadena ASCII
// "12345678901234567890" (20 bytes) → en base32:
const SECRETO_RFC = base32Encode(Buffer.from('12345678901234567890', 'ascii'))
const MATERIAL = 'material-de-prueba-para-cifrado'

test('base32: el secreto de los vectores RFC se codifica como se espera', () => {
  assert.equal(SECRETO_RFC, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  assert.equal(base32Decode(SECRETO_RFC).toString('ascii'), '12345678901234567890')
})

test('base32: roundtrip con bytes aleatorios y rechazo de entrada inválida', () => {
  for (const largo of [1, 2, 5, 20, 32, 64]) {
    const bytes = Buffer.from(Array.from({ length: largo }, (_, i) => (i * 37) % 256))
    assert.deepEqual(base32Decode(base32Encode(bytes)), bytes)
  }
  assert.throws(() => base32Decode('!!!'), /base32/i)
  assert.throws(() => base32Decode(''), /base32/i)
})

test('HOTP: vectores del RFC 4226 Apéndice D (contadores 0..9)', () => {
  const esperados = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489',
  ]
  const secreto = base32Decode(SECRETO_RFC)
  esperados.forEach((esperado, contador) => {
    assert.equal(hotp(secreto, contador), esperado, `contador ${contador}`)
  })
})

test('TOTP: vectores del RFC 6238 Apéndice B (6 dígitos)', () => {
  const vectores = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ]
  for (const [segundos, esperado] of vectores) {
    assert.equal(totpCode(SECRETO_RFC, segundos * 1000), esperado, `T=${segundos}`)
  }
})

test('verifyTOTP: acepta el paso actual y tolera ±1 paso (±30 s)', () => {
  const ahora = 1_700_000_000_000
  const codigoActual = totpCode(SECRETO_RFC, ahora)
  assert.equal(verifyTOTP(SECRETO_RFC, codigoActual, { at: ahora }), true)

  // Un código del paso anterior sigue siendo válido con la ventana por defecto…
  const anterior = totpCode(SECRETO_RFC, ahora - 30_000)
  assert.equal(verifyTOTP(SECRETO_RFC, anterior, { at: ahora }), true)
  // …pero no con ventana 0 (relojes sincronizados) ni ±2 pasos atrás.
  assert.equal(verifyTOTP(SECRETO_RFC, anterior, { at: ahora, window: 0 }), false)
  assert.equal(verifyTOTP(SECRETO_RFC, totpCode(SECRETO_RFC, ahora - 90_000), { at: ahora }), false)
})

test('verifyTOTP: rechaza códigos malformados sin explotar', () => {
  const ahora = 1_700_000_000_000
  assert.equal(verifyTOTP(SECRETO_RFC, '', { at: ahora }), false)
  assert.equal(verifyTOTP(SECRETO_RFC, '12345', { at: ahora }), false) // 5 dígitos
  assert.equal(verifyTOTP(SECRETO_RFC, 'abcdef', { at: ahora }), false)
  assert.equal(verifyTOTP(SECRETO_RFC, null, { at: ahora }), false)
  assert.equal(verifyTOTP('NO-ES-BASE32', '123456', { at: ahora }), false)
})

test('generateTOTPSecret: 160 bits (32 caracteres base32) y siempre distinto', () => {
  const secretos = new Set()
  for (let i = 0; i < 50; i++) {
    const secreto = generateTOTPSecret()
    assert.match(secreto, /^[A-Z2-7]{32}$/)
    secretos.add(secreto)
  }
  assert.equal(secretos.size, 50)
})

test('otpauthUri: formato que entienden las apps de autenticación', () => {
  const uri = otpauthUri({ secret: SECRETO_RFC, email: 'cliente@agromaiz.com', issuer: 'OmniMargen' })
  assert.match(uri, /^otpauth:\/\/totp\/OmniMargen%3Acliente%40agromaiz\.com\?/)
  const params = new URLSearchParams(uri.split('?')[1])
  assert.equal(params.get('secret'), SECRETO_RFC)
  assert.equal(params.get('issuer'), 'OmniMargen')
  assert.equal(params.get('algorithm'), 'SHA1')
  assert.equal(params.get('digits'), '6')
  assert.equal(params.get('period'), '30')
})

test('códigos de respaldo: 10 códigos únicos, con formato y sin caracteres ambiguos', () => {
  const codigos = generateBackupCodes(10)
  assert.equal(codigos.length, 10)
  assert.equal(new Set(codigos).size, 10)
  for (const codigo of codigos) {
    assert.match(codigo, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    for (const caracter of codigo.replace(/-/g, '')) {
      assert.ok(BACKUP_CODE_ALFABETO.includes(caracter), `carácter ambiguo: ${caracter}`)
    }
  }
})

test('hashBackupCode: estable, normaliza formato y no guarda el código en claro', () => {
  const codigo = 'ABCD-2345-WXYZ'
  const hash = hashBackupCode(codigo, MATERIAL)
  assert.match(hash, /^[a-f0-9]{64}$/)
  // El usuario puede escribirlo en minúsculas, con espacios o sin guiones.
  assert.equal(hashBackupCode('abcd 2345 wxyz', MATERIAL), hash)
  assert.equal(hashBackupCode('ABCD2345WXYZ', MATERIAL), hash)
  assert.notEqual(hashBackupCode('ABCD-2345-WXY2', MATERIAL), hash)
  // Con otro pepper (otra instalación) el hash cambia.
  assert.notEqual(hashBackupCode(codigo, 'otro-material'), hash)
})

test('cifrado en reposo: roundtrip AES-256-GCM y detección de manipulación', () => {
  const secreto = 'JBSWY3DPEHPK3PXP'
  const cifrado = cifrar(secreto, MATERIAL)
  assert.match(cifrado, /^enc:v1:/)
  assert.ok(!cifrado.includes(secreto), 'el secreto no debe quedar visible')
  assert.equal(descifrar(cifrado, MATERIAL), secreto)

  // Un valor sin cifrar se devuelve tal cual (compatibilidad).
  assert.equal(descifrar('texto-plano', MATERIAL), 'texto-plano')

  // Si alguien toca el texto cifrado o el tag, el GCM falla (no devuelve basura).
  const partes = cifrado.split(':')
  const datosAlterados = [...partes]
  datosAlterados[3] = Buffer.from('otras-cosas-distintas').toString('base64url')
  assert.throws(() => descifrar(datosAlterados.join(':'), MATERIAL))

  // Con otra clave tampoco se puede descifrar.
  assert.throws(() => descifrar(cifrado, 'material-equivocado'))
})
