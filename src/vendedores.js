// Vinculación de una empresa (cliente) con el vendedor que la trajo.
//
// CONTEXTO DE DATOS (ver docs/SUPABASE.md y docs/DECISION_BASE_DE_DATOS.md):
// las tablas del sistema de vendedores (`vendedores`, `vendedor_clientes`,
// `vendedor_comisiones`) viven en Supabase/Postgres y las administra la landing
// page. Este módulo es el único punto del backend que las toca.
//
// En dev/test el backend corre en SQLite (sin DATABASE_URL) y esas tablas no
// existen: en ese caso `tablasVendedoresDisponibles()` devuelve false y la API
// responde 503 en vez de romper. La columna `empresas.vendedor_id` guarda el ID
// humano (OMV-XXXXX), no el UUID, porque es lo que el cliente escribe en
// TOG Admin y funciona igual en SQLite y en Postgres.

import { db, isPostgres } from './db.js'

export const ID_VENDEDOR_REGEX = /^OMV-[A-Z0-9]{5}$/

/** Normaliza y valida el ID de vendedor que llega desde TOG Admin. */
export function validarIdVendedor(valor) {
  const id = typeof valor === 'string' ? valor.trim().toUpperCase() : ''
  return { id, valido: ID_VENDEDOR_REGEX.test(id) }
}

/**
 * ¿Están las tablas de vendedores en esta base? Sólo puede ser true en
 * Postgres/Supabase; SQLite (dev/test) nunca las tiene.
 */
export async function tablasVendedoresDisponibles() {
  if (!isPostgres) return false
  try {
    const row = await db.prepare('SELECT to_regclass($1) AS tabla').get('public.vendedores')
    return !!row?.tabla
  } catch {
    return false
  }
}

/** Busca al vendedor por su ID humano (OMV-XXXXX). */
export async function buscarVendedor(idVendedor) {
  return (
    (await db
      .prepare('SELECT id, id_vendedor, nombre, apellido, email, comision_porcentaje, activo FROM vendedores WHERE id_vendedor = $1')
      .get(idVendedor)) ?? null
  )
}

/**
 * Comisión de un pago, redondeada a 2 decimales (30% de 15 => 4.5).
 * `porcentaje` puede venir como string/numeric desde Postgres.
 */
export function calcularComision(monto, porcentaje) {
  const base = Number(monto)
  const pct = Number(porcentaje)
  if (!Number.isFinite(base) || !Number.isFinite(pct)) return 0
  return Math.round(base * pct) / 100
}

/** Periodo (YYYY-MM) de una fecha ISO o de un timestamp de la DB. */
export function periodoDeFecha(fecha) {
  const d = fecha ? new Date(fecha) : new Date()
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 7)
  return d.toISOString().slice(0, 7)
}

function hoy() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Crea o actualiza la fila de `vendedor_clientes` de esta empresa.
 * La tabla no tiene UNIQUE(vendedor_id, cliente_empresa), así que se busca
 * primero para no duplicar clientes en cada sincronización.
 */
async function upsertCliente({ vendedorId, empresa, licencia, montoMensual, comisionPorcentaje, existente }) {
  const modulos = licencia?.modules ? JSON.parse(licencia.modules) : null
  const datos = {
    cliente_empresa: empresa.nombre,
    cliente_email: empresa.email_contacto,
    cliente_telefono: null,
    cliente_ubicacion: [empresa.pais, empresa.documento].filter(Boolean).join(' '),
    licencia_id: licencia ? String(licencia.id) : null,
    licencia_estado: licencia && licencia.expires_at >= hoy() ? 'activa' : licencia ? 'vencida' : 'sin_licencia',
    licencia_modulos: modulos ? JSON.stringify(modulos) : null,
    licencia_expira: licencia?.expires_at ?? null,
    monto_mensual: montoMensual,
    commission_status: existente?.commission_status || 'pendiente',
  }

  if (existente) {
    await db
      .prepare(
        `UPDATE vendedor_clientes
            SET cliente_email = $1, cliente_ubicacion = $2, licencia_id = $3, licencia_estado = $4,
                licencia_modulos = $5, licencia_expira = $6, monto_mensual = $7
          WHERE id = $8`,
      )
      .run(
        datos.cliente_email,
        datos.cliente_ubicacion,
        datos.licencia_id,
        datos.licencia_estado,
        datos.licencia_modulos,
        datos.licencia_expira,
        datos.monto_mensual,
        existente.id,
      )
    return { id: existente.id, creado: false }
  }

  const cols = Object.keys(datos)
  const placeholders = cols.map((_, i) => `$${i + 2}`).join(', ')
  const result = await db
    .prepare(
      `INSERT INTO vendedor_clientes (vendedor_id, ${cols.join(', ')})
       VALUES ($1, ${placeholders}) RETURNING id, registrado_en`,
    )
    .run(vendedorId, ...cols.map((c) => datos[c]))

  return { id: result.lastInsertRowid, creado: true }
}

/** Monto mensual del último pago confirmado + su periodo. */
export function montoMensualDePago(pago, mesesPorPeriodo = {}) {
  if (!pago) return { monto: null, periodo: null }
  let detalle = {}
  try {
    detalle = typeof pago.detalle === 'string' ? JSON.parse(pago.detalle) : pago.detalle || {}
  } catch {
    detalle = {}
  }
  const meses = mesesPorPeriodo[detalle.periodo] || 1
  const monto = Number(pago.monto)
  if (!Number.isFinite(monto)) return { monto: null, periodo: null }
  return {
    monto: Math.round((monto / meses) * 100) / 100,
    periodo: periodoDeFecha(pago.paid_at || pago.created_at),
    moneda: pago.moneda || 'USD',
  }
}

/**
 * Vincula la empresa con el vendedor: guarda `empresas.vendedor_id`, deja el
 * cliente en el panel del vendedor y registra la comisión de cada pago ya
 * confirmado (idempotente: no repite comisión por periodo).
 *
 * Devuelve `{ ok, cliente_id, cliente_creado, comisiones_creadas, error }`.
 */
export async function vincularEmpresaConVendedor({ empresa, vendedor, licencia = null, pagos = [], mesesPorPeriodo = {} }) {
  if (!vendedor?.id) return { ok: false, error: 'Vendedor inválido' }

  const { monto, periodo } = montoMensualDePago(pagos[pagos.length - 1], mesesPorPeriodo)
  const existente =
    (await db
      .prepare('SELECT id, commission_status FROM vendedor_clientes WHERE vendedor_id = $1 AND cliente_empresa = $2 LIMIT 1')
      .get(vendedor.id, empresa.nombre)) ?? null

  const cliente = await upsertCliente({
    vendedorId: vendedor.id,
    empresa,
    licencia,
    montoMensual: monto,
    comisionPorcentaje: vendedor.comision_porcentaje,
    existente,
  })

  await db.prepare('UPDATE empresas SET vendedor_id = $1 WHERE id = $2').run(vendedor.id_vendedor, empresa.id)

  let comisionesCreadas = 0
  for (const pago of pagos) {
    const creadas = await registrarComisionDePago({ vendedor, clienteId: cliente.id, pago, mesesPorPeriodo })
    comisionesCreadas += creadas
  }

  return {
    ok: true,
    cliente_id: cliente.id,
    cliente_creado: cliente.creado,
    comisiones_creadas: comisionesCreadas,
    monto_mensual: monto,
    periodo,
  }
}

/**
 * Monto, moneda y periodo de la comisión que le corresponde a un pago.
 * Función pura: la usan tanto el registro en la base como el aviso por
 * Telegram, para que no haya dos formas de calcular el mismo monto.
 * Devuelve null si el pago no genera comisión.
 */
export function detalleComision({ pago, mesesPorPeriodo = {}, porcentaje, moneda = 'USD' }) {
  const base = Number(pago?.monto)
  if (!Number.isFinite(base) || base <= 0) return null

  const { monto: mensual, periodo } = montoMensualDePago(pago, mesesPorPeriodo)
  const monto = calcularComision(mensual ?? base, porcentaje)
  if (monto <= 0) return null

  return { monto, moneda: moneda || 'USD', periodo }
}

/**
 * Registra la comisión de un pago confirmado. Idempotente por
 * (cliente, periodo): si ya existe una comisión de ese mes para ese cliente, no
 * la duplica. Devuelve 1 si creó la fila, 0 si no había nada que hacer.
 */
export async function registrarComisionDePago({ vendedor, clienteId, pago, mesesPorPeriodo = {}, moneda = 'USD' }) {
  if (!vendedor?.id || !clienteId || !pago) return 0

  const detalle = detalleComision({
    pago,
    mesesPorPeriodo,
    porcentaje: vendedor.comision_porcentaje,
    moneda,
  })
  if (!detalle) return 0

  const yaExiste = await db
    .prepare('SELECT id FROM vendedor_comisiones WHERE cliente_id = $1 AND periodo = $2 LIMIT 1')
    .get(clienteId, detalle.periodo)
  if (yaExiste) return 0

  await db
    .prepare(
      `INSERT INTO vendedor_comisiones (vendedor_id, cliente_id, monto, moneda, periodo, estado)
       VALUES ($1, $2, $3, $4, $5, 'pendiente')`,
    )
    .run(vendedor.id, clienteId, detalle.monto, detalle.moneda, detalle.periodo)

  return 1
}

/**
 * Versión "de paso": tras confirmar un pago, si la empresa ya está vinculada a
 * un vendedor, le registra la comisión. Nunca debe romper el flujo de pago, así
 * que devuelve { registrada, motivo } en vez de lanzar.
 */
export async function registrarComisionDePagoConfirmado({ empresa, pago, mesesPorPeriodo = {} }) {
  if (!empresa?.vendedor_id || !pago) return { registrada: false, motivo: 'empresa sin vendedor' }
  if (!(await tablasVendedoresDisponibles())) return { registrada: false, motivo: 'tablas de vendedores no disponibles' }

  const vendedor = await buscarVendedor(empresa.vendedor_id)
  if (!vendedor) return { registrada: false, motivo: 'vendedor no encontrado' }

  const cliente =
    (await db
      .prepare('SELECT id FROM vendedor_clientes WHERE vendedor_id = $1 AND cliente_empresa = $2 LIMIT 1')
      .get(vendedor.id, empresa.nombre)) ?? null
  if (!cliente) return { registrada: false, motivo: 'cliente del vendedor no encontrado' }

  const creadas = await registrarComisionDePago({ vendedor, clienteId: cliente.id, pago, mesesPorPeriodo })
  if (creadas <= 0) return { registrada: false, motivo: 'comisión ya registrada para el periodo' }

  // Detalle para poder avisarle al vendedor (ver src/telegram.js).
  const detalle = detalleComision({
    pago,
    mesesPorPeriodo,
    porcentaje: vendedor.comision_porcentaje,
  })

  return {
    registrada: true,
    motivo: 'ok',
    detalle: detalle ? { ...detalle, cliente: empresa.nombre } : null,
  }
}
