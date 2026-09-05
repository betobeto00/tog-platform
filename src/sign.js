import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'

// Módulos activables de TOG Platform.
// Mantener sincronizado con src/shared/modules.ts del repo tog-admin.
export const MODULE_IDS = ['comercializador', 'distribuidor', 'restaurant', 'productor', 'procesador', 'postventa']

/**
 * Firma una licencia con el MISMO formato que valida TOG Admin
 * (src/main/services/license.ts):
 *  - payload JSON plano con las claves en el orden:
 *    cliente → expira → version → machineId → modules → emitida → id
 *  - firma RSA-SHA256 (PKCS#1 v1.5) sobre JSON.stringify(payload sin "firma")
 *  - el archivo resultante es JSON con { ...payload, firma } listo para importar
 */
export function signLicense(privateKey, { cliente, expira, machineId = null, modules = null }) {
  if (!cliente || !expira) throw new Error('cliente y expira son requeridos')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expira)) throw new Error('expira debe ser YYYY-MM-DD')
  if (modules) {
    const unknown = modules.filter((m) => !MODULE_IDS.includes(m))
    if (unknown.length) throw new Error(`Módulo(s) desconocido(s): ${unknown.join(', ')}`)
  }

  const payload = {
    cliente,
    expira,
    version: '1.0.0',
    machineId,
    ...(modules && modules.length ? { modules } : {}),
    emitida: new Date().toISOString(),
    id: crypto.randomBytes(6).toString('hex'),
  }

  const sign = crypto.createSign('SHA256')
  sign.update(JSON.stringify(payload))
  const firma = sign.sign(privateKey, 'base64')

  return { ...payload, firma }
}

export function loadPrivateKey(envPath) {
  const key = readFileSync(envPath, 'utf8')
  // Sanity: la clave debe parsear como RSA
  crypto.createPrivateKey(key)
  return key
}

// Autotest: firma una licencia de ejemplo y verifica la firma con la pública derivada
function selfTest() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  }
  const license = signLicense(pem.privateKey, {
    cliente: 'Autotest',
    expira: '2099-12-31',
    modules: ['distribuidor'],
  })
  const { firma, ...data } = license
  const verify = crypto.createVerify('SHA256')
  verify.update(JSON.stringify(data))
  const ok = verify.verify(pem.publicKey, firma, 'base64')
  console.log(`self-test: firma ${ok ? 'válida ✅' : 'inválida ❌'} (modules=${JSON.stringify(license.modules)})`)
  process.exit(ok ? 0 : 1)
}

if (process.argv.includes('--self-test')) selfTest()