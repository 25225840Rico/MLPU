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
  getOrderDetail, todayRange, monthRange,
} from './ml-history.js'
import { sendMessageToBuyer, getConversation, TEMPLATES, TEMPLATE_LABELS } from './ml-messaging.js'
import { exchangeAuthCode, buildAuthUrl } from './index.js'

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
    [{ text: '🧾 Órdenes' }, { text: '📭 Pendientes' }],
    [{ text: '📋 Historial' }, { text: '💬 Mensajes' }],
    [{ text: 'ℹ️ Ayuda' }],
  ],
  resize_keyboard: true,
}
const isButtonLabel = (t) =>
  ['📋 Historial', '💬 Mensajes', '🧾 Órdenes', '📭 Pendientes', 'ℹ️ Ayuda'].includes(t)

// ── Webhook receiver ─────────────────────────────────────────
export async function handleTelegramWebhook(request, env, ctx) {
  let update
  try {
    update = await request.json()
  } catch {
    logErr('Update con JSON inválido')
    return new Response('ok') // 200 siempre: evita reintentos en bucle de Telegram
  }

  // Procesamos en segundo plano (visión + ML pueden tardar) y devolvemos 200 ya,
  // para que Telegram no agote el timeout ni reintente duplicando.
  const work = (async () => {
    try {
      const msg = update.message || update.edited_message
      if (update.callback_query)   await handleCallback(env, update.callback_query)
      else if (msg?.photo?.length) await handlePhoto(env, msg)
      else if (msg?.text)          await handleTextCommand(env, msg)
    } catch (e) {
      logErr('Error procesando update:', e.message)
    }
  })()
  // Antes esto corría en ctx.waitUntil y las respuestas del bot no llegaban
  // (el 200 cerraba el evento antes de completar el envío a Telegram). Ahora
  // esperamos a que termine —incluido el sendMessage— antes de responder 200.
  // Todas las operaciones (comandos, visión, ML) terminan muy por debajo del
  // timeout de webhook de Telegram (~60s), así que es seguro await-earlas.
  await work

  return new Response('ok')
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
    return void tgSend(env, chatId, `✍️ Escribe el texto del mensaje para el comprador de la orden <code>${text.trim()}</code>:`)
  }
  if (pend0?.mode === 'await_conv_order' && text && !text.startsWith('/') && !isButtonLabel(text)) {
    await clearPending(env, chatId)
    return runShowConversation(env, chatId, text.trim())
  }
  if (pend0?.mode === 'await_tmpl_order' && text && !text.startsWith('/') && !isButtonLabel(text)) {
    return previewTemplate(env, chatId, pend0.tmpl, text.trim())
  }

  // Botonera (reply keyboard) ↔ mismas acciones que los comandos.
  if (text === 'ℹ️ Ayuda' || text === '/start' || text.startsWith('/start@')) return sendStart(env, chatId)
  if (text === '🧾 Órdenes')   return sendOrdersList(env, chatId)
  if (text === '📭 Pendientes') return sendPendingList(env, chatId)
  if (text === '📋 Historial')  return sendHistoryMenu(env, chatId)
  if (text === '💬 Mensajes')   return sendMessagesMenu(env, chatId)
  if (text === '/historial')    return sendMlLast(env, chatId, 0)
  if (text.startsWith('/buscar ')) return runMlSearch(env, chatId, text.slice(8).trim())

  if (text === '/si' || text === '/sí')  return doConfirmYes(env, chatId)
  if (text === '/no')                     return doConfirmNo(env, chatId)
  if (text === '/listo')                  return doFinalize(env, chatId)

  if (text.startsWith('/asignar')) {
    const orderId = text.split(/\s+/)[1]
    if (!orderId) return void tgSend(env, chatId, 'Uso: <code>/asignar &lt;order_id&gt;</code>')
    const p = await getPending(env, chatId)
    if (!p?.tracking_number) return void tgSend(env, chatId, 'No hay tracking pendiente. Mandá primero la foto del sticker.')
    return doAssign(env, chatId, orderId, p.tracking_number)
  }

  if (text === '/ordenes')    return sendOrdersList(env, chatId)
  if (text === '/pendientes') return sendPendingList(env, chatId)
  if (text.startsWith('/orden ')) return sendOrderDetail(env, chatId, text.slice('/orden '.length).trim().split(/\s+/)[0])

  if (text.startsWith('/mensaje ')) {
    const rest = text.slice('/mensaje '.length).trim()
    const sp = rest.indexOf(' ')
    if (sp < 1) return void tgSend(env, chatId, 'Uso: <code>/mensaje &lt;order_id&gt; &lt;texto&gt;</code>')
    return sendBuyerMessageManual(env, chatId, rest.slice(0, sp), rest.slice(sp + 1).trim())
  }

  await tgSend(env, chatId, 'No reconozco eso. Usá los botones de abajo o /start.', { reply_markup: MAIN_KB })
}

// ── Botonera + acciones (reutilizadas por comandos y botones inline) ──
async function sendStart(env, chatId) {
  await tgSend(env, chatId,
    '✅ <b>Bot MLPU actualizado y operativo.</b>\n\n' +
    'Ya puedes usar todo desde los botones 👇\n' +
    '🧾 Órdenes · 📭 Pendientes\n' +
    '📋 Historial — ventas reales de ML (buscar cliente, hoy, este mes)\n' +
    '💬 Mensajes — directo, ver conversación y plantillas\n\n' +
    '📸 Para despachar: envía la foto del sticker y sigue los botones.\n' +
    '🔑 Si alguna vez se corta la conexión con ML, te aviso por acá y reconectas pegando el código.',
    { reply_markup: MAIN_KB })
}

async function sendHistory(env, chatId, page = 0) {
  const all = await listOrders(env, 1000)
  if (!all.length) return void tgSend(env, chatId, 'Tu historial está vacío todavía.', { reply_markup: MAIN_KB })
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
  if (!p?.tracking_number) return void tgSend(env, chatId, 'No hay nada pendiente de confirmar. Mandá la foto del sticker.')
  if (!p.order_id) return void tgSend(env, chatId, 'Elegí la orden de la lista.')
  return doAssign(env, chatId, p.order_id, p.tracking_number)
}
async function doConfirmNo(env, chatId) {
  const p = await getPending(env, chatId)
  if (!p?.tracking_number) return void tgSend(env, chatId, 'Ok. Mandá la foto del sticker cuando quieras.')
  const { pending } = await findPendingMatches(env, p.recipient_name || '')
  await setPending(env, chatId, { tracking_number: p.tracking_number, recipient_name: p.recipient_name })
  return sendPendingChoice(env, chatId, pending, p)
}
async function doFinalize(env, chatId) {
  const p = await getPending(env, chatId)
  if (p?.mode !== 'collect_evidence') return void tgSend(env, chatId, 'No hay un envío en curso. Mandá la foto del sticker para empezar.')
  return finalizeEvidence(env, chatId, p)
}

async function sendOrdersList(env, chatId) {
  const orders = await listOrders(env, 10)
  if (!orders.length) return void tgSend(env, chatId, 'No hay órdenes registradas todavía.', { reply_markup: MAIN_KB })
  const lines = orders.map(o =>
    `• <code>${o.order_id}</code> — ${statusEs(o.status)}\n   ${o.buyer_name} · ${o.product}` +
    (o.tracking_number ? `\n   🔖 ${o.tracking_number}` : ''))
  await tgSend(env, chatId, `🧾 <b>Últimas ${orders.length} órdenes</b>\n\n${lines.join('\n')}`, {
    reply_markup: { inline_keyboard: orders.map(o => [{ text: `🔎 ${o.order_id} · ${o.buyer_name}`, callback_data: `ver:${o.order_id}` }]) },
  })
}

async function sendPendingList(env, chatId) {
  const pend = (await listOrders(env, 200)).filter(o => !o.tracking_number)
  if (!pend.length) return void tgSend(env, chatId, '✅ No hay órdenes pendientes de tracking.', { reply_markup: MAIN_KB })
  const slice = pend.slice(0, 20)
  const lines = slice.map(o => `• <code>${o.order_id}</code> — ${o.buyer_name} · ${o.product}`)
  await tgSend(env, chatId, `📭 <b>Pendientes de tracking (${pend.length})</b>\n\n${lines.join('\n')}\n\n📸 Mandá la foto del sticker para asignar.`, {
    reply_markup: { inline_keyboard: slice.map(o => [{ text: `🔎 ${o.order_id} · ${o.buyer_name}`, callback_data: `ver:${o.order_id}` }]) },
  })
}

async function sendOrderDetail(env, chatId, id) {
  const o = await getOrder(env, id)
  if (!o) return void tgSend(env, chatId, `No encontré la orden <code>${id}</code>.`, { reply_markup: MAIN_KB })
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
  if (!body) return void tgSend(env, chatId, 'Falta el texto del mensaje.')
  await tgSend(env, chatId, `📨 Enviando mensaje al comprador de la orden <code>${orderId}</code>…`)
  let ev
  try {
    ev = await sendBuyerEvidence(env, orderId, { text: body, photos: [] })
  } catch (e) {
    return void tgSend(env, chatId, `❌ ${e.message}`)
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
  if (data === 'tcancel')      { await clearPending(env, chatId); return void tgSend(env, chatId, 'Cancelado.', { reply_markup: MAIN_KB }) }
  if (data.startsWith('ver:'))  return sendOrderDetail(env, chatId, data.slice(4))
  if (data.startsWith('asg:')) {
    const id = data.slice(4)
    const p = await getPending(env, chatId)
    if (!p?.tracking_number) return void tgSend(env, chatId, 'No hay tracking pendiente. Mandá primero la foto del sticker.')
    return doAssign(env, chatId, id, p.tracking_number)
  }
  if (data.startsWith('msg:')) {
    const id = data.slice(4)
    await setPending(env, chatId, { mode: 'await_message', order_id: id })
    return void tgSend(env, chatId, `✍️ Escribí el texto del mensaje para el comprador de la orden <code>${id}</code>:`)
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

// ── Módulo 1: Historial real desde ML ─────────────────────────
// Las órdenes vienen de ml-history.js con campos: order_id, fecha, estado,
// producto, cantidad, monto, currency, buyer_name, shipment_id, tracking_number.

// Si ML devuelve 403 (token sin permiso de órdenes), avisa qué hacer en vez de romper.
async function withMlGuard(env, chatId, fn) {
  try {
    return await fn()
  } catch (e) {
    if (e?.status === 403) {
      return void tgSend(env, chatId,
        '🔒 ML no autoriza leer órdenes con el token actual.\n' +
        'Re-autorizá la app (OAuth con scope <code>read</code>) para habilitar el historial.',
        { reply_markup: MAIN_KB })
    }
    logErr('ML historial:', e?.message)
    return void tgSend(env, chatId, `❌ Error consultando ML: ${e?.message || e}`, { reply_markup: MAIN_KB })
  }
}

// Línea compacta de una orden ML.
function fmtOrderLine(o) {
  const fecha = (o.fecha || '').slice(0, 10)
  return `• <code>${o.order_id}</code> · ${o.buyer_name || o.buyer_nickname || '—'} · ${o.producto}\n` +
         `   ${fmtMoney(o.monto, o.currency)} · ${statusEs(o.estado)}${fecha ? ` · ${fecha}` : ''}`
}

// Botones [🔎 abrir] por cada orden de la lista.
function ordersListMarkup(orders) {
  return orders.map(o => [{ text: `🔎 ${o.order_id} · ${o.buyer_name || o.buyer_nickname || '—'}`, callback_data: `vord:${o.order_id}` }])
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
    if (!orders.length) return void tgSend(env, chatId, 'No hay ventas en ese rango.', { reply_markup: MAIN_KB })
    const lines = orders.map(fmtOrderLine)
    const nav = []
    if (offset > 0)                 nav.push({ text: '◀ Anterior',  callback_data: `hlast:${Math.max(0, offset - PAGE)}` })
    if (offset + PAGE < total)      nav.push({ text: 'Siguiente ▶', callback_data: `hlast:${offset + PAGE}` })
    const kb = ordersListMarkup(orders)
    kb.push([{ text: '⬅️ Menú historial', callback_data: 'hmenu' }])
    if (nav.length) kb.push(nav)
    await tgSend(env, chatId,
      `📅 <b>Últimas ventas</b> — ${total} en total\n` +
      `Mostrando ${offset + 1}–${offset + orders.length}\n\n${lines.join('\n')}`,
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
  if (!query) return void tgSend(env, chatId, 'Falta el texto a buscar.', { reply_markup: MAIN_KB })
  return withMlGuard(env, chatId, async () => {
    const orders = await searchOrderByBuyer(env, query)
    if (!orders.length) return void tgSend(env, chatId, `Sin resultados para “${query}”.`, { reply_markup: MAIN_KB })
    const lines = orders.slice(0, 10).map(fmtOrderLine)
    const kb = ordersListMarkup(orders.slice(0, 10))
    kb.push([{ text: '⬅️ Menú historial', callback_data: 'hmenu' }])
    await tgSend(env, chatId,
      `🔍 <b>Resultados para “${query}”</b> — ${orders.length}\n\n${lines.join('\n')}`,
      { reply_markup: { inline_keyboard: kb } })
  })
}

// Ventas de hoy / este mes, con total facturado.
async function sendMlRange(env, chatId, which) {
  return withMlGuard(env, chatId, async () => {
    const { from, to } = which === 'today' ? todayRange() : monthRange()
    const { total, orders } = await getOrdersByDateRange(env, from, to)
    const titulo = which === 'today' ? '📆 Ventas de hoy' : '📆 Ventas de este mes'
    if (!orders.length) return void tgSend(env, chatId, `${titulo}: sin ventas.`, { reply_markup: MAIN_KB })
    const totalCLP = orders
      .filter(o => (o.currency || 'CLP') === 'CLP')
      .reduce((s, o) => s + (Number(o.monto) || 0), 0)
    const lines = orders.slice(0, 15).map(fmtOrderLine)
    const kb = ordersListMarkup(orders.slice(0, 15))
    kb.push([{ text: '⬅️ Menú historial', callback_data: 'hmenu' }])
    await tgSend(env, chatId,
      `${titulo} — ${total} venta(s) · ${fmtMoney(totalCLP, 'CLP')}\n\n${lines.join('\n')}` +
      (orders.length > 15 ? `\n\n…y ${orders.length - 15} más.` : ''),
      { reply_markup: { inline_keyboard: kb } })
  })
}

// Detalle de una orden ML (incluye envío + tracking si hay).
async function sendMlDetail(env, chatId, orderId) {
  return withMlGuard(env, chatId, async () => {
    const o = await getOrderDetail(env, orderId)
    const body = [
      `🧾 <b>Orden</b> <code>${o.order_id}</code>`,
      `Estado: ${statusEs(o.estado)}`,
      `👤 ${o.buyer_name || o.buyer_nickname || '—'}`,
      `📦 ${o.producto}${o.cantidad > 1 ? ` (x${o.cantidad})` : ''}`,
      `💰 ${fmtMoney(o.monto, o.currency)}`,
      o.ship_status ? `🚚 Envío: ${statusEs(o.ship_status)}` : null,
      `🔖 Tracking: ${o.tracking_number ? `<code>${o.tracking_number}</code>` : '— (pendiente)'}`,
      o.pack_id ? `Pack: <code>${o.pack_id}</code>` : null,
      `🕒 ${(o.fecha || '—').slice(0, 19).replace('T', ' ')}`,
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
    if (!o.shipment_id) return void tgSend(env, chatId, 'Esta orden no tiene envío asociado.', { reply_markup: MAIN_KB })
    await tgSend(env, chatId, [
      `📦 <b>Envío</b> de la orden <code>${o.order_id}</code>`,
      `Estado: ${statusEs(o.ship_status) || '—'}`,
      `🔖 Tracking: ${o.tracking_number ? `<code>${o.tracking_number}</code>` : '— (pendiente)'}`,
      `Shipment: <code>${o.shipment_id}</code>`,
    ].join('\n'), { reply_markup: { inline_keyboard: [[{ text: '⬅️ Volver', callback_data: `vord:${o.order_id}` }]] } })
  })
}

// ── Re-autorización de ML desde Telegram ──────────────────────
// Si el token se cae, el usuario abre el enlace, copia el code y lo pega acá:
// el bot lo canjea contra ML y deja la sesión lista, sin terminal ni terceros.
async function runReauth(env, chatId, code) {
  code = (code || '').trim()
  if (!/^TG-/i.test(code)) {
    return void tgSend(env, chatId,
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
      return void tgSend(env, chatId, `No hay mensajes en la conversación de la orden <code>${orderId}</code>.`, { reply_markup: MAIN_KB })
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
  if (!TEMPLATES[tmplKey]) return void tgSend(env, chatId, 'Plantilla desconocida.')
  await setPending(env, chatId, { mode: 'await_tmpl_order', tmpl: tmplKey })
  await tgSend(env, chatId, `${TEMPLATE_LABELS[tmplKey]} — mándame el N° de orden al que enviar la plantilla:`)
}

// Arma la vista previa con el nombre real del comprador y pide confirmación.
async function previewTemplate(env, chatId, tmplKey, orderId) {
  const fn = TEMPLATES[tmplKey]
  if (!fn) { await clearPending(env, chatId); return void tgSend(env, chatId, 'Plantilla desconocida.') }
  let nombre = 'cliente'
  try {
    const o = await getOrderDetail(env, orderId)
    nombre = (o.buyer_name || o.buyer_nickname || 'cliente').split(' ')[0]
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
    return void tgSend(env, chatId, 'No hay un mensaje pendiente de confirmar.', { reply_markup: MAIN_KB })
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

// ── Paso 3: foto del sticker → tracking ───────────────────────
async function handlePhoto(env, msg) {
  const chatId = msg.chat.id
  const pend = await getPending(env, chatId)
  // Si estamos recolectando fotos del empaque, esta foto se suma a la evidencia.
  if (pend?.mode === 'collect_evidence') return collectEvidencePhoto(env, chatId, msg, pend)
  return analyzeStickerPhoto(env, chatId, msg)
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
    return void tgSend(env, chatId, '❌ No pude descargar la imagen. Probá de nuevo.')
  }

  let data
  try {
    data = await extractTrackingFromImage(b64, env.ANTHROPIC_API_KEY)
  } catch (e) {
    logErr('visión:', e.message)
    return void tgSend(env, chatId, `❌ Error al leer la imagen: ${e.message}`)
  }

  if (!data.tracking_number) {
    return void tgSend(env, chatId, '⚠️ No pude leer el número de seguimiento. Mandá una foto más nítida del sticker.')
  }

  const { pending, best } = await findPendingMatches(env, data.recipient_name)
  if (pending.length === 0) {
    return void tgSend(env, chatId,
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
    return void tgSend(env, chatId,
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
    return void tgSend(env, chatId, `❌ ${e.message}`)
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
    return void tgSend(env, chatId, `❌ No se pudo enviar al comprador: ${e.message}`)
  }

  await clearPending(env, chatId)
  await tgSend(env, chatId, [
    `📦 Orden <code>${p.order_id}</code> — envío al comprador:`,
    ev.msgOk ? '✅ Mensaje enviado al comprador' : `⚠️ Mensaje no enviado: ${ev.msgErr}`,
    `🖼️ Fotos adjuntadas: ${ev.attachOk}` +
      (ev.attachErr?.length ? ` (fallaron ${ev.attachErr.length})` : ''),
  ].join('\n'))
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
