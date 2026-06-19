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
 * POST clásico a /messages. Sirve cuando la conversación ya está abierta
 * (el comprador escribió primero) o cuando el mensaje lleva adjuntos.
 * No lanza: devuelve { ok, error?, blocked?, status? }.
 *
 * `blocked` indica que ML rechazó el INICIO de la conversación por política
 * de vendedor (sustatus blocked_by_conversation_initiated_by_seller_limited),
 * lo que dispara el fallback al Action Guide.
 */
async function postClassicMessage(env, token, { packId, sellerId, buyerId, text, attachments = [] }) {
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
      const blocked = res.status === 403 ||
        /block|initiated_by_seller|not_allowed|cap_exceeded|limit/i.test(JSON.stringify(data || ''))
      return { ok: false, error: msg, blocked, status: res.status }
    }

    return { ok: true, via: 'messages' }
  } catch (err) {
    logErr('postClassicMessage falló:', err.message || err)
    return { ok: false, error: err.message || String(err) }
  }
}

/**
 * GET de las opciones del Action Guide ("motivos para comunicarse") que ML
 * habilita para INICIAR una conversación post-venta en un pack. Devuelve el
 * array de opciones o null si no aplica / falla.
 */
async function getActionGuideOptions(env, token, packId) {
  try {
    const res = await fetch(`${API_BASE}/messages/action_guide/packs/${packId}?tag=post_sale`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    const data = await res.json()
    return Array.isArray(data?.options) ? data.options : null
  } catch (err) {
    logErr('getActionGuideOptions falló:', err.message || err)
    return null
  }
}

/**
 * POST de una opción del Action Guide (texto libre OTHER o plantilla).
 * No lanza: devuelve { ok, error?, status? }.
 */
async function postActionGuideOption(env, token, packId, payload) {
  try {
    const res = await fetch(`${API_BASE}/messages/action_guide/packs/${packId}/option?tag=post_sale`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    let data = null
    try { data = await res.json() } catch { /* respuesta no-JSON, se ignora */ }

    if (!res.ok) {
      const msg = data?.message || data?.error || `HTTP ${res.status}`
      return { ok: false, error: msg, status: res.status }
    }

    return { ok: true, via: 'action_guide' }
  } catch (err) {
    logErr('postActionGuideOption falló:', err.message || err)
    return { ok: false, error: err.message || String(err) }
  }
}

/**
 * Envía un mensaje de texto (y opcionalmente adjuntos) al comprador de un pack.
 * No lanza excepción: siempre devuelve { ok, error?, via?, need_buyer_reply? }.
 *
 * MercadoLibre BLOQUEA que un vendedor nuevo / con Mercado Envíos INICIE la
 * conversación con un POST directo a /messages (substatus
 * blocked_by_conversation_initiated_by_seller_limited). La forma oficial de
 * iniciar es vía el Action Guide: se elige un "motivo para comunicarse"
 * (opción FREE_TEXT "OTHER", límite 350 chars, con cupo cap_available). Una vez
 * que el comprador responde, la conversación se desbloquea y vuelve a servir el
 * endpoint clásico (sin cupo).
 *
 * Estrategia:
 *   - Con adjuntos → endpoint clásico (el Action Guide es solo texto).
 *   - Si hay opción FREE_TEXT con cupo → enviar por Action Guide (texto truncado
 *     a su char_limit).
 *   - Si el cupo está agotado → intentar el clásico (por si el comprador ya
 *     respondió); si no, devolver error claro `need_buyer_reply`.
 *   - Si no hay gating de Action Guide → endpoint clásico.
 */
export async function sendBuyerMessage(env, token, { packId, sellerId, buyerId, text, attachments = [] }) {
  // Adjuntos (fotos de evidencia): el Action Guide no transporta archivos.
  if (attachments.length) {
    return postClassicMessage(env, token, { packId, sellerId, buyerId, text, attachments })
  }

  const options = await getActionGuideOptions(env, token, packId)
  const freeText = options?.find(o => o.type === 'FREE_TEXT' && o.enabled && o.actionable)

  if (freeText) {
    if ((freeText.cap_available ?? 0) >= 1) {
      const limit = freeText.char_limit || 350
      const body = text.length > limit ? text.slice(0, limit) : text
      const r = await postActionGuideOption(env, token, packId, { option_id: freeText.id, text: body })
      if (r.ok) {
        log(`Mensaje enviado vía Action Guide (${freeText.id}) al pack ${packId}`)
        return r
      }
      // Falló el Action Guide: probamos el clásico por si la conversación ya está abierta.
      logErr('Action Guide falló, intento clásico:', r.error)
      const c = await postClassicMessage(env, token, { packId, sellerId, buyerId, text })
      return c.ok ? c : { ok: false, error: r.error || c.error }
    }
    // Cupo de inicio agotado: ML exige que el comprador responda antes de otro
    // mensaje. Igual probamos el clásico (si el comprador ya respondió, abre).
    const c = await postClassicMessage(env, token, { packId, sellerId, buyerId, text })
    if (c.ok) return c
    return {
      ok: false,
      need_buyer_reply: true,
      error: 'ML no permite otro mensaje hasta que el comprador responda (cupo de inicio agotado).',
    }
  }

  // Sin gating de Action Guide (conversación abierta o envío no aplicable).
  return postClassicMessage(env, token, { packId, sellerId, buyerId, text })
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
