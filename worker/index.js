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

const ML_API = 'https://api.mercadolibre.com'
const SESSION_KEY = 'ml_session'
const REFRESH_MARGIN_S = 300 // renovar si quedan < 5 min

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
async function getValidAccessToken(env, { force = false } = {}) {
  let session = await getSession(env)
  if (!session?.access_token) throw new Error('No hay sesión ML activa. Re-autoriza en Config.')
  if (force || secsLeft(session) < REFRESH_MARGIN_S) {
    session = await refreshSession(env, session)
  }
  return session.access_token
}

// ── Endpoint: POST /ml/auth/init ──────────────────────────────
async function handleAuthInit(request, env) {
  if (!env.ML_CLIENT_ID || !env.ML_CLIENT_SECRET)
    return json({ error: 'Faltan secrets ML_CLIENT_ID / ML_CLIENT_SECRET en el Worker' }, 500)

  let payload
  try { payload = await request.json() } catch { return json({ error: 'Body JSON inválido' }, 400) }

  const code = (payload.code || '').trim()
  const redirect_uri = payload.redirect_uri || 'https://httpbin.org/get'
  if (!code) return json({ error: 'Falta el código OAuth (code)' }, 400)

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
  if (!r.ok) return json({ error: data.message || data.error || `HTTP ${r.status}` }, r.status)

  const session = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_in:    data.expires_in || 21600,
    obtained_at:   Date.now(),
  }
  await putSession(env, session)
  return json({ ok: true, expires_in: session.expires_in, secs_left: secsLeft(session) })
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

// ── Proxy genérico con token inyectado ────────────────────────
async function handleProxy(request, env, mlPath, search) {
  const buildHeaders = (token) => {
    const h = new Headers()
    const skip = new Set(['host', 'cf-ray', 'cf-connecting-ip', 'x-forwarded-for',
                          'x-real-ip', 'cf-ipcountry', 'cf-visitor', 'authorization'])
    for (const [k, v] of request.headers.entries()) {
      if (!skip.has(k.toLowerCase())) h.set(k, v)
    }
    h.set('Authorization', `Bearer ${token}`)
    return h
  }

  const mlUrl = `${ML_API}${mlPath}${search}`
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  // Bufferizar el body para poder reintentar tras un 401.
  const bodyBuf = hasBody ? await request.arrayBuffer() : undefined

  let token = await getValidAccessToken(env)
  let upstream = await fetch(mlUrl, {
    method: request.method,
    headers: buildHeaders(token),
    body: bodyBuf,
  })

  // En 401: forzar refresh una vez y reintentar.
  if (upstream.status === 401) {
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

// ── Router ────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }

    const url = new URL(request.url)
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
      // Resto: proxy con token inyectado desde KV.
      return await handleProxy(request, env, mlPath, url.search)
    } catch (e) {
      return json({ error: e.message || 'Error interno del Worker' }, 500)
    }
  },
}
