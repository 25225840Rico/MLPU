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
import { firstName } from './ml-history.js'

const ML_API = 'https://api.mercadolibre.com'
const log    = (...a) => console.log('[ML-BOT]', ...a)
const logErr = (...a) => console.error('[ML-BOT]', ...a)

const HOURS_48_MS = 48 * 3600 * 1000

// CTA persuasivo que se envía al comprador apenas el pedido queda ENTREGADO:
// busca convertir al cliente en seguidor de Instagram y que suba una historia
// con su producto (prueba social orgánica). Editá el texto acá si querés.
// Mensaje ≤350 caracteres: la opción FREE_TEXT del Action Guide tiene
// char_limit 350. Sin HTML (esto va a la mensajería de ML, no a Telegram).
function igStoryCta(nombre) {
  return (
    `¡Hola ${nombre}! 🏁 Tu pedido de TopWheels ya llegó 🔥 Esperamos que te encante.\n\n` +
    `¿Nos ayudas con 30 segundos? Síguenos en Instagram @topwheels.cl y sube una historia con tu pieza etiquetándonos 📸\n\n` +
    `Sorteamos modelos entre quienes nos etiquetan. ¡Gracias por elegirnos! 🚗`
  )
}

// Línea de estado del envío al comprador para los avisos de Telegram.
// Distingue éxito, bloqueo por política de ML (cupo de inicio agotado) y error.
function msgStatusLine(res) {
  if (res?.ok) return '✅ Mensaje entregado al comprador.'
  if (res?.need_buyer_reply)
    return '⏸️ ML no deja iniciar otro mensaje (cupo agotado). Queda pendiente hasta que el comprador responda; lo reintento solo.'
  return `⚠️ No se pudo enviar al comprador: ${res?.error || 'error desconocido'}`
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
      // FIX A/B: el flag de "mensaje al comprador" se separa del aviso al
      // vendedor y SOLO se marca cuando el mensaje realmente salió; si ML lo
      // bloquea (cupo OTHER agotado) se reintenta en la próxima corrida y se
      // avisa al vendedor una sola vez. Así no se pierde el mensaje en silencio.
      if (status === 'shipped') {
        // Aviso al vendedor: una sola vez.
        if (!rec.shipped_notified) {
          await tgSend(env, env.TELEGRAM_CHAT_ID,
            `🚚 Orden <code>${rec.order_id}</code> en camino (${rec.buyer_name}).`)
          rec.shipped_notified = true
          await saveOrder(env, rec)
        }
        // Mensaje al comprador: reintentar hasta que ML lo acepte.
        if (!rec.shipped_msg_sent) {
          if (sellerId === null) sellerId = await fetchSellerId(token)
          const fechaEstimada = estimatedDeliveryText(shipment)
          const msgRes = await sendBuyerMessage(env, token, {
            packId:   rec.pack_id || rec.order_id,
            sellerId,
            buyerId:  rec.buyer_id,
            text:     `Tu pedido está en camino 🚚, llegada estimada: ${fechaEstimada}.`,
          })
          rec.shipped_msg_sent = !!msgRes?.ok
          if (msgRes?.ok) {
            rec.shipped_msg_warned = false
            await tgSend(env, env.TELEGRAM_CHAT_ID,
              `📨 Orden <code>${rec.order_id}</code> (en camino): ${msgStatusLine(msgRes)}`)
          } else {
            logErr('sendBuyerMessage (shipped) falló para orden', rec.order_id, msgRes?.error)
            if (!rec.shipped_msg_warned) {
              await tgSend(env, env.TELEGRAM_CHAT_ID,
                `📨 Orden <code>${rec.order_id}</code> (en camino): ${msgStatusLine(msgRes)}`)
              rec.shipped_msg_warned = true
            }
          }
          await saveOrder(env, rec)
        }
      }

      // ── Transición: entregado ──────────────────────────────
      if (status === 'delivered') {
        // 1) Registrar la entrega una sola vez (arranca el reloj de 48 h).
        if (!rec.delivered_at) {
          rec.delivered_at = Date.now()
          rec.delivered_notified = true
          await tgSend(env, env.TELEGRAM_CHAT_ID,
            `📬 Orden <code>${rec.order_id}</code> ENTREGADA (${rec.buyer_name}).`)
          await saveOrder(env, rec)
        }

        // 2) CTA de Instagram al comprador: reintentar hasta que salga.
        if (!rec.ig_cta_sent) {
          if (sellerId === null) sellerId = await fetchSellerId(token)
          const nombreIg = firstName(shipment?.receiver_address?.receiver_name || rec.buyer_name)
          const ctaRes = await sendBuyerMessage(env, token, {
            packId:   rec.pack_id || rec.order_id,
            sellerId,
            buyerId:  rec.buyer_id,
            text:     igStoryCta(nombreIg),
          })
          rec.ig_cta_sent = !!ctaRes?.ok
          if (ctaRes?.ok) {
            rec.ig_cta_warned = false
            await tgSend(env, env.TELEGRAM_CHAT_ID,
              `📸 Orden <code>${rec.order_id}</code> (CTA Instagram): ${msgStatusLine(ctaRes)}`)
          } else {
            logErr('sendBuyerMessage (CTA Instagram) falló para orden', rec.order_id, ctaRes?.error)
            if (!rec.ig_cta_warned) {
              await tgSend(env, env.TELEGRAM_CHAT_ID,
                `📸 Orden <code>${rec.order_id}</code> (CTA Instagram): ${msgStatusLine(ctaRes)}`)
              rec.ig_cta_warned = true
            }
          }
          await saveOrder(env, rec)
        }

        // 3) A las 48 h: feedback (1 intento) + recordatorio de reseña (reintenta).
        if (rec.delivered_at && !rec.feedback_done && (Date.now() - rec.delivered_at) >= HOURS_48_MS) {
          // a) Feedback automático: un solo intento (best-effort, sin cupo).
          if (!rec.feedback_attempted) {
            const fbRes = await sendOrderFeedback(token, rec.order_id)
            rec.feedback_attempted = true
            rec.feedback_ok = !!fbRes.ok
            if (!fbRes.ok) logErr('feedback falló para orden', rec.order_id, fbRes.error)
            await tgSend(env, env.TELEGRAM_CHAT_ID,
              `${fbRes.ok ? '✅' : '⚠️'} Feedback orden <code>${rec.order_id}</code>` +
              (fbRes.ok ? '' : ` (${fbRes.error})`))
            await saveOrder(env, rec)
          }

          // b) Recordatorio de reseña al comprador: reintentar hasta que salga.
          if (!rec.review_msg_sent) {
            if (sellerId === null) sellerId = await fetchSellerId(token)
            const nombre = firstName(shipment?.receiver_address?.receiver_name || rec.buyer_name)
            const recordatorio =
              `Hola ${nombre}, ¡gracias por tu compra! 🙌 Si quedaste conforme, te agradeceríamos un montón ` +
              'tu calificación ⭐ en MercadoLibre: nos ayuda muchísimo a seguir creciendo. ¡Que lo disfrutes! 🚗'
            const msgRes = await sendBuyerMessage(env, token, {
              packId:   rec.pack_id || rec.order_id,
              sellerId,
              buyerId:  rec.buyer_id,
              text:     recordatorio,
            })
            rec.review_msg_sent = !!msgRes?.ok
            if (msgRes?.ok) {
              rec.review_warned = false
              await tgSend(env, env.TELEGRAM_CHAT_ID,
                `⭐ Orden <code>${rec.order_id}</code> (recordatorio reseña): ${msgStatusLine(msgRes)}`)
            } else {
              logErr('sendBuyerMessage (recordatorio) falló para orden', rec.order_id, msgRes?.error)
              if (!rec.review_warned) {
                await tgSend(env, env.TELEGRAM_CHAT_ID,
                  `⭐ Orden <code>${rec.order_id}</code> (recordatorio reseña): ${msgStatusLine(msgRes)}`)
                rec.review_warned = true
              }
            }
            await saveOrder(env, rec)
          }

          // c) Cerrar la orden cuando feedback (intentado) y recordatorio (enviado) estén listos.
          if (rec.feedback_attempted && rec.review_msg_sent) {
            rec.feedback_done = true
            await saveOrder(env, rec)
          }
        }
      }

      processed++
    } catch (e) {
      logErr('Error procesando orden', rec?.order_id, e.message)
    }
  }

  log(`runScheduled: ${processed}/${eligible.length} órdenes elegibles procesadas (de ${orders.length} totales).`)
}
