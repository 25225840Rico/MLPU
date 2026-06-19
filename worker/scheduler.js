/**
 * [ML-BOT] Seguimiento automático de órdenes — PASO 4.
 *
 * Corre cada 6 h vía el handler `scheduled()` del Worker (ver wrangler.toml).
 * Detecta transiciones de estado de envío (en camino / entregado) y dispara:
 *   - mensaje al comprador (vía messaging.js)
 *   - alerta al vendedor por Telegram
 *   - feedback automático + recordatorio de reseña 48 h después de entregado
 *
 * Idempotente: usa flags persistidos en el rec de la orden (KV ML_ORDERS)
 * para no repetir notificaciones en corridas sucesivas.
 */
import { getValidAccessToken, buildAuthUrl } from './index.js'
import { listOrders, saveOrder } from './orders.js'
import { tgSend } from './telegram-bot.js'
import { sendBuyerMessage } from './messaging.js'

const ML_API = 'https://api.mercadolibre.com'
const log    = (...a) => console.log('[ML-BOT]', ...a)
const logErr = (...a) => console.error('[ML-BOT]', ...a)

const HOURS_48_MS = 48 * 3600 * 1000

// CTA persuasivo que se envía al comprador apenas el pedido queda ENTREGADO:
// busca convertir al cliente en seguidor de Instagram y que suba una historia
// con su producto (prueba social orgánica). Editá el texto acá si querés.
function igStoryCta(nombre) {
  return (
    `¡Hola ${nombre}! 🏁 Tu pedido de <b>TopWheels</b> ya llegó 🔥 Esperamos que te encante.\n\n` +
    `¿Nos das una mano de 30 segundos? 🙌\n` +
    `1️⃣ Síguenos en Instagram 👉 @topwheels.cl\n` +
    `2️⃣ Sube una historia mostrando tu nueva pieza y etiquétanos @topwheels.cl 📸\n\n` +
    `🏆 Reposteamos las mejores historias y entre quienes nos etiquetan sorteamos modelos todos los meses. ` +
    `¡Súmate a la comunidad de coleccionistas y muestra tu colección! 🚗💨 Gracias por elegirnos.`
  )
}

// ── Helpers ───────────────────────────────────────────────────

// Trae el shipment desde ML. Devuelve null si falla (no lanza).
async function fetchShipment(token, shipmentId) {
  try {
    const r = await fetch(`${ML_API}/shipments/${shipmentId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!r.ok) {
      logErr(`GET /shipments/${shipmentId} HTTP ${r.status}`)
      return null
    }
    return await r.json()
  } catch (e) {
    logErr(`excepción GET /shipments/${shipmentId}:`, e.message)
    return null
  }
}

// Fecha estimada de entrega: prueba varios campos posibles del shipment.
function estimatedDeliveryText(shipment) {
  const date =
    shipment?.shipping_option?.estimated_delivery_time?.date ||
    shipment?.status_history?.date_delivered
  return date || 'pronto'
}

// Trae el id del vendedor autenticado (se cachea una vez por corrida).
async function fetchSellerId(token) {
  try {
    const r = await fetch(`${ML_API}/users/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!r.ok) {
      logErr(`GET /users/me HTTP ${r.status}`)
      return null
    }
    const data = await r.json()
    return data.id ?? null
  } catch (e) {
    logErr('excepción GET /users/me:', e.message)
    return null
  }
}

// Envía el feedback automático de la orden. Best-effort: no lanza.
async function sendOrderFeedback(token, orderId) {
  try {
    const r = await fetch(`${ML_API}/orders/${orderId}/feedback`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fulfilled: true,
        rating: 'positive',
        message: 'Gracias por tu compra',
      }),
    })
    if (!r.ok) {
      const txt = await r.text().catch(() => '')
      return { ok: false, error: `HTTP ${r.status} ${txt}`.trim() }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// ── Punto de entrada (handler scheduled()) ──────────────────────
export async function runScheduled(env) {
  let token
  try {
    token = await getValidAccessToken(env)
  } catch (e) {
    logErr('No se pudo obtener token ML:', e.message)
    // Token caído / refresh fallido: avisar con la URL de re-autorización lista
    // para tocar. El usuario abre el link, copia el code y lo pega en el bot
    // (el bot lo canjea solo). Así no depende de la terminal ni de nadie.
    await tgSend(env, env.TELEGRAM_CHAT_ID,
      `🔑 <b>Se cortó la conexión con MercadoLibre</b>\n` +
      `No pude renovar el token: ${e.message}\n\n` +
      `<b>Reconectá en 2 pasos:</b>\n` +
      `1) Abrí este enlace y aceptá:\n${buildAuthUrl(env)}\n` +
      `2) Copiá el <code>code</code> que aparece en la página y pegámelo acá (o mandá <code>/reauth &lt;code&gt;</code>).`,
      { disable_web_page_preview: true })
    return
  }

  let orders
  try {
    orders = await listOrders(env, 200)
  } catch (e) {
    logErr('No se pudo listar órdenes:', e.message)
    return
  }

  const eligible = orders.filter(rec =>
    rec?.tracking_number && rec?.shipment_id && !rec.feedback_done)

  let sellerId = null // se resuelve perezosamente, una sola vez
  let processed = 0

  for (const rec of eligible) {
    try {
      const shipment = await fetchShipment(token, rec.shipment_id)
      if (!shipment) continue // ya logueado en fetchShipment

      const status = shipment.status

      // ── Transición: en camino ──────────────────────────────
      if (status === 'shipped' && !rec.shipped_notified) {
        if (sellerId === null) sellerId = await fetchSellerId(token)
        const fechaEstimada = estimatedDeliveryText(shipment)

        const msgRes = await sendBuyerMessage(env, token, {
          packId:   rec.pack_id || rec.order_id,
          sellerId,
          buyerId:  rec.buyer_id,
          text:     `Tu pedido está en camino 🚚, llegada estimada: ${fechaEstimada}.`,
        })
        if (!msgRes?.ok) logErr('sendBuyerMessage (shipped) falló para orden', rec.order_id, msgRes?.error)

        await tgSend(env, env.TELEGRAM_CHAT_ID,
          `🚚 Orden <code>${rec.order_id}</code> en camino (${rec.buyer_name}).`)

        rec.shipped_notified = true
        await saveOrder(env, rec)
      }

      // ── Transición: entregado ──────────────────────────────
      if (status === 'delivered') {
        if (!rec.delivered_at) {
          rec.delivered_at = Date.now()
          rec.delivered_notified = true

          // Mensaje persuasivo al comprador: seguir en Instagram + subir historia
          // con el producto (prueba social orgánica). Se manda 1 sola vez.
          if (sellerId === null) sellerId = await fetchSellerId(token)
          const nombreIg = (rec.buyer_name || 'cliente').split(' ')[0]
          const ctaRes = await sendBuyerMessage(env, token, {
            packId:   rec.pack_id || rec.order_id,
            sellerId,
            buyerId:  rec.buyer_id,
            text:     igStoryCta(nombreIg),
          })
          if (!ctaRes?.ok) logErr('sendBuyerMessage (CTA Instagram) falló para orden', rec.order_id, ctaRes?.error)
          rec.ig_cta_sent = !!ctaRes?.ok

          await tgSend(env, env.TELEGRAM_CHAT_ID,
            `📬 Orden <code>${rec.order_id}</code> ENTREGADA (${rec.buyer_name}).\n` +
            `${ctaRes?.ok ? '✅' : '⚠️'} CTA de Instagram enviado al cliente. Recordatorio de reseña en 48 h.`)
          await saveOrder(env, rec)
        } else if (!rec.feedback_done && (Date.now() - rec.delivered_at) >= HOURS_48_MS) {
          // a) Feedback automático (best-effort).
          const fbRes = await sendOrderFeedback(token, rec.order_id)
          if (!fbRes.ok) logErr('feedback falló para orden', rec.order_id, fbRes.error)

          // b) Recordatorio de reseña al comprador.
          if (sellerId === null) sellerId = await fetchSellerId(token)
          const nombre = (rec.buyer_name || 'cliente').split(' ')[0]
          const recordatorio =
            `Hola ${nombre}, ¡gracias por tu compra! 🙌 Si quedaste conforme, te agradeceríamos un montón ` +
            'tu calificación ⭐ en MercadoLibre: nos ayuda muchísimo a seguir creciendo. ¡Que lo disfrutes! 🚗'

          const msgRes = await sendBuyerMessage(env, token, {
            packId:   rec.pack_id || rec.order_id,
            sellerId,
            buyerId:  rec.buyer_id,
            text:     recordatorio,
          })
          if (!msgRes?.ok) logErr('sendBuyerMessage (recordatorio) falló para orden', rec.order_id, msgRes?.error)

          // c) Reporte al vendedor.
          await tgSend(env, env.TELEGRAM_CHAT_ID,
            `${fbRes.ok ? '✅' : '⚠️'} Feedback orden <code>${rec.order_id}</code>` +
            (fbRes.ok ? '' : ` (${fbRes.error})`) + '\n' +
            `${msgRes?.ok ? '✅' : '⚠️'} Recordatorio de reseña enviado (${rec.buyer_name}).`)

          // d) Marcar como finalizada.
          rec.feedback_done = true
          await saveOrder(env, rec)
        }
      }

      processed++
    } catch (e) {
      logErr('Error procesando orden', rec?.order_id, e.message)
    }
  }

  log(`runScheduled: ${processed}/${eligible.length} órdenes elegibles procesadas (de ${orders.length} totales).`)
}
