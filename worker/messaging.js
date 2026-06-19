/**
 * [ML-BOT] Mensajería post-venta universal (custom, a acordar o Mercado Envíos).
 *
 * Permite enviar mensajes y adjuntar fotos al comprador a través del sistema
 * de mensajería de MercadoLibre, sin importar el tipo de envío de la orden.
 */
import { getValidAccessToken } from './index.js'

const log    = (...a) => console.log('[ML-BOT]', ...a)
const logErr = (...a) => console.error('[ML-BOT]', ...a)

const API_BASE = 'https://api.mercadolibre.com'

/**
 * Sube un adjunto (ej. foto) al sistema de mensajería de ML.
 * `bytes` puede ser ArrayBuffer o Uint8Array.
 * Devuelve el id del adjunto (string) o lanza un error con el detalle.
 */
export async function uploadAttachment(env, token, bytes, filename = 'foto.jpg', mimeType = 'image/jpeg') {
  try {
    const form = new FormData()
    form.append('file', new File([bytes], filename, { type: mimeType }))

    const res = await fetch(`${API_BASE}/messages/attachments?tag=post_sale&site_id=MLC`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })

    let data = null
    try { data = await res.json() } catch { /* respuesta no-JSON, se ignora */ }

    if (!res.ok) {
      const msg = data?.message || data?.error || `HTTP ${res.status}`
      throw new Error(msg)
    }

    const id = data?.id || data?.attachment_id
    if (!id) throw new Error('Respuesta de ML sin id de adjunto')
    return String(id)
  } catch (err) {
    logErr('uploadAttachment falló:', err.message || err)
    throw err
  }
}

/**
 * Envía un mensaje de texto (y opcionalmente adjuntos) al comprador de un pack.
 * No lanza excepción: siempre devuelve { ok, error? }.
 */
export async function sendBuyerMessage(env, token, { packId, sellerId, buyerId, text, attachments = [] }) {
  try {
    const body = {
      from: { user_id: sellerId },
      to: { user_id: buyerId },
      text,
    }
    if (attachments.length) body.attachments = attachments

    const res = await fetch(`${API_BASE}/messages/packs/${packId}/sellers/${sellerId}?tag=post_sale`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    let data = null
    try { data = await res.json() } catch { /* respuesta no-JSON, se ignora */ }

    if (!res.ok) {
      const msg = data?.message || data?.error || `HTTP ${res.status}`
      throw new Error(msg)
    }

    return { ok: true }
  } catch (err) {
    logErr('sendBuyerMessage falló:', err.message || err)
    return { ok: false, error: err.message || String(err) }
  }
}

/**
 * Envía evidencia (texto + fotos) al comprador de una orden, resolviendo
 * automáticamente packId/sellerId/buyerId desde la orden. Las fotos se
 * suben en best-effort: un fallo individual no aborta el resto.
 */
export async function sendBuyerEvidence(env, orderId, { text, photos = [] }) {
  const token = await getValidAccessToken(env)

  let order
  try {
    const res = await fetch(`${API_BASE}/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      let data = null
      try { data = await res.json() } catch { /* ignorar */ }
      throw new Error(data?.message || `HTTP ${res.status}`)
    }
    order = await res.json()
  } catch (err) {
    logErr('No se pudo obtener la orden', orderId, err.message || err)
    throw new Error(`No se pudo obtener la orden ${orderId}: ${err.message || err}`)
  }

  const sellerId   = order.seller?.id
  const buyerId    = order.buyer?.id
  const buyerFirst = order.buyer?.first_name || order.buyer?.nickname || 'cliente'
  const packId     = order.pack_id || orderId

  const attachmentIds = []
  const attachErr = []
  for (const photo of photos) {
    try {
      const id = await uploadAttachment(env, token, photo.bytes, photo.filename, photo.mimeType)
      attachmentIds.push(id)
    } catch (err) {
      attachErr.push(err.message || String(err))
    }
  }

  const msgRes = await sendBuyerMessage(env, token, { packId, sellerId, buyerId, text, attachments: attachmentIds })

  if (msgRes.ok) log('Evidencia enviada a comprador de orden', orderId)
  else logErr('Evidencia con error de mensaje para orden', orderId, msgRes.error)

  return {
    ok: msgRes.ok,
    msgOk: msgRes.ok,
    msgErr: msgRes.error,
    attachOk: attachmentIds.length,
    attachErr,
    buyerFirst,
  }
}
