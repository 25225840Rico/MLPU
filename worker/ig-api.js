/**
 * [IG] Cliente de la Instagram Graph API (Meta).
 * El token de larga duración vive en D1 (ig_config.meta_token) porque el
 * Worker no puede escribir secrets; se renueva vía fb_exchange_token.
 */

import { maxResPicture, padImageUrl, blurImageUrl } from './ig-logic.js'

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
let RETRY_BASE_MS = 1500
export const _setRetryBaseMs = ms => { RETRY_BASE_MS = ms } // solo para tests

// media_publish falla con "Media ID is not available" mientras Meta todavía
// procesa el contenedor: reintentar con espera creciente (hasta ~15 s en total).
async function publishWhenReady(igUserId, contId, token) {
  for (let i = 0; ; i++) {
    try {
      return await graphPost(`${igUserId}/media_publish`, { creation_id: contId, access_token: token })
    } catch (e) {
      if (i >= 4 || !/media id is not available|not ready|in progress/i.test(e.message)) throw e
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
  // Cadena: fondo blur propio → padding blanco wsrv → URL original. Solo se cae
  // al siguiente eslabón ante errores de imagen/descarga; un rate-limit o token
  // vencido fallaría igual en todos y duplicaría llamadas.
  const best = maxResPicture(imageUrl)
  try {
    return await attempt(blurImageUrl(env.PUBLIC_URL, best, story))
  } catch (e) {
    if (!esErrorDeImagen(e)) throw e
    log('fondo blur falló, reintento con padding blanco:', e.message)
    try {
      return await attempt(padImageUrl(best, story))
    } catch (e2) {
      if (!esErrorDeImagen(e2)) throw e2
      log('padding falló, reintento con la URL original:', e2.message)
      return attempt(imageUrl)
    }
  }
}

const esErrorDeImagen = (e) => /image|photo|media|download|fetch|url/i.test(e.message) &&
  !/rate|limit|token|permission|oauth|not available/i.test(e.message)

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
