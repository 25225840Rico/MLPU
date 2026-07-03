/**
 * Cloudflare Worker — Proxy + gestor de sesión para MercadoLibre API
 *
 * El Worker es la ÚNICA fuente de verdad del token OAuth de ML.
 * Guarda access_token + refresh_token en KV (binding ML_TOKENS), los renueva
 * automáticamente y los inyecta en cada request proxeada. Los celulares ya no
 * gestionan el token: solo siembran la sesión (/ml/auth/init) y consultan
 * estado (/ml/auth/status).
 *
 * Endpoints:
 *   POST /ml/auth/init      → exchange del código OAuth inicial, siembra KV
 *   GET  /ml/auth/status    → estado de la sesión (sin exponer tokens)
 *   POST /ml/pictures/...   → proxy con Authorization inyectado desde KV
 *   POST /ml/items          → proxy con Authorization inyectado desde KV
 *   *    /ml/*              → proxy con Authorization inyectado desde KV
 *
 * Config requerida en Cloudflare:
 *   - KV namespace binding: ML_TOKENS
 *   - Secrets: ML_CLIENT_ID, ML_CLIENT_SECRET
 */

import { handleTelegramWebhook } from './telegram-bot.js'
import { recordOrderFromML } from './orders.js'
import { runScheduled } from './scheduler.js'
import { mlFetch } from './ml-fetch.js'
import { runCatchup } from './backfill.js'

const ML_API = 'https://api.mercadolibre.com'
const SESSION_KEY = 'ml_session'
const REFRESH_MARGIN_S = 300 // renovar si quedan < 5 min

// mutex ligero: evita refreshes concurrentes paralelos (race condition KV)
let refreshingPromise = null

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })

// ── KV helpers ────────────────────────────────────────────────
async function getSession(env) {
  const raw = await env.ML_TOKENS.get(SESSION_KEY)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

async function putSession(env, session) {
  await env.ML_TOKENS.put(SESSION_KEY, JSON.stringify(session))
}

function secsLeft(session) {
  if (!session?.obtained_at || !session?.expires_in) return 0
  const elapsed = (Date.now() - session.obtained_at) / 1000
  return Math.max(0, Math.floor(session.expires_in - elapsed))
}

// ── OAuth: refresh ────────────────────────────────────────────
async function refreshSession(env, session) {
  if (!session?.refresh_token) throw new Error('No hay refresh_token en KV')
  if (!env.ML_CLIENT_ID || !env.ML_CLIENT_SECRET)
    throw new Error('Faltan secrets ML_CLIENT_ID / ML_CLIENT_SECRET')

  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     env.ML_CLIENT_ID,
    client_secret: env.ML_CLIENT_SECRET,
    refresh_token: session.refresh_token,
  })
  const r = await fetch(`${ML_API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  })
  const data = await r.json()
  if (!r.ok) throw new Error(data.message || data.error || `refresh HTTP ${r.status}`)

  const next = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token || session.refresh_token,
    expires_in:    data.expires_in || 21600,
    obtained_at:   Date.now(),
  }
  await putSession(env, next)
  return next
}

/**
 * Devuelve un access_token vigente, renovando si está por expirar.
 * Re-lee KV justo antes de decidir (best-effort para 2 usuarios concurrentes).
 */
export async function getValidAccessToken(env, { force = false } = {}) {
  let session = await getSession(env)
  if (!session?.access_token) throw new Error('No hay sesión ML activa. Re-autoriza en Config.')
  if (force || secsLeft(session) < REFRESH_MARGIN_S) {
    if (!refreshingPromise) {
      refreshingPromise = (async () => {
        // Re-leer KV justo antes de refrescar: otro isolate/celular pudo haber
        // renovado ya. ML rota el refresh_token, así que un refresh duplicado
        // invalida la sesión compartida. Si la copia fresca de KV ya está vigente
        // (y no es un refresh forzado por 401), la reutilizamos en vez de rotar.
        const fresh = await getSession(env)
        if (!force && fresh?.access_token && secsLeft(fresh) >= REFRESH_MARGIN_S) return fresh
        return refreshSession(env, fresh || session)
      })().finally(() => { refreshingPromise = null })
    }
    session = await refreshingPromise
  }
  return session.access_token
}

// URL de autorización OAuth de ML (para re-autorizar cuando el token muere).
// El redirect_uri debe coincidir con uno registrado en la app de ML.
export const ML_REDIRECT_URI = 'https://httpbin.org/get'
export function buildAuthUrl(env) {
  const cid = env.ML_CLIENT_ID || ''
  const scope = encodeURIComponent('offline_access read write')
  return 'https://auth.mercadolibre.cl/authorization' +
         `?response_type=code&client_id=${cid}` +
         `&redirect_uri=${encodeURIComponent(ML_REDIRECT_URI)}&scope=${scope}`
}

/**
 * Canjea un código OAuth (authorization_code) por la sesión y la guarda en KV.
 * Reutilizable desde el endpoint HTTP y desde el bot de Telegram (/reauth).
 * Lanza Error con mensaje claro si ML rechaza el código.
 */
export async function exchangeAuthCode(env, code, redirect_uri = ML_REDIRECT_URI) {
  if (!env.ML_CLIENT_ID || !env.ML_CLIENT_SECRET)
    throw new Error('Faltan secrets ML_CLIENT_ID / ML_CLIENT_SECRET en el Worker')
  if (!code) throw new Error('Falta el código OAuth (code)')

  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    client_id:     env.ML_CLIENT_ID,
    client_secret: env.ML_CLIENT_SECRET,
    code,
    redirect_uri,
  })
  const r = await fetch(`${ML_API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  })
  const data = await r.json()
  if (!r.ok) throw new Error(data.message || data.error || `HTTP ${r.status}`)

  const session = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_in:    data.expires_in || 21600,
    obtained_at:   Date.now(),
  }
  await putSession(env, session)
  return { expires_in: session.expires_in, secs_left: secsLeft(session) }
}

// ── Endpoint: POST /ml/auth/init ──────────────────────────────
async function handleAuthInit(request, env) {
  let payload
  try { payload = await request.json() } catch { return json({ error: 'Body JSON inválido' }, 400) }

  const code = (payload.code || '').trim()
  const redirect_uri = payload.redirect_uri || ML_REDIRECT_URI
  try {
    const res = await exchangeAuthCode(env, code, redirect_uri)
    return json({ ok: true, ...res })
  } catch (e) {
    return json({ error: e.message }, 400)
  }
}

// ── Endpoint: GET /ml/auth/status ─────────────────────────────
async function handleAuthStatus(env) {
  const session = await getSession(env)
  if (!session?.access_token) return json({ active: false, secs_left: 0 })
  const left = secsLeft(session)
  return json({
    active: true,
    secs_left: left,
    expires_at: session.obtained_at + session.expires_in * 1000,
  })
}

// ── Endpoint: POST /ml/notifications (webhook de MercadoLibre) ─
// ML envía solo { topic, resource, ... } sin los datos. Respondemos 200 al
// instante y traemos la orden en segundo plano (ML reintenta si no hay 200).
async function handleMlNotification(request, env, ctx) {
  let note
  try { note = await request.json() } catch { return json({ ok: true }) }

  const topic    = note.topic || ''
  const resource = note.resource || ''
  console.log('[ML-BOT] notif topic=' + topic + ' resource=' + resource)

  const work = (async () => {
    try {
      if (topic === 'orders_v2' && resource) {
        await processOrderNotification(env, resource)
      }
      // 'shipments' y otros topics se manejarán en pasos siguientes.
    } catch (e) {
      console.error('[ML-BOT] notif error:', e.message)
    }
  })()
  if (ctx?.waitUntil) ctx.waitUntil(work)
  else await work

  return json({ ok: true })
}

async function processOrderNotification(env, resource) {
  const orderId = resource.split('/').filter(Boolean).pop()
  const token = await getValidAccessToken(env)

  const r = await mlFetch(`${ML_API}/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!r.ok) throw new Error(`GET /orders/${orderId} HTTP ${r.status}`)
  const order = await r.json()

  // Tipo de envío (best-effort; no bloquea la alerta si falla).
  let shipment = null
  const shipmentId = order.shipping?.id
  if (shipmentId) {
    try {
      const sr = await mlFetch(`${ML_API}/shipments/${shipmentId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (sr.ok) shipment = await sr.json()
    } catch (e) {
      console.error('[ML-BOT] no se pudo leer shipment', shipmentId, e.message)
    }
  }

  await recordOrderFromML(env, order, shipment)
}

// ── Proxy genérico con token inyectado ────────────────────────
async function handleProxy(request, env, mlPath, search) {
  const buildHeaders = (token) => {
    const h = new Headers()
    const skip = new Set(['host', 'cf-ray', 'cf-connecting-ip', 'x-forwarded-for',
                          'x-real-ip', 'cf-ipcountry', 'cf-visitor', 'authorization'])
    for (const [k, v] of request.headers.entries()) {
      if (!skip.has(k.toLowerCase())) h.set(k, v)
    }
    if (token) h.set('Authorization', `Bearer ${token}`)
    return h
  }

  const mlUrl = `${ML_API}${mlPath}${search}`
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  // Bufferizar el body para poder reintentar tras un 401.
  const bodyBuf = hasBody ? await request.arrayBuffer() : undefined

  // endpoints públicos de ML que no requieren auth
  // /sites/ fue removido — listing_prices sí necesita token para comisiones personalizadas
  const PUBLIC_PATHS = ['/currencies/', '/countries/']
  const isPublic = PUBLIC_PATHS.some(p => mlPath.startsWith(p))

  let token
  if (!isPublic) {
    token = await getValidAccessToken(env)
  }
  let upstream = await fetch(mlUrl, {
    method: request.method,
    headers: buildHeaders(token),
    body: bodyBuf,
  })

  // En 401: forzar refresh una vez y reintentar (solo rutas con auth).
  if (!isPublic && upstream.status === 401) {
    token = await getValidAccessToken(env, { force: true })
    upstream = await fetch(mlUrl, {
      method: request.method,
      headers: buildHeaders(token),
      body: bodyBuf,
    })
  }

  const resHeaders = new Headers(upstream.headers)
  for (const [k, v] of Object.entries(CORS)) resHeaders.set(k, v)
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: resHeaders,
  })
}

// ── Admin del webhook de Telegram ─────────────────────────────
async function handleTgAdmin(request, env, ctx) {
  const url = new URL(request.url)
  const action = url.searchParams.get('action') || 'info'
  const token = env.TELEGRAM_BOT_TOKEN
  if (!token) return json({ error: 'Falta el secret TELEGRAM_BOT_TOKEN en el Worker' }, 500)

  const tgBase = `https://api.telegram.org/bot${token}`
  const hookUrl = `${url.origin}/tg/webhook`

  // Acción única: procesar ventas de este mes + el anterior por estado y limpiar
  // el KV. Corre en segundo plano (puede tardar) y reporta el resumen por Telegram.
  if (action === 'catchup') {
    const work = runCatchup(env).catch(e => console.error('[ML-CATCHUP] error:', e.message))
    if (ctx?.waitUntil) ctx.waitUntil(work); else await work
    return json({ action: 'catchup', started: true, note: 'El resumen llega por Telegram al terminar.' })
  }

  if (action === 'off') {
    const r = await fetch(`${tgBase}/deleteWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drop_pending_updates: true }),
    })
    return json({ action: 'off', telegram: await r.json() })
  }

  if (action === 'set') {
    const r = await fetch(`${tgBase}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: hookUrl,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: false,
      }),
    })
    return json({ action: 'set', webhook: hookUrl, telegram: await r.json() })
  }

  // info (por defecto): no expone el token, solo el estado del webhook.
  const r = await fetch(`${tgBase}/getWebhookInfo`)
  return json({ action: 'info', telegram: await r.json() })
}

// ── Router ────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }

    const url = new URL(request.url)

    // ── Bot de Telegram (webhook, aditivo; no interfiere con /ml/*) ──
    if (url.pathname === '/tg/webhook' && request.method === 'POST') {
      return handleTelegramWebhook(request, env, ctx)
    }

    // ── Admin del webhook de Telegram ──
    // GET /tg/admin?action=info  → estado del webhook (getWebhookInfo)
    // GET /tg/admin?action=set   → re-registra el webhook a este Worker
    // Útil si el webhook se perdió (p. ej. al correr el bot en polling con el
    // mismo token, que lo borra). Usa el secret TELEGRAM_BOT_TOKEN del Worker.
    if (url.pathname === '/tg/admin' && request.method === 'GET') {
      return handleTgAdmin(request, env, ctx)
    }

    if (!url.pathname.startsWith('/ml/')) {
      return new Response('Not found', { status: 404 })
    }

    // Guard: KV debe estar configurado.
    if (!env.ML_TOKENS) {
      return json({ error: 'KV ML_TOKENS no configurado en el Worker' }, 500)
    }

    const mlPath = url.pathname.replace(/^\/ml/, '')

    try {
      if (mlPath === '/auth/init' && request.method === 'POST') {
        return await handleAuthInit(request, env)
      }
      if (mlPath === '/auth/status' && request.method === 'GET') {
        return await handleAuthStatus(env)
      }
      if (mlPath === '/notifications' && request.method === 'POST') {
        return await handleMlNotification(request, env, ctx)
      }
      // Resto: proxy con token inyectado desde KV.
      return await handleProxy(request, env, mlPath, url.search)
    } catch (e) {
      return json({ error: e.message || 'Error interno del Worker' }, 500)
    }
  },

  // Cron Trigger (cada 6 h): seguimiento automático de envíos (Paso 4).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env))
  },
}
