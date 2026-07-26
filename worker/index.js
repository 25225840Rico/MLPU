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

import { handleTelegramWebhook, tgSend } from './telegram-bot.js'
import { recordOrderFromML } from './orders.js'
import { runIgPublisher, runIgDaily } from './ig-queue.js'
import { esc } from './ig-logic.js'
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
  // X-MLPU-Key: sin declararla acá el navegador aborta el preflight del SPA.
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-MLPU-Key',
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

// ── Llave del Worker (secret MLPU_KEY) ────────────────────────
// El proxy /ml/* inyecta el token de ML del vendedor: sin llave, cualquiera que
// conozca la URL del Worker publica, edita o lee las ventas de la cuenta. La
// llave es OPCIONAL a propósito: mientras el secret no exista el Worker se
// comporta igual que antes, así que desplegar esto no rompe nada. Recién cuando
// se corre `wrangler secret put MLPU_KEY` (y se pega la misma llave en el SPA,
// pantalla de ajustes) las rutas quedan cerradas.
//
// Comparación en tiempo constante: un `!==` filtra la llave carácter a carácter
// por diferencia de tiempo de respuesta.
function llaveValida(recibida, esperada) {
  const a = String(recibida || ''), b = String(esperada || '')
  if (a.length !== b.length) return false
  let dif = 0
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return dif === 0
}

// Devuelve null si la request puede pasar, o la Response 401 que la corta.
function exigirLlave(request, env) {
  if (!env.MLPU_KEY) return null                 // sin secret: comportamiento previo
  const url = new URL(request.url)
  const recibida = request.headers.get('X-MLPU-Key') || url.searchParams.get('key') || ''
  if (llaveValida(recibida, env.MLPU_KEY)) return null
  return json({ error: 'No autorizado: falta o no coincide la llave del Worker (X-MLPU-Key).' }, 401)
}

// ── Proxy genérico con token inyectado ────────────────────────
async function handleProxy(request, env, mlPath, search) {
  const buildHeaders = (token) => {
    const h = new Headers()
    // 'x-mlpu-key' va en el skip: es NUESTRA llave, no tiene por qué viajar a ML.
    const skip = new Set(['host', 'cf-ray', 'cf-connecting-ip', 'x-forwarded-for',
                          'x-real-ip', 'cf-ipcountry', 'cf-visitor', 'authorization',
                          'x-mlpu-key'])
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
    // secret_token: Telegram lo repite en el header X-Telegram-Bot-Api-Secret-Token
    // de cada update, y handleTelegramWebhook lo exige. ES OBLIGATORIO volver a
    // correr ?action=set después de configurar TELEGRAM_WEBHOOK_SECRET: si el
    // secret existe en el Worker pero Telegram no lo manda, TODOS los updates
    // se descartan con 401 y el bot queda mudo.
    const r = await fetch(`${tgBase}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: hookUrl,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: false,
        ...(env.TELEGRAM_WEBHOOK_SECRET ? { secret_token: env.TELEGRAM_WEBHOOK_SECRET } : {}),
      }),
    })
    return json({
      action: 'set',
      webhook: hookUrl,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET ? 'registrado' : 'no configurado',
      telegram: await r.json(),
    })
  }

  // info (por defecto): no expone el token, solo el estado del webhook.
  // `has_custom_certificate`/`pending_update_count` vienen de Telegram; el
  // diagnóstico propio avisa del desajuste que deja al bot mudo.
  // OJO: getWebhookInfo NO dice si Telegram tiene registrado un secret_token,
  // así que el desajuste no se puede detectar acá; solo se puede avisar.
  const r = await fetch(`${tgBase}/getWebhookInfo`)
  return json({
    action: 'info',
    telegram: await r.json(),
    seguridad: {
      webhook_secret_en_worker: !!env.TELEGRAM_WEBHOOK_SECRET,
      mlpu_key_en_worker: !!env.MLPU_KEY,
      aviso: env.TELEGRAM_WEBHOOK_SECRET
        ? 'Si el bot dejó de responder, corré ?action=set: Telegram necesita registrar el secret_token.'
        : 'Sin TELEGRAM_WEBHOOK_SECRET el webhook acepta POSTs de cualquiera.',
    },
  })
}

// ── Router ────────────────────────────────────────────────────
// Sirve una foto de Google Drive como JPEG público (proxy para IG/Cloudinary).
// Cachea 24 h en el edge para no repegarle a Drive en cada fetch de Meta.
async function serveDriveImage(rawId, ctx) {
  const fileId = (rawId || '').split('/')[0].split('?')[0].trim()
  if (!/^[A-Za-z0-9_-]{10,}$/.test(fileId)) {
    return new Response('bad drive id', { status: 400, headers: CORS })
  }
  const cache = caches.default
  const key = new Request(`https://img.drive/${fileId}`)
  const hit = await cache.match(key)
  if (hit) return hit

  const sources = [
    `https://drive.google.com/thumbnail?id=${fileId}&sz=w1600`,
    `https://drive.usercontent.google.com/download?id=${fileId}&export=download`,
  ]
  for (const src of sources) {
    const r = await fetch(src, { redirect: 'follow' })
    const ct = r.headers.get('content-type') || ''
    if (r.ok && ct.startsWith('image/')) {
      const resp = new Response(r.body, {
        status: 200,
        headers: { 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400', ...CORS },
      })
      ctx.waitUntil(cache.put(key, resp.clone()))
      return resp
    }
  }
  return new Response('drive image not available', { status: 502, headers: CORS })
}

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
    // Cerrado con MLPU_KEY cuando el secret existe: 'set'/'off' reconfiguran el
    // webhook del bot y 'catchup' dispara trabajo real contra ML.
    if (url.pathname === '/tg/admin' && request.method === 'GET') {
      return exigirLlave(request, env) || handleTgAdmin(request, env, ctx)
    }

    // ── Compositor de imágenes para IG (fondo blur; import dinámico para no
    // cargar el WASM de photon en requests que no lo usan) ──
    if (url.pathname === '/ig/img' && request.method === 'GET') {
      const { igImageProxy } = await import('./ig-image.js')
      return igImageProxy(request, env)
    }

    // ── Proxy de imágenes de Google Drive (inventario propio, fuente 'drive') ──
    // GET /img/drive/<fileId> → sirve la foto de Drive como imagen pública para
    // que Instagram (Graph API) y Cloudinary puedan tomarla: los links de Drive
    // no sirven directo como image_url. Usa el endpoint `thumbnail`, que
    // transcodifica a JPEG (resuelve HEIC del iPhone) y evita el interstitial de
    // "análisis de virus" de las descargas grandes.
    if (url.pathname.startsWith('/img/drive/') && request.method === 'GET') {
      return serveDriveImage(url.pathname.slice('/img/drive/'.length), ctx)
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
      // Siembra la sesión de ML en KV → con llave (quien la toque secuestra la
      // sesión del Worker).
      if (mlPath === '/auth/init' && request.method === 'POST') {
        return exigirLlave(request, env) || await handleAuthInit(request, env)
      }
      // Sin llave a propósito: solo dice si la sesión está viva y cuánto le
      // queda. No expone token ni datos, y el SPA lo consulta en cada carga.
      if (mlPath === '/auth/status' && request.method === 'GET') {
        return await handleAuthStatus(env)
      }
      if (mlPath === '/notifications' && request.method === 'POST') {
        // Sin llave a propósito: lo llama MercadoLibre, que no puede mandar
        // nuestro header. No expone datos (responde 200 vacío) y solo dispara
        // una lectura de la orden contra ML.
        return await handleMlNotification(request, env, ctx)
      }
      // Resto: proxy con el token del vendedor inyectado → exige la llave.
      return exigirLlave(request, env) || await handleProxy(request, env, mlPath, url.search)
    } catch (e) {
      return json({ error: e.message || 'Error interno del Worker' }, 500)
    }
  },

  // Crons (ver worker/wrangler.toml): '* * * * *' corre el publisher de IG cada
  // minuto (rush / goteo / ventanas; las guardas baratas descartan el tick que no
  // toca); '0 10 * * *' (06:00 Chile) recalcula ventanas y renueva el token de
  // Meta. OJO: el post-venta (runScheduled de scheduler.js) sigue APAGADO adrede.
  //
  // El .catch NO es decorativo: waitUntil() se traga la excepción y el tick
  // moría en silencio (cola congelada con el panel diciendo "🔥 RUSH activo").
  // Que el aviso falle no puede tumbar el handler, de ahí el catch anidado.
  async scheduled(event, env, ctx) {
    const notify = t => tgSend(env, env.TELEGRAM_CHAT_ID, t)
    const blindar = (tarea, quien) => tarea.catch(async e => {
      console.error(`[IG] ${quien} murió:`, e?.stack || e?.message || e)
      try { await notify(`⚠️ IG: el cron ${quien} falló: ${esc(e?.message || e)}`) } catch {}
    })
    if (event.cron === '0 10 * * *') ctx.waitUntil(blindar(runIgDaily(env, notify), 'diario'))
    else ctx.waitUntil(blindar(runIgPublisher(env, { notify }), 'publisher'))
  },
}
