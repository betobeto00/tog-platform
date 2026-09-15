import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { signLicense, MODULE_IDS, MODULOS_VENDIBLES } from './sign.js'

/**
 * El catálogo de módulos vive en tres lugares que se desincronizaron una vez:
 *   - tog-platform/src/sign.js        → qué se puede FIRMAR y VALIDAR
 *   - landing-page PricingClient      → qué puede MARCAR el cliente
 *   - tog-admin src/shared/modules.ts → qué ACTIVA la app
 *
 * `hipico` estaba en tog-admin pero no acá, así que emitir una licencia con el
 * módulo Hípico fallaba en producción. Estos tests fijan el contrato del backend.
 */

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' })
const publicPem = publicKey.export({ type: 'spki', format: 'pem' })

function firmarCon(modulos) {
  return signLicense(privatePem, { cliente: 'Prueba SA', expira: '2099-12-31', modules: modulos })
}

test('incluye hípico entre los módulos firmables', () => {
  assert.ok(MODULE_IDS.includes('hipico'), 'hipico debe poder firmarse (FASE 7b)')
})

test('el catálogo vendible no expone la base, omniserv ni rrhh', () => {
  assert.deepEqual(
    [...MODULOS_VENDIBLES].sort(),
    ['administracion', 'distribuidor', 'hipico', 'postventa', 'procesador', 'productor', 'restaurant'],
  )
  assert.ok(!MODULOS_VENDIBLES.includes('comercializador'), 'la base va incluida en todo plan')
  assert.ok(!MODULOS_VENDIBLES.includes('omniserv'), 'OmniServ se vende por su lado')
  assert.ok(!MODULOS_VENDIBLES.includes('rrhh'), 'RRHH se activa con administracion')
})

test('firma una licencia con todos los módulos vendibles y la firma verifica', () => {
  const license = firmarCon([...MODULOS_VENDIBLES])
  const { firma, ...payload } = license

  const verify = crypto.createVerify('SHA256')
  verify.update(JSON.stringify(payload))
  assert.ok(verify.verify(publicPem, firma, 'base64'), 'la firma debe verificar con la pública')

  assert.deepEqual([...payload.modules].sort(), [...MODULOS_VENDIBLES].sort())
})

test('rechaza un módulo desconocido en vez de firmar algo que la app ignoraría', () => {
  assert.throws(() => firmarCon(['comercializador', 'inventado']), /Módulo\(s\) desconocido\(s\): inventado/)
})

test('el payload respeta las claves y el orden que valida tog-admin', () => {
  const license = firmarCon(['comercializador', 'hipico'])
  assert.deepEqual(Object.keys(license).slice(0, 5), ['cliente', 'expira', 'version', 'machineId', 'modules'])
  assert.equal(license.version, '1.0.0')
})

test('valida max_pcs en el rango de la red local', () => {
  assert.equal(signLicense(privatePem, { cliente: 'A', expira: '2099-12-31', maxPcs: 20 }).max_pcs, 20)
  assert.throws(() => signLicense(privatePem, { cliente: 'A', expira: '2099-12-31', maxPcs: 21 }), /max_pcs/)
  assert.throws(() => signLicense(privatePem, { cliente: 'A', expira: '2099-12-31', maxPcs: 0 }), /max_pcs/)
})

test('exige cliente y fecha con formato', () => {
  assert.throws(() => signLicense(privatePem, { expira: '2099-12-31' }), /cliente/)
  assert.throws(() => signLicense(privatePem, { cliente: 'A', expira: '31-12-2099' }), /YYYY-MM-DD/)
})
