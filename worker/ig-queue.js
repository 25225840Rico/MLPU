/**
 * [IG] Cola de publicaciones a Instagram y orquestación de los crons.
 * runIgPublisher: corre cada minuto. Tres modos:
 *  - rush (/ig rush): subida masiva inmediata — tandas cortas encadenadas
 *    (~2 productos/min) hasta llenar el cupo diario real de Meta; avisa la
 *    hora de reapertura y "duerme" hasta entonces sin gastar Graph API;
 *  - goteo (/ig auto N): 1 producto cada N min, hasta vaciar la cola;
 *  - ventanas (clásico): una corrida por ventana óptima, tope 3 productos.
 * Todos solo 09:00–23:00 Chile; corridas cortas = confiables.
 * Robustez anti-duplicados (post-mortem 2026-07-15): claim atómico por fila
 * (estado 'publicando'), feed idempotente (ig_media_id se guarda apenas sale),
 * historia best-effort (su fallo no repite el feed), lock entre corridas y
 * recuperación de filas colgadas si el Worker muere a mitad de una corrida.
 * runIgDaily: recalcula ventanas desde insights y renueva el token de Meta.
 * enqueueStock: carga inicial con el inventario activo ya publicado en ML.
 */
import { buildCaption, windowKey, pickBestWindows, enHorarioAuto, horaChile, FALLBACK_WINDOWS, esc } from './ig-logic.js'
import { igPublishImage, fetchOnlineFollowers, fetchPublishingQuota, maybeRefreshMetaToken, fetchMediaInteractions, igDeleteMedia } from './ig-api.js'
import { mlFetch } from './ml-fetch.js'
import { iniciarPresupuesto, hayPara, restante } from './ig-budget.js'

const MAX_POR_VENTANA = 3
const MAX_INTENTOS = 3
// Minutos tras los que una fila reclamada (estado='publicando') se considera
// colgada. Fuente de verdad del proyecto (CONTRATO 4.1): también lo documenta
// worker/schema-ig.sql y lo replica worker/test/fake-db.js. Nunca 15.
export const RECOVERY_MIN = 10
const log    = (...a) => console.log('[IG]', ...a)
const logErr = (...a) => console.error('[IG]', ...a)

async function getConfig(db, clave) {
  const row = await db.prepare('SELECT valor FROM ig_config WHERE clave=?').bind(clave).first()
  return row ? JSON.parse(row.valor) : null
}
const setConfig = (db, clave, obj) =>
  db.prepare('REPLACE INTO ig_config (clave, valor) VALUES (?, ?)').bind(clave, JSON.stringify(obj)).run()

// Foco de fuente para el publisher: si está seteado ('ml' o 'drive'), TODAS las
// corridas (rush, goteo, ventanas, /ig ahora) publican SOLO filas de esa fuente
// —claim y conteos filtrados— para subir un lote aislado (p.ej. el inventario
// propio de Google Drive) sin mezclarlo jamás con MercadoLibre. Se gestiona con
// /ig solo <fuente|off>. Whitelist estricta porque el valor se inyecta en SQL.
export const FUENTES = ['ml', 'drive']
export async function getFoco(env) {
  const f = await getConfig(env.DB, 'foco_fuente')
  return FUENTES.includes(f?.fuente) ? f.fuente : null
}
export async function setFoco(env, fuente) {
  if (fuente && !FUENTES.includes(fuente)) throw new Error(`fuente inválida: ${fuente}`)
  if (fuente) await setConfig(env.DB, 'foco_fuente', { fuente })
  else await env.DB.prepare("DELETE FROM ig_config WHERE clave='foco_fuente'").run()
}
// El foco viaja INTERPOLADO en el SQL (no bindeado) a propósito: varias de
// estas sentencias se ejecutan sin parámetros. Por eso pasa por la whitelist.
const focoWhere = foco => (FUENTES.includes(foco) ? ` AND fuente='${foco}'` : '')

export async function enqueueIg(env, { mlItemId, titulo, precio, permalink }) {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO ig_queue (ml_item_id, titulo, precio, permalink_ml) VALUES (?, ?, ?, ?)')
    .bind(mlItemId, titulo, Math.round(Number(precio)) || 0, permalink || null).run()
}

// foco opcional (CONTRATO 4.3): null = ambas fuentes. Con default para que
// telegram-bot.js siga funcionando igual hasta que L6 le pase el foco real.
export async function listPendientes(env, foco = null) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM ig_queue WHERE estado='pendiente'${focoWhere(foco)} ORDER BY id LIMIT 50`).all()
  return results || []
}

export async function quitarDeCola(env, id) {
  const r = await env.DB.prepare(
    "UPDATE ig_queue SET estado='cancelado' WHERE id=? AND estado='pendiente'").bind(Number(id)).run()
  return (r.meta?.changes ?? 0) > 0
}

// #10: con foco activo, /ig vaciar cancelaba TAMBIÉN la otra fuente (p.ej. las
// 55 filas de ML aisladas a propósito mientras se sube el lote de drive).
export async function vaciarCola(env, foco = null) {
  const r = await env.DB.prepare(
    `UPDATE ig_queue SET estado='cancelado' WHERE estado='pendiente'${focoWhere(foco)}`).run()
  // B14: sin esto, las filas realmente colgadas en 'publicando' volvían a
  // 'pendiente' en la corrida siguiente (recoverStuck) y publicaban algo que el
  // usuario acababa de cancelar. Las que una corrida VIVA acaba de reclamar
  // (claim < RECOVERY_MIN) no se tocan. Nota: esta mitad NO filtra por fuente
  // —una fila colgada es estado roto, se limpia siempre— (CONTRATO 4.2 #4).
  const colgadas = await env.DB.prepare(
    `UPDATE ig_queue SET estado='cancelado'
     WHERE estado='publicando' AND (claimed_en IS NULL OR claimed_en < datetime('now','-${RECOVERY_MIN} minutes'))`).run()
  return (r.meta?.changes ?? 0) + (colgadas.meta?.changes ?? 0)
}

// Devuelve a la cola las filas que quedaron en 'error' tras MAX_INTENTOS.
// Hasta ahora no había forma de rescatarlas: un corte de Cloudinary o un token
// vencido de un rato dejaba productos muertos para siempre, y eso es cantidad
// perdida. intentos=0 para que vuelvan a tener sus 3 oportunidades; ig_media_id
// se conserva, así que un feed que ya salió no se repite (idempotencia de
// publicarFila) y solo se reintenta lo que falta. Respeta el foco de fuente.
export async function reintentarErrores(env, foco = null) {
  const r = await env.DB.prepare(
    `UPDATE ig_queue SET estado='pendiente', intentos=0, ultimo_error=NULL
     WHERE estado='error'${focoWhere(foco)}`).run()
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

// CANTIDAD (2026-07-26): el cupo de Meta es de 100 publicaciones por 24 h y las
// HISTORIAS también cuentan (verificado en @topwheels.cl), así que publicar feed
// + historia por producto topea el día en ~48 productos. Apagando las historias
// el mismo cupo rinde ~96. Por defecto siguen ENCENDIDAS —el comportamiento de
// siempre— y se apagan a mano con /ig historias off cuando lo que importa es
// vaciar cola (p.ej. subir el inventario de Drive completo).
export async function getHistorias(env) {
  const c = await getConfig(env.DB, 'historias')
  return !c?.off
}
export async function setHistorias(env, on) {
  if (on) return env.DB.prepare("DELETE FROM ig_config WHERE clave='historias'").run()
  return setConfig(env.DB, 'historias', { off: true, desde: new Date().toISOString() })
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
// RENDIMIENTO (2026-07-26): era 3 y estaba puesto "a ojo" porque una fila podía
// gastar hasta 64 subrequests y reventar el límite de 50 del plan Free. Con el
// poll adaptativo (14 por imagen en el peor caso), el aviso agrupado por corrida
// y el corte por presupuesto de abajo, una fila típica gasta ~7 subrequests. Se
// sube a 6 y es el presupuesto —no una constante ciega— el que decide cuántas
// entran de verdad: el cupo diario de Meta se llena en ~8 ticks en vez de ~17.
// Exportada para que los tests midan contra ella y no contra un número copiado.
export const RUSH_POR_TICK = 6
// Subrequests que hay que tener disponibles para intentar una fila entera:
// ML(1) + feed crear/consultar/publicar(3) + historia(3) = 7, +2 de margen (el
// aviso de Telegram ya no cuenta por fila: sale uno solo al cerrar la corrida).
// Por debajo de esto la corrida termina y el tick siguiente —un minuto después—
// sigue con la cola intacta, en vez de morir a mitad de una publicación y dejar
// la fila reclamada 10 minutos.
const COSTO_FILA = 9

// 'YYYY-MM-DD HH:MM:SS' (D1, UTC) o ISO → epoch ms.
function parseDbUtc(s) {
  const t = String(s).replace(' ', 'T')
  return Date.parse(t.endsWith('Z') ? t : t + 'Z')
}

// Cupo lleno: estima cuándo se libera (el post más viejo dentro de la ventana
// móvil de 24 h expira a las +24 h), guarda la estimación en rush_avisado —que
// además hace de "siesta": hasta esa hora los ticks no consultan más a Meta— y
// avisa UNA vez por episodio (si el flag ya existía, solo corre la estimación
// en silencio). El flag se borra al volver a publicar.
async function avisarCupoLleno(env, now, quota, notify) {
  const previo = await getConfig(env.DB, 'rush_avisado')
  const row = await env.DB.prepare(
    "SELECT MIN(publicado_en) m FROM ig_queue WHERE publicado_en > datetime('now','-24 hours')").first()
  const reabre = new Date((row?.m ? parseDbUtc(row.m) + 24 * 3600e3 : now.getTime() + 3600e3) + 5 * 60e3)
  const flag = { reabre: reabre.toISOString() }
  if (previo) return setConfig(env.DB, 'rush_avisado', flag)  // re-estimación silenciosa
  const fueraDeHorario = !enHorarioAuto(reabre)
  const res = await notify(`🚦 Cupo diario de Meta lleno (${quota.usados}/${quota.total} en 24 h). ` +
    `El rush retoma solo ~${horaChile(reabre)}${fueraDeHorario ? ' (ajustado al horario 09:00–23:00)' : ''} hora de Chile. No tienes que hacer nada.`)
  // CONTRATO 4.6: el flag hace de "siesta" (los ticks siguientes ni consultan a
  // Meta), así que solo se persiste si el aviso REALMENTE salió. tgSend no lanza:
  // devuelve {ok:false}. Antes, un fallo de Telegram dormía el rush en silencio.
  if (res?.ok) await setConfig(env.DB, 'rush_avisado', flag)
}

// #4: la Graph API dejó de responder (token vencido, rate-limit, permiso caído).
// Avisa como máximo una vez por hora: el rush corre cada minuto y sin la guarda
// mandaría 60 mensajes iguales. Mismo criterio que arriba: el flag se persiste
// solo si el aviso salió de verdad, para no silenciar el problema por un fallo
// pasajero de Telegram.
const CUPO_ERROR_SILENCIO_MS = 3600e3
async function avisarFalloCupo(env, now, err, notify) {
  const previo = await getConfig(env.DB, 'cupo_error_avisado')
  if (previo?.hasta && Date.parse(previo.hasta) > now.getTime()) return
  const res = await notify(`⚠️ No puedo consultar el cupo de publicación de Meta: ${err.message}\n` +
    `El rush queda detenido hasta que se resuelva (reintenta solo cada minuto). ` +
    `Si el token expiró, usa /reauth.`)
  if (res?.ok) {
    await setConfig(env.DB, 'cupo_error_avisado',
      { hasta: new Date(now.getTime() + CUPO_ERROR_SILENCIO_MS).toISOString() })
  }
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

// deps solo para tests (en producción se usan getMlToken y mlFetch reales).
// #5: sin mirar r.ok, un 401/404/500 de ML devolvía un cuerpo con `status`
// NUMÉRICO que publicarFila leía como "ya no está activo" y cancelaba la fila
// para siempre, sin aviso. Ahora el error sube y la fila se reintenta.
export async function getItemDefault(env, mlItemId, deps = {}) {
  const token = await (deps.getToken ? deps.getToken() : getMlToken(env))
  const r = await (deps.mlFetch || mlFetch)(`https://api.mercadolibre.com/items/${mlItemId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!r.ok) throw new Error(`ML items/${mlItemId} HTTP ${r.status}`)
  return r.json()
}

// Lock consultivo entre corridas (cron + /ig ahora): evita que dos corridas
// trabajen a la vez. No es atómico, pero el claim por fila de abajo sí lo es,
// así que el FEED no puede duplicarse (ig_media_id lo protege).
//
// #11: el TTL era de 3 min y una corrida real dura más. Cota superior medida:
// waitForContainer son 30 polls × 2 s = 60 s por imagen, y cada fila publica
// feed + historia ≈ 140 s; con RUSH_POR_TICK=3 la corrida llega a ~7 min. El
// lock vencía a mitad, el tick siguiente arrancaba una segunda corrida en
// paralelo y la historia —que no tiene la protección de ig_media_id— salía
// dos veces, quedando una huérfana 24 h porque borrarHistorias solo conoce el
// último id. 15 min cubre el peor caso con margen, y sigue por encima de
// RECOVERY_MIN (10) para que al expirar el lock las filas colgadas ya
// califiquen para recuperación.
const LOCK_TTL_MS = 15 * 60 * 1000
async function acquireLock(env) {
  const lock = await getConfig(env.DB, 'corriendo')
  if (lock?.hasta && Date.parse(lock.hasta) > Date.now()) return false
  await setConfig(env.DB, 'corriendo', { hasta: new Date(Date.now() + LOCK_TTL_MS).toISOString() })
  return true
}
const releaseLock = env => env.DB.prepare("DELETE FROM ig_config WHERE clave='corriendo'").run()

// Toma atómicamente la próxima fila pendiente (estado='publicando' + intento
// contado). Con esto, dos corridas en paralelo NUNCA publican el mismo ítem.
// Orden: prioridad DESC (interacciones del feed, ver requeueStories) y luego id.
async function claimNext(env, foco = null) {
  return env.DB.prepare(
    `UPDATE ig_queue SET estado='publicando', intentos=intentos+1, claimed_en=datetime('now')
     WHERE id=(SELECT id FROM ig_queue WHERE estado='pendiente'${focoWhere(foco)} ORDER BY prioridad DESC, id LIMIT 1)
     RETURNING *`).first()
}

// Filas que quedaron en 'publicando' porque el Worker murió a mitad de una
// corrida vuelven a 'pendiente' (el feed ya subido NO se repite: queda en
// ig_media_id y publicarFila lo salta).
// #9: hay que contemplar claimed_en NULL explícitamente. En SQLite `NULL < x`
// es NULL (no true), así que las filas que quedaron en 'publicando' antes de
// que existiera la columna (ALTER TABLE del 2026-07-16, ver schema-ig.sql)
// jamás se recuperaban y encima eran invisibles para /ig cola.
async function recoverStuck(env) {
  await env.DB.prepare(
    `UPDATE ig_queue SET estado='pendiente'
     WHERE estado='publicando' AND (claimed_en IS NULL OR claimed_en < datetime('now', '-${RECOVERY_MIN} minutes'))`).run()
}

// Publica UNA fila ya reclamada: feed idempotente (si un intento anterior ya
// lo subió, no se repite) + historia best-effort (su fallo no repite el feed).
async function publicarFila(env, row, { publishImage, getItem, notify, conHistoria = true }) {
  // Fuente 'drive' = inventario propio (fotos en Google Drive, sin ML): la foto
  // se sirve por el proxy del Worker y el caption ya viene armado en la fila; no
  // se consulta ML. El resto del flujo (feed idempotente + historia, cadena
  // blur/banner de publishImage) es idéntico al de los ítems de ML.
  const esDrive = row.fuente === 'drive'
  const item = esDrive
    ? { status: 'active', pictures: [{ secure_url: row.image_url }] }
    : await getItem(env, row.ml_item_id)
  if (item.status !== 'active') {
    await env.DB.prepare("UPDATE ig_queue SET estado='cancelado' WHERE id=?").bind(row.id).run()
    log(`${row.ml_item_id} ya no está activo (${item.status}) → cancelado`)
    return false
  }
  const foto = item.pictures?.[0]?.secure_url
  if (!foto) throw new Error(esDrive ? 'la fila drive no tiene image_url' : 'el ítem no tiene fotos en ML')

  const caption = row.caption || buildCaption({ titulo: row.titulo, precio: row.precio })
  const teniaFeed = !!row.ig_media_id  // re-historia: el feed no se repite
  let feedId = row.ig_media_id
  if (!feedId) {
    feedId = await publishImage(env, { imageUrl: foto, caption })
    await env.DB.prepare('UPDATE ig_queue SET ig_media_id=? WHERE id=?').bind(feedId, row.id).run()
  }

  let storyId = row.ig_story_id, storyErr = null
  if (!storyId && conHistoria) {
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
  // notify() termina en tgSend con parse_mode:'HTML': un título de ML con "&"
  // (hay varios: "Hot Wheels & Matchbox") hacía que Telegram rechazara el aviso
  // con 400 y la publicación quedaba invisible aunque hubiera salido bien.
  const t = esc(row.titulo), sErr = esc(storyErr)
  await notify(storyErr
    ? (teniaFeed ? `⚠️ IG: la historia de "${t}" falló: ${sErr}`
                 : `📸 Subido a IG: ${t} (solo feed; la historia falló: ${sErr})`)
    : !conHistoria ? `📸 Subido a IG: ${t} (solo feed — historias apagadas)`
    : (teniaFeed ? `📸 Historia re-subida a IG: ${t}`
                 : `📸 Subido a IG: ${t} (feed + historia)`))
  return true
}

export async function runIgPublisher(env, { force = false, now = new Date(), notify = async () => {}, deps = {}, max = MAX_POR_VENTANA } = {}) {
  if (await isPausado(env)) return { publicados: 0, pausado: true }
  // Presupuesto de subrequests de ESTA invocación (ver worker/ig-budget.js). Se
  // reinicia acá porque el isolate se reutiliza entre invocaciones del cron.
  iniciarPresupuesto()
  const publishImage = deps.publishImage || igPublishImage
  const getItem      = deps.getItem      || getItemDefault
  const { horas } = await getVentanas(env)
  const foco = await getFoco(env)  // null = ambas fuentes; 'drive'/'ml' = aislado
  const conHistoria = await getHistorias(env)  // off = el cupo de Meta rinde el doble

  let auto = null
  let ventanaKey = null   // B6: se persiste recién con el lock en la mano
  let lockTomado = false
  if (!force) {
    auto = await getAuto(env)
    if (auto?.rush) {
      // Modo rush: subida masiva inmediata. El cron corre cada minuto y cada
      // tick sube una tanda corta (corridas largas en un solo invoke morían a
      // mitad de camino): encadenados dan ~2 productos/min hasta llenar el
      // cupo diario de Meta. Guardas baratas primero para que los ticks
      // sobrantes no le peguen a la Graph API.
      if (!enHorarioAuto(now)) return { publicados: 0 }
      const pend = await env.DB.prepare("SELECT COUNT(*) n FROM ig_queue WHERE estado='pendiente'" + focoWhere(foco)).first()
      if (!pend?.n) return { publicados: 0 }
      const siesta = await getConfig(env.DB, 'rush_avisado')
      if (siesta?.reabre && Date.parse(siesta.reabre) > now.getTime()) return { publicados: 0, cupoLleno: true }
      // EFICIENCIA (2026-07-26): el lock se tomaba DESPUÉS de consultar el cupo,
      // así que mientras una corrida trabajaba (varios minutos) cada tick del
      // cron le pegaba igual a la Graph API para después irse por 'enCurso':
      // ~60 llamadas perdidas por hora contra el rate limit de Meta (200/h).
      // Ahora el tick que no tiene el lock se va antes de tocar la red.
      if (!(await acquireLock(env))) return { publicados: 0, enCurso: true }
      lockTomado = true
      // #4: fetchPublishingQuota lanza con el token de Meta vencido o rate-limit.
      // Como el rush corre CADA MINUTO dentro de un waitUntil sin .catch, esa
      // excepción se perdía y la cola quedaba congelada para siempre mientras el
      // panel seguía diciendo "🔥 RUSH activo". Ahora avisa (una vez por hora,
      // para no spamear 60 veces) y se detiene sin publicar.
      let quota
      try {
        quota = await (deps.getQuota || fetchPublishingQuota)(env)
      } catch (e) {
        await releaseLock(env)   // el lock ya es nuestro: soltarlo en cada salida
        await avisarFalloCupo(env, now, e, notify)
        return { publicados: 0, errorCupo: true }
      }
      // Cada producto gasta 2 unidades del cupo (feed + historia) o 1 si las
      // historias están apagadas: ahí el mismo cupo diario rinde el doble.
      const cupo = Math.floor((quota.total - quota.usados - RUSH_RESERVA) / (conHistoria ? 2 : 1))
      if (cupo < 1) {
        await releaseLock(env)
        await avisarCupoLleno(env, now, quota, notify)
        return { publicados: 0, cupoLleno: true }
      }
      // Sin historias cada fila gasta la mitad de subrequests (no hay segunda
      // imagen que crear, esperar y publicar), así que entran el doble por tick.
      // Igual manda el presupuesto: si no alcanzan, la corrida corta sola.
      max = Math.min(RUSH_POR_TICK * (conHistoria ? 1 : 2), cupo)
    } else if (auto?.intervalo_min) {
      // Modo goteo: 1 por tick del cron, cada intervalo_min minutos.
      if (!(await tocaGotear(env, now, auto.intervalo_min))) return { publicados: 0 }
      max = 1
    } else {
      // B3: la rama de ventanas era la única que no miraba el horario permitido
      // (el rush lo hace arriba y el goteo dentro de tocaGotear). Con ventanas
      // manuales o de insights de madrugada, el cron publicaba a las 02:00.
      if (!enHorarioAuto(now)) return { publicados: 0 }
      const key = windowKey(now, horas)
      if (!key) return { publicados: 0 }
      const ultima = await getConfig(env.DB, 'ultima_corrida')
      if (ultima?.key === key) return { publicados: 0 } // ya corrió en esta ventana
      ventanaKey = key
    }
  }

  if (!lockTomado && !(await acquireLock(env))) return { publicados: 0, enCurso: true }
  // B6: marcar la ventana solo si esta corrida es la que va a trabajar; si se
  // hacía antes del lock, un tick que perdía el lock quemaba la ventana entera.
  if (ventanaKey) await setConfig(env.DB, 'ultima_corrida', { key: ventanaKey })

  // EFICIENCIA (2026-07-26): cada fila mandaba su propio mensaje de Telegram, o
  // sea 6 subrequests y 6 notificaciones por minuto durante un rush. Los avisos
  // de publicación se acumulan y salen en UNO al cerrar la corrida; con una sola
  // fila (goteo/ventanas) el mensaje es idéntico al de antes. Los errores NO
  // pasan por acá: siguen saliendo al instante, que es cuando importan.
  const avisos = []
  const notifyLote = async t => { avisos.push(t); return { ok: true } }
  const volcarAvisos = async () => {
    if (!avisos.length) return
    const texto = avisos.length === 1
      ? avisos[0]
      : `🚀 IG · ${avisos.length} publicaciones en esta tanda:\n${avisos.join('\n')}`
    avisos.length = 0
    try { await notify(texto) } catch (e) { logErr('aviso de tanda:', e.message) }
  }

  let publicados = 0
  try {
    await recoverStuck(env)
    for (let i = 0; i < max; i++) {
      if (await isPausado(env)) return { publicados, pausado: true }
      // Corte por presupuesto: si no alcanza para una fila entera, se termina la
      // corrida ANTES de reclamarla. Así la fila queda 'pendiente' y la toma el
      // tick siguiente, en vez de que Cloudflare mate la invocación a mitad de
      // publicar y la fila quede reclamada hasta que la rescate recoverStuck.
      const costoFila = conHistoria ? COSTO_FILA : COSTO_FILA - 3  // sin historia: una imagen menos
      if (i > 0 && !hayPara(costoFila)) {
        log(`corto la corrida: quedan ${restante()} subrequests, una fila necesita ~${costoFila}`)
        break
      }
      const row = await claimNext(env, foco)
      if (!row) break
      try {
        if (await publicarFila(env, row, { publishImage, getItem, notify: notifyLote, conHistoria })) publicados++
      } catch (e) {
        // Fallo del feed (o de ML): la fila vuelve a pendiente, o a error al 3er intento.
        // row.intentos ya viene incrementado por el claim.
        logErr(row.ml_item_id, e.message)
        await env.DB.prepare(
          "UPDATE ig_queue SET ultimo_error=?, estado=CASE WHEN intentos>=" + MAX_INTENTOS +
          " THEN 'error' ELSE 'pendiente' END WHERE id=?").bind(e.message.slice(0, 300), row.id).run()
        if (row.intentos >= MAX_INTENTOS) await notify(`❌ IG: "${esc(row.titulo)}" falló ${MAX_INTENTOS} veces y quedó en error: ${esc(e.message)}`)
      }
    }
  } finally {
    await releaseLock(env)
    // En el finally para que la tanda se avise igual si la corrida sale por
    // 'pausado' o revienta a mitad: lo ya publicado siempre se reporta.
    await volcarAvisos()
  }
  if (auto && publicados > 0) {
    await env.DB.prepare("DELETE FROM ig_config WHERE clave='rush_avisado'").run()
    const resto = await env.DB.prepare("SELECT COUNT(*) n FROM ig_queue WHERE estado='pendiente'" + focoWhere(foco)).first()
    // El comando de recarga depende del foco: /ig stock SOLO carga el inventario
    // de ML; la cola de 'drive' se recarga aplicando worker/seed-hw.sql (B16).
    if (!resto?.n) await notify(foco === 'drive'
      ? '📭 Modo automático: la cola de Instagram (fuente drive) quedó vacía. Para recargarla hay que aplicar worker/seed-hw.sql a D1.'
      : '📭 Modo automático: la cola de Instagram quedó vacía. Recargar: /ig stock')
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
    if (!r.ok) throw new Error(`ML ${r.status}`)   // B15: un 401 decía "0 activos en ML"
    const data = await r.json()
    ids.push(...(data.results || []))
    if (ids.length >= (data.paging?.total || 0) || !(data.results || []).length) break
  }
  let encolados = 0
  for (let i = 0; i < ids.length; i += 20) {
    const r = await doFetch(`https://api.mercadolibre.com/items?ids=${ids.slice(i, i + 20).join(',')}&attributes=id,title,price,permalink,status`, auth)
    if (!r.ok) throw new Error(`ML ${r.status}`)   // B15
    const lote = await r.json()
    // Un solo round-trip a D1 por tanda de 20 (antes: un .run() por ítem, o sea
    // 55 statements para el catálogo actual). D1 corre el batch en transacción.
    const stmts = []
    for (const it of Array.isArray(lote) ? lote : []) {
      const b = it.body
      if (b?.status !== 'active') continue
      stmts.push(env.DB.prepare(
        `INSERT INTO ig_queue (ml_item_id, titulo, precio, permalink_ml) VALUES (?, ?, ?, ?)
         ON CONFLICT(ml_item_id) DO UPDATE SET estado='pendiente', intentos=0, ultimo_error=NULL,
           titulo=excluded.titulo, precio=excluded.precio, permalink_ml=excluded.permalink_ml
         WHERE ig_queue.estado='cancelado'`)
        .bind(b.id, b.title, Math.round(Number(b.price)) || 0, b.permalink || null))
    }
    if (!stmts.length) continue
    for (const res of await env.DB.batch(stmts)) encolados += (res.meta?.changes ?? 0)
  }
  log(`enqueueStock: ${ids.length} activos, ${encolados} encolados nuevos`)
  return { total: ids.length, encolados }
}

// Re-encola para SOLO HISTORIA todo lo ya publicado en el feed: la fila
// vuelve a 'pendiente' CONSERVANDO ig_media_id (la idempotencia de
// publicarFila salta el feed → no se repite el post) y limpiando ig_story_id
// (sale una historia nueva). prioridad = likes+comentarios del post del feed,
// así el rush/goteo saca primero los productos con más interacciones.
// Ítems vendidos/pausados se cancelan solos al publicar (status != active).
export async function requeueStories(env, deps = {}) {
  const getInteractions = deps.getInteractions || fetchMediaInteractions
  const { results } = await env.DB.prepare(
    "SELECT id, ig_media_id FROM ig_queue WHERE estado='publicado' AND ig_media_id IS NOT NULL").all()
  const rows = results || []
  if (!rows.length) return { encoladas: 0 }
  let inter = {}
  try { inter = await getInteractions(env, rows.map(r => r.ig_media_id)) }
  catch (e) { logErr('interacciones:', e.message) } // sin datos → todo prioridad 0
  await env.DB.batch(rows.map(r => env.DB.prepare(
    `UPDATE ig_queue SET estado='pendiente', intentos=0, ultimo_error=NULL,
       ig_story_id=NULL, prioridad=? WHERE id=?`).bind(inter[r.ig_media_id] || 0, r.id)))
  log(`requeueStories: ${rows.length} re-encoladas (${Object.keys(inter).length} con interacciones)`)
  return { encoladas: rows.length }
}

// Borra de IG todas las historias "vivas" (las publicadas hace <24 h; las
// demás ya expiraron solas). Tanda de hasta 35 por invocación (presupuesto de
// subrequests del Worker); si quedan, se repite el comando. Requiere el
// permiso instagram_manage_contents en el token de Meta.
export async function borrarHistorias(env, deps = {}) {
  const deleteMedia = deps.deleteMedia || igDeleteMedia
  const vivas = "ig_story_id IS NOT NULL AND publicado_en > datetime('now','-24 hours')"
  const { results } = await env.DB.prepare(
    `SELECT id, ig_story_id FROM ig_queue WHERE ${vivas} ORDER BY id LIMIT 35`).all()
  let borradas = 0, errores = 0, lastErr = null
  for (const r of (results || [])) {
    try {
      await deleteMedia(env, r.ig_story_id)
      borradas++
      await env.DB.prepare('UPDATE ig_queue SET ig_story_id=NULL WHERE id=?').bind(r.id).run()
    } catch (e) {
      // #6: "missing permissions on the object" NO significa que la historia
      // expiró: significa que al token le falta instagram_manage_contents. Si se
      // trata como expirada se borra ig_story_id con la historia viva en IG y el
      // bot responde "No hay historias vivas". Va a errores → dispara el mensaje
      // de permisos de telegram-bot.js:556.
      if (/does not exist|cannot be loaded|unsupported/i.test(e.message)) {
        // ya expiró o se borró a mano: limpiar el id igual
        await env.DB.prepare('UPDATE ig_queue SET ig_story_id=NULL WHERE id=?').bind(r.id).run()
      } else { errores++; lastErr = e.message }
    }
  }
  const resto = await env.DB.prepare(`SELECT COUNT(*) n FROM ig_queue WHERE ${vivas}`).first()
  return { borradas, errores, lastErr, quedan: resto?.n ?? 0 }
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
    await notify(`⚠️ IG: no pude calcular las ventanas de hoy (${esc(e.message)}); sigo con las últimas conocidas.`)
  }
  try {
    await maybeRefreshMetaToken(env)
  } catch (e) {
    logErr('token:', e.message)
    await notify(`⚠️ IG: falló la renovación del token de Meta: ${esc(e.message)}`)
  }
}
