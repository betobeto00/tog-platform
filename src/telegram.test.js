import test from 'node:test'
import assert from 'node:assert/strict'

import { avisarComisionAcreditada, configBotTelegram, motivoParaRevisar } from './telegram.js'

const ENV = { TELEGRAM_BOT_URL: 'https://bot.test/', TELEGRAM_BOT_SECRET: 's3creto' }

const AVISO = {
  idVendedor: 'OMV-AB12C',
  cliente: 'Empresa XYZ',
  monto: 4.5,
  moneda: 'USD',
  periodo: '2026-09',
}

/** fetch falso que registra las llamadas. */
function fetchFalso(respuesta) {
  const llamadas = []
  const impl = async (url, opciones) => {
    llamadas.push({ url, opciones })
    if (respuesta instanceof Error) throw respuesta
    return {
      ok: respuesta.status >= 200 && respuesta.status < 300,
      status: respuesta.status,
      json: async () => respuesta.body,
    }
  }
  return { impl, llamadas }
}

const logSilencioso = { warn() {}, error() {}, log() {} }

test('configBotTelegram: normaliza la URL y exige ambas variables', () => {
  assert.deepEqual(configBotTelegram(ENV), {
    url: 'https://bot.test',
    secreto: 's3creto',
    configurado: true,
  })
  assert.equal(configBotTelegram({ TELEGRAM_BOT_URL: 'https://bot.test' }).configurado, false)
  assert.equal(configBotTelegram({ TELEGRAM_BOT_SECRET: 's3creto' }).configurado, false)
  assert.equal(configBotTelegram({}).configurado, false)
  assert.equal(configBotTelegram({ TELEGRAM_BOT_URL: '  ', TELEGRAM_BOT_SECRET: 'x' }).configurado, false)
})

test('avisarComisionAcreditada: sin configuración no llama a nadie', async () => {
  const { impl, llamadas } = fetchFalso({ status: 200, body: {} })
  const res = await avisarComisionAcreditada(AVISO, { env: {}, fetchImpl: impl, log: logSilencioso })

  assert.deepEqual(res, { enviado: false, motivo: 'telegram no configurado' })
  assert.equal(llamadas.length, 0)
})

test('avisarComisionAcreditada: manda el ID, el secreto y el detalle', async () => {
  const { impl, llamadas } = fetchFalso({ status: 200, body: { ok: true, enviado: true, motivo: 'ok' } })
  const res = await avisarComisionAcreditada(AVISO, { env: ENV, fetchImpl: impl, log: logSilencioso })

  assert.deepEqual(res, { enviado: true, motivo: 'ok' })
  assert.equal(llamadas.length, 1)
  assert.equal(llamadas[0].url, 'https://bot.test/notify/comision')
  assert.equal(llamadas[0].opciones.method, 'POST')
  assert.equal(llamadas[0].opciones.headers['x-bot-secret'], 's3creto')
  assert.deepEqual(JSON.parse(llamadas[0].opciones.body), {
    id_vendedor: 'OMV-AB12C',
    cliente: 'Empresa XYZ',
    monto: 4.5,
    moneda: 'USD',
    periodo: '2026-09',
  })
})

test('avisarComisionAcreditada: normaliza el ID y el monto', async () => {
  const { impl, llamadas } = fetchFalso({ status: 200, body: { enviado: true, motivo: 'ok' } })
  await avisarComisionAcreditada(
    { idVendedor: ' omv-ab12c ', monto: '4.5', periodo: '2026-09' },
    { env: ENV, fetchImpl: impl, log: logSilencioso },
  )

  const body = JSON.parse(llamadas[0].opciones.body)
  assert.equal(body.id_vendedor, 'OMV-AB12C')
  assert.equal(body.monto, 4.5)
  assert.equal(body.moneda, 'USD', 'moneda por defecto')
  assert.equal(body.cliente, null, 'cliente opcional')
})

test('avisarComisionAcreditada: no llama si faltan datos', async () => {
  const { impl, llamadas } = fetchFalso({ status: 200, body: {} })
  const opciones = { env: ENV, fetchImpl: impl, log: logSilencioso }

  assert.equal((await avisarComisionAcreditada({ ...AVISO, idVendedor: '' }, opciones)).motivo, 'datos incompletos')
  assert.equal((await avisarComisionAcreditada({ ...AVISO, monto: 0 }, opciones)).motivo, 'datos incompletos')
  assert.equal((await avisarComisionAcreditada({ ...AVISO, monto: -1 }, opciones)).motivo, 'datos incompletos')
  assert.equal((await avisarComisionAcreditada({ ...AVISO, monto: 'mucho' }, opciones)).motivo, 'datos incompletos')
  assert.equal((await avisarComisionAcreditada({ ...AVISO, periodo: null }, opciones)).motivo, 'datos incompletos')
  assert.equal(llamadas.length, 0)
})

test('avisarComisionAcreditada: informa el rechazo del bot sin lanzar', async () => {
  const { impl } = fetchFalso({ status: 401, body: { ok: false } })
  const res = await avisarComisionAcreditada(AVISO, { env: ENV, fetchImpl: impl, log: logSilencioso })

  assert.deepEqual(res, { enviado: false, motivo: 'el bot respondió 401' })
})

test('avisarComisionAcreditada: un bot caído no rompe el cobro', async () => {
  const { impl } = fetchFalso(new Error('ECONNREFUSED'))
  const res = await avisarComisionAcreditada(AVISO, { env: ENV, fetchImpl: impl, log: logSilencioso })

  assert.equal(res.enviado, false)
  assert.match(res.motivo, /^error de red: ECONNREFUSED$/)
})

test('avisarComisionAcreditada: propaga el motivo del bot (vendedor sin Telegram)', async () => {
  const { impl } = fetchFalso({ status: 200, body: { ok: true, enviado: false, motivo: 'vendedor sin Telegram verificado' } })
  const res = await avisarComisionAcreditada(AVISO, { env: ENV, fetchImpl: impl, log: logSilencioso })

  assert.deepEqual(res, { enviado: false, motivo: 'vendedor sin Telegram verificado' })
})

test('motivoParaRevisar: sólo ruido real, no el vendedor sin Telegram', () => {
  assert.equal(motivoParaRevisar('error de red: timeout'), true)
  assert.equal(motivoParaRevisar('el bot respondió 500'), true)
  assert.equal(motivoParaRevisar('vendedor sin Telegram verificado'), false)
  assert.equal(motivoParaRevisar('telegram no configurado'), false)
  assert.equal(motivoParaRevisar(undefined), false)
})
