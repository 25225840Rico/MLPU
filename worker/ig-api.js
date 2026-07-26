/**
 * [IG] Cliente de la Instagram Graph API (Meta).
 * El token de larga duración vive en D1 (ig_config.meta_token) porque el
 * Worker no puede escribir secrets; se renueva vía fb_exchange_token.
 */

import { maxResPicture, blurImageUrl, liteImageUrl, cloudinaryBlurUrl } from './ig-logic.js'
import { gastar, restante } from './ig-budget.js'

// #3: había DOS versiones conviviendo (v21.0 aquí, v25.0 en igDeleteMedia).
// v25.0 es la vigente; las versiones antiguas se van deprecando en bloque
// (v20.0 caduca el 24-sep-2026) y una llamada contra una versión muerta
// devuelve error 2635 sin previo aviso. Una sola constante para todo el módulo.
const GRAPH = 'https://graph.facebook.com/v25.0'
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
  gastar()
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
// Hasta ~65 s: las imágenes compuestas (blur 1080x1920) tardan más que los
// 15 s del poll original, que terminaba en "Media ID is not available".
//
// RENDIMIENTO (2026-07-26). Antes: 30 polls a 2 s fijos. Eso costaba dos cosas:
//  - latencia: el caso normal (Cloudinary ya tiene la imagen, Meta la procesa en
//    ~1-2 s) igual esperaba 2 s completos antes de la primera consulta;
//  - presupuesto: 30 polls + crear + publicar = 32 subrequests por IMAGEN, y una
//    fila publica dos (feed + historia) = 64 > los 50 del plan Free. Una sola
//    imagen lenta reventaba la invocación entera y mataba la corrida.
// Ahora la espera arranca en 0,5 s y crece (0,5 → 1 → 2 → 4 → 8 s): el caso
// normal responde ~4 veces más rápido y el peor caso cubre los mismos ~65 s con
// 12 consultas en vez de 30 (14 subrequests por imagen). Además se corta si el
// presupuesto de la invocación se agota: mejor intentar publicar con lo que hay
// —media_publish tiene su propio reintento— que morir por exceso de subrequests.
const POLL_PLAN_MS = [500, 1000, 2000, 4000, 8000]
const MAX_POLLS = 12
const RESERVA_PUBLICAR = 3   // create + publish + un reintento
let POLL_MS = null
export const _setPollMs = ms => { POLL_MS = ms } // solo para tests (espera fija)
const esperaPoll = i => POLL_MS ?? POLL_PLAN_MS[Math.min(i, POLL_PLAN_MS.length - 1)]

async function waitForContainer(contId, token) {
  for (let i = 0; i < MAX_POLLS; i++) {
    if (restante() <= RESERVA_PUBLICAR) {
      log(`presupuesto de subrequests casi agotado; dejo de consultar ${contId} y publico igual`)
      return
    }
    gastar()
    const r = await fetch(`${GRAPH}/${contId}?fields=status_code&access_token=${encodeURIComponent(token)}`)
    const data = await r.json().catch(() => ({}))
    if (data.status_code === 'IN_PROGRESS') { await sleep(esperaPoll(i)); continue }
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
  // Cadena de fallback (2026-07-17): Cloudinary primero — mismo efecto blur +
  // banner pero SIN CPU del Worker, porque el compositor propio excede el
  // límite del plan Free (error 1102) bajo carga sostenida y Meta recibía
  // texto en vez de JPEG ("Only photo or video can be accepted"). Después el
  // compositor propio (blur → lite) y, como último salvavidas, la URL original
  // (sin blur: mejor publicar que dejar la fila en error). Solo se cae al
  // siguiente eslabón ante errores de imagen/descarga; un rate-limit o token
  // vencido fallaría igual en todos y duplicaría llamadas.
  const best = maxResPicture(imageUrl)
  // #1: el compositor propio (/ig/img) solo acepta fotos de mlstatic.com — es
  // una whitelist deliberada, no un descuido: abrirla lo convertiría en un proxy
  // de imágenes abierto y reviviría el error 1102 de CPU que obligó a migrar a
  // Cloudinary. Con las filas de fuente 'drive' (foto servida por el propio
  // Worker) esos dos eslabones devolvían 403 SIEMPRE: Meta contestaba "Media
  // download failed" y se quemaban dos contenedores y dos esperas por imagen
  // antes de llegar al eslabón útil. Para URLs que no son de ML la cadena es
  // Cloudinary (sí sabe traer cualquier URL pública) → original.
  const esML = /(^|\.)mlstatic\.com$/.test(hostDe(best))
  const cadena = [
    ...(env.CLOUDINARY_CLOUD ? [cloudinaryBlurUrl(env.CLOUDINARY_CLOUD, best, story)] : []),
    ...(esML ? [blurImageUrl(env.PUBLIC_URL, best, story), liteImageUrl(env.PUBLIC_URL, best, story)] : []),
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

const hostDe = u => { try { return new URL(u).hostname } catch { return '' } }

// Borra un media de IG (post, historia o reel). Soportado por la Graph API
// con Facebook Login (DELETE /<media_id>); requiere que el token tenga el
// permiso instagram_manage_contents. Las historias expiran solas a las 24 h,
// así que solo tiene sentido para historias "vivas".
export async function igDeleteMedia(env, mediaId) {
  const token = await getMetaToken(env.DB)
  gastar()
  const r = await fetch(`${GRAPH}/${mediaId}?access_token=${encodeURIComponent(token)}`,
    { method: 'DELETE' })
  const data = await r.json().catch(() => ({}))
  if (!r.ok || data.error) throw new Error(data.error?.message || `delete ${r.status}`)
  return true
}

// Interacciones (likes + comentarios) de posts del feed, en lotes de hasta 50
// ids por llamada (?ids=). Best-effort: un lote fallido deja esos ids sin dato
// (prioridad 0), no aborta el resto.
export async function fetchMediaInteractions(env, mediaIds) {
  const token = await getMetaToken(env.DB)
  const out = {}
  for (let i = 0; i < mediaIds.length; i += 50) {
    const chunk = mediaIds.slice(i, i + 50)
    gastar()
    const r = await fetch(`${GRAPH}/?ids=${chunk.join(',')}&fields=like_count,comments_count&access_token=${encodeURIComponent(token)}`)
    const data = await r.json().catch(() => ({}))
    if (!r.ok || data.error) { log('interacciones falló:', data.error?.message || r.status); continue }
    for (const id of chunk) {
      const m = data[id]
      if (m) out[id] = (m.like_count || 0) + (m.comments_count || 0)
    }
  }
  return out
}

// Cupo de publicación por API de Meta (ventana móvil de 24 h). Verificado
// 2026-07-16 en @topwheels.cl: quota_total=100 y las HISTORIAS también cuentan.
export async function fetchPublishingQuota(env) {
  const token = await getMetaToken(env.DB)
  gastar()
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
  gastar()
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
  gastar()
  const r = await fetch(url)
  const data = await r.json()
  if (!r.ok || data.error || !data.access_token) throw new Error(data.error?.message || 'no se pudo renovar el token')
  await saveMetaToken(env.DB, data.access_token)
  log('token de Meta renovado')
  return true
}
