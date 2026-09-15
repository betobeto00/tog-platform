/**
 * Aviso al vendedor por Telegram.
 *
 * POR QUÉ NO SE MANDA DIRECTO DESDE ACÁ: el token del bot vive en un solo
 * servicio (telegram-bot), que es el dueño de Telegram y de los chat_id de los
 * vendedores. Este backend sólo le pide que mande el aviso, con un secreto
 * compartido, al endpoint POST /notify/comision.
 *
 * Nunca lanza: esto corre dentro del cobro, y un aviso caído no puede romper
 * una venta. Si falta configuración simplemente no hace nada y lo informa.
 */

export const TIMEOUT_AVISO_MS = 5000

/** Lee la configuración del bot desde el entorno. */
export function configBotTelegram(env = process.env) {
  const url = String(env?.TELEGRAM_BOT_URL || '').trim().replace(/\/+$/, '')
  const secreto = String(env?.TELEGRAM_BOT_SECRET || '').trim()
  return { url, secreto, configurado: !!url && !!secreto }
}

/**
 * Le pide al bot que le avise al vendedor que se le acreditó una comisión.
 * Devuelve `{ enviado, motivo }` (nunca lanza).
 */
export async function avisarComisionAcreditada(
  { idVendedor, cliente, monto, moneda, periodo },
  { env = process.env, fetchImpl = globalThis.fetch, log = console, timeoutMs = TIMEOUT_AVISO_MS } = {},
) {
  const { url, secreto, configurado } = configBotTelegram(env)
  if (!configurado) return { enviado: false, motivo: 'telegram no configurado' }

  const id = String(idVendedor || '').trim().toUpperCase()
  const importe = Number(monto)
  if (!id || !Number.isFinite(importe) || importe <= 0 || !periodo) {
    return { enviado: false, motivo: 'datos incompletos' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetchImpl(`${url}/notify/comision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bot-secret': secreto },
      body: JSON.stringify({
        id_vendedor: id,
        cliente: cliente ?? null,
        monto: importe,
        moneda: moneda || 'USD',
        periodo,
      }),
      signal: controller.signal,
    })

    if (!res.ok) return { enviado: false, motivo: `el bot respondió ${res.status}` }

    const body = await res.json().catch(() => null)
    return { enviado: !!body?.enviado, motivo: body?.motivo || 'respuesta inesperada' }
  } catch (err) {
    return { enviado: false, motivo: `error de red: ${err?.message || err}` }
  } finally {
    clearTimeout(timer)
  }
}

/** true si el motivo amerita mirarlo (no es simplemente "el vendedor no usa Telegram"). */
export function motivoParaRevisar(motivo) {
  return typeof motivo === 'string' && (motivo.startsWith('error de red') || motivo.startsWith('el bot respondió'))
}
