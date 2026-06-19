/**
 * [ML-CATCHUP] Acción única: procesar las ventas de ESTE MES + el MES PASADO
 * según su estado de envío, enviar el mensaje que corresponda y luego dejar el
 * KV limpio para "empezar de 0" con cada venta nueva.
 *
 * Reglas de mensaje por estado del envío:
 *   - delivered            → reseña ⭐ + seguir IG (deliveredEngagementCta)
 *   - shipped (en camino)  → NADA (ML ya manda ese aviso)
 *   - resto (paid/ready_to_ship/handling/pending/sin envío) → "en preparación"
 *   - cancelled/not_delivered → se saltan
 *
 * Respeta el límite de ML (blocked_by_conversation_initiated_by_seller_limited):
 * los que ML bloquee se cuentan aparte. Al final reporta un resumen por Telegram.
 */
import { getValidAccessToken } from './index.js'
import { getOrdersByDateRange, monthRange, getOrderDetail, firstName } from './ml-history.js'
import { sendBuyerMessage } from './messaging.js'
import { prepCta, deliveredEngagementCta } from './scheduler.js'
import { clearAllOrders } from './orders.js'
import { tgSend } from './telegram-bot.js'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const isBlocked = (res) => res?.need_buyer_reply || /blocked|limited/i.test(res?.error || '')

export async function runCatchup(env) {
  const token    = await getValidAccessToken(env)
  const sellerId = env.SELLER_ID

  // Rango: 1° del mes pasado → fin del mes actual.
  const cur = monthRange()
  const from = new Date(Date.UTC(cur.from.getUTCFullYear(), cur.from.getUTCMonth() - 1, 1, 0, 0, 0))
  const to   = cur.to

  const { orders } = await getOrdersByDateRange(env, from, to)

  const r = { total: orders.length, prep: 0, deliv: 0, skip: 0, blocked: 0, err: 0 }

  for (const o of orders) {
    try {
      const detail = await getOrderDetail(env, o.order_id)   // trae ship_status
      const st     = detail.ship_status
      if (st === 'cancelled' || st === 'not_delivered') { r.skip++; continue }
      if (st === 'shipped') { r.skip++; continue }           // ML ya avisa "en camino"

      const nombre = firstName(detail.buyer_name || o.buyer_name)
      const entregado = st === 'delivered'
      const text = entregado ? deliveredEngagementCta(nombre) : prepCta(nombre)

      const res = await sendBuyerMessage(env, token, {
        packId:  o.pack_id || o.order_id,
        sellerId,
        buyerId: o.buyer_id,
        text,
      })
      if (res?.ok) { entregado ? r.deliv++ : r.prep++ }
      else if (isBlocked(res)) r.blocked++
      else r.err++
    } catch (e) {
      r.err++
    }
    await sleep(150) // suave con el rate limit de ML
  }

  // Dejar todo limpio: empezar de 0 con las ventas nuevas (que entran por notificación).
  const borradas = await clearAllOrders(env)

  await tgSend(env, env.TELEGRAM_CHAT_ID,
    `🔄 <b>Catch-up</b> de ${r.total} ventas (mes actual + anterior):\n` +
    `📦 En preparación enviados: ${r.prep}\n` +
    `⭐ Reseña + IG enviados: ${r.deliv}\n` +
    `⏭️ En camino (ML ya avisa): ${r.skip}\n` +
    `⏸️ Bloqueados por ML (esperan respuesta del comprador): ${r.blocked}\n` +
    `⚠️ Errores: ${r.err}\n\n` +
    `🧹 KV limpiado (${borradas} órdenes). Las ventas nuevas arrancan de 0.`)

  return { ...r, borradas }
}
