// Tests de vinculación empresa ↔ vendedor (FASE 5).
//
// Cómo corren:
//   - Con `npm test` (sin DATABASE_URL) el backend usa SQLite, donde las tablas
//     de vendedores NO existen: se verifica la parte pura + que la API responda
//     400 (formato inválido) y 503 (entorno sin vendedores).
//   - Con DATABASE_URL apuntando a Postgres (certificación de la rama Postgres)
//     se crean las tablas de vendedores como fixturas y se prueba el flujo
//     completo: vincular, idempotencia, comisión del 30% y errores.
//
// Las fixturas replican las columnas que usa src/vendedores.js. La definición
// canónica vive en supabase/migrations/001_rls_policies.sql (tablas) y
// 002_vendedores_auth.sql (password_hash).

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpDir = mkdtempSync(join(tmpdir(), 'tog-platform-vendedores-'))
process.env.TOG_PLATFORM_DATA = join(tmpDir, 'data')
process.env.ADMIN_API_KEY = 'test-admin-key'
process.env.PAYMENT_HMAC_SECRET = 'test-hmac-secret'
process.env.JWT_SECRET = 'test-jwt-secret'
process.env.RATE_LIMIT_MAX = '5000'

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const keyPath = join(tmpDir, 'private.pem')
writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
process.env.LICENSE_PRIVATE_KEY_PATH = keyPath

const { isPostgres } = await import('./db.js')
const {
  validarIdVendedor,
  calcularComision,
  periodoDeFecha,
  montoMensualDePago,
  tablasVendedoresDisponibles,
  registrarComisionDePagoConfirmado,
} = await import('./vendedores.js')
const { db, closeDatabase } = await import('./db.js')

const ID_VENDEDOR = 'OMV-T3ST1'
const DOCUMENTO_EMPRESA = `V-${Date.now()}`

let server
let base = ''
let empresa = null

const FIXTURAS = [
  `CREATE TABLE IF NOT EXISTS vendedores (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     email varchar(255) UNIQUE NOT NULL,
     nombre varchar(100) NOT NULL,
     apellido varchar(100) NOT NULL,
     documento varchar(50) NOT NULL,
     nacionalidad varchar(5) NOT NULL,
     pais varchar(5),
     telegram_verificado boolean DEFAULT false,
     crixto_verificado boolean DEFAULT false,
     activo boolean DEFAULT true,
     id_vendedor varchar(20) UNIQUE NOT NULL,
     comision_porcentaje decimal(5,2) DEFAULT 30.00,
     password_hash text,
     created_at timestamptz DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS vendedor_clientes (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     vendedor_id uuid REFERENCES vendedores(id),
     cliente_empresa varchar(255) NOT NULL,
     cliente_email varchar(255),
     cliente_telefono varchar(50),
     cliente_ubicacion text,
     licencia_id varchar(100),
     licencia_estado varchar(20),
     licencia_modulos jsonb,
     licencia_expira timestamptz,
     monto_mensual decimal(10,2),
     commission_status varchar(20) DEFAULT 'pendiente',
     registrado_en timestamptz DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS vendedor_comisiones (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     vendedor_id uuid REFERENCES vendedores(id),
     cliente_id uuid REFERENCES vendedor_clientes(id),
     monto decimal(10,2) NOT NULL,
     moneda varchar(3) DEFAULT 'USD',
     periodo varchar(7),
     estado varchar(20) DEFAULT 'pendiente',
     fecha_pago timestamptz,
     comprobante_url text,
     created_at timestamptz DEFAULT now()
   )`,
]

before(async () => {
  if (isPostgres) {
    for (const sql of FIXTURAS) await db.exec(sql)
    await db
      .prepare(
        `INSERT INTO vendedores (email, nombre, apellido, documento, nacionalidad, id_vendedor, pais)
         VALUES ($1, 'Test', 'Vendedor', 'V-1', 'VE', $2, 'VE')
         ON CONFLICT (id_vendedor) DO NOTHING`,
      )
      .run('vendedor-test@omnimargen.test', ID_VENDEDOR)
  }

  const { startServer } = await import('./server.js')
  server = startServer({ port: 0 })
  await new Promise((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${server.address().port}`

  const res = await fetch(`${base}/api/empresas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': 'test-admin-key' },
    body: JSON.stringify({
      nombre: 'Cliente Vinculado C.A.',
      pais: 'VE',
      documento: DOCUMENTO_EMPRESA,
      email_contacto: 'cliente@omnimargen.test',
    }),
  })
  const body = await res.json()
  assert.equal(res.status, 201)
  empresa = { id: body.id, api_key: body.api_key }
})

after(async () => {
  if (isPostgres && empresa) {
    await db.prepare('DELETE FROM vendedor_comisiones WHERE vendedor_id IN (SELECT id FROM vendedores WHERE id_vendedor = $1)').run(ID_VENDEDOR)
    await db.prepare('DELETE FROM vendedor_clientes WHERE vendedor_id IN (SELECT id FROM vendedores WHERE id_vendedor = $1)').run(ID_VENDEDOR)
    await db.prepare('DELETE FROM empresas WHERE documento = $1').run(DOCUMENTO_EMPRESA)
    await db.prepare('DELETE FROM vendedores WHERE id_vendedor = $1').run(ID_VENDEDOR)
  }
  server?.close()
  closeDatabase()
  rmSync(tmpDir, { recursive: true, force: true })
})

async function vincular(idVendedor, headers = {}) {
  const res = await fetch(`${base}/api/empresas/${empresa.id}/vendedor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': empresa.api_key, ...headers },
    body: JSON.stringify({ id_vendedor: idVendedor }),
  })
  return { status: res.status, body: await res.json() }
}

test('validarIdVendedor normaliza y valida el formato OMV-XXXXX', () => {
  assert.deepEqual(validarIdVendedor(' omv-t3st1 '), { id: 'OMV-T3ST1', valido: true })
  assert.equal(validarIdVendedor('OMV-1234').valido, false, '4 caracteres no alcanza')
  assert.equal(validarIdVendedor('OMV-123456').valido, false, '6 caracteres sobra')
  assert.equal(validarIdVendedor('VND-12345').valido, false, 'prefijo incorrecto')
  assert.equal(validarIdVendedor(undefined).valido, false)
})

test('calcularComision aplica el porcentaje del vendedor sobre el monto', () => {
  assert.equal(calcularComision(15, 30), 4.5)
  assert.equal(calcularComision(150, 30), 45)
  assert.equal(calcularComision(40, '30.00'), 12)
  assert.equal(calcularComision('no-numero', 30), 0)
})

test('montoMensualDePago lleva un pago anual a su equivalente mensual', () => {
  const pago = { monto: 150, detalle: JSON.stringify({ periodo: 'anual' }), paid_at: '2026-03-15 10:00:00' }
  assert.deepEqual(montoMensualDePago(pago, { anual: 12 }), { monto: 12.5, periodo: '2026-03', moneda: 'USD' })
  assert.equal(periodoDeFecha('2026-03-15 10:00:00'), '2026-03')
})

test('vincular rechaza formatos inválidos y entornos sin vendedores', async () => {
  const invalido = await vincular('NO-ES-UN-ID')
  assert.equal(invalido.status, 400)

  const disponible = await tablasVendedoresDisponibles()
  const valido = await vincular(ID_VENDEDOR)
  if (disponible) {
    assert.equal(valido.status, 200)
  } else {
    assert.equal(valido.status, 503, 'sin tablas de vendedores (SQLite dev) debe responder 503')
  }
})

test('vincular exige la API key de la empresa', async () => {
  const res = await fetch(`${base}/api/empresas/${empresa.id}/vendedor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id_vendedor: ID_VENDEDOR }),
  })
  assert.equal(res.status, 401)
})

if (isPostgres) {
  test('vinculación completa: cliente en el panel del vendedor + comisión de pagos confirmados', async () => {
    const pago = await db
      .prepare(
        `INSERT INTO pagos (empresa_id, concepto, detalle, monto, moneda, estado, paid_at)
         VALUES ($1, 'tog:mensual', $2, 15, 'USD', 'confirmed', ${'NOW()'}) RETURNING id`,
      )
      .run(empresa.id, JSON.stringify({ producto: 'tog', periodo: 'mensual', modulos: ['comercializador'] }))

    const { status, body } = await vincular(ID_VENDEDOR)
    assert.equal(status, 200, JSON.stringify(body))
    assert.equal(body.vendedor.id_vendedor, ID_VENDEDOR)
    assert.equal(body.monto_mensual, 15)
    assert.equal(body.comisiones_creadas, 1)

    const empresaRow = await db.prepare('SELECT vendedor_id FROM empresas WHERE id = $1').get(empresa.id)
    assert.equal(empresaRow.vendedor_id, ID_VENDEDOR, 'el ID humano queda en empresas.vendedor_id')

    const cliente = await db
      .prepare('SELECT * FROM vendedor_clientes WHERE cliente_empresa = $1')
      .get('Cliente Vinculado C.A.')
    assert.ok(cliente, 'el cliente aparece en el panel del vendedor')
    assert.equal(cliente.licencia_estado, 'sin_licencia')
    assert.equal(Number(cliente.monto_mensual), 15)

    const comisiones = await db
      .prepare('SELECT * FROM vendedor_comisiones WHERE cliente_id = $1')
      .all(cliente.id)
    assert.equal(comisiones.length, 1)
    assert.equal(Number(comisiones[0].monto), 4.5, '30% de 15')
    assert.equal(comisiones[0].estado, 'pendiente')

    // Idempotencia: volver a vincular no duplica cliente ni comisión.
    const repetido = await vincular(ID_VENDEDOR)
    assert.equal(repetido.status, 200)
    assert.equal(repetido.body.cliente_creado, false)
    assert.equal(repetido.body.comisiones_creadas, 0)
    const clientes = await db
      .prepare('SELECT count(*)::int AS total FROM vendedor_clientes WHERE cliente_empresa = $1')
      .get('Cliente Vinculado C.A.')
    assert.equal(clientes.total, 1)

    // Comisión del pago confirmado ya registrado (hook de confirmarPago).
    const empresaConVendedor = await db.prepare('SELECT * FROM empresas WHERE id = $1').get(empresa.id)
    const otra = await registrarComisionDePagoConfirmado({
      empresa: empresaConVendedor,
      pago: { id: pago.lastInsertRowid, monto: 15, detalle: JSON.stringify({ periodo: 'mensual' }), paid_at: new Date().toISOString() },
      mesesPorPeriodo: { mensual: 1 },
    })
    assert.equal(otra.registrada, false, 'el mismo periodo no genera otra comisión')

    await db.prepare('DELETE FROM vendedor_comisiones WHERE cliente_id = $1').run(cliente.id)
    await db.prepare('DELETE FROM pagos WHERE id = $1').run(pago.lastInsertRowid)
  })

  test('vincular rechaza vendedor inexistente e inactivo', async () => {
    const inexistente = await vincular('OMV-N0P3Z')
    assert.equal(inexistente.status, 404)

    await db.prepare('UPDATE vendedores SET activo = false WHERE id_vendedor = $1').run(ID_VENDEDOR)
    const inactivo = await vincular(ID_VENDEDOR)
    assert.equal(inactivo.status, 409)
    await db.prepare('UPDATE vendedores SET activo = true WHERE id_vendedor = $1').run(ID_VENDEDOR)
  })
}
