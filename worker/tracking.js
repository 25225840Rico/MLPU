/**
 * [ML-BOT] Paso 3 — Foto del sticker → número de seguimiento.
 *
 * - extractTrackingFromImage: imagen base64 → Anthropic (claude-sonnet-4-6) →
 *   { tracking_number, recipient_name }.
 * - findPendingMatches: matchea el destinatario contra órdenes sin tracking.
 * - assignTracking: asigna el tracking en ML (best-effort), guarda en KV y manda
 *   el mensaje al comprador (best-effort). Devuelve un resumen de qué funcionó.
 *
 * NO toca el flujo de publicación. Reusa el token vía getValidAccessToken.
 */
import { getValidAccessToken } from './index.js'
import { getOrder, saveOrder, listOrders } from './orders.js'

const ML_API = 'https://api.mercadolibre.com'
const log    = (...a) => console.log('[ML-BOT]', ...a)
const logErr = (...a) => console.error('[ML-BOT]', ...a)

// ── Visión: extraer tracking + destinatario de la imagen ──────
export async function extractTrackingFromImage(imageB64, apiKey) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY no configurada en el Worker')

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageB64 } },
          { type: 'text', text: 'Extrae el número de seguimiento y el nombre del destinatario de esta imagen. Responde SOLO con JSON válido: {tracking_number: string, recipient_name: string}' },
        ],
      }],
    }),
  })

  if (!r.ok) {
    let msg
    try { msg = (await r.json()).error?.message } catch {}
    throw new Error(msg || `Anthropic HTTP ${r.status}`)
  }

  const raw = (await r.json()).content?.[0]?.text || '{}'
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('La IA no devolvió JSON')
  let parsed
  try { parsed = JSON.parse(match[0]) } catch { throw new Error('JSON inválido de la IA') }
  return {
    tracking_number: (parsed.tracking_number || '').toString().trim(),
    recipient_name:  (parsed.recipient_name  || '').toString().trim(),
  }
}

// ── Matching de destinatario contra órdenes pendientes ────────
const norm = (s) => (s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * Devuelve { pending, best } donde:
 *  - pending: todas las órdenes sin tracking (las elegibles).
 *  - best: pendientes con coincidencia de nombre, ordenadas por score desc.
 */
export async function findPendingMatches(env, recipientName) {
  const all = await listOrders(env, 200)
  const pending = all.filter(o => !o.tracking_number)
  const target = new Set(norm(recipientName).split(' ').filter(Boolean))

  const best = pending
    .map(o => {
      const toks = norm(o.buyer_name).split(' ').filter(Boolean)
      const score = toks.filter(t => target.has(t)).length
      return { order: o, score }
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)

  return { pending, best }
}

/** Hay match claro si el mejor existe y supera (o es único frente a) los demás. */
export function clearMatch(best) {
  if (best.length === 0) return null
  if (best.length === 1) return best[0].order
  return best[0].score > best[1].score ? best[0].order : null
}

// ── Asignar tracking en ML + mensaje al comprador ─────────────
async function mlGet(token, path) {
  const r = await fetch(`${ML_API}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  const data = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, data }
}

/**
 * Asigna `tracking` a la orden `orderId`. Siempre persiste el tracking en KV;
 * los pasos contra ML (PUT shipment + mensaje) son best-effort y se reportan.
 * Devuelve { order, carrier, trackingOk, trackingErr, msgOk, msgErr }.
 */
export async function assignTracking(env, orderId, tracking) {
  const token = await getValidAccessToken(env)
  const result = { trackingOk: false, trackingErr: null, carrier: 'el courier' }

  // Datos frescos de la orden para ubicar el shipment.
  const o = await mlGet(token, `/orders/${orderId}`)
  if (!o.ok) throw new Error(`No pude leer la orden ${orderId} (HTTP ${o.status})`)
  const shipmentId = o.data.shipping?.id

  // Carrier (best-effort) desde el shipment.
  if (shipmentId) {
    const s = await mlGet(token, `/shipments/${shipmentId}`)
    if (s.ok) result.carrier = s.data.tracking_method || s.data.logistic_type || 'el courier'
  }

  // 1) PUT tracking en ML (solo válido para envíos custom / a acordar).
  if (shipmentId) {
    try {
      const r = await fetch(`${ML_API}/shipments/${shipmentId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracking_number: tracking }),
      })
      if (r.ok) { result.trackingOk = true }
      else {
        const e = await r.json().catch(() => ({}))
        result.trackingErr = e.message || e.error || `HTTP ${r.status}`
      }
    } catch (e) { result.trackingErr = e.message }
  } else {
    result.trackingErr = 'La orden no tiene shipment asociado'
  }

  // 2) Persistir tracking en KV (independiente del resultado en ML).
  const rec = (await getOrder(env, orderId)) || { order_id: String(orderId) }
  rec.tracking_number = tracking
  rec.carrier = result.carrier
  await saveOrder(env, rec)

  result.order = rec
  log('assignTracking', orderId, JSON.stringify({ trackingOk: result.trackingOk }))
  if (result.trackingErr) logErr('tracking ML', orderId, result.trackingErr)
  return result
}
