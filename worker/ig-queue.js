/**
 * [IG] Cola de publicaciones a Instagram y orquestación de los crons.
 * runIgPublisher: corre cada 15 min. Dos modos:
 *  - goteo automático (/ig auto N): 1 producto cada N min, 09:00–23:00 Chile,
 *    hasta vaciar la cola (corridas cortas = confiables);
 *  - ventanas (clásico): una corrida por ventana óptima, tope 3 productos.
 * Robustez anti-duplicados (post-mortem 2026-07-15): claim atómico por fila
 * (estado 'publicando'), feed idempotente (ig_media_id se guarda apenas sale),
 * historia best-effort (su fallo no repite el feed), lock entre corridas y
 * recuperación de filas colgadas si el Worker muere a mitad de una corrida.
 * runIgDaily: recalcula ventanas desde insights y renueva el token de Meta.
 * enqueueStock: carga inicial con el inventario activo ya publicado en ML.
 */
import { buildCaption, windowKey, pickBestWindows, enHorarioAuto, horaChile, FALLBACK_WINDOWS } from './ig-logic.js'
import { igPublishImage, fetchOnlineFollowers, fetchPublishingQuota, maybeRefreshMetaToken } from './ig-api.js'
import { mlFetch } from './ml-fetch.js'

const MAX_POR_VENTANA = 3
const MAX_INTENTOS = 3
const log    = (...a) => console.log('[IG]', ...a)
const logErr = (...a) => console.error('[IG]', ...a)

async function getConfig(db, clave) {
  const row = await db.prepare('SELECT valor FROM ig_config WHERE clave=?').bind(clave).first()
  return row ? JSON.parse(row.valor) : null
}
const setConfig = (db, clave, obj) =>
  db.prepare('REPLACE INTO ig_config (clave, valor) VALUES (?, ?)').bind(clave, JSON.stringify(obj)).run()

export async function enqueueIg(env, { mlItemId, titulo, precio, permalink }) {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO ig_queue (ml_item_id, titulo, precio, permalink_ml) VALUES (?, ?, ?, ?)')
    .bind(mlItemId, titulo, Math.round(Number(precio)) || 0, permalink || null).run()
}

export async function listPendientes(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM ig_queue WHERE estado='pendiente' ORDER BY id LIMIT 50").all()
  return results || []
}

export async function quitarDeCola(env, id) {
  const r = await env.DB.prepare(
    "UPDATE ig_queue SET estado='cancelado' WHERE id=? AND estado='pendiente'").bind(Number(id)).run()
  return (r.meta?.changes ?? 0) > 0
}

export async function vaciarCola(env) {
  const r = await env.DB.prepare(
    "UPDATE ig_queue SET estado='cancelado' WHERE estado='pendiente'").run()
  return r.meta?.changes ?? 0
}

export async function getVentanas(env) {
  const manual = await getConfig(env.DB, 'ventanas_manual')
  if (manual?.horas?.length) return { horas: manual.horas, origen: 'manual' }
  const auto = await getConfig(env.DB, 'ventanas')
  if (auto?.horas?.length) return { horas: auto.horas, origen: auto.origen || 'insights' }
  return { horas: FALLBACK_WINDOWS, origen: 'fallback' }
}

export async function isPausado(env) {
  return !!(await getConfig(env.DB, 'pausado'))
}

// Modo automático. Dos variantes (null = modo ventanas clásico):
//  - goteo: {intervalo_min}: 1 producto cada N minutos;
//  - rush:  {rush:true}: 3 productos por tick del cron hasta llenar el cupo
//    diario de Meta (consultado en vivo), avisando cuándo se reabre.
// Ambas solo entre 09:00 y 23:00 Chile, hasta vaciar la cola.
export async function getAuto(env) {
  return getConfig(env.DB, 'modo_auto')
}
export async function setAuto(env, intervaloMin) {
  if (!intervaloMin) return env.DB.prepare("DELETE FROM ig_config WHERE clave='modo_auto'").run()
  return setConfig(env.DB, 'modo_auto', { intervalo_min: intervaloMin, desde: new Date().toISOString() })
}
export async function setRush(env) {
  return setConfig(env.DB, 'modo_auto', { rush: true, desde: new Date().toISOString() })
}

// Cuántos del cupo de Meta se reservan para acciones manuales (/ig promo).
export const RUSH_RESERVA = 4
const RUSH_POR_TICK = 3

// 'YYYY-MM-DD HH:MM:SS' (D1, UTC) o ISO → epoch ms.
function parseDbUtc(s) {
  const t = String(s).replace(' ', 'T')
  return Date.parse(t.endsWith('Z') ? t : t + 'Z')
}

// Cupo lleno: estima cuándo se libera (el post más viejo dentro de la ventana
// móvil de 24 h expira a las +24 h) y avisa UNA vez por episodio (el flag
// rush_avisado se borra al volver a publicar).
async function avisarCupoLleno(env, now, quota, notify) {
  if (await getConfig(env.DB, 'rush_avisado')) return
  const row = await env.DB.prepare(
    "SELECT MIN(publicado_en) m FROM ig_queue WHERE publicado_en > datetime('now','-24 hours')").first()
  const reabre = new Date((row?.m ? parseDbUtc(row.m) + 24 * 3600e3 : now.getTime() + 3600e3) + 5 * 60e3)
  const fueraDeHorario = !enHorarioAuto(reabre)
  await setConfig(env.DB, 'rush_avisado', { reabre: reabre.toISOString() })
  await notify(`🚦 Cupo diario de Meta lleno (${quota.usados}/${quota.total} en 24 h). ` +
    `El rush retoma solo ~${horaChile(reabre)}${fueraDeHorario ? ' (ajustado al horario 09:00–23:00)' : ''} hora de Chile. No tienes que hacer nada.`)
}

// ¿Le toca publicar al goteo? Compara contra la última publicación real
// (MAX(publicado_en), UTC) con 5 min de gracia para que el redondeo a ticks
// del cron no corra el intervalo hacia arriba.
async function tocaGotear(env, now, intervaloMin) {
  if (!enHorarioAuto(now)) return false
  const row = await env.DB.prepare('SELECT MAX(publicado_en) m FROM ig_queue').first()
  if (!row?.m) return true
  return now.getTime() - parseDbUtc(row.m) >= (intervaloMin - 5) * 60000
}

export async function setPausado(env, on) {
  if (on) return setConfig(env.DB, 'pausado', { desde: new Date().toISOString() })
  await env.DB.prepare("DELETE FROM ig_config WHERE clave='pausado'").run()
}

// Import dinámico para no arrastrar index.js (y todo el worker) a los unit tests.
async function getMlToken(env) {
  const { getValidAccessToken } = await import('./index.js')
  return getValidAccessToken(env)
}

async function getItemDefault(env, mlItemId) {
  const token = await getMlToken(env)
  const r = await mlFetch(`https://api.mercadolibre.com/items/${mlItemId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return r.json()
}

// Lock consultivo entre corridas (cron + /ig ahora): evita que dos corridas
// trabajen a la vez. No es atómico, pero el claim por fila de abajo sí lo es,
// así que aun en el peor caso no puede haber publicaciones duplicadas.
const LOCK_TTL_MS = 5 * 60 * 1000
async function acquireLock(env) {
  const lock = await getConfig(env.DB, 'corriendo')
  if (lock?.hasta && Date.parse(lock.hasta) > Date.now()) return false
  await setConfig(env.DB, 'corriendo', { hasta: new Date(Date.now() + LOCK_TTL_MS).toISOString() })
  return true
}
const releaseLock = env => env.DB.prepare("DELETE FROM ig_config WHERE clave='corriendo'").run()

// Toma atómicamente la próxima fila pendiente (estado='publicando' + intento
// contado). Con esto, dos corridas en paralelo NUNCA publican el mismo ítem.
async function claimNext(env) {
  return env.DB.prepare(
    `UPDATE ig_queue SET estado='publicando', intentos=intentos+1, claimed_en=datetime('now')
     WHERE id=(SELECT id FROM ig_queue WHERE estado='pendiente' ORDER BY id LIMIT 1)
     RETURNING *`).first()
}

// Filas que quedaron en 'publicando' porque el Worker murió a mitad de una
// corrida vuelven a 'pendiente' (el feed ya subido NO se repite: queda en
// ig_media_id y publicarFila lo salta).
async function recoverStuck(env) {
  await env.DB.prepare(
    `UPDATE ig_queue SET estado='pendiente'
     WHERE estado='publicando' AND claimed_en < datetime('now', '-15 minutes')`).run()
}

// Publica UNA fila ya reclamada: feed idempotente (si un intento anterior ya
// lo subió, no se repite) + historia best-effort (su fallo no repite el feed).
async function publicarFila(env, row, { publishImage, getItem, notify }) {
  const item = await getItem(env, row.ml_item_id)
  if (item.status !== 'active') {
    await env.DB.prepare("UPDATE ig_queue SET estado='cancelado' WHERE id=?").bind(row.id).run()
    log(`${row.ml_item_id} ya no está activo (${item.status}) → cancelado`)
    return false
  }
  const foto = item.pictures?.[0]?.secure_url
  if (!foto) throw new Error('el ítem no tiene fotos en ML')

  let feedId = row.ig_media_id
  if (!feedId) {
    feedId = await publishImage(env, { imageUrl: foto, caption: buildCaption({ titulo: row.titulo, precio: row.precio }) })
    await env.DB.prepare('UPDATE ig_queue SET ig_media_id=? WHERE id=?').bind(feedId, row.id).run()
  }

  let storyId = row.ig_story_id, storyErr = null
  if (!storyId) {
    try {
      storyId = await publishImage(env, { imageUrl: foto, story: true })
      await env.DB.prepare('UPDATE ig_queue SET ig_story_id=? WHERE id=?').bind(storyId, row.id).run()
    } catch (e) {
      storyErr = e.message
      logErr(row.ml_item_id, 'historia:', e.message)
    }
  }

  await env.DB.prepare(
    "UPDATE ig_queue SET estado='publicado', publicado_en=datetime('now'), ultimo_error=? WHERE id=?")
    .bind(storyErr && `historia: ${storyErr.slice(0, 290)}`, row.id).run()
  await notify(storyErr
    ? `📸 Subido a IG: ${row.titulo} (solo feed; la historia falló: ${storyErr})`
    : `📸 Subido a IG: ${row.titulo} (feed + historia)`)
  return true
}

export async function runIgPublisher(env, { force = false, now = new Date(), notify = async () => {}, deps = {}, max = MAX_POR_VENTANA } = {}) {
  if (await isPausado(env)) return { publicados: 0, pausado: true }
  const publishImage = deps.publishImage || igPublishImage
  const getItem      = deps.getItem      || getItemDefault
  const { horas } = await getVentanas(env)

  let auto = null
  if (!force) {
    auto = await getAuto(env)
    if (auto?.rush) {
      // Modo rush: exprime el cupo diario de Meta en tandas cortas de 3 por
      // tick (corridas largas en un solo invoke morían a mitad de camino).
      if (!enHorarioAuto(now)) return { publicados: 0 }
      const quota = await (deps.getQuota || fetchPublishingQuota)(env)
      const cupo = Math.floor((quota.total - quota.usados - RUSH_RESERVA) / 2) // feed+historia = 2
      if (cupo < 1) {
        await avisarCupoLleno(env, now, quota, notify)
        return { publicados: 0, cupoLleno: true }
      }
      max = Math.min(RUSH_POR_TICK, cupo)
    } else if (auto?.intervalo_min) {
      // Modo goteo: 1 por tick del cron, cada intervalo_min minutos.
      if (!(await tocaGotear(env, now, auto.intervalo_min))) return { publicados: 0 }
      max = 1
    } else {
      const key = windowKey(now, horas)
      if (!key) return { publicados: 0 }
      const ultima = await getConfig(env.DB, 'ultima_corrida')
      if (ultima?.key === key) return { publicados: 0 } // ya corrió en esta ventana
      await setConfig(env.DB, 'ultima_corrida', { key })
    }
  }

  if (!(await acquireLock(env))) return { publicados: 0, enCurso: true }
  let publicados = 0
  try {
    await recoverStuck(env)
    for (let i = 0; i < max; i++) {
      if (await isPausado(env)) return { publicados, pausado: true }
      const row = await claimNext(env)
      if (!row) break
      try {
        if (await publicarFila(env, row, { publishImage, getItem, notify })) publicados++
      } catch (e) {
        // Fallo del feed (o de ML): la fila vuelve a pendiente, o a error al 3er intento.
        // row.intentos ya viene incrementado por el claim.
        logErr(row.ml_item_id, e.message)
        await env.DB.prepare(
          "UPDATE ig_queue SET ultimo_error=?, estado=CASE WHEN intentos>=" + MAX_INTENTOS +
          " THEN 'error' ELSE 'pendiente' END WHERE id=?").bind(e.message.slice(0, 300), row.id).run()
        if (row.intentos >= MAX_INTENTOS) await notify(`❌ IG: "${row.titulo}" falló ${MAX_INTENTOS} veces y quedó en error: ${e.message}`)
      }
    }
  } finally {
    await releaseLock(env)
  }
  if (auto && publicados > 0) {
    await env.DB.prepare("DELETE FROM ig_config WHERE clave='rush_avisado'").run()
    const resto = await env.DB.prepare("SELECT COUNT(*) n FROM ig_queue WHERE estado='pendiente'").first()
    if (!resto?.n) await notify('📭 Modo automático: la cola de Instagram quedó vacía. Recargar: /ig stock')
  }
  return { publicados }
}

// Carga inicial: encola todo el inventario activo de ML que no esté ya en la
// cola (o publicado). La cola lo gotea a MAX_POR_VENTANA por ventana.
export async function enqueueStock(env, deps = {}) {
  const getToken = deps.getToken || (() => getMlToken(env))
  const doFetch  = deps.mlFetch  || mlFetch
  const token = await getToken()
  const auth = { headers: { Authorization: `Bearer ${token}` } }
  const ids = []
  for (let offset = 0; ; offset += 50) {
    const r = await doFetch(`https://api.mercadolibre.com/users/${env.SELLER_ID}/items/search?status=active&limit=50&offset=${offset}`, auth)
    const data = await r.json()
    ids.push(...(data.results || []))
    if (ids.length >= (data.paging?.total || 0) || !(data.results || []).length) break
  }
  let encolados = 0
  for (let i = 0; i < ids.length; i += 20) {
    const r = await doFetch(`https://api.mercadolibre.com/items?ids=${ids.slice(i, i + 20).join(',')}&attributes=id,title,price,permalink,status`, auth)
    const lote = await r.json()
    for (const it of Array.isArray(lote) ? lote : []) {
      const b = it.body
      if (b?.status !== 'active') continue
      const res = await env.DB.prepare(
        `INSERT INTO ig_queue (ml_item_id, titulo, precio, permalink_ml) VALUES (?, ?, ?, ?)
         ON CONFLICT(ml_item_id) DO UPDATE SET estado='pendiente', intentos=0, ultimo_error=NULL,
           titulo=excluded.titulo, precio=excluded.precio, permalink_ml=excluded.permalink_ml
         WHERE ig_queue.estado='cancelado'`)
        .bind(b.id, b.title, Math.round(Number(b.price)) || 0, b.permalink || null).run()
      encolados += (res.meta?.changes ?? 0)
    }
  }
  log(`enqueueStock: ${ids.length} activos, ${encolados} encolados nuevos`)
  return { total: ids.length, encolados }
}

export async function runIgDaily(env, notify = async () => {}) {
  try {
    const hourly = await fetchOnlineFollowers(env)
    const horas = hourly ? pickBestWindows(hourly) : FALLBACK_WINDOWS
    await setConfig(env.DB, 'ventanas', {
      horas, origen: hourly ? 'insights' : 'fallback', calculado_en: new Date().toISOString(),
    })
    log('ventanas del día:', horas.join(', '), hourly ? '(insights)' : '(fallback)')
  } catch (e) {
    logErr('insights:', e.message)
    await notify(`⚠️ IG: no pude calcular las ventanas de hoy (${e.message}); sigo con las últimas conocidas.`)
  }
  try {
    await maybeRefreshMetaToken(env)
  } catch (e) {
    logErr('token:', e.message)
    await notify(`⚠️ IG: falló la renovación del token de Meta: ${e.message}`)
  }
}
