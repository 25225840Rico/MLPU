/**
 * [ML-MSG] Módulo 2: mensajería directa al comprador.
 *
 * Permite enviar mensajes de post-venta a un comprador a partir del id de
 * orden, y leer la conversación existente del pack asociado. Reusa la
 * mensajería ya implementada en `messaging.js` y el manejo de tokens de
 * `index.js`.
 */
import { getValidAccessToken } from './index.js'
import { sendBuyerMessage } from './messaging.js'

const ML_API = 'https://api.mercadolibre.com'
const log = (...a) => console.log('[ML-MSG]', ...a)
const logErr = (...a) => console.error('[ML-MSG]', ...a)

/**
 * Resuelve sellerId/buyerId/packId/nombre del comprador a partir de una orden.
 * Lanza Error con `.status` si la petición a ML falla.
 */
async function resolveOrderParties(env, token, orderId) {
  const res = await fetch(`${ML_API}/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  let data = null
  try { data = await res.json() } catch { /* respuesta no-JSON, se ignora */ }

  if (!res.ok) {
    const err = new Error(`No se pudo obtener la orden ${orderId}: HTTP ${res.status}${data?.message ? ` - ${data.message}` : ''}`)
    err.status = res.status
    throw err
  }

  const order = data
  return {
    sellerId: order.seller?.id,
    buyerId: order.buyer?.id,
    packId: order.pack_id || orderId,
    buyerFirst: order.buyer?.first_name || order.buyer?.nickname || 'cliente',
  }
}

/**
 * Envía un mensaje de texto al comprador de una orden.
 * Devuelve { ok, error?, buyerFirst }.
 */
export async function sendMessageToBuyer(env, orderId, text) {
  const token = await getValidAccessToken(env)
  const parties = await resolveOrderParties(env, token, orderId)

  const res = await sendBuyerMessage(env, token, {
    packId: parties.packId,
    sellerId: parties.sellerId,
    buyerId: parties.buyerId,
    text,
  })

  if (res.ok) log('Mensaje enviado a comprador de orden', orderId)
  else logErr('Error al enviar mensaje para orden', orderId, res.error)

  return { ok: res.ok, error: res.error, buyerFirst: parties.buyerFirst }
}

/**
 * Obtiene la conversación (mensajes) del pack asociado a una orden.
 * Devuelve { buyerFirst, messages } con los mensajes normalizados y
 * ordenados ascendentemente por fecha, limitados a `limit`.
 */
export async function getConversation(env, orderId, limit = 10) {
  const token = await getValidAccessToken(env)
  const parties = await resolveOrderParties(env, token, orderId)

  const res = await fetch(
    `${ML_API}/messages/packs/${parties.packId}/sellers/${parties.sellerId}?tag=post_sale&mark_as_read=false&limit=${limit}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )

  let data = null
  try { data = await res.json() } catch { /* respuesta no-JSON, se ignora */ }

  if (!res.ok) {
    const err = new Error(`No se pudo obtener la conversación de la orden ${orderId}: HTTP ${res.status}${data?.message ? ` - ${data.message}` : ''}`)
    err.status = res.status
    throw err
  }

  const rawMessages = data?.messages || data?.results || []

  let messages = rawMessages.map((m) => ({
    from_seller: m.from?.user_id == parties.sellerId,
    text: m.text || m.message?.text || '',
    date: m.message_date?.created || m.date_created || m.date || null,
  }))

  const allHaveDates = messages.every((m) => m.date)
  if (allHaveDates) {
    messages.sort((a, b) => new Date(a.date) - new Date(b.date))
  }

  if (messages.length > limit) {
    messages = messages.slice(messages.length - limit)
  }

  return { buyerFirst: parties.buyerFirst, messages }
}

/**
 * Plantillas persuasivas de post-venta para TopWheels (@topwheels.cl).
 */
export const TEMPLATES = {
  despachado: (nombre) =>
    `¡Hola ${nombre}! Te contamos que tu pedido en TopWheels ya fue despachado. ¡Muchas gracias por tu compra, esperamos que lo disfrutes mucho! 🚗📦`,
  en_camino: (nombre) =>
    `${nombre}, tu pedido va en camino y debería llegar muy pronto. ¡Gracias por la paciencia, ya casi lo tienes en tus manos! 🚚`,
  recibido: (nombre) =>
    `Hola ${nombre}, ¿pudiste recibir tu pedido en buen estado? Si surge cualquier duda o problema, escríbenos sin problema, estamos para ayudarte. 😊`,
  calificacion: (nombre) =>
    `${nombre}, si quedaste contento con tu compra nos ayudaría muchísimo que nos dejes tu calificación ⭐ en MercadoLibre. ¡Gracias por confiar en TopWheels!`,
}

export const TEMPLATE_LABELS = {
  despachado: '📦 Despachado',
  en_camino: '🚚 En camino',
  recibido: '✅ Recibido',
  calificacion: '⭐ Calificación',
}
