/**
 * [ML-BOT] Bot de Telegram para MLPU — corre DENTRO del Worker mlpu-proxy.
 *
 * Recibe updates de Telegram por WEBHOOK (no polling) en POST /tg/webhook.
 * Reusa el token de ML que ya vive en KV (ML_TOKENS) para llamadas futuras a ML.
 *
 * Secrets del Worker (NO van en .env; ver instrucciones del Paso 1):
 *   - TELEGRAM_BOT_TOKEN : token del bot (de @BotFather)
 *   - TELEGRAM_CHAT_ID   : tu chat id personal (se usa desde el Paso 2)
 */

import { extractTrackingFromImage, findPendingMatches, clearMatch, assignTracking } from './tracking.js'
import { sendBuyerEvidence } from './messaging.js'
import { listOrders, getOrder } from './orders.js'
import {
  getOrderHistory, getOrdersByDateRange, searchOrderByBuyer,
  getOrderDetail, todayRange, monthRange, attachReceiverNames, firstName,
} from './ml-history.js'
import { sendMessageToBuyer, getConversation, TEMPLATES, TEMPLATE_LABELS } from './ml-messaging.js'
import { exchangeAuthCode, buildAuthUrl, getValidAccessToken } from './index.js'
import {
  analyzeProduct, clusterPhotos, discoverCategories, getRequiredAttrs, fillAttributesWithAI,
  getMarketPrices, uploadPicture, createListing, cleanTitle, roundTo990, estimateProfit,
} from './publisher.js'

const TG_API = 'https://api.telegram.org'
const log    = (...a) => console.log('[ML-BOT]', ...a)
const logErr = (...a) => console.error('[ML-BOT]', ...a)

// ── Telegram API helper (con manejo de errores) ──────────────
export async function tgApi(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    logErr('Falta secret TELEGRAM_BOT_TOKEN')
    throw new Error('TELEGRAM_BOT_TOKEN no configurado en el Worker')
  }
  try {
    const r = await fetch(`${TG_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await r.json()
    if (!data.ok) {
      logErr(`${method} falló:`, data.description || r.status)
      return { ok: false, error: data.description || `HTTP ${r.status}` }
    }
    return data
  } catch (e) {
    logErr(`${method} excepción:`, e.message)
    return { ok: false, error: e.message }
  }
}

export const tgSend = (env, chatId, text, extra = {}) =>
  tgApi(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra })

// Botonera persistente (reply keyboard) con las acciones principales.
const MAIN_KB = {
  keyboard: [
    [{ text: '📸 Catalogar' }, { text: '📦 Despacho' }],
    [{ text: '🧾 Órdenes' }, { text: '📋 Historial' }],
    [{ text: '💬 Mensajes' }, { text: 'ℹ️ Ayuda' }],
    [{ text: '🧹 Limpiar' }],
  ],
  resize_keyboard: true,
}
const isButtonLabel = (t) =>
  ['📸 Catalogar', '📦 Despacho', '📋 Historial', '💬 Mensajes', '🧾 Órdenes', '📭 Pendientes', 'ℹ️ Ayuda', '🧹 Limpiar'].includes(t)

// ── Webhook receiver ─────────────────────────────────────────
export async function handleTelegramWebhook(request, env, ctx) {
  // La URL del webhook es pública: antes de tocar KV o procesar nada se
  // verifica que el POST venga de Telegram, vía el secret del webhook
  // (setWebhook con secret_token; Telegram lo repite en este header en cada
  // update). Sin esto, cualquiera podría envenenar el dedupe por update_id
  // o generar escrituras KV. Si el secret no está configurado se mantiene
  // el comportamiento anterior (solo control de acceso por chat).
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || ''
    if (got !== env.TELEGRAM_WEBHOOK_SECRET) {
      logErr('Webhook con secret inválido — descartado')
      return new Response('unauthorized', { status: 401 })
    }
  }

  let update
  try {
    update = await request.json()
  } catch {
    logErr('Update con JSON inválido')
    return new Response('ok') // 200 siempre: evita reintentos en bucle de Telegram
  }

  // Si Telegram reintenta un update (p.ej. porque un análisis de varios
  // productos superó su timeout de ~60 s), no se reprocesa: quedaría todo
  // duplicado (dobles análisis, dobles publicaciones).
  if (update.update_id != null) {
    const dedupeKey = `upd:${update.update_id}`
    if (await env.ML_ORDERS.get(dedupeKey)) return new Response('ok')
    await env.ML_ORDERS.put(dedupeKey, '1', { expirationTtl: 600 })
  }

  const work = (async () => {
    try {
      const msg = update.message || update.edited_message
      const chatId = update.callback_query?.message?.chat?.id ?? msg?.chat?.id
      if (chatId != null && !(await isAllowed(env, chatId))) {
        return requestAccess(env, chatId, msg?.from || update.callback_query?.from)
      }
      if (update.callback_query)   await handleCallback(env, update.callback_query)
      else if (msg?.photo?.length) await handlePhoto(env, msg)
      else if (msg?.text)          await handleTextCommand(env, msg)
    } catch (e) {
      logErr('Error procesando update:', e.message)
    }
  })()
  // Se espera el trabajo antes del 200 (con solo ctx.waitUntil las respuestas
  // no llegaban), pero ADEMÁS se registra en waitUntil: si Telegram corta la
  // conexión a los ~60 s (análisis de varios productos), el Worker sigue vivo
  // hasta terminar y las previews igual salen. El dedupe por update_id de
  // arriba evita que el reintento de Telegram duplique el proceso.
  if (ctx?.waitUntil) ctx.waitUntil(work.catch(() => {}))
  await work

  return new Response('ok')
}

// ── Control de acceso: admin (TELEGRAM_CHAT_ID) + operadores aprobados ──
// Los operadores (p.ej. la esposa) publican en LA MISMA cuenta de ML del admin.
const ALLOWED_KEY = 'chats:allowed'
async function getAllowedChats(env) {
  try { return JSON.parse(await env.ML_ORDERS.get(ALLOWED_KEY)) || [] } catch { return [] }
}
async function isAllowed(env, chatId) {
  if (String(chatId) === String(env.TELEGRAM_CHAT_ID)) return true
  return (await getAllowedChats(env)).includes(String(chatId))
}
async function requestAccess(env, chatId, from) {
  const who = [from?.first_name, from?.last_name].filter(Boolean).join(' ') ||
              from?.username || String(chatId)
  await tgSend(env, chatId, '🔒 Este bot es privado. Le avisé al administrador; si te aprueba, podrás usarlo.')
  await tgSend(env, env.TELEGRAM_CHAT_ID,
    `🔑 <b>${esc(who)}</b> (chat <code>${chatId}</code>) quiere usar el bot.`,
    { reply_markup: { inline_keyboard: [[
      { text: '✅ Aprobar', callback_data: `acc:ok:${chatId}` },
      { text: '❌ Rechazar', callback_data: `acc:no:${chatId}` },
    ]] } })
}
async function approveChat(env, adminChat, targetId, ok) {
  if (String(adminChat) !== String(env.TELEGRAM_CHAT_ID))
    return tgSend(env, adminChat, 'Solo el administrador puede aprobar accesos.')
  if (ok) {
    const list = await getAllowedChats(env)
    if (!list.includes(String(targetId))) list.push(String(targetId))
    await env.ML_ORDERS.put(ALLOWED_KEY, JSON.stringify(list))
    await tgSend(env, targetId, '✅ Acceso aprobado. Mandá fotos de un producto para catalogarlo y publicarlo. 📸')
    return tgSend(env, adminChat, `✅ Chat <code>${targetId}</code> aprobado.`)
  }
  await tgSend(env, targetId, '❌ El administrador rechazó tu solicitud.')
  return tgSend(env, adminChat, `Chat <code>${targetId}</code> rechazado.`)
}

function esc(t) {
  return String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function handleTextCommand(env, msg) {
  const chatId = msg.chat.id
  const text   = (msg.text || '').trim()
  log(`msg de chat ${chatId}: ${text.slice(0, 40)}`)

  // Re-autorización de ML desde el propio chat: /reauth <code> o pegar el code
  // TG-... que devuelve la página de autorización. Se canjea solo (sin terminal).
  if (text.startsWith('/reauth')) return runReauth(env, chatId, text.slice(7).trim())
  if (/^TG-[a-z0-9]+-\d+$/i.test(text)) return runReauth(env, chatId, text)

  // Si estamos esperando el texto de un mensaje al comprador (botón 💬).
  const pend0 = await getPending(env, chatId)
  if (pend0?.mode === 'await_message' && text && !text.startsWith('/') && !isButtonLabel(text)) {
    await clearPending(env, chatId)
    return sendBuyerMessageManual(env, chatId, pend0.order_id, text)
  }
  // Esperando el texto de búsqueda de cliente (botón 🔍 Buscar del historial).
  if (pend0?.mode === 'await_search' && text && !text.startsWith('/') && !isButtonLabel(text)) {
    await clearPending(env, chatId)
    return runMlSearch(env, chatId, text)
  }
  // Esperando el N° de orden para Mensajes (directo / conversación / plantilla).
  if (pend0?.mode === 'await_msg_order' && text && !text.startsWith('/') && !isButtonLabel(text)) {
    await setPending(env, chatId, { mode: 'await_message', order_id: text.trim() })
    return tgSend(env, chatId, `✍️ Escribe el texto del mensaje para el comprador de la orden <code>${text.trim()}</code>:`)
  }
  if (pend0?.mode === 'await_conv_order' && text && !text.startsWith('/') && !isButtonLabel(text)) {
    await clearPending(env, chatId)
    return runShowConversation(env, chatId, text.trim())
  }
  if (pend0?.mode === 'await_tmpl_order' && text && !text.startsWith('/') && !isButtonLabel(text)) {
    return previewTemplate(env, chatId, pend0.tmpl, text.trim())
  }

  // Catalogado: edición de precio / título / cantidad del lote apuntado por
  // el pending (el borrador vive por-lote en lotd:<chat>:<lote>).
  if (['cat_price', 'cat_title', 'cat_qty'].includes(pend0?.mode) && text && !text.startsWith('/') && !isButtonLabel(text)) {
    const lotId = pend0.lotId
    const p = await getLotDraft(env, chatId, lotId)
    if (!p?.draft) {
      await clearPending(env, chatId)
      return tgSend(env, chatId, 'Ese borrador ya no existe (se publicó, descartó o expiró).', { reply_markup: MAIN_KB })
    }
    if (pend0.mode === 'cat_price') {
      const raw = Math.round(Number(text.replace(/[.$\s]/g, '').replace(',', '.')))
      if (!raw || raw < 1) return tgSend(env, chatId, '❌ Precio inválido. Mandá solo el número, ej: <code>12990</code>')
      const price = roundTo990(raw)
      if (price !== raw) await tgSend(env, chatId, `ℹ️ Precio ajustado a terminación 990: <b>${fmtMoney(price, 'CLP')}</b>`)
      p.draft.price = price
    } else if (pend0.mode === 'cat_title') {
      p.draft.title = cleanTitle(text)
    } else {
      const qty = Math.round(Number(text.replace(/[.\s]/g, '')))
      if (!qty || qty < 1 || qty > 9999) return tgSend(env, chatId, '❌ Cantidad inválida. Mandá solo el número, ej: <code>3</code>')
      p.draft.qty = qty
    }
    await setLotDraft(env, chatId, lotId, p)
    await clearPending(env, chatId)
    return sendCatalogPreview(env, chatId, lotId, p.draft)
  }

  // Botonera (reply keyboard) ↔ mismas acciones que los comandos.
  if (text === 'ℹ️ Ayuda' || text === '/start' || text.startsWith('/start@')) return sendStart(env, chatId)
  if (text === '📸 Catalogar') {
    await clearPending(env, chatId)
    await bumpLotGen(env, chatId)
    return tgSend(env, chatId,
      '📸 Mandá las fotos de los productos — pueden ser <b>varios productos ' +
      'mezclados</b>.\n\n🔀 Cuando estén todas, tocá <b>Analizar</b> (una sola ' +
      'vez): la IA separa los productos y te manda una vista previa de cada ' +
      'uno para publicarlos por separado.',
      { reply_markup: MAIN_KB })
  }
  if (text === '📦 Despacho') {
    await setPending(env, chatId, { mode: 'await_sticker' })
    return tgSend(env, chatId, '📦 Mandá la foto del sticker de envío para asignar el tracking.', { reply_markup: MAIN_KB })
  }
  if (text === '🧾 Órdenes')   return sendOrdersList(env, chatId)
  if (text === '📭 Pendientes') return sendPendingList(env, chatId)
  if (text === '📋 Historial')  return sendHistoryMenu(env, chatId)
  if (text === '💬 Mensajes')   return sendMessagesMenu(env, chatId)
  if (text === '🧹 Limpiar')    return clearChat(env, chatId, msg.message_id)
  if (text === '/historial')    return sendMlLast(env, chatId, 0)
  if (text.startsWith('/buscar ')) return runMlSearch(env, chatId, text.slice(8).trim())

  if (text === '/si' || text === '/sí')  return doConfirmYes(env, chatId)
  if (text === '/no')                     return doConfirmNo(env, chatId)
  if (text === '/listo')                  return doFinalize(env, chatId)

  if (text.startsWith('/asignar')) {
    const orderId = text.split(/\s+/)[1]
    if (!orderId) return tgSend(env, chatId, 'Uso: <code>/asignar &lt;order_id&gt;</code>')
    const p = await getPending(env, chatId)
    if (!p?.tracking_number) return tgSend(env, chatId, 'No hay tracking pendiente. Mandá primero la foto del sticker.')
    return doAssign(env, chatId, orderId, p.tracking_number)
  }

  if (text === '/ordenes')    return sendOrdersList(env, chatId)
  if (text === '/pendientes') return sendPendingList(env, chatId)
  if (text.startsWith('/orden ')) return sendOrderDetail(env, chatId, text.slice('/orden '.length).trim().split(/\s+/)[0])

  if (text.startsWith('/mensaje ')) {
    const rest = text.slice('/mensaje '.length).trim()
    const sp = rest.indexOf(' ')
    if (sp < 1) return tgSend(env, chatId, 'Uso: <code>/mensaje &lt;order_id&gt; &lt;texto&gt;</code>')
    return sendBuyerMessageManual(env, chatId, rest.slice(0, sp), rest.slice(sp + 1).trim())
  }

  await tgSend(env, chatId, 'No reconozco eso. Usá los botones de abajo o /start.', { reply_markup: MAIN_KB })
}

// ── Limpiar el chat ───────────────────────────────────────────
// Telegram no expone un "borrar todo": se borra por rango de message_id hacia
// atrás desde el mensaje actual. `deleteMessages` falla COMPLETO si un solo id
// del lote no se puede borrar (> 48 h, etc.), así que se borra en lotes chicos
// y, si un lote falla, se cae a borrar ese lote uno por uno. Todo bajo un
// presupuesto de llamadas para no agotar los subrequests del Worker (~50).
async function clearChat(env, chatId, fromMessageId) {
  const upto = Number(fromMessageId) || 0
  if (!upto) return tgSend(env, chatId, '🧹 No pude limpiar (sin referencia de mensaje).', { reply_markup: MAIN_KB })

  const ids = []
  for (let id = upto; id > Math.max(0, upto - 100); id--) ids.push(id)

  let budget = 40 // llamadas a la API de Telegram como máximo (deja margen para el mensaje final)
  for (let i = 0; i < ids.length && budget > 0; i += 25) {
    const chunk = ids.slice(i, i + 25)
    budget--
    const bulk = await tgApi(env, 'deleteMessages', { chat_id: chatId, message_ids: chunk })
    if (bulk?.ok) continue
    for (const id of chunk) {
      if (budget-- <= 0) break
      await tgApi(env, 'deleteMessage', { chat_id: chatId, message_id: id })
    }
  }
  return tgSend(env, chatId, '🧹 Chat limpiado.', { reply_markup: MAIN_KB })
}

// ── Botonera + acciones (reutilizadas por comandos y botones inline) ──
async function sendStart(env, chatId) {
  await tgSend(env, chatId,
    '✅ <b>Bot MLPU operativo.</b>\n\n' +
    '📸 <b>Catalogar</b> (lo principal): mandá fotos, tocá <b>Analizar</b> y ' +
    'la IA arma título, precio, categoría y descripción. Revisás, ajustás con ' +
    'los botones y <b>Publicar</b>. Envío a cargo del comprador y stock 1 por defecto.\n' +
    '🔀 <b>Por lotes</b>: mandá fotos de varios productos mezclados; la IA ' +
    'las agrupa por producto y cada uno se analiza y publica por separado.\n\n' +
    '📦 Despacho — foto del sticker para asignar tracking.\n' +
    '🧾 Órdenes · 📋 Historial — ventas reales de ML.\n' +
    '💬 Mensajes — directo, conversación y plantillas.\n\n' +
    '🔑 Si se corta la conexión con ML, te aviso por acá y reconectás pegando el código.',
    { reply_markup: MAIN_KB })
}

async function sendHistory(env, chatId, page = 0) {
  const all = await listOrders(env, 1000)
  if (!all.length) return tgSend(env, chatId, 'Tu historial está vacío todavía.', { reply_markup: MAIN_KB })
  const PAGE = 8
  const pages = Math.ceil(all.length / PAGE)
  page = Math.max(0, Math.min(page, pages - 1))
  const slice = all.slice(page * PAGE, page * PAGE + PAGE)

  const totalCLP = all
    .filter(o => (o.currency || 'CLP') === 'CLP')
    .reduce((s, o) => s + (Number(o.amount) || 0), 0)

  const lines = slice.map(o => {
    const fecha = (o.fecha || '').slice(0, 10)
    return `• <code>${o.order_id}</code> · ${fecha} · ${statusEs(o.status)}\n` +
           `   ${o.buyer_name} · ${o.product} · ${fmtMoney(o.amount, o.currency)}`
  })

  const nav = []
  if (page > 0)          nav.push({ text: '◀ Anterior',  callback_data: `hist:${page - 1}` })
  if (page < pages - 1)  nav.push({ text: 'Siguiente ▶', callback_data: `hist:${page + 1}` })
  const kb = slice.map(o => [{ text: `🔎 ${o.order_id} · ${o.buyer_name}`, callback_data: `ver:${o.order_id}` }])
  if (nav.length) kb.push(nav)

  await tgSend(env, chatId,
    `📚 <b>Historial de ventas</b> — ${all.length} en total · ${fmtMoney(totalCLP, 'CLP')}\n` +
    `Página ${page + 1}/${pages}\n\n${lines.join('\n')}`,
    { reply_markup: { inline_keyboard: kb } })
}

// Lista de pendientes para elegir a qué orden asignar el tracking leído.
async function sendPendingChoice(env, chatId, pending, data) {
  const slice = pending.slice(0, 10)
  const lines = slice.map((o, i) => `${i + 1}. <code>${o.order_id}</code> — ${o.buyer_name} — ${o.product}`)
  await tgSend(env, chatId,
    `📦 Tracking: <code>${data.tracking_number}</code>\n` +
    `👤 Destinatario leído: ${data.recipient_name || '—'}\n\n` +
    `No encontré una coincidencia clara. Elegí la orden:\n${lines.join('\n')}`,
    { reply_markup: { inline_keyboard: slice.map(o => [{ text: `🏷 ${o.order_id} · ${o.buyer_name}`, callback_data: `asg:${o.order_id}` }]) } })
}

// Acciones del flujo de despacho (reutilizadas por comandos y botones inline).
async function doConfirmYes(env, chatId) {
  const p = await getPending(env, chatId)
  if (!p?.tracking_number) return tgSend(env, chatId, 'No hay nada pendiente de confirmar. Mandá la foto del sticker.')
  if (!p.order_id) return tgSend(env, chatId, 'Elegí la orden de la lista.')
  return doAssign(env, chatId, p.order_id, p.tracking_number)
}
async function doConfirmNo(env, chatId) {
  const p = await getPending(env, chatId)
  if (!p?.tracking_number) return tgSend(env, chatId, 'Ok. Mandá la foto del sticker cuando quieras.')
  const { pending } = await findPendingMatches(env, p.recipient_name || '')
  await setPending(env, chatId, { tracking_number: p.tracking_number, recipient_name: p.recipient_name })
  return sendPendingChoice(env, chatId, pending, p)
}
async function doFinalize(env, chatId) {
  const p = await getPending(env, chatId)
  if (p?.mode !== 'collect_evidence') return tgSend(env, chatId, 'No hay un envío en curso. Mandá la foto del sticker para empezar.')
  return finalizeEvidence(env, chatId, p)
}

async function sendOrdersList(env, chatId) {
  const orders = await listOrders(env, 10)
  if (!orders.length) return tgSend(env, chatId, 'No hay órdenes registradas todavía.', { reply_markup: MAIN_KB })
  const lines = orders.map(o =>
    `• <code>${o.order_id}</code> — ${statusEs(o.status)}\n   ${o.buyer_name} · ${o.product}` +
    (o.tracking_number ? `\n   🔖 ${o.tracking_number}` : ''))
  await tgSend(env, chatId, `🧾 <b>Últimas ${orders.length} órdenes</b>\n\n${lines.join('\n')}`, {
    reply_markup: { inline_keyboard: orders.map(o => [{ text: `🔎 ${o.order_id} · ${o.buyer_name}`, callback_data: `ver:${o.order_id}` }]) },
  })
}

async function sendPendingList(env, chatId) {
  const pend = (await listOrders(env, 200)).filter(o => !o.tracking_number)
  if (!pend.length) return tgSend(env, chatId, '✅ No hay órdenes pendientes de tracking.', { reply_markup: MAIN_KB })
  const slice = pend.slice(0, 20)
  const lines = slice.map(o => `• <code>${o.order_id}</code> — ${o.buyer_name} · ${o.product}`)
  await tgSend(env, chatId, `📭 <b>Pendientes de tracking (${pend.length})</b>\n\n${lines.join('\n')}\n\n📸 Mandá la foto del sticker para asignar.`, {
    reply_markup: { inline_keyboard: slice.map(o => [{ text: `🔎 ${o.order_id} · ${o.buyer_name}`, callback_data: `ver:${o.order_id}` }]) },
  })
}

async function sendOrderDetail(env, chatId, id) {
  const o = await getOrder(env, id)
  if (!o) return tgSend(env, chatId, `No encontré la orden <code>${id}</code>.`, { reply_markup: MAIN_KB })
  const body = [
    `🧾 <b>Orden</b> <code>${o.order_id}</code>`,
    `Estado: ${statusEs(o.status)}`,
    `👤 ${o.buyer_name}`,
    `📦 ${o.product}${o.quantity > 1 ? ` (x${o.quantity})` : ''}`,
    `💰 ${fmtMoney(o.amount, o.currency)}`,
    `🚚 ${o.shipping_type || '—'}`,
    `🔖 Tracking: ${o.tracking_number ? `<code>${o.tracking_number}</code>` : '— (pendiente)'}`,
    o.pack_id ? `Pack: <code>${o.pack_id}</code>` : null,
    `🕒 ${o.fecha || '—'}`,
  ].filter(Boolean).join('\n')
  await tgSend(env, chatId, body, {
    reply_markup: { inline_keyboard: [
      [{ text: '💬 Mensajear comprador', callback_data: `msg:${o.order_id}` }],
      [{ text: '🧾 Órdenes', callback_data: 'ord' }, { text: '📭 Pendientes', callback_data: 'pend' }],
    ] },
  })
}

async function sendBuyerMessageManual(env, chatId, orderId, body) {
  if (!body) return tgSend(env, chatId, 'Falta el texto del mensaje.')
  await tgSend(env, chatId, `📨 Enviando mensaje al comprador de la orden <code>${orderId}</code>…`)
  let ev
  try {
    ev = await sendBuyerEvidence(env, orderId, { text: body, photos: [] })
  } catch (e) {
    return tgSend(env, chatId, `❌ ${e.message}`)
  }
  await tgSend(env, chatId, ev.msgOk ? '✅ Mensaje enviado al comprador.' : `⚠️ No se envió: ${ev.msgErr}`)
}

// ── Botones inline (callback_query) ──────────────────────────
async function handleCallback(env, cq) {
  const chatId = cq.message?.chat?.id
  const data = cq.data || ''
  try { await tgApi(env, 'answerCallbackQuery', { callback_query_id: cq.id }) } catch {}
  if (!chatId) return
  if (data === 'ord')  return sendOrdersList(env, chatId)
  if (data === 'pend') return sendPendingList(env, chatId)
  if (data === 'si')   return doConfirmYes(env, chatId)
  if (data === 'no')   return doConfirmNo(env, chatId)
  if (data === 'fin')  return doFinalize(env, chatId)
  if (data.startsWith('hist:')) return sendHistory(env, chatId, parseInt(data.slice(5), 10) || 0)
  // ── Módulo 1: historial real desde ML ──
  if (data === 'hmenu')          return sendHistoryMenu(env, chatId)
  if (data === 'hsearch')        return sendMlSearchPrompt(env, chatId)
  if (data === 'hday')           return sendMlRange(env, chatId, 'today')
  if (data === 'hmonth')         return sendMlRange(env, chatId, 'month')
  if (data.startsWith('hlast:')) return sendMlLast(env, chatId, parseInt(data.slice(6), 10) || 0)
  if (data.startsWith('vord:'))  return sendMlDetail(env, chatId, data.slice(5))
  if (data.startsWith('ship:'))  return sendShipment(env, chatId, data.slice(5))
  // ── Módulo 2: mensajería directa ──
  if (data === 'mmenu')          return sendMessagesMenu(env, chatId)
  if (data === 'mdirect')        return askMsgOrder(env, chatId, 'direct')
  if (data === 'mconv')          return askMsgOrder(env, chatId, 'conv')
  if (data === 'mtmpl')          return sendTemplatesMenu(env, chatId)
  if (data.startsWith('tmpl:'))  return askTemplateOrder(env, chatId, data.slice(5))
  if (data === 'tsend')          return sendTemplateConfirmed(env, chatId)
  if (data === 'tcancel')      { await clearPending(env, chatId); return tgSend(env, chatId, 'Cancelado.', { reply_markup: MAIN_KB }) }
  if (data.startsWith('ver:'))  return sendOrderDetail(env, chatId, data.slice(4))
  if (data.startsWith('asg:')) {
    const id = data.slice(4)
    const p = await getPending(env, chatId)
    if (!p?.tracking_number) return tgSend(env, chatId, 'No hay tracking pendiente. Mandá primero la foto del sticker.')
    return doAssign(env, chatId, id, p.tracking_number)
  }
  if (data.startsWith('msg:')) {
    const id = data.slice(4)
    await setPending(env, chatId, { mode: 'await_message', order_id: id })
    return tgSend(env, chatId, `✍️ Escribí el texto del mensaje para el comprador de la orden <code>${id}</code>:`)
  }
  // ── Módulo 3: catalogado y publicación por lotes ──
  if (data.startsWith('acc:')) {
    const [, verdict, target] = data.split(':')
    return approveChat(env, chatId, target, verdict === 'ok')
  }
  if (data === 'cat:new') { // botón legado: cierra el lote abierto
    await bumpLotGen(env, chatId)
    return tgSend(env, chatId, '🆕 Listo: las próximas fotos arrancan una tanda nueva.')
  }
  if (data.startsWith('cat:go:'))    return runCatalogAnalyze(env, chatId, data.slice(7))
  if (data.startsWith('cat:pub:'))   return runCatalogPublish(env, chatId, data.slice(8))
  if (data.startsWith('cat:x:')) {
    const lotId = data.slice(6)
    await deleteLot(env, chatId, lotId)
    return tgSend(env, chatId, `🗑 Lote ${lotLabel(lotId)} descartado.`, { reply_markup: MAIN_KB })
  }
  if (data === 'cat:x') { await clearPending(env, chatId); return tgSend(env, chatId, '🗑 Catalogado cancelado.', { reply_markup: MAIN_KB }) }
  if (data.startsWith('cat:price:')) {
    const lotId = data.slice(10)
    if (!(await getLotDraft(env, chatId, lotId))) return tgSend(env, chatId, 'Ese borrador ya no existe.')
    await setPending(env, chatId, { mode: 'cat_price', lotId })
    return tgSend(env, chatId, `💲 Lote ${lotLabel(lotId)}: mandá el precio nuevo en CLP (solo número, ej: <code>12990</code>):`)
  }
  if (data.startsWith('cat:qty:')) {
    const lotId = data.slice(8)
    if (!(await getLotDraft(env, chatId, lotId))) return tgSend(env, chatId, 'Ese borrador ya no existe.')
    await setPending(env, chatId, { mode: 'cat_qty', lotId })
    return tgSend(env, chatId, `🔢 Lote ${lotLabel(lotId)}: mandá la cantidad de unidades (solo número, ej: <code>3</code>):`)
  }
  if (data.startsWith('cat:title:')) {
    const lotId = data.slice(10)
    if (!(await getLotDraft(env, chatId, lotId))) return tgSend(env, chatId, 'Ese borrador ya no existe.')
    await setPending(env, chatId, { mode: 'cat_title', lotId })
    return tgSend(env, chatId, `✏️ Lote ${lotLabel(lotId)}: mandá el título nuevo (máx. 60 caracteres):`)
  }
  if (data.startsWith('cat:ship:')) {
    const lotId = data.slice(9)
    const p = await getLotDraft(env, chatId, lotId)
    if (!p?.draft) return tgSend(env, chatId, 'Ese borrador ya no existe.')
    p.draft.freeShipping = !p.draft.freeShipping
    await setLotDraft(env, chatId, lotId, p)
    return sendCatalogPreview(env, chatId, lotId, p.draft)
  }
  if (data.startsWith('cat:cond:')) {
    const lotId = data.slice(9)
    const p = await getLotDraft(env, chatId, lotId)
    if (!p?.draft) return tgSend(env, chatId, 'Ese borrador ya no existe.')
    p.draft.condition = p.draft.condition === 'new' ? 'used' : 'new'
    await setLotDraft(env, chatId, lotId, p)
    return sendCatalogPreview(env, chatId, lotId, p.draft)
  }
  if (data.startsWith('cat:setc:')) {
    // cat:setc:<lotId>:<idx> — el lotId no contiene ':' (g<digitos> o s<digitos>)
    const rest = data.slice(9)
    const sep = rest.lastIndexOf(':')
    return runCatalogSetCategory(env, chatId, rest.slice(0, sep), parseInt(rest.slice(sep + 1), 10))
  }
  if (data.startsWith('cat:cats:')) {
    const lotId = data.slice(9)
    const p = await getLotDraft(env, chatId, lotId)
    if (!p?.cats?.length) return tgSend(env, chatId, 'No hay categorías alternativas.')
    return tgSend(env, chatId, `🏷 Lote ${lotLabel(lotId)} — elegí la categoría:`, { reply_markup: { inline_keyboard:
      p.cats.map((c, i) => [{ text: `${c.id === p.draft.categoryId ? '✅ ' : ''}${c.name}`, callback_data: `cat:setc:${lotId}:${i}` }]) } })
  }
}

// ── Helpers de formato para los comandos ──────────────────────
function statusEs(s) {
  const m = {
    paid: 'Pagada 💰', confirmed: 'Confirmada', cancelled: 'Cancelada ❌',
    shipped: 'En camino 🚚', delivered: 'Entregada 📬',
    payment_required: 'Pago pendiente', payment_in_process: 'Pago en proceso',
  }
  return m[s] || s || '—'
}
function fmtMoney(n, cur) {
  const v = Number(n) || 0
  return cur === 'CLP' ? `$${v.toLocaleString('es-CL')}` : `${v} ${cur || ''}`.trim()
}

// '#' + últimos 6 dígitos del order_id (el id completo va siempre en callback_data).
function shortId(id) {
  const s = String(id || '')
  return '#' + s.slice(-6)
}
// "18 jun" en español. iso nulo/invalido → ''.
function fechaCorta(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('es-CL', { day: 'numeric', month: 'short' }).replace('.', '')
}
// Emoji semáforo según estado de la orden.
function estadoIcon(estado) {
  const m = {
    paid: '🟢', confirmed: '🟢', shipped: '🔵', delivered: '✅',
    cancelled: '❌', payment_required: '⏳', payment_in_process: '⏳',
  }
  return m[estado] || '⚪'
}
// Corta texto a n chars y agrega '…' si excede.
function truncar(texto, n = 32) {
  const s = String(texto || '')
  return s.length > n ? s.slice(0, n).trimEnd() + '…' : s
}

// ── Módulo 1: Historial real desde ML ─────────────────────────
// Las órdenes vienen de ml-history.js con campos: order_id, fecha, estado,
// producto, cantidad, monto, currency, buyer_name, shipment_id, tracking_number.

// Si ML devuelve 403 (token sin permiso de órdenes), avisa qué hacer en vez de romper.
async function withMlGuard(env, chatId, fn) {
  try {
    return await fn()
  } catch (e) {
    if (e?.status === 403) {
      return tgSend(env, chatId,
        '🔒 ML no autoriza leer órdenes con el token actual.\n' +
        'Re-autorizá la app (OAuth con scope <code>read</code>) para habilitar el historial.',
        { reply_markup: MAIN_KB })
    }
    logErr('ML historial:', e?.message)
    return tgSend(env, chatId, `❌ Error consultando ML: ${e?.message || e}`, { reply_markup: MAIN_KB })
  }
}

// Nombre a mostrar: el real si existe, si no un genérico (nunca el nickname feo).
function nombreCliente(o) {
  const n = (o.buyer_name || '').trim()
  // Si quedó el nickname (sin espacios y con dígitos), mejor "Cliente".
  if (!n || (/\d/.test(n) && !n.includes(' '))) return 'Cliente'
  return n
}

// Línea de una venta: 2 líneas simples y humanas (nombre + monto / producto + fecha).
function fmtOrderLine(o) {
  return `${estadoIcon(o.estado)} <b>${nombreCliente(o)}</b> · ${fmtMoney(o.monto, o.currency)}\n` +
         `   ${truncar(o.producto, 34)} · ${fechaCorta(o.fecha)}`
}

// Botón por venta: nombre + monto (el order_id completo va en callback_data).
function ordersListMarkup(orders) {
  return orders.map(o => [{ text: `${estadoIcon(o.estado)} ${truncar(nombreCliente(o), 20)} · ${fmtMoney(o.monto, o.currency)}`, callback_data: `vord:${o.order_id}` }])
}

// Menú raíz del historial.
async function sendHistoryMenu(env, chatId) {
  await tgSend(env, chatId, '📋 <b>Historial de ventas</b>\nElegí una opción:', {
    reply_markup: { inline_keyboard: [
      [{ text: '📅 Últimas ventas', callback_data: 'hlast:0' }],
      [{ text: '🔍 Buscar cliente', callback_data: 'hsearch' }],
      [{ text: '📆 Hoy', callback_data: 'hday' }, { text: '📆 Este mes', callback_data: 'hmonth' }],
    ] },
  })
}

// Últimas ventas, paginadas de a 10 con navegación ◀/▶.
async function sendMlLast(env, chatId, offset = 0) {
  return withMlGuard(env, chatId, async () => {
    const PAGE = 10
    const { total, orders } = await getOrderHistory(env, { limit: PAGE, offset })
    if (!orders.length) return tgSend(env, chatId, 'No hay ventas en ese rango.', { reply_markup: MAIN_KB })
    await attachReceiverNames(env, orders)   // nombre real de los que se muestran
    const lines = orders.map(fmtOrderLine)
    const nav = []
    if (offset > 0)                 nav.push({ text: '◀ Anterior',  callback_data: `hlast:${Math.max(0, offset - PAGE)}` })
    if (offset + PAGE < total)      nav.push({ text: 'Siguiente ▶', callback_data: `hlast:${offset + PAGE}` })
    const kb = ordersListMarkup(orders)
    kb.push([{ text: '⬅️ Menú historial', callback_data: 'hmenu' }])
    if (nav.length) kb.push(nav)
    await tgSend(env, chatId,
      `📅 <b>Últimas ventas</b>  <i>(${total})</i>\n\n${lines.join('\n')}`,
      { reply_markup: { inline_keyboard: kb } })
  })
}

// Pide el texto de búsqueda (queda en pending mode await_search).
async function sendMlSearchPrompt(env, chatId) {
  await setPending(env, chatId, { mode: 'await_search' })
  await tgSend(env, chatId, '🔍 Escribí el nombre o nickname del cliente a buscar:')
}

// Ejecuta la búsqueda por comprador.
async function runMlSearch(env, chatId, query) {
  if (!query) return tgSend(env, chatId, 'Falta el texto a buscar.', { reply_markup: MAIN_KB })
  return withMlGuard(env, chatId, async () => {
    const orders = await searchOrderByBuyer(env, query)   // ya trae el nombre real
    if (!orders.length) return tgSend(env, chatId, `Sin resultados para “${query}”.`, { reply_markup: MAIN_KB })
    const top = orders.slice(0, 10)
    const lines = top.map(fmtOrderLine)
    const kb = ordersListMarkup(top)
    kb.push([{ text: '⬅️ Menú historial', callback_data: 'hmenu' }])
    await tgSend(env, chatId,
      `🔍 <b>${query}</b>  <i>(${orders.length})</i>\n\n${lines.join('\n')}`,
      { reply_markup: { inline_keyboard: kb } })
  })
}

// Ventas de hoy / este mes, con total facturado.
async function sendMlRange(env, chatId, which) {
  return withMlGuard(env, chatId, async () => {
    const { from, to } = which === 'today' ? todayRange() : monthRange()
    const { total, orders } = await getOrdersByDateRange(env, from, to)
    const titulo = which === 'today' ? '📆 <b>Hoy</b>' : '📆 <b>Este mes</b>'
    if (!orders.length) return tgSend(env, chatId, `${titulo}\nSin ventas.`, { reply_markup: MAIN_KB })
    const totalCLP = orders
      .filter(o => (o.currency || 'CLP') === 'CLP')
      .reduce((s, o) => s + (Number(o.monto) || 0), 0)
    const top = orders.slice(0, 15)
    await attachReceiverNames(env, top)   // nombre real de los que se muestran
    const lines = top.map(fmtOrderLine)
    const kb = ordersListMarkup(top)
    kb.push([{ text: '⬅️ Menú historial', callback_data: 'hmenu' }])
    await tgSend(env, chatId,
      `${titulo} · 💰 <b>${fmtMoney(totalCLP, 'CLP')}</b>  <i>(${total})</i>\n\n${lines.join('\n')}` +
      (orders.length > 15 ? `\n\n…y ${orders.length - 15} más.` : ''),
      { reply_markup: { inline_keyboard: kb } })
  })
}

// Detalle de una orden ML (incluye envío + tracking si hay).
async function sendMlDetail(env, chatId, orderId) {
  return withMlGuard(env, chatId, async () => {
    const o = await getOrderDetail(env, orderId)
    const body = [
      `🧾 <b>${nombreCliente(o)}</b>`,
      `${estadoIcon(o.estado)} ${statusEs(o.estado)}`,
      `📦 ${o.producto}${o.cantidad > 1 ? ` ×${o.cantidad}` : ''}`,
      `💰 <b>${fmtMoney(o.monto, o.currency)}</b>`,
      o.ship_status ? `🚚 ${statusEs(o.ship_status)}` : null,
      `🔖 ${o.tracking_number ? `<code>${o.tracking_number}</code>` : 'sin tracking aún'}`,
      `🕒 ${fechaCorta(o.fecha)}`,
      `<i>N° de orden: ${o.order_id}</i>`,
    ].filter(Boolean).join('\n')
    const kb = [[{ text: '💬 Mensajear', callback_data: `msg:${o.order_id}` }]]
    if (o.shipment_id) kb.push([{ text: '📦 Ver envío', callback_data: `ship:${o.order_id}` }])
    kb.push([{ text: '⬅️ Volver', callback_data: 'hmenu' }])
    await tgSend(env, chatId, body, { reply_markup: { inline_keyboard: kb } })
  })
}

// Estado de envío + tracking de una orden.
async function sendShipment(env, chatId, orderId) {
  return withMlGuard(env, chatId, async () => {
    const o = await getOrderDetail(env, orderId)
    if (!o.shipment_id) return tgSend(env, chatId, 'Esta orden no tiene envío asociado.', { reply_markup: MAIN_KB })
    await tgSend(env, chatId, [
      `📦 <b>Envío</b> · Orden ${shortId(o.order_id)}`,
      `${statusEs(o.ship_status) || '—'}`,
      `🔖 ${o.tracking_number ? `<code>${o.tracking_number}</code>` : 'sin tracking aún'}`,
      `<i>Shipment ${o.shipment_id}</i>`,
    ].join('\n'), { reply_markup: { inline_keyboard: [[{ text: '⬅️ Volver', callback_data: `vord:${o.order_id}` }]] } })
  })
}

// ── Re-autorización de ML desde Telegram ──────────────────────
// Si el token se cae, el usuario abre el enlace, copia el code y lo pega acá:
// el bot lo canjea contra ML y deja la sesión lista, sin terminal ni terceros.
async function runReauth(env, chatId, code) {
  code = (code || '').trim()
  if (!/^TG-/i.test(code)) {
    return tgSend(env, chatId,
      '🔑 Para reconectar con MercadoLibre:\n' +
      '1) Abre este enlace y acepta:\n' + buildAuthUrl(env) + '\n' +
      '2) Copia el <code>code</code> que aparece en la página y pégamelo acá.',
      { disable_web_page_preview: true })
  }
  await tgSend(env, chatId, '🔄 Reconectando con MercadoLibre…')
  try {
    const r = await exchangeAuthCode(env, code)
    const horas = Math.round((r.secs_left || 0) / 3600)
    await tgSend(env, chatId,
      `✅ ¡Reconectado con MercadoLibre! De ahora en más el acceso se renueva solo (vence en ~${horas} h).`,
      { reply_markup: MAIN_KB })
  } catch (e) {
    await tgSend(env, chatId,
      `❌ No pude reconectar: ${e.message}\n` +
      'El code dura ~10 min y es de un solo uso. Genera uno nuevo con este enlace y pégamelo:\n' +
      buildAuthUrl(env),
      { disable_web_page_preview: true })
  }
}

// ── Módulo 2: menú de mensajería ──────────────────────────────
async function sendMessagesMenu(env, chatId) {
  await tgSend(env, chatId, '💬 <b>Mensajes al comprador</b>\n¿Qué quieres hacer?', {
    reply_markup: { inline_keyboard: [
      [{ text: '✍️ Mensaje directo', callback_data: 'mdirect' }],
      [{ text: '💬 Ver conversación', callback_data: 'mconv' }],
      [{ text: '📋 Plantillas', callback_data: 'mtmpl' }],
    ] },
  })
}

async function sendTemplatesMenu(env, chatId) {
  const keys = Object.keys(TEMPLATE_LABELS)
  const rows = []
  for (let i = 0; i < keys.length; i += 2) {
    rows.push(keys.slice(i, i + 2).map(k => ({ text: TEMPLATE_LABELS[k], callback_data: `tmpl:${k}` })))
  }
  rows.push([{ text: '⬅️ Volver', callback_data: 'mmenu' }])
  await tgSend(env, chatId, '📋 <b>Plantillas</b>\nElige una y después te pido el N° de orden:', {
    reply_markup: { inline_keyboard: rows },
  })
}

// Pide el N° de orden para un mensaje directo o para ver la conversación.
async function askMsgOrder(env, chatId, kind) {
  await setPending(env, chatId, { mode: kind === 'conv' ? 'await_conv_order' : 'await_msg_order' })
  const q = kind === 'conv' ? 'ver la conversación' : 'escribir el mensaje'
  await tgSend(env, chatId, `🧾 Mándame el N° de orden para ${q}:`)
}

// Muestra la conversación del pack de una orden.
async function runShowConversation(env, chatId, orderId) {
  return withMlGuard(env, chatId, async () => {
    const { buyerFirst, messages } = await getConversation(env, orderId, 10)
    if (!messages.length) {
      return tgSend(env, chatId, `No hay mensajes en la conversación de la orden <code>${orderId}</code>.`, { reply_markup: MAIN_KB })
    }
    const lines = messages.map(m => {
      const quien = m.from_seller ? '🟦 Tú' : `👤 ${buyerFirst}`
      const fecha = (m.date || '').slice(0, 16).replace('T', ' ')
      return `${quien}${fecha ? ` · ${fecha}` : ''}\n${m.text || '—'}`
    })
    await tgSend(env, chatId,
      `💬 <b>Conversación</b> — orden <code>${orderId}</code>\n\n${lines.join('\n\n')}`,
      { reply_markup: { inline_keyboard: [[{ text: '✍️ Responder', callback_data: `msg:${orderId}` }]] } })
  })
}

// Plantilla elegida → pide el N° de orden.
async function askTemplateOrder(env, chatId, tmplKey) {
  if (!TEMPLATES[tmplKey]) return tgSend(env, chatId, 'Plantilla desconocida.')
  await setPending(env, chatId, { mode: 'await_tmpl_order', tmpl: tmplKey })
  await tgSend(env, chatId, `${TEMPLATE_LABELS[tmplKey]} — mándame el N° de orden al que enviar la plantilla:`)
}

// Arma la vista previa con el nombre real del comprador y pide confirmación.
async function previewTemplate(env, chatId, tmplKey, orderId) {
  const fn = TEMPLATES[tmplKey]
  if (!fn) { await clearPending(env, chatId); return tgSend(env, chatId, 'Plantilla desconocida.') }
  let nombre = 'cliente'
  try {
    const o = await getOrderDetail(env, orderId)
    const real = nombreCliente(o)             // 'Cliente' si solo hay nickname
    if (real !== 'Cliente') nombre = firstName(real)
  } catch { /* sin nombre: usa genérico */ }
  const texto = fn(nombre)
  await setPending(env, chatId, { mode: 'confirm_tmpl', order_id: orderId, text: texto })
  await tgSend(env, chatId,
    `📋 <b>Vista previa</b> — orden <code>${orderId}</code>\n\n${texto}\n\n¿Enviar este mensaje al comprador?`,
    { reply_markup: { inline_keyboard: [[
      { text: '✅ Confirmar', callback_data: 'tsend' },
      { text: '❌ Cancelar',  callback_data: 'tcancel' },
    ]] } })
}

// Envía la plantilla ya confirmada.
async function sendTemplateConfirmed(env, chatId) {
  const p = await getPending(env, chatId)
  if (p?.mode !== 'confirm_tmpl' || !p.order_id || !p.text) {
    return tgSend(env, chatId, 'No hay un mensaje pendiente de confirmar.', { reply_markup: MAIN_KB })
  }
  await clearPending(env, chatId)
  await tgSend(env, chatId, `📨 Enviando a la orden <code>${p.order_id}</code>…`)
  return withMlGuard(env, chatId, async () => {
    const r = await sendMessageToBuyer(env, p.order_id, p.text)
    await tgSend(env, chatId,
      r.ok ? '✅ Mensaje enviado al comprador.' : `⚠️ No se envió: ${r.error}`,
      { reply_markup: MAIN_KB })
  })
}

// ── Fotos: catalogado (por defecto) o despacho/evidencia ──────
async function handlePhoto(env, msg) {
  const chatId = msg.chat.id
  const pend = await getPending(env, chatId)
  // Si estamos recolectando fotos del empaque, esta foto se suma a la evidencia.
  if (pend?.mode === 'collect_evidence') return collectEvidencePhoto(env, chatId, msg, pend)
  // Despacho: solo si se pidió explícitamente (botón 📦 Despacho).
  if (pend?.mode === 'await_sticker') {
    await clearPending(env, chatId)
    return analyzeStickerPhoto(env, chatId, msg)
  }
  // Por defecto: catalogar. Cada álbum de Telegram = un lote/producto aparte.
  return catalogCollectPhoto(env, chatId, msg)
}

async function collectEvidencePhoto(env, chatId, msg, pend) {
  const photo = msg.photo[msg.photo.length - 1]
  pend.photos = pend.photos || []
  pend.photos.push(photo.file_id)
  await setPending(env, chatId, pend)
  await tgSend(env, chatId, `📸 Foto ${pend.photos.length} recibida. Mandá más o tocá Enviar.`,
    { reply_markup: { inline_keyboard: [[{ text: '✅ Enviar al comprador', callback_data: 'fin' }]] } })
}

async function analyzeStickerPhoto(env, chatId, msg) {
  const photo  = msg.photo[msg.photo.length - 1] // mayor resolución disponible
  await tgApi(env, 'sendChatAction', { chat_id: chatId, action: 'typing' })
  await tgSend(env, chatId, '🔎 Analizando la imagen…')

  let b64
  try {
    b64 = await tgGetFileBytes(env, photo.file_id)
  } catch (e) {
    logErr('descarga foto:', e.message)
    return tgSend(env, chatId, '❌ No pude descargar la imagen. Probá de nuevo.')
  }

  let data
  try {
    data = await extractTrackingFromImage(b64, env.ANTHROPIC_API_KEY)
  } catch (e) {
    logErr('visión:', e.message)
    return tgSend(env, chatId, `❌ Error al leer la imagen: ${e.message}`)
  }

  if (!data.tracking_number) {
    return tgSend(env, chatId, '⚠️ No pude leer el número de seguimiento. Mandá una foto más nítida del sticker.')
  }

  const { pending, best } = await findPendingMatches(env, data.recipient_name)
  if (pending.length === 0) {
    return tgSend(env, chatId,
      `📦 Tracking leído: <code>${data.tracking_number}</code>\n` +
      `👤 Destinatario: ${data.recipient_name || '—'}\n\n` +
      'No hay órdenes pendientes de tracking ahora mismo.')
  }

  const match = clearMatch(best)
  if (match) {
    await setPending(env, chatId, {
      tracking_number: data.tracking_number,
      recipient_name:  data.recipient_name,
      order_id:        match.order_id,
    })
    return tgSend(env, chatId,
      `📦 Tracking: <code>${data.tracking_number}</code>\n` +
      `👤 Destinatario leído: ${data.recipient_name || '—'}\n\n` +
      `¿Es la orden de <b>${match.buyer_name}</b> por <b>${match.product}</b>?`,
      { reply_markup: { inline_keyboard: [[
        { text: '✅ Sí', callback_data: 'si' },
        { text: '❌ No', callback_data: 'no' },
      ]] } })
  }

  // Ambiguo o sin coincidencia clara → lista para elegir (con botones).
  await setPending(env, chatId, { tracking_number: data.tracking_number, recipient_name: data.recipient_name })
  await sendPendingChoice(env, chatId, pending, data)
}

function pendingListText(pending, data) {
  const lines = pending.slice(0, 10).map((o, i) =>
    `${i + 1}. <code>${o.order_id}</code> — ${o.buyer_name} — ${o.product}`)
  return `📦 Tracking: <code>${data.tracking_number}</code>\n` +
         `👤 Destinatario leído: ${data.recipient_name || '—'}\n\n` +
         `No encontré una coincidencia clara. Órdenes pendientes:\n${lines.join('\n')}\n\n` +
         `Asigná con: <code>/asignar &lt;order_id&gt;</code>`
}

async function doAssign(env, chatId, orderId, tracking) {
  await tgSend(env, chatId, `⏳ Asignando tracking <code>${tracking}</code> a la orden <code>${orderId}</code>…`)
  let res
  try {
    res = await assignTracking(env, orderId, tracking)
  } catch (e) {
    return tgSend(env, chatId, `❌ ${e.message}`)
  }
  // Pasamos a recolectar fotos del empaque; el mensaje al comprador (tracking +
  // fotos) se envía al recibir /listo, vía la mensajería de ML (todo tipo de envío).
  await setPending(env, chatId, {
    mode:        'collect_evidence',
    order_id:    orderId,
    tracking,
    carrier:     res.carrier,
    trackingOk:  res.trackingOk,
    trackingErr: res.trackingErr,
    photos:      [],
  })
  await tgSend(env, chatId, [
    `📦 Orden <code>${orderId}</code>`,
    `🔖 Tracking guardado: <code>${tracking}</code>`,
    res.trackingOk ? '✅ Tracking actualizado en MercadoLibre'
                   : `⚠️ ML no aceptó el tracking (igual se enviará por mensaje): ${res.trackingErr}`,
    '',
    '📸 Ahora mandá las fotos del empaque y tocá <b>Enviar</b> cuando termines.',
    '(O tocá Enviar para mandar solo el número de seguimiento.)',
  ].join('\n'), { reply_markup: { inline_keyboard: [[{ text: '✅ Enviar al comprador', callback_data: 'fin' }]] } })
}

// Envía al comprador, por mensajería de ML, el tracking + las fotos del empaque.
async function finalizeEvidence(env, chatId, p) {
  await tgSend(env, chatId, '📨 Enviando al comprador…')

  const photos = []
  for (const fileId of (p.photos || [])) {
    try {
      const bytes = await tgGetFileBuffer(env, fileId)
      photos.push({ bytes, filename: `empaque-${photos.length + 1}.jpg`, mimeType: 'image/jpeg' })
    } catch (e) {
      logErr('descarga foto empaque:', e.message)
    }
  }

  const text =
    `¡Tu pedido fue despachado! 📦 Tu número de seguimiento es: ${p.tracking}. ` +
    `Podés rastrearlo en ${p.carrier}.` +
    (photos.length ? ' Adjuntamos fotos del empaque como comprobante. ✅' : '')

  let ev
  try {
    ev = await sendBuyerEvidence(env, p.order_id, { text, photos })
  } catch (e) {
    await clearPending(env, chatId)
    return tgSend(env, chatId, `❌ No se pudo enviar al comprador: ${e.message}`)
  }

  await clearPending(env, chatId)
  await tgSend(env, chatId, [
    `📦 Orden <code>${p.order_id}</code> — envío al comprador:`,
    ev.msgOk ? '✅ Mensaje enviado al comprador' : `⚠️ Mensaje no enviado: ${ev.msgErr}`,
    `🖼️ Fotos adjuntadas: ${ev.attachOk}` +
      (ev.attachErr?.length ? ` (fallaron ${ev.attachErr.length})` : ''),
  ].join('\n'))
}

// ── Módulo 3: catalogado y publicación por LOTES (fotos → IA → ML) ───────
// Reglas fijas: envío SIEMPRE pagado por el comprador, stock SIEMPRE 1.
//
// UX: el usuario manda TODAS las fotos (de uno o varios productos, mezcladas,
// con o sin álbum) → un ÚNICO mensaje de estado con UN botón Analizar → la IA
// agrupa las fotos por producto físico y manda UNA vista previa por producto,
// cada uno con su propia publicación.
//
// Todas las fotos entrantes caen en el "lote abierto" del chat, cuyo id es
// determinístico: o<generación>. La generación (lotgen:<chat>) solo cambia
// cuando el usuario toca Analizar/Descartar/Catalogar — nunca al recibir
// fotos — así los updates simultáneos de un álbum no compiten por crear el
// lote. Cada foto se guarda en SU PROPIA clave KV (lotp:<chat>:<lote>:<msgId>,
// file_id en metadata): nada de leer-modificar-escribir sobre una clave
// compartida (las escrituras concurrentes se pisaban; así se rompía el flujo viejo).
const LOT_PHOTO_PFX = (chatId, lotId) => `lotp:${chatId}:${lotId}:`
const LOT_PHOTO_KEY = (chatId, lotId, msgId) => `${LOT_PHOTO_PFX(chatId, lotId)}${String(msgId).padStart(12, '0')}`
const LOT_DRAFT_KEY = (chatId, lotId) => `lotd:${chatId}:${lotId}`
const LOT_MSG_KEY   = (chatId, lotId) => `lotm:${chatId}:${lotId}`
const LOT_GEN_KEY   = (chatId) => `lotgen:${chatId}`
const LOT_TTL = 7200 // 2 h para armar/revisar/publicar un lote

// Lote abierto actual del chat (donde caen las fotos nuevas).
async function openLotId(env, chatId) {
  return `o${(await env.ML_ORDERS.get(LOT_GEN_KEY(chatId))) || '0'}`
}
// Cierra el lote abierto: las próximas fotos caen en un lote nuevo.
async function bumpLotGen(env, chatId) {
  await env.ML_ORDERS.put(LOT_GEN_KEY(chatId), String(Date.now()))
}

const lotLabel = (lotId) => `#${String(lotId).slice(-4)}`

// Fotos del lote como [{name, fid}], en el orden en que llegaron (message_id
// ascendente: las claves KV se listan en orden lexicográfico, msgId con padding).
async function listLotPhotos(env, chatId, lotId) {
  const res = await env.ML_ORDERS.list({ prefix: LOT_PHOTO_PFX(chatId, lotId), limit: 100 })
  return res.keys.filter(k => k.metadata?.fid).map(k => ({ name: k.name, fid: k.metadata.fid }))
}

async function getLotDraft(env, chatId, lotId) {
  try { return JSON.parse(await env.ML_ORDERS.get(LOT_DRAFT_KEY(chatId, lotId))) } catch { return null }
}
async function setLotDraft(env, chatId, lotId, state) {
  await env.ML_ORDERS.put(LOT_DRAFT_KEY(chatId, lotId), JSON.stringify(state), { expirationTtl: LOT_TTL })
}

async function deleteLot(env, chatId, lotId) {
  const res = await env.ML_ORDERS.list({ prefix: LOT_PHOTO_PFX(chatId, lotId), limit: 100 })
  await Promise.all(res.keys.map(k => env.ML_ORDERS.delete(k.name)))
  await env.ML_ORDERS.delete(LOT_DRAFT_KEY(chatId, lotId))
  await env.ML_ORDERS.delete(LOT_MSG_KEY(chatId, lotId))
  if (lotId === (await openLotId(env, chatId))) await bumpLotGen(env, chatId)
}

async function catalogCollectPhoto(env, chatId, msg) {
  const photo = msg.photo[msg.photo.length - 1] // mayor resolución

  // TODAS las fotos van al lote abierto del chat (id determinístico o<gen>:
  // los updates simultáneos de un álbum calculan el mismo lote sin carreras).
  const lotId = await openLotId(env, chatId)

  await env.ML_ORDERS.put(LOT_PHOTO_KEY(chatId, lotId, msg.message_id), '1',
    { metadata: { fid: photo.file_id }, expirationTtl: LOT_TTL })

  const n = (await listLotPhotos(env, chatId, lotId)).length
  const text =
    `📸 <b>${n} foto(s) recibidas.</b>\n` +
    'Mandá el resto y, cuando estén todas, tocá <b>Analizar</b>: la IA separa ' +
    'los productos y te da una vista previa de cada uno. 🔀'
  const kb = { inline_keyboard: [
    [{ text: '🤖 Analizar', callback_data: `cat:go:${lotId}` }],
    [{ text: '🗑 Descartar fotos', callback_data: `cat:x:${lotId}` }],
  ] }

  // Un ÚNICO mensaje de estado con UN botón Analizar: se edita con el conteo
  // actualizado (las fotos llegan en ráfaga; mandar uno por foto era spam).
  const prevMsgId = await env.ML_ORDERS.get(LOT_MSG_KEY(chatId, lotId))
  if (prevMsgId) {
    const r = await tgApi(env, 'editMessageText',
      { chat_id: chatId, message_id: Number(prevMsgId), text, parse_mode: 'HTML', reply_markup: kb })
    if (r.ok) return
  }
  const sent = await tgSend(env, chatId, text, { reply_markup: kb })
  if (sent.ok) {
    await env.ML_ORDERS.put(LOT_MSG_KEY(chatId, lotId), String(sent.result.message_id), { expirationTtl: LOT_TTL })
  }
}

// Divide un lote en sub-lotes según los grupos que detectó la IA.
// groups: [{label, photos:[índices sobre `entries`]}]. Reusa el sufijo msgId
// de cada clave original para conservar el orden. Devuelve
// [{lotId, label, fids, imageIdx}] (imageIdx = índices sobre `entries`).
async function splitLotIntoGroups(env, chatId, lotId, entries, groups) {
  const subLots = []
  for (let gi = 0; gi < groups.length; gi++) {
    const subId = `${lotId}-${gi + 1}`
    const fids = []
    for (const idx of groups[gi].photos) {
      const entry = entries[idx]
      if (!entry) continue
      const msgPart = entry.name.split(':').pop()
      await env.ML_ORDERS.put(`${LOT_PHOTO_PFX(chatId, subId)}${msgPart}`, '1',
        { metadata: { fid: entry.fid }, expirationTtl: LOT_TTL })
      fids.push(entry.fid)
    }
    subLots.push({ lotId: subId, label: groups[gi].label, fids, imageIdx: groups[gi].photos })
  }
  // El lote original desaparece (sus fotos ya viven en los sub-lotes). Se
  // borra por prefijo para no dejar claves huérfanas; el ':' final del prefijo
  // no matchea los sub-lotes (usan '<lotId>-N:').
  const res = await env.ML_ORDERS.list({ prefix: LOT_PHOTO_PFX(chatId, lotId), limit: 100 })
  await Promise.all(res.keys.map(k => env.ML_ORDERS.delete(k.name)))
  await env.ML_ORDERS.delete(LOT_MSG_KEY(chatId, lotId))
  return subLots
}

// Máximo de fotos que entran a la pasada de agrupación/análisis por invocación
// (límite de subrequests del Worker y de tamaño del request a la IA).
const MAX_ANALYZE_PHOTOS = 10
// Máximo de productos que se analizan de corrido en una invocación; si la IA
// detecta más, los restantes quedan con botón Analizar (límite de subrequests).
const MAX_AUTO_ANALYZE = 5

// Análisis + vista previa de UN producto: IA de catalogado → categoría →
// atributos+mercado → draft en KV → preview. `lite` omite la ganancia
// estimada para ahorrar subrequests cuando se analizan varios de corrido
// (cualquier edición posterior re-renderiza la preview completa).
async function analyzeAndPreviewLot(env, chatId, lotId, photoFids, imagesB64, lite = false) {
  let analysis
  try {
    analysis = await analyzeProduct(imagesB64.slice(0, 3), env.ANTHROPIC_API_KEY)
  } catch (e) {
    return tgSend(env, chatId, `❌ Error de IA en el lote ${lotLabel(lotId)}: ${esc(e.message)}`)
  }

  const cats = await discoverCategories(analysis.categorySearches)
  const best = cats.find(c => c.id) || null
  if (!best) {
    return tgSend(env, chatId,
      `⚠️ No encontré una categoría de ML para "${esc(analysis.product)}" (lote ${lotLabel(lotId)}). ` +
      'Agregá una foto más clara y volvé a Analizar.',
      { reply_markup: { inline_keyboard: [[
        { text: '🤖 Reanalizar', callback_data: `cat:go:${lotId}` },
        { text: '🗑 Descartar', callback_data: `cat:x:${lotId}` },
      ]] } })
  }

  // Atributos (ML + IA) y precios de mercado en paralelo: no dependen entre sí.
  const [attrValues, market] = await Promise.all([
    getRequiredAttrs(best.id)
      .then(required => fillAttributesWithAI(required, analysis, env.ANTHROPIC_API_KEY,
        { title: analysis.title, description: analysis.description, categoryName: best.name }))
      .catch(e => { logErr('attrs:', e.message); return {} }),
    getMarketPrices(best.id, analysis.title),
  ])

  const draft = {
    title:        analysis.title,
    // Valor inicial = precio de mercado (mediana) si existe; si no, el estimado
    // por la IA. Siempre con terminación 990.
    price:        market?.median ? roundTo990(market.median) : analysis.price,
    freeShipping: false, // envío a cargo del comprador por defecto
    description:  analysis.description,
    condition:    analysis.condition,
    // Identificación de las fotos: la reutiliza fillAttributesWithAI al
    // recategorizar (el draft hace de "analysis") — la marca no se pierde.
    product:      analysis.product,
    brand:        analysis.brand,
    model:        analysis.model,
    features:     analysis.features,
    specs:        analysis.specs,
    categoryId:   best.id,
    categoryName: best.name,
    attrValues,
    photos:       photoFids,
    market,
    qty:          1,
  }
  await setLotDraft(env, chatId, lotId, { draft, cats })
  return sendCatalogPreview(env, chatId, lotId, draft, lite)
}

async function runCatalogAnalyze(env, chatId, lotId) {
  const entries = await listLotPhotos(env, chatId, lotId)
  if (!entries.length)
    return tgSend(env, chatId, 'No hay fotos para analizar (o expiraron). Mandá las fotos de nuevo.')

  // Si era el lote abierto, se cierra: las próximas fotos abren uno nuevo
  // mientras estos productos se revisan/publican.
  if (lotId === (await openLotId(env, chatId))) await bumpLotGen(env, chatId)

  await tgApi(env, 'sendChatAction', { chat_id: chatId, action: 'typing' })
  await tgSend(env, chatId, `🤖 Analizando ${entries.length} foto(s) con IA…`)

  // Se descargan TODAS las fotos (con tope): primero para que la IA decida si
  // son de un solo producto o de varios, y de paso quedan listas para el análisis.
  const capped = entries.slice(0, MAX_ANALYZE_PHOTOS)
  const buffers = await Promise.all(capped.map(e =>
    tgGetFileBytes(env, e.fid).catch(err => { logErr('descarga foto análisis:', err.message); return null })))
  const valid = capped.map((e, i) => ({ entry: e, b64: buffers[i] })).filter(x => x.b64)
  if (!valid.length) return tgSend(env, chatId, '❌ No pude descargar las fotos. Probá de nuevo.')

  // Pasada de agrupación: ¿estas fotos muestran 1 producto o varios?
  // Si la IA de agrupación falla, se sigue asumiendo un solo producto.
  let groups = [{ label: null, photos: valid.map((_, i) => i) }]
  if (valid.length > 1) {
    try {
      groups = await clusterPhotos(valid.map(v => v.b64), env.ANTHROPIC_API_KEY)
    } catch (e) { logErr('clusterPhotos:', e.message) }
  }

  // Un solo producto → análisis directo (las fotos ya están descargadas).
  if (groups.length <= 1) {
    return analyzeAndPreviewLot(env, chatId, lotId,
      entries.map(e => e.fid), valid.slice(0, 3).map(v => v.b64))
  }

  // Varios productos → dividir en sub-lotes y analizarlos TODOS de corrido:
  // el usuario recibe una vista previa individual por producto, sin toques
  // intermedios. Los b64 ya descargados se reutilizan (sin re-descargas).
  const overflow = entries.slice(MAX_ANALYZE_PHOTOS)
  const allEntries = valid.map(v => v.entry).concat(overflow)
  const subLots = await splitLotIntoGroups(env, chatId, lotId, allEntries,
    // las fotos que excedieron el tope van al último grupo para no perderlas
    groups.map((g, gi) => gi === groups.length - 1 && overflow.length
      ? { ...g, photos: g.photos.concat(overflow.map((_, k) => valid.length + k)) }
      : g))

  const resumen = subLots.map((s, i) =>
    `${i + 1}. ${esc(s.label || 'producto')} (${s.fids.length} foto(s))`)
  await tgSend(env, chatId,
    `🔀 Detecté <b>${subLots.length} productos distintos</b>:\n${resumen.join('\n')}\n\n` +
    '⏳ Analizando cada uno… te va llegando una vista previa por producto.')

  const auto = subLots.slice(0, MAX_AUTO_ANALYZE)
  for (const s of auto) {
    // Imágenes del grupo ya descargadas (índices < valid.length).
    let imgs = s.imageIdx.filter(i => i < valid.length).slice(0, 3).map(i => valid[i].b64)
    if (!imgs.length && s.fids.length) {
      // Grupo formado solo por fotos de desborde: descargar hasta 3.
      const bufs = await Promise.all(s.fids.slice(0, 3).map(fid =>
        tgGetFileBytes(env, fid).catch(() => null)))
      imgs = bufs.filter(Boolean)
    }
    if (!imgs.length) continue
    await analyzeAndPreviewLot(env, chatId, s.lotId, s.fids, imgs, true)
  }

  // Si hubo más productos que el tope por invocación, los restantes quedan
  // listos con su botón (caso raro: >5 productos en una tanda).
  const rest = subLots.slice(MAX_AUTO_ANALYZE)
  if (rest.length) {
    await tgSend(env, chatId,
      `➕ Quedan ${rest.length} producto(s) por analizar (tope por tanda). Tocá cada botón:`,
      { reply_markup: { inline_keyboard: rest.map(s =>
        [{ text: `🤖 Analizar · ${(s.label || 'producto').slice(0, 28)}`, callback_data: `cat:go:${s.lotId}` }]) } })
  }
}

async function sendCatalogPreview(env, chatId, lotId, draft, lite = false) {
  const m = draft.market

  // Ganancia estimada: comisión real de ML + costo de envío si lo paga el
  // vendedor. Si algo falla, la preview sale igual sin esa línea. En modo
  // lite (análisis de varios productos de corrido) se omite para no agotar
  // los subrequests; reaparece al editar cualquier cosa del borrador.
  let profitLine = null
  try {
    if (lite) throw new Error('lite')
    const token = await getValidAccessToken(env)
    const est = await estimateProfit(token, draft)
    if (est.fee != null) {
      const parts = [`comisión ${fmtMoney(est.fee, 'CLP')}`]
      if (draft.freeShipping) parts.push(`envío ~${fmtMoney(est.ship || 0, 'CLP')}`)
      profitLine = `💰 <b>Ganancia estimada: ${fmtMoney(est.net, 'CLP')}</b> <i>(${parts.join(' − ')}, ${est.listingType === 'free' ? 'publicación gratuita' : 'Clásica/paga'})</i>`
    }
  } catch (e) { if (e.message !== 'lite') logErr('estimateProfit:', e.message) }

  const lines = [
    `📋 <b>Vista previa — lote ${lotLabel(lotId)}</b>`,
    '',
    `📌 <b>${esc(draft.title)}</b>`,
    `💲 <b>${fmtMoney(draft.price, 'CLP')}</b>` +
      (m ? `  <i>(mercado: ${fmtMoney(m.min, 'CLP')}–${fmtMoney(m.max, 'CLP')}, mediana ${fmtMoney(m.median, 'CLP')}, ${m.count} avisos)</i>` : ''),
    ...(profitLine ? [profitLine] : []),
    `🏷 ${esc(draft.categoryName)} · ${draft.condition === 'new' ? 'Nuevo' : 'Usado'} · 📸 ${draft.photos.length} foto(s)`,
    `🚚 Envío: ${draft.freeShipping ? 'GRATIS (lo paga el vendedor)' : 'a cargo del comprador'} · Stock: ${draft.qty || 1}`,
  ]
  const attrs = Object.entries(draft.attrValues || {}).filter(([, v]) => v?.toString().trim())
  if (attrs.length)
    lines.push('🔧 ' + attrs.slice(0, 6).map(([k, v]) => `${k}: ${esc(v)}`).join(' · '))
  lines.push('', `📝 ${esc(draft.description.slice(0, 350))}${draft.description.length > 350 ? '…' : ''}`)

  return tgSend(env, chatId, lines.join('\n'), { reply_markup: { inline_keyboard: [
    [{ text: '✅ Publicar', callback_data: `cat:pub:${lotId}` }],
    [{ text: '💲 Precio', callback_data: `cat:price:${lotId}` },
     { text: '✏️ Título', callback_data: `cat:title:${lotId}` },
     { text: '🔢 Cantidad', callback_data: `cat:qty:${lotId}` }],
    [{ text: '🏷 Categoría', callback_data: `cat:cats:${lotId}` },
     { text: `🔄 ${draft.condition === 'new' ? 'Nuevo→Usado' : 'Usado→Nuevo'}`, callback_data: `cat:cond:${lotId}` }],
    [{ text: `🚚 ${draft.freeShipping ? 'Cambiar a envío por comprador' : 'Cambiar a envío gratis (vendedor)'}`, callback_data: `cat:ship:${lotId}` }],
    [{ text: '❌ Descartar lote', callback_data: `cat:x:${lotId}` }],
  ] } })
}

async function runCatalogSetCategory(env, chatId, lotId, idx) {
  const p = await getLotDraft(env, chatId, lotId)
  if (!p?.cats?.[idx]) return tgSend(env, chatId, `El borrador del lote ${lotLabel(lotId)} ya no existe.`)
  const cat = p.cats[idx]
  p.draft.categoryId = cat.id
  p.draft.categoryName = cat.name
  await tgSend(env, chatId, `🏷 Categoría: <b>${esc(cat.name)}</b>. Recalculando atributos…`)
  try {
    const required = await getRequiredAttrs(cat.id)
    p.draft.attrValues = await fillAttributesWithAI(required, p.draft, env.ANTHROPIC_API_KEY,
      { title: p.draft.title, description: p.draft.description, categoryName: cat.name })
  } catch (e) { logErr('attrs recat:', e.message) }
  p.draft.market = await getMarketPrices(cat.id, p.draft.title)
  await setLotDraft(env, chatId, lotId, p)
  return sendCatalogPreview(env, chatId, lotId, p.draft)
}

async function runCatalogPublish(env, chatId, lotId) {
  const p = await getLotDraft(env, chatId, lotId)
  if (!p?.draft) return tgSend(env, chatId, `No hay un borrador listo en el lote ${lotLabel(lotId)}.`)
  const d = p.draft

  await tgSend(env, chatId, `⏳ Lote ${lotLabel(lotId)}: subiendo ${d.photos.length} foto(s) y publicando…`)

  let token
  try {
    token = await getValidAccessToken(env)
  } catch (e) {
    return tgSend(env, chatId, `❌ Sin conexión con ML: ${esc(e.message)}`)
  }

  // Descarga de Telegram + subida a ML de todas las fotos en paralelo,
  // conservando el orden (la primera foto es la portada del aviso).
  const uploaded = await Promise.all(d.photos.map(async fileId => {
    try {
      const buf = await tgGetFileBuffer(env, fileId)
      return await uploadPicture(token, buf)
    } catch (e) { logErr('subida foto:', e.message); return null }
  }))
  const pictureIds = uploaded.filter(Boolean)
  if (d.photos.length > 0 && pictureIds.length === 0) {
    return tgSend(env, chatId,
      `❌ Lote ${lotLabel(lotId)}: no se pudo subir ninguna foto a ML; cancelé la publicación para no crear un aviso sin imágenes. Probá de nuevo con <b>Publicar</b>.`,
      { reply_markup: { inline_keyboard: [[{ text: '✅ Publicar', callback_data: `cat:pub:${lotId}` }, { text: '🗑 Descartar lote', callback_data: `cat:x:${lotId}` }]] } })
  }

  let item
  try {
    item = await createListing(token, { ...d, pictureIds })
  } catch (e) {
    // El borrador del lote sigue guardado: se puede corregir y reintentar.
    return tgSend(env, chatId,
      `❌ ML rechazó la publicación del lote ${lotLabel(lotId)}: ${esc(e.message)}\n\nCorregí lo necesario y volvé a intentar.`,
      { reply_markup: { inline_keyboard: [
        [{ text: '✅ Reintentar', callback_data: `cat:pub:${lotId}` }],
        [{ text: '✏️ Título', callback_data: `cat:title:${lotId}` }, { text: '🏷 Categoría', callback_data: `cat:cats:${lotId}` }],
        [{ text: '🗑 Descartar lote', callback_data: `cat:x:${lotId}` }],
      ] } })
  }

  await deleteLot(env, chatId, lotId)
  await tgSend(env, chatId, [
    '🎉 <b>¡Publicado!</b>',
    `📌 ${esc(d.title)}`,
    `💲 ${fmtMoney(d.price, 'CLP')} · 🚚 ${d.freeShipping ? 'envío gratis (vendedor)' : 'envío a cargo del comprador'} · stock ${d.qty || 1}`,
    `🔗 ${item.permalink || item.id}`,
  ].join('\n'), { reply_markup: MAIN_KB })

  // Aviso al admin cuando publica un operador.
  if (String(chatId) !== String(env.TELEGRAM_CHAT_ID)) {
    await tgSend(env, env.TELEGRAM_CHAT_ID,
      `📢 Se publicó desde el chat <code>${chatId}</code>:\n${esc(d.title)} — ${fmtMoney(d.price, 'CLP')}\n${item.permalink || item.id}`)
  }
}

// ── Descarga de archivo de Telegram → base64 ──────────────────
export async function tgGetFileBuffer(env, fileId) {
  const info = await tgApi(env, 'getFile', { file_id: fileId })
  if (!info.ok) throw new Error(info.error || 'getFile falló')
  const path = info.result?.file_path
  if (!path) throw new Error('Telegram no devolvió file_path')
  const r = await fetch(`${TG_API}/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`)
  if (!r.ok) throw new Error(`descarga HTTP ${r.status}`)
  return await r.arrayBuffer()
}

export async function tgGetFileBytes(env, fileId) {
  return abToBase64(await tgGetFileBuffer(env, fileId))
}

function abToBase64(buf) {
  const bytes = new Uint8Array(buf)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

// ── Estado de confirmación pendiente (KV ML_ORDERS, TTL 1 h) ──
const PENDING_KEY = (chatId) => `pending:${chatId}`
async function setPending(env, chatId, data) {
  await env.ML_ORDERS.put(PENDING_KEY(chatId), JSON.stringify(data), { expirationTtl: 3600 })
}
async function getPending(env, chatId) {
  try { return JSON.parse(await env.ML_ORDERS.get(PENDING_KEY(chatId))) } catch { return null }
}
async function clearPending(env, chatId) {
  try { await env.ML_ORDERS.delete(PENDING_KEY(chatId)) } catch {}
}
