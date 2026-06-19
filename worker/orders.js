/**
 * [ML-BOT] Almacenamiento de órdenes en KV + alerta de venta a Telegram.
 *
 * KV binding: ML_ORDERS. NO toca el flujo de publicación existente.
 * Esquema por orden (clave `order:<id>`):
 *   { order_id, buyer_name, buyer_id, pack_id, shipment_id, tracking_number,
 *     status, product, quantity, amount, currency, shipping_type, fecha, alerted }
 * Clave índice `orders:index`: array de ids (más reciente primero) para listar.
 */
import { tgSend } from './telegram-bot.js'

const log    = (...a) => console.log('[ML-BOT]', ...a)
const logErr = (...a) => console.error('[ML-BOT]', ...a)

const ORDER_KEY = (id) => `order:${id}`
const INDEX_KEY = 'orders:index'
const INDEX_MAX = 200

// ── KV: índice de órdenes (ids, más reciente primero) ─────────
async function getIndex(env) {
  try { return JSON.parse(await env.ML_ORDERS.get(INDEX_KEY)) || [] } catch { return [] }
}
async function addToIndex(env, orderId) {
  const id = String(orderId)
  const idx = await getIndex(env)
  if (idx[0] === id) return
  const next = [id, ...idx.filter(x => x !== id)].slice(0, INDEX_MAX)
  await env.ML_ORDERS.put(INDEX_KEY, JSON.stringify(next))
}

export async function getOrder(env, orderId) {
  try { return JSON.parse(await env.ML_ORDERS.get(ORDER_KEY(orderId))) } catch { return null }
}
export async function saveOrder(env, rec) {
  await env.ML_ORDERS.put(ORDER_KEY(rec.order_id), JSON.stringify(rec))
  await addToIndex(env, rec.order_id)
}
export async function listOrders(env, limit = 10) {
  const ids = (await getIndex(env)).slice(0, limit)
  const recs = await Promise.all(ids.map(id => getOrder(env, id)))
  return recs.filter(Boolean)
}

// ── Helpers de formato ────────────────────────────────────────
function buyerName(buyer = {}) {
  const full = [buyer.first_name, buyer.last_name].filter(Boolean).join(' ').trim()
  return full || buyer.nickname || 'Comprador'
}
function shippingType(shipment) {
  if (!shipment) return 'No especificado'
  return shipment.logistic_type || shipment.shipping_mode || shipment.mode || 'No especificado'
}
const fmtMoney = (n, cur) => {
  const v = Number(n) || 0
  return cur === 'CLP' ? `$${v.toLocaleString('es-CL')}` : `${v} ${cur || ''}`.trim()
}

/**
 * Guarda/actualiza la orden desde el JSON de ML y, si está pagada y aún no se
 * alertó, manda la alerta a Telegram. Idempotente: ML manda varias notifs.
 */
export async function recordOrderFromML(env, order, shipment) {
  const orderId  = String(order.id)
  const existing = await getOrder(env, orderId)
  const item     = order.order_items?.[0] || {}

  const rec = {
    order_id:        orderId,
    buyer_name:      buyerName(order.buyer),
    buyer_id:        order.buyer?.id ?? null,
    pack_id:         order.pack_id ?? null,
    shipment_id:     order.shipping?.id ?? null,
    tracking_number: existing?.tracking_number ?? null,
    status:          order.status || 'unknown',
    product:         item.item?.title || 'Producto',
    quantity:        item.quantity || 1,
    amount:          order.total_amount ?? null,
    currency:        order.currency_id || 'CLP',
    shipping_type:   shippingType(shipment),
    fecha:           existing?.fecha || order.date_created || new Date().toISOString(),
    alerted:         existing?.alerted || false,
  }

  const shouldAlert = rec.status === 'paid' && !rec.alerted
  await saveOrder(env, { ...rec, alerted: rec.alerted || shouldAlert })

  if (shouldAlert) {
    const text =
      '🛒 <b>Nueva venta confirmada</b>\n\n' +
      `👤 <b>Comprador:</b> ${rec.buyer_name}\n` +
      `📦 <b>Producto:</b> ${rec.product}${rec.quantity > 1 ? ` (x${rec.quantity})` : ''}\n` +
      `💰 <b>Monto:</b> ${fmtMoney(rec.amount, rec.currency)}\n` +
      `🚚 <b>Envío:</b> ${rec.shipping_type}\n` +
      `🆔 <b>Orden:</b> <code>${rec.order_id}</code>` +
      (rec.pack_id ? ` · Pack: <code>${rec.pack_id}</code>` : '')
    const res = await tgSend(env, env.TELEGRAM_CHAT_ID, text)
    if (res?.ok) log('Alerta enviada para orden', orderId)
    else logErr('No se pudo enviar alerta de orden', orderId, res?.error)
  } else {
    log('Orden', orderId, `guardada (status=${rec.status}, alerted=${rec.alerted})`)
  }
}
