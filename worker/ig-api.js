/**
 * [IG] Cliente de la Instagram Graph API (Meta).
 * El token de larga duración vive en D1 (ig_config.meta_token) porque el
 * Worker no puede escribir secrets; se renueva vía fb_exchange_token.
 */

import { maxResPicture, padImageUrl, blurImageUrl, padOwnImageUrl } from './ig-logic.js'

const GRAPH = 'https://graph.facebook.com/v21.0'
const REFRESH_AFTER_MS = 45 * 24 * 3600 * 1000 // renovar a los 45 días (expira a los 60)
const log = (...a) => console.log('[IG]', ...a)

export async function getMetaToken(db) {
  const row = await db.prepare('SELECT valor FROM ig_config WHERE clave=?').bind('meta_token').first()
  if (!row) throw new Error('sin token de Meta (seed ig_config.meta_token)')
  return JSON.parse(row.valor).token
}

async function saveMetaToken(db, token) {
  await db.prepare('REPLACE INTO ig_config (clave, valor) VALUES (?, ?)')
    .bind('meta_token', JSON.stringify({ token, obtenido_en: new Date().toISOString() })).run()
}

async function graphPost(path, params) {
  const r = await fetch(`${GRAPH}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  })
  const data = await r.json()
  if (!r.ok || data.error) throw new Error(data.error?.message || `Graph API ${r.status}`)
  return data
}

const sleep = ms => new Promise(res => setTimeout(res, ms))
let RETRY_BASE_MS = 3000
export const _setRetryBaseMs = ms => { RETRY_BASE_MS = ms } // solo para tests

// Espera a que Meta termine de procesar el contenedor consultando su
// status_code (publica APENAS está listo, en vez de reintentos ciegos).
// Hasta ~60 s: las imágenes compuestas (blur 1080x1920) tardan más que los
// 15 s del poll original, que terminaba en "Media ID is not available".
let POLL_MS = 2000
export const _setPollMs = ms => { POLL_MS = ms } // solo para tests
async function waitForContainer(contId, token) {
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${GRAPH}/${contId}?fields=status_code&access_token=${encodeURIComponent(token)}`)
    const data = await r.json().catch(() => ({}))
    if (data.status_code === 'IN_PROGRESS') { await sleep(POLL_MS); continue }
    if (data.status_code === 'ERROR' || data.status_code === 'EXPIRED')
      throw new Error(`contenedor ${contId} quedó en ${data.status_code}`)
    return // FINISHED, o status desconocido/no legible → intentar publicar igual
  }
}

// Red de seguridad: si aun así media_publish dice "Media ID is not available",
// reintentar un par de veces con espera creciente.
async function publishWhenReady(igUserId, contId, token) {
  await waitForContainer(contId, token)
  for (let i = 0; ; i++) {
    try {
      return await graphPost(`${igUserId}/media_publish`, { creation_id: contId, access_token: token })
    } catch (e) {
      if (i >= 2 || !/media id is not available|not ready|in progress/i.test(e.message)) throw e
      log(`contenedor ${contId} aún procesándose, reintento ${i + 1}…`)
      await sleep((i + 1) * RETRY_BASE_MS)
    }
  }
}

// Publica una imagen como post de feed (con caption) o historia (story: true).
// Sin raw: pasa por wsrv.nl (padding blanco, sin recorte) partiendo de la variante
// -F.jpg de ML; si wsrv o la descarga fallan, reintenta una vez con la URL original.
export async function igPublishImage(env, { imageUrl, caption, story = false, raw = false }) {
  const token = await getMetaToken(env.DB)
  const attempt = async (img) => {
    const cont = await graphPost(`${env.IG_USER_ID}/media`, {
      image_url: img,
      ...(story ? { media_type: 'STORIES' } : { caption }),
      access_token: token,
    })
    const pub = await publishWhenReady(env.IG_USER_ID, cont.id, token)
    return pub.id
  }
  if (raw) return attempt(imageUrl)
  // Cadena de fallback: blur propio → pad propio (solo historias: conserva el
  // banner DISPONIBLE) → padding blanco wsrv → URL original. Solo se cae al
  // siguiente eslabón ante errores de imagen/descarga; un rate-limit o token
  // vencido fallaría igual en todos y duplicaría llamadas.
  const best = maxResPicture(imageUrl)
  const cadena = [
    blurImageUrl(env.PUBLIC_URL, best, story),
    ...(story ? [padOwnImageUrl(env.PUBLIC_URL, best, story)] : []),
    padImageUrl(best, story),
    imageUrl,
  ]
  for (let i = 0; ; i++) {
    try {
      return await attempt(cadena[i])
    } catch (e) {
      if (i >= cadena.length - 1 || !esErrorDeImagen(e)) throw e
      log(`imagen falló (${e.message}); fallback ${i + 2}/${cadena.length}`)
    }
  }
}

const esErrorDeImagen = (e) => /image|photo|media|download|fetch|url/i.test(e.message) &&
  !/rate|limit|token|permission|oauth|not available/i.test(e.message)

// Cupo de publicación por API de Meta (ventana móvil de 24 h). Verificado
// 2026-07-16 en @topwheels.cl: quota_total=100 y las HISTORIAS también cuentan.
export async function fetchPublishingQuota(env) {
  const token = await getMetaToken(env.DB)
  const r = await fetch(`${GRAPH}/${env.IG_USER_ID}/content_publishing_limit?fields=quota_usage,config&access_token=${encodeURIComponent(token)}`)
  const data = await r.json()
  if (!r.ok || data.error) throw new Error(data.error?.message || `quota ${r.status}`)
  const q = data.data?.[0]
  return { usados: q?.quota_usage ?? 0, total: q?.config?.quota_total ?? 25 }
}

// Seguidores conectados por hora (metric online_followers). La API entrega un
// valor por día; se suman los días devueltos. null si la cuenta aún no da datos.
export async function fetchOnlineFollowers(env) {
  const token = await getMetaToken(env.DB)
  const url = `${GRAPH}/${env.IG_USER_ID}/insights?metric=online_followers&period=lifetime&access_token=${encodeURIComponent(token)}`
  const r = await fetch(url)
  const data = await r.json()
  if (!r.ok || data.error) throw new Error(data.error?.message || `insights ${r.status}`)
  const values = data.data?.[0]?.values
  if (!values?.length) return null
  const hourly = {}
  for (const v of values) for (const [h, n] of Object.entries(v.value || {}))
    hourly[h] = (hourly[h] || 0) + (Number(n) || 0)
  return Object.keys(hourly).length ? hourly : null
}

// Renueva el token de larga duración si tiene más de 45 días. true si renovó.
export async function maybeRefreshMetaToken(env) {
  const row = await env.DB.prepare('SELECT valor FROM ig_config WHERE clave=?').bind('meta_token').first()
  if (!row) throw new Error('sin token de Meta (seed ig_config.meta_token)')
  const { token, obtenido_en } = JSON.parse(row.valor)
  if (Date.now() - Date.parse(obtenido_en) < REFRESH_AFTER_MS) return false
  const url = `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token` +
    `&client_id=${encodeURIComponent(env.META_APP_ID)}&client_secret=${encodeURIComponent(env.META_APP_SECRET)}` +
    `&fb_exchange_token=${encodeURIComponent(token)}`
  const r = await fetch(url)
  const data = await r.json()
  if (!r.ok || data.error || !data.access_token) throw new Error(data.error?.message || 'no se pudo renovar el token')
  await saveMetaToken(env.DB, data.access_token)
  log('token de Meta renovado')
  return true
}
