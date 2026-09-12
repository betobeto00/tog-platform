// TOTP/HOTP (RFC 4226 + RFC 6238) y cifrado en reposo de secretos 2FA.
//
// Módulo puro (sólo `node:crypto`) para poder testearlo contra los vectores de
// prueba de las RFCs sin tocar la base de datos. El repo es cero-dependencias
// runtime, así que la implementación es propia.
//
// Compatible con Google Authenticator / Authy: SHA-1, 6 dígitos, paso de 30 s.

import crypto from 'node:crypto'

const BASE32_ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const BASE32_MAPA = new Map([...BASE32_ALFABETO].map((c, i) => [c, i]))
// Alfabeto de códigos de respaldo sin caracteres ambiguos (0/O, 1/I/L, U).
export const BACKUP_CODE_ALFABETO = '23456789ABCDEFGHJKMNPQRSTVWXYZ'

export const TOTP_DEFAULTS = { step: 30, digits: 6, window: 1, counterBytes: 8 }

export function base32Encode(buf) {
  let bits = 0
  let valor = 0
  let salida = ''
  for (const byte of buf) {
    valor = (valor << 8) | byte
    bits += 8
    while (bits >= 5) {
      salida += BASE32_ALFABETO[(valor >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) salida += BASE32_ALFABETO[(valor << (5 - bits)) & 31]
  return salida
}

export function base32Decode(texto) {
  const limpio = String(texto || '')
    .toUpperCase()
    .replace(/[=\s-]/g, '')
  if (!limpio) throw new Error('secreto base32 vacío')
  let bits = 0
  let valor = 0
  const bytes = []
  for (const caracter of limpio) {
    const v = BASE32_MAPA.get(caracter)
    if (v === undefined) throw new Error('secreto base32 inválido')
    valor = (valor << 5) | v
    bits += 5
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

/** HOTP (RFC 4226): truncado dinámico sobre HMAC-SHA1. */
export function hotp(secretBuf, counter, digits = TOTP_DEFAULTS.digits) {
  const contador = Buffer.alloc(8)
  contador.writeBigUInt64BE(BigInt(counter))
  const hmac = crypto.createHmac('sha1', secretBuf).update(contador).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const binario =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3]
  return String(binario % 10 ** digits).padStart(digits, '0')
}

/** Código TOTP para un instante dado. */
export function totpCode(secretBase32, at = Date.now(), { step = TOTP_DEFAULTS.step, digits = TOTP_DEFAULTS.digits } = {}) {
  return hotp(base32Decode(secretBase32), Math.floor(at / 1000 / step), digits)
}

/**
 * Verifica un código TOTP con ventana de tolerancia (± `window` pasos, por
 * defecto ±30 s para absorber el desfase de reloj del teléfono).
 * La comparación es de tiempo constante.
 */
export function verifyTOTP(secretBase32, codigo, { at = Date.now(), window = TOTP_DEFAULTS.window, step = TOTP_DEFAULTS.step, digits = TOTP_DEFAULTS.digits } = {}) {
  const limpio = String(codigo ?? '').replace(/\D/g, '')
  if (limpio.length !== digits) return false
  let secreto
  try {
    secreto = base32Decode(secretBase32)
  } catch {
    return false
  }
  const contador = Math.floor(at / 1000 / step)
  let valido = false
  for (let delta = -window; delta <= window; delta++) {
    const esperado = hotp(secreto, contador + delta, digits)
    // timingSafeEqual exige buffers del mismo largo (garantizado arriba).
    if (crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(limpio))) valido = true
  }
  return valido
}

/** Secreto nuevo: 160 bits (20 bytes) en base32, como recomienda la RFC 4226. */
export function generateTOTPSecret() {
  return base32Encode(crypto.randomBytes(20))
}

export function otpauthUri({ secret, email, issuer = 'OmniMargen', digits = TOTP_DEFAULTS.digits, step = TOTP_DEFAULTS.step }) {
  const label = encodeURIComponent(`${issuer}:${email || 'usuario'}`)
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(digits),
    period: String(step),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}

/**
 * Códigos de respaldo de un solo uso: `XXXX-XXXX-XXXX` con alfabeto sin
 * caracteres ambiguos (≈ 59 bits de entropía cada uno).
 */
export function generateBackupCodes(cantidad = 10) {
  const codigos = new Set()
  while (codigos.size < cantidad) {
    let codigo = ''
    for (let i = 0; i < 12; i++) {
      codigo += BACKUP_CODE_ALFABETO[crypto.randomInt(BACKUP_CODE_ALFABETO.length)]
    }
    codigos.add(`${codigo.slice(0, 4)}-${codigo.slice(4, 8)}-${codigo.slice(8, 12)}`)
  }
  return [...codigos]
}

// ---------- cifrado en reposo (AES-256-GCM) ----------

function clave(material) {
  if (!material) throw new Error('falta el material de cifrado')
  return Buffer.from(crypto.hkdfSync('sha256', material, 'omnimargen-2fa', 'secret-at-rest', 32))
}

/** Devuelve `enc:v1:<iv>:<datos>:<tag>` (todo base64url). */
export function cifrar(texto, material) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', clave(material), iv)
  const datos = Buffer.concat([cipher.update(String(texto), 'utf8'), cipher.final()])
  return `enc:v1:${iv.toString('base64url')}:${datos.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}`
}

/** Descifra un valor `enc:v1:...`. Si no tiene ese prefijo, lo devuelve tal cual. */
export function descifrar(valor, material) {
  const texto = String(valor ?? '')
  if (!texto.startsWith('enc:v1:')) return texto
  const [, , ivB64, datosB64, tagB64] = texto.split(':')
  const decipher = crypto.createDecipheriv('aes-256-gcm', clave(material), Buffer.from(ivB64, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(datosB64, 'base64url')), decipher.final()]).toString('utf8')
}

/** HMAC-SHA256 con pepper derivado: en la DB nunca queda el código en claro. */
export function hashBackupCode(codigo, material) {
  const normalizado = String(codigo || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  const pepper = Buffer.from(crypto.hkdfSync('sha256', material, 'omnimargen-2fa', 'backup-code-pepper', 32))
  return crypto.createHmac('sha256', pepper).update(normalizado).digest('hex')
}
