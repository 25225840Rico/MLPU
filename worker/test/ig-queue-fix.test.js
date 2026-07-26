// Lote L1 del plan de reparacion 2026-07-26: cola y publisher.
// Cada test de este archivo se escribio ROJO primero y demuestra un bug real de
// produccion (numero de hallazgo en el titulo). No tocar fake-db.js: el doble de
// D1 quedo congelado en L0 y lanza ante SQL que no reconoce.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  enqueueIg, listPendientes, vaciarCola, runIgPublisher, setAuto, setRush,
  setFoco, enqueueStock, borrarHistorias, getItemDefault, RECOVERY_MIN,
} from '../ig-queue.js'
import { pickBestWindows, FALLBACK_WINDOWS } from '../ig-logic.js'
import { FakeDB } from './fake-db.js'

const mkEnv = () => ({ DB: new FakeDB(), IG_USER_ID: 'IGU', TELEGRAM_CHAT_ID: '1', SELLER_ID: 'S1' })
const okDeps = () => ({
  getItem: async () => ({ status: 'active', pictures: [{ secure_url: 'https://pic/1.jpg' }] }),
  publishImage: async (env, { story }) => (story ? 'ST1' : 'FEED1'),
})
// notify fiel a produccion: index.js:446 devuelve la promesa de tgSend, que
// resuelve a { ok: true | false } y NUNCA lanza (CONTRATO 4.6).
const notifyOk = (avisos) => async (t) => { avisos.push(t); return { ok: true } }

const enHorario   = new Date('2026-07-14T18:00:00Z') // 14:00 Chile
const deMadrugada = new Date('2026-07-14T06:10:00Z') // 02:10 Chile
const enVentana   = new Date('2026-07-14T00:15:00Z') // 20:15 Chile (fallback 20:00)

// ── 1. B16: el aviso de cola vacia manda al comando equivocado ──────────────
test('B16: con foco drive el aviso de cola vacia no sugiere /ig stock', async () => {
  const env = mkEnv()
  env.DB.seedQueue({ ml_item_id: 'hw-1', titulo: 'Auto Drive', precio: 0, fuente: 'drive',
    image_url: 'https://p/1', caption: 'c1' })
  await setFoco(env, 'drive')
  await setAuto(env, 30)
  const avisos = []
  await runIgPublisher(env, { now: enHorario, deps: okDeps(), notify: notifyOk(avisos) })
  const txt = avisos.join(' ')
  assert.match(txt, /quedó vacía/)
  assert.doesNotMatch(txt, /\/ig stock/)   // /ig stock solo carga ML: no recarga drive
  assert.match(txt, /seed-hw\.sql/)
})

test('B16: sin foco (o con foco ml) el aviso sigue sugiriendo /ig stock', async () => {
  const env = mkEnv()
  await enqueueIg(env, { mlItemId: 'MLC1', titulo: 'A', precio: 1 })
  await setAuto(env, 30)
  const avisos = []
  await runIgPublisher(env, { now: enHorario, deps: okDeps(), notify: notifyOk(avisos) })
  assert.match(avisos.join(' '), /\/ig stock/)
})

// Espia de la FakeDB (sin tocar fake-db.js, congelado en L0): cuenta statements
// sueltos vs. batches, para poder afirmar sobre el numero de round-trips a D1.
function spyDb(db) {
  const c = { runsSueltos: 0, batches: 0 }
  let dentro = false
  const wrap = st => ({ ...st, run: async () => { if (!dentro) c.runsSueltos++; return st.run() }, bind: (...a) => wrap(st.bind(...a)) })
  const prep = db.prepare.bind(db)
  db.prepare = sql => wrap(prep(sql))
  const bat = db.batch.bind(db)
  db.batch = async (s) => { c.batches++; dentro = true; try { return await bat(s) } finally { dentro = false } }
  return c
}

// ── 3. B15: enqueueStock ignoraba r.ok y un 401 se reportaba como "0 activos" ──
test('B15: enqueueStock lanza si ML responde error en el search', async () => {
  const env = mkEnv()
  const mlFetch = async () => ({ ok: false, status: 401, json: async () => ({ message: 'invalid token' }) })
  await assert.rejects(
    enqueueStock(env, { getToken: async () => 'T', mlFetch }),
    /ML 401/)
})

test('B15: enqueueStock lanza si ML responde error en el multiget', async () => {
  const env = mkEnv()
  const mlFetch = async (url) => url.includes('/items/search')
    ? { ok: true, status: 200, json: async () => ({ results: ['MLC1'], paging: { total: 1 } }) }
    : { ok: false, status: 500, json: async () => ({}) }
  await assert.rejects(
    enqueueStock(env, { getToken: async () => 'T', mlFetch }),
    /ML 500/)
})

// ── 4. Otros: enqueueStock hacia un .run() por item (55 items = 55 statements) ──
test('enqueueStock encola por batch, no un statement por item', async () => {
  const env = mkEnv()
  const ids = Array.from({ length: 25 }, (_, i) => 'MLC' + i)
  const mlFetch = async (url) => url.includes('/items/search')
    ? { ok: true, status: 200, json: async () => ({ results: ids, paging: { total: ids.length } }) }
    : { ok: true, status: 200, json: async () => new URL(url).searchParams.get('ids').split(',')
        .map(id => ({ body: { id, title: 'T ' + id, price: 1000, permalink: 'https://ml/' + id, status: 'active' } })) }
  const spy = spyDb(env.DB)
  const r = await enqueueStock(env, { getToken: async () => 'T', mlFetch })
  assert.equal(r.encolados, 25)
  assert.equal((await listPendientes(env)).length, 25)
  assert.equal(spy.runsSueltos, 0)   // ningun INSERT suelto
  assert.equal(spy.batches, 2)       // una tanda de 20 + una de 5
})

// ── 5. B6: la ventana se quemaba si el lock estaba tomado ───────────────────
test('B6: con el lock tomado la ventana NO se marca como corrida', async () => {
  const env = mkEnv()
  await enqueueIg(env, { mlItemId: 'MLC1', titulo: 'A', precio: 1 })
  await env.DB.seedConfig('corriendo', JSON.stringify({ hasta: new Date(Date.now() + 60000).toISOString() }))
  const r1 = await runIgPublisher(env, { now: enVentana, deps: okDeps() })
  assert.equal(r1.enCurso, true)
  assert.equal(await env.DB.getConfig('ultima_corrida'), undefined) // ventana intacta
  // el lock se libera; el tick siguiente, dentro de la MISMA ventana, publica
  env.DB.config.delete('corriendo')
  const r2 = await runIgPublisher(env, { now: new Date(enVentana.getTime() + 120000), deps: okDeps() })
  assert.equal(r2.publicados, 1)
})

// ── 6. #5: getItemDefault no miraba r.ok y vaciaba la cola de ML en silencio ──
const mlError = (status) => ({
  getToken: async () => 'T',
  // Un error de la API de ML trae un campo `status` NUMERICO en el cuerpo.
  mlFetch: async () => ({ ok: false, status, json: async () => ({ status, message: 'error', error: 'x' }) }),
})

test('#5: getItemDefault lanza si ML responde con error HTTP', async () => {
  await assert.rejects(getItemDefault(mkEnv(), 'MLC1', mlError(401)), /items\/MLC1 HTTP 401/)
})

test('#5: un 401 de ML deja la fila reintentable, no la cancela', async () => {
  const env = mkEnv()
  await enqueueIg(env, { mlItemId: 'MLC1', titulo: 'A', precio: 1 })
  const deps = { ...okDeps(), getItem: (e, id) => getItemDefault(e, id, mlError(401)) }
  // max:1 = un solo intento; con el max por defecto (3) la misma corrida
  // reintenta la fila 3 veces y la manda a 'error' (comportamiento previo, ajeno a este fix).
  const r = await runIgPublisher(env, { force: true, max: 1, deps })
  assert.equal(r.publicados, 0)
  assert.equal(env.DB.queue[0].estado, 'pendiente')  // antes: 'cancelado' e irrecuperable
  assert.match(env.DB.queue[0].ultimo_error, /HTTP 401/)
})

// ── 7. #9: filas con claimed_en NULL atascadas en 'publicando' para siempre ──
// No es hipotetico: schema-ig.sql:26 registra que la columna claimed_en se
// agrego a la base REMOTA el 2026-07-16; toda fila que estuviera publicando ese
// dia quedo con NULL, y `NULL < x` en SQLite nunca es true.
test('#9: fila en publicando con claimed_en NULL se recupera y publica', async () => {
  const env = mkEnv()
  env.DB.seedQueue({ ml_item_id: 'ATASCADA', titulo: 'A', precio: 1, estado: 'publicando', claimed_en: null })
  const r = await runIgPublisher(env, { force: true, max: 1, deps: okDeps() })
  assert.equal(r.publicados, 1)
  assert.equal(env.DB.queue[0].estado, 'publicado')
})

test('#9: RECOVERY_MIN es 10 y una fila recien reclamada no se recupera', async () => {
  assert.equal(RECOVERY_MIN, 10)
  const env = mkEnv()
  env.DB.seedQueue({ ml_item_id: 'MLC1', titulo: 'A', precio: 1, estado: 'publicando',
    claimed_en: new Date(Date.now() - 60000).toISOString() })
  const r = await runIgPublisher(env, { force: true, max: 1, deps: okDeps() })
  assert.equal(r.publicados, 0)
  assert.equal(env.DB.queue[0].estado, 'publicando')
})

// ── 8. #7(cupo): el flag se persistia ANTES de saber si el aviso salio ──────
test('#7: si Telegram falla, el rush no se duerme y reintenta el aviso', async () => {
  const env = mkEnv()
  await enqueueIg(env, { mlItemId: 'MLC1', titulo: 'A', precio: 1 })
  await setRush(env)
  const avisos = []
  let consultas = 0
  const deps = { ...okDeps(), getQuota: async () => { consultas++; return { usados: 99, total: 100 } } }
  const notifyRoto = async (t) => { avisos.push(t); return { ok: false, error: '400 Bad Request' } }
  const r1 = await runIgPublisher(env, { now: enHorario, deps, notify: notifyRoto })
  assert.equal(r1.cupoLleno, true)
  assert.equal(await env.DB.getConfig('rush_avisado'), undefined) // sin flag: sin siesta mentirosa
  await runIgPublisher(env, { now: enHorario, deps, notify: notifyRoto })
  assert.equal(avisos.length, 2)   // el aviso se reintenta
  assert.equal(consultas, 2)
})

test('#7: con el aviso entregado el flag se persiste y el rush duerme', async () => {
  const env = mkEnv()
  await enqueueIg(env, { mlItemId: 'MLC1', titulo: 'A', precio: 1 })
  await setRush(env)
  const avisos = []
  let consultas = 0
  const deps = { ...okDeps(), getQuota: async () => { consultas++; return { usados: 99, total: 100 } } }
  await runIgPublisher(env, { now: enHorario, deps, notify: notifyOk(avisos) })
  assert.ok(await env.DB.getConfig('rush_avisado'))
  await runIgPublisher(env, { now: enHorario, deps, notify: notifyOk(avisos) })
  assert.equal(avisos.length, 1)
  assert.equal(consultas, 1)
})

// ── 9. #6: borrarHistorias confundia "sin permisos" con "ya no existe" ──────
test('#6: "missing permissions" es error real, no historia expirada', async () => {
  const env = mkEnv()
  env.DB.seedQueue({ ml_item_id: 'MLC1', titulo: 'A', precio: 1, estado: 'publicado',
    ig_media_id: 'M1', ig_story_id: 'S1', publicado_en: new Date().toISOString() })
  const r = await borrarHistorias(env, { deleteMedia: async () => {
    throw new Error('(#10) Application does not have permission: missing permissions on the object')
  } })
  assert.equal(r.borradas, 0)
  assert.equal(r.errores, 1)                       // antes: 0 errores y "No hay historias vivas"
  assert.match(r.lastErr, /missing permissions/)
  assert.equal(env.DB.queue[0].ig_story_id, 'S1')  // la historia sigue viva en IG: se conserva el id
  assert.equal(r.quedan, 1)
})

test('#6: una historia realmente inexistente sigue limpiando el id sin error', async () => {
  const env = mkEnv()
  env.DB.seedQueue({ ml_item_id: 'MLC1', titulo: 'A', precio: 1, estado: 'publicado',
    ig_media_id: 'M1', ig_story_id: 'S1', publicado_en: new Date().toISOString() })
  const r = await borrarHistorias(env, { deleteMedia: async () => {
    throw new Error('Object with ID S1 does not exist')
  } })
  assert.equal(r.errores, 0)
  assert.equal(env.DB.queue[0].ig_story_id, null)
})

// ── 10. #10: /ig vaciar y /ig cola ignoraban el foco de fuente ──────────────
const mezcla = (env) => {
  env.DB.seedQueue({ ml_item_id: 'MLC1', titulo: 'ML 1', precio: 1 })
  env.DB.seedQueue({ ml_item_id: 'MLC2', titulo: 'ML 2', precio: 2 })
  env.DB.seedQueue({ ml_item_id: 'hw-1', titulo: 'Drive 1', precio: 0, fuente: 'drive', image_url: 'https://p/1', caption: 'c1' })
  env.DB.seedQueue({ ml_item_id: 'hw-2', titulo: 'Drive 2', precio: 0, fuente: 'drive', image_url: 'https://p/2', caption: 'c2' })
}

test('#10: vaciarCola con foco drive no toca las filas de ML', async () => {
  const env = mkEnv()
  mezcla(env)
  assert.equal(await vaciarCola(env, 'drive'), 2)
  const estados = Object.fromEntries(env.DB.queue.map(r => [r.ml_item_id, r.estado]))
  assert.deepEqual(estados, { MLC1: 'pendiente', MLC2: 'pendiente', 'hw-1': 'cancelado', 'hw-2': 'cancelado' })
})

test('#10: vaciarCola sin foco sigue cancelando todo (default null, CONTRATO 4.3)', async () => {
  const env = mkEnv()
  mezcla(env)
  assert.equal(await vaciarCola(env), 4)
  assert.ok(env.DB.queue.every(r => r.estado === 'cancelado'))
})

test('#10: listPendientes filtra por foco y sin foco lista todo', async () => {
  const env = mkEnv()
  mezcla(env)
  assert.deepEqual((await listPendientes(env, 'drive')).map(r => r.ml_item_id), ['hw-1', 'hw-2'])
  assert.deepEqual((await listPendientes(env, 'ml')).map(r => r.ml_item_id), ['MLC1', 'MLC2'])
  assert.equal((await listPendientes(env)).length, 4)
})

// ── 11. B3: el modo VENTANAS publicaba de madrugada (dos mitades) ───────────
test('B3(a): con ventanas de madrugada el cron NO publica', async () => {
  const env = mkEnv()
  await enqueueIg(env, { mlItemId: 'MLC1', titulo: 'A', precio: 1 })
  await env.DB.seedConfig('ventanas_manual', JSON.stringify({ horas: ['02:00', '04:00'] }))
  const r = await runIgPublisher(env, { now: deMadrugada, deps: okDeps() })  // 02:10 Chile
  assert.equal(r.publicados, 0)
  assert.equal(env.DB.queue[0].estado, 'pendiente')
  assert.equal(await env.DB.getConfig('ultima_corrida'), undefined) // ni quema la ventana
})

test('B3(a): el modo manual /ig horas sigue publicando dentro del horario', async () => {
  const env = mkEnv()
  await enqueueIg(env, { mlItemId: 'MLC1', titulo: 'A', precio: 1 })
  await env.DB.seedConfig('ventanas_manual', JSON.stringify({ horas: ['14:00'] }))
  const r = await runIgPublisher(env, { now: enHorario, deps: okDeps() })   // 14:00 Chile
  assert.equal(r.publicados, 1)
})

// ── #4: la Graph API se cae y el rush moría mudo ───────────────────────────
// index.js hace ctx.waitUntil(runIgPublisher(...)) SIN .catch, asi que una
// excepcion de fetchPublishingQuota se perdia: la cola quedaba congelada para
// siempre mientras el panel seguia diciendo "RUSH activo".
const quotaRota = () => ({ ...okDeps(), getQuota: async () => { throw new Error('OAuthException: token expirado') } })

test('#4: si falla la consulta de cupo, avisa y NO propaga la excepcion', async () => {
  const env = mkEnv()
  await enqueueIg(env, { mlItemId: 'MLC1', titulo: 'A', precio: 1 })
  await setRush(env, true)
  const avisos = []
  const r = await runIgPublisher(env, { now: enHorario, deps: quotaRota(), notify: notifyOk(avisos) })
  assert.equal(r.publicados, 0)
  assert.equal(r.errorCupo, true)
  assert.match(avisos.join(' '), /cupo de publicación de Meta/)
  assert.match(avisos.join(' '), /token expirado/)   // el motivo real, no un generico
})

test('#4: no repite el aviso en cada tick (el cron corre cada minuto)', async () => {
  const env = mkEnv()
  await enqueueIg(env, { mlItemId: 'MLC1', titulo: 'A', precio: 1 })
  await setRush(env, true)
  const avisos = []
  const notify = notifyOk(avisos)
  for (let i = 0; i < 5; i++) {
    await runIgPublisher(env, { now: new Date(enHorario.getTime() + i * 60e3), deps: quotaRota(), notify })
  }
  assert.equal(avisos.length, 1, 'cinco ticks seguidos deben producir UN solo aviso')
})

test('#4: si Telegram no entrega el aviso, no se marca como avisado', async () => {
  const env = mkEnv()
  await enqueueIg(env, { mlItemId: 'MLC1', titulo: 'A', precio: 1 })
  await setRush(env, true)
  let intentos = 0
  const notifyCaido = async () => { intentos++; return { ok: false } }   // tgSend no lanza
  await runIgPublisher(env, { now: enHorario, deps: quotaRota(), notify: notifyCaido })
  await runIgPublisher(env, { now: new Date(enHorario.getTime() + 60e3), deps: quotaRota(), notify: notifyCaido })
  assert.equal(intentos, 2, 'con Telegram caido debe reintentar el aviso, no silenciarse')
})

// ── #11: el lock duraba menos que la corrida ────────────────────────────────
test('#11: el lock cubre una corrida completa de rush (~7 min)', async () => {
  const env = mkEnv()
  await enqueueIg(env, { mlItemId: 'MLC1', titulo: 'A', precio: 1 })
  await setRush(env, true)
  let restanteMs = 0
  const deps = {
    ...okDeps(),
    getQuota: async () => ({ usados: 0, total: 100 }),
    // se ejecuta DENTRO de la corrida, con el lock ya tomado
    publishImage: async (e, { story }) => {
      const row = await env.DB.prepare('SELECT valor FROM ig_config WHERE clave=?').bind('corriendo').first()
      restanteMs = Date.parse(JSON.parse(row.valor).hasta) - Date.now()
      return story ? 'ST1' : 'FEED1'
    },
  }
  await runIgPublisher(env, { now: enHorario, deps, notify: notifyOk([]) })
  // Cota medida en la auditoria: 3 filas x (feed+historia) ~ 420 s.
  assert.ok(restanteMs > 7 * 60e3,
    `el lock debe durar mas que la corrida mas larga; quedaban ${Math.round(restanteMs / 1000)} s`)
})

test('B3(a): /ig ahora (force) publica igual de madrugada', async () => {
  const env = mkEnv()
  await enqueueIg(env, { mlItemId: 'MLC1', titulo: 'A', precio: 1 })
  await env.DB.seedConfig('ventanas_manual', JSON.stringify({ horas: ['02:00'] }))
  const r = await runIgPublisher(env, { now: deMadrugada, force: true, deps: okDeps() })
  assert.equal(r.publicados, 1)
})

// ── 12. B14: /ig vaciar no tocaba las filas en 'publicando' ─────────────────
test('B14: vaciarCola cancela las colgadas y respeta la corrida viva', async () => {
  const env = mkEnv()
  env.DB.seedQueue({ ml_item_id: 'COLGADA', titulo: 'A', precio: 1, estado: 'publicando',
    claimed_en: new Date(Date.now() - 20 * 60000).toISOString() })
  env.DB.seedQueue({ ml_item_id: 'NULA', titulo: 'B', precio: 1, estado: 'publicando', claimed_en: null })
  env.DB.seedQueue({ ml_item_id: 'VIVA', titulo: 'C', precio: 1, estado: 'publicando',
    claimed_en: new Date().toISOString() })
  env.DB.seedQueue({ ml_item_id: 'PEND', titulo: 'D', precio: 1 })
  assert.equal(await vaciarCola(env), 3)  // PEND + COLGADA + NULA
  const estados = Object.fromEntries(env.DB.queue.map(r => [r.ml_item_id, r.estado]))
  assert.deepEqual(estados, { COLGADA: 'cancelado', NULA: 'cancelado', VIVA: 'publicando', PEND: 'cancelado' })
  // y el publisher ya no las resucita 10 min después
  const r = await runIgPublisher(env, { force: true, max: 5, deps: okDeps() })
  assert.equal(r.publicados, 0)
})

test('B3(b): pickBestWindows acota las horas pico al horario permitido', () => {
  // insights con pico de madrugada: se descarta y gana la mejor hora válida
  assert.deepEqual(pickBestWindows({ 2: 100, 4: 90, 13: 30, 20: 20 }), ['13:00', '20:00'])
  // si TODO el trafico es de madrugada, fallback (nunca ventanas fuera de horario)
  assert.deepEqual(pickBestWindows({ 2: 100, 4: 90, 7: 50 }), FALLBACK_WINDOWS)
  // los bordes: 23 y 8 quedan fuera; 9 y 22 adentro
  assert.deepEqual(pickBestWindows({ 23: 50, 8: 40, 9: 30, 22: 10 }), ['09:00', '22:00'])
})
