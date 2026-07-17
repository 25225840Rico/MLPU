import test from 'node:test'
import assert from 'node:assert/strict'
import { enqueueIg, enqueueStock, listPendientes, quitarDeCola, vaciarCola, getVentanas, runIgPublisher, isPausado, setPausado, getAuto, setAuto, setRush } from '../ig-queue.js'
import { FakeDB } from './fake-db.js'

const mkEnv = () => ({ DB: new FakeDB(), IG_USER_ID: 'IGU', TELEGRAM_CHAT_ID: '1', SELLER_ID: '283388639' })
const item = { mlItemId: 'MLC1', titulo: 'Foco Accent', precio: 19990, permalink: 'https://ml/MLC1' }
// deps de prueba: ítem activo en ML con foto, publicación IG que devuelve ids.
const okDeps = () => ({
  getItem: async () => ({ status: 'active', pictures: [{ secure_url: 'https://pic/1.jpg' }] }),
  publishImage: async (env, { story }) => (story ? 'ST1' : 'FEED1'),
})
// Lunes 2026-07-13 20:15 Chile (UTC-4) → dentro de la ventana fallback 20:00.
const enVentana = new Date('2026-07-14T00:15:00Z')

test('enqueueIg encola una vez (dedupe por ml_item_id)', async () => {
  const env = mkEnv()
  await enqueueIg(env, item)
  await enqueueIg(env, item)
  assert.equal((await listPendientes(env)).length, 1)
})

test('getVentanas prioriza manual > insights > fallback', async () => {
  const env = mkEnv()
  assert.deepEqual((await getVentanas(env)).horas, ['12:30', '20:00'])
  await env.DB.seedConfig('ventanas', JSON.stringify({ horas: ['13:00', '21:00'], origen: 'insights' }))
  assert.deepEqual((await getVentanas(env)).horas, ['13:00', '21:00'])
  await env.DB.seedConfig('ventanas_manual', JSON.stringify({ horas: ['09:00'] }))
  assert.deepEqual((await getVentanas(env)).horas, ['09:00'])
})

test('quitarDeCola cancela solo pendientes', async () => {
  const env = mkEnv()
  await enqueueIg(env, item)
  const id = env.DB.queue[0].id
  assert.equal(await quitarDeCola(env, id), true)
  assert.equal(env.DB.queue[0].estado, 'cancelado')
  assert.equal(await quitarDeCola(env, id), false)
})

test('runIgPublisher fuera de ventana no publica; force sí', async () => {
  const env = mkEnv()
  await enqueueIg(env, item)
  const fuera = new Date('2026-07-13T10:00:00Z') // 06:00 Chile
  assert.equal((await runIgPublisher(env, { now: fuera, deps: okDeps() })).publicados, 0)
  assert.equal((await runIgPublisher(env, { now: fuera, force: true, deps: okDeps() })).publicados, 1)
})

test('runIgPublisher publica feed + historia y notifica', async () => {
  const env = mkEnv()
  await enqueueIg(env, item)
  const avisos = []
  const r = await runIgPublisher(env, { now: enVentana, deps: okDeps(), notify: async t => avisos.push(t) })
  assert.equal(r.publicados, 1)
  assert.equal((await listPendientes(env)).length, 0)
  assert.equal(env.DB.queue[0].ig_media_id, 'FEED1')
  assert.equal(env.DB.queue[0].ig_story_id, 'ST1')
  assert.match(avisos.join(' '), /Subido a IG/)
})

test('runIgPublisher corre UNA vez por ventana', async () => {
  const env = mkEnv()
  await enqueueIg(env, item)
  await runIgPublisher(env, { now: enVentana, deps: okDeps() })
  await enqueueIg(env, { ...item, mlItemId: 'MLC2' })
  // misma ventana 30 min después → no publica el segundo
  const r = await runIgPublisher(env, { now: new Date('2026-07-14T00:45:00Z'), deps: okDeps() })
  assert.equal(r.publicados, 0)
})

test('ítem no activo en ML → cancelado sin publicar', async () => {
  const env = mkEnv()
  await enqueueIg(env, item)
  const deps = { ...okDeps(), getItem: async () => ({ status: 'paused', pictures: [] }) }
  const r = await runIgPublisher(env, { now: enVentana, deps })
  assert.equal(r.publicados, 0)
  assert.equal((await listPendientes(env)).length, 0)
})

test('fallo de IG suma intento; al 3ro pasa a error y avisa', async () => {
  const env = mkEnv()
  await enqueueIg(env, item)
  const avisos = []
  const deps = { ...okDeps(), publishImage: async () => { throw new Error('boom') } }
  for (const _ of [1, 2, 3])
    await runIgPublisher(env, { force: true, deps, notify: async t => avisos.push(t) })
  const row = env.DB.queue[0]
  assert.equal(row.intentos, 3)
  assert.equal(row.estado, 'error')
  assert.match(avisos.join(' '), /boom/)
})

test('enqueueStock pagina, filtra activos y dedupea', async () => {
  const env = mkEnv()
  await enqueueIg(env, { mlItemId: 'MLC10', titulo: 'ya estaba', precio: 1000, permalink: 'x' })
  const fetchMock = async (url) => {
    if (url.includes('/items/search')) {
      return { json: async () => ({ results: ['MLC10', 'MLC11', 'MLC12'], paging: { total: 3 } }) }
    }
    // multiget: MLC12 viene pausado → no se encola
    return { json: async () => ([
      { body: { id: 'MLC10', title: 'ya estaba', price: 1000, permalink: 'x', status: 'active' } },
      { body: { id: 'MLC11', title: 'Nuevo', price: 5990, permalink: 'y', status: 'active' } },
      { body: { id: 'MLC12', title: 'Pausado', price: 100, permalink: 'z', status: 'paused' } },
    ]) }
  }
  const r = await enqueueStock(env, { getToken: async () => 'TOK', mlFetch: fetchMock })
  assert.equal(r.total, 3)
  assert.equal(r.encolados, 1) // solo MLC11
  assert.equal((await listPendientes(env)).length, 2)
})

test('runIgPublisher: con pausado activo no publica nada', async () => {
  const env = { DB: new FakeDB() }
  env.DB.seedQueue({ ml_item_id: 'MLC1', titulo: 'A', precio: 1000, permalink_ml: 'https://x/1' })
  await setPausado(env, true)
  const r = await runIgPublisher(env, { force: true, deps: { publishImage: async () => { throw new Error('no debía publicar') }, getItem: async () => ({ status: 'active', pictures: [{ secure_url: 'https://f/1.jpg' }] }) } })
  assert.deepEqual(r, { publicados: 0, pausado: true })
})

test('runIgPublisher: /ig parar a mitad de tanda corta el resto', async () => {
  const env = { DB: new FakeDB() }
  env.DB.seedQueue({ ml_item_id: 'MLC1', titulo: 'A', precio: 1, permalink_ml: 'https://x/1' })
  env.DB.seedQueue({ ml_item_id: 'MLC2', titulo: 'B', precio: 2, permalink_ml: 'https://x/2' })
  let published = 0
  const r = await runIgPublisher(env, { force: true, deps: {
    getItem: async () => ({ status: 'active', pictures: [{ secure_url: 'https://f/1.jpg' }] }),
    publishImage: async () => { if (++published === 2) await setPausado(env, true); return 'M' + published },
  } })
  // el ítem 1 se publica (feed+historia = 2 llamadas, pausa al final); el ítem 2 ya no arranca
  assert.equal(r.publicados, 1)
  assert.equal(r.pausado, true)
})

test('setPausado(false) reanuda', async () => {
  const env = { DB: new FakeDB() }
  await setPausado(env, true)
  await setPausado(env, false)
  assert.equal(await isPausado(env), false)
})

test('vaciarCola: cancela todos los pendientes y devuelve el conteo', async () => {
  const env = { DB: new FakeDB() }
  env.DB.seedQueue({ ml_item_id: 'MLC1', titulo: 'A', precio: 1 })
  env.DB.seedQueue({ ml_item_id: 'MLC2', titulo: 'B', precio: 2 })
  env.DB.seedQueue({ ml_item_id: 'MLC3', titulo: 'C', precio: 3, estado: 'publicado' })
  assert.equal(await vaciarCola(env), 2)
  assert.ok(env.DB.queue.every(r => r.ml_item_id === 'MLC3' ? r.estado === 'publicado' : r.estado === 'cancelado'))
})

// ── Anti-duplicados (post-mortem 2026-07-15: feeds repetidos en IG) ──

test('historia falla → feed NO se repite: fila queda publicada con aviso', async () => {
  const env = mkEnv()
  await enqueueIg(env, item)
  const avisos = []
  let feeds = 0
  const deps = { ...okDeps(), publishImage: async (e, { story }) => {
    if (story) throw new Error('story boom')
    return `FEED${++feeds}`
  } }
  const r = await runIgPublisher(env, { force: true, deps, notify: async t => avisos.push(t) })
  assert.equal(r.publicados, 1)
  const row = env.DB.queue[0]
  assert.equal(row.estado, 'publicado')       // no vuelve a pendiente (antes: reintentaba y duplicaba el feed)
  assert.equal(row.ig_media_id, 'FEED1')
  assert.equal(feeds, 1)
  assert.match(avisos.join(' '), /historia falló/)
})

test('reintento de fila con feed ya subido no vuelve a publicar el feed', async () => {
  const env = mkEnv()
  const row = env.DB.seedQueue({ ml_item_id: 'MLC1', titulo: 'A', precio: 1000, ig_media_id: 'FEED_VIEJO', intentos: 1 })
  const llamadas = []
  const deps = { ...okDeps(), publishImage: async (e, { story }) => { llamadas.push(story ? 'story' : 'feed'); return 'ST_NUEVO' } }
  const r = await runIgPublisher(env, { force: true, deps })
  assert.equal(r.publicados, 1)
  assert.deepEqual(llamadas, ['story'])       // solo la historia; el feed idempotente se salta
  assert.equal(row.ig_media_id, 'FEED_VIEJO')
  assert.equal(row.estado, 'publicado')
})

test('claim atómico: una fila en publicando no la toma otra corrida', async () => {
  const env = mkEnv()
  env.DB.seedQueue({ ml_item_id: 'MLC1', titulo: 'A', precio: 1, estado: 'publicando', claimed_en: new Date().toISOString() })
  const r = await runIgPublisher(env, { force: true, deps: { ...okDeps(),
    publishImage: async () => { throw new Error('no debía publicar') } } })
  assert.equal(r.publicados, 0)
})

test('recovery: fila colgada en publicando >15 min vuelve a pendiente y sale', async () => {
  const env = mkEnv()
  const vieja = new Date(Date.now() - 20 * 60 * 1000).toISOString()
  env.DB.seedQueue({ ml_item_id: 'MLC1', titulo: 'A', precio: 1, estado: 'publicando', claimed_en: vieja, ig_media_id: 'FEED_YA' })
  const llamadas = []
  const deps = { ...okDeps(), publishImage: async (e, { story }) => { llamadas.push(story ? 'story' : 'feed'); return 'X' } }
  const r = await runIgPublisher(env, { force: true, deps })
  assert.equal(r.publicados, 1)
  assert.deepEqual(llamadas, ['story'])       // recuperada, y el feed ya subido no se repite
})

test('lock: con otra corrida en curso responde enCurso y no publica', async () => {
  const env = mkEnv()
  await enqueueIg(env, item)
  await env.DB.seedConfig('corriendo', JSON.stringify({ hasta: new Date(Date.now() + 60000).toISOString() }))
  const r = await runIgPublisher(env, { force: true, deps: { ...okDeps(),
    publishImage: async () => { throw new Error('no debía publicar') } } })
  assert.deepEqual(r, { publicados: 0, enCurso: true })
  // lock vencido → publica normal
  await env.DB.seedConfig('corriendo', JSON.stringify({ hasta: new Date(Date.now() - 1000).toISOString() }))
  assert.equal((await runIgPublisher(env, { force: true, deps: okDeps() })).publicados, 1)
})

test('/ig ahora respeta el máximo pedido', async () => {
  const env = mkEnv()
  for (const n of [1, 2, 3, 4, 5]) await enqueueIg(env, { ...item, mlItemId: 'MLC' + n })
  const r = await runIgPublisher(env, { force: true, deps: okDeps(), max: 5 })
  assert.equal(r.publicados, 5)
  assert.equal((await listPendientes(env)).length, 0)
})

// ── Modo automático (goteo): 1 por tick del cron, intervalo configurable ──
// 2026-07-14T18:00Z = 14:00 Chile (dentro de 09-23); T07:00Z = 03:00 (fuera).
const enHorario   = new Date('2026-07-14T18:00:00Z')
const deMadrugada = new Date('2026-07-14T07:00:00Z')

test('auto: el cron gotea 1 por tick, aunque haya varios pendientes', async () => {
  const env = mkEnv()
  for (const n of [1, 2, 3]) await enqueueIg(env, { ...item, mlItemId: 'MLC' + n })
  await setAuto(env, 30)
  const r = await runIgPublisher(env, { now: enHorario, deps: okDeps() })
  assert.equal(r.publicados, 1)
  assert.equal((await listPendientes(env)).length, 2)
})

test('auto: fuera de horario (madrugada Chile) no publica', async () => {
  const env = mkEnv()
  await enqueueIg(env, item)
  await setAuto(env, 30)
  const r = await runIgPublisher(env, { now: deMadrugada, deps: okDeps() })
  assert.equal(r.publicados, 0)
})

test('auto: respeta el intervalo desde la última publicación', async () => {
  const env = mkEnv()
  await setAuto(env, 60)
  env.DB.seedQueue({ ml_item_id: 'MLC9', titulo: 'ya salió', precio: 1, estado: 'publicado',
    publicado_en: new Date(enHorario.getTime() - 10 * 60000).toISOString() }) // hace 10 min
  await enqueueIg(env, item)
  assert.equal((await runIgPublisher(env, { now: enHorario, deps: okDeps() })).publicados, 0)
  // hace 58 min (>= 60-5 de gracia) → publica
  env.DB.queue[0].publicado_en = new Date(enHorario.getTime() - 58 * 60000).toISOString()
  assert.equal((await runIgPublisher(env, { now: enHorario, deps: okDeps() })).publicados, 1)
})

test('auto: avisa cuando la cola queda vacía', async () => {
  const env = mkEnv()
  await enqueueIg(env, item)
  await setAuto(env, 30)
  const avisos = []
  await runIgPublisher(env, { now: enHorario, deps: okDeps(), notify: async t => avisos.push(t) })
  assert.match(avisos.join(' '), /cola de Instagram quedó vacía/)
})

test('auto off: vuelve al modo por ventanas', async () => {
  const env = mkEnv()
  await enqueueIg(env, item)
  await setAuto(env, 30)
  await setAuto(env, 0)
  assert.equal(await getAuto(env), null)
  // 14:00 Chile no es ventana (fallback 12:30/20:00) → el cron no publica
  const r = await runIgPublisher(env, { now: enHorario, deps: okDeps() })
  assert.equal(r.publicados, 0)
})

// ── Modo rush: exprime el cupo diario de Meta, 3 por tick ──

test('rush: publica 3 por tick mientras el cupo alcance', async () => {
  const env = mkEnv()
  for (const n of [1, 2, 3, 4, 5]) await enqueueIg(env, { ...item, mlItemId: 'MLC' + n })
  await setRush(env)
  const deps = { ...okDeps(), getQuota: async () => ({ usados: 10, total: 100 }) }
  const r = await runIgPublisher(env, { now: enHorario, deps })
  assert.equal(r.publicados, 3)
  assert.equal((await listPendientes(env)).length, 2)
})

test('rush: con poco cupo publica solo lo que cabe (reserva incluida)', async () => {
  const env = mkEnv()
  for (const n of [1, 2, 3]) await enqueueIg(env, { ...item, mlItemId: 'MLC' + n })
  await setRush(env)
  // libres: 100-91=9; menos reserva 4 → 5 → 2 productos (feed+historia = 2 c/u)
  const deps = { ...okDeps(), getQuota: async () => ({ usados: 91, total: 100 }) }
  assert.equal((await runIgPublisher(env, { now: enHorario, deps })).publicados, 2)
})

test('rush: cupo lleno → avisa hora de reapertura UNA vez y no publica', async () => {
  const env = mkEnv()
  await enqueueIg(env, item)
  await setRush(env)
  env.DB.seedQueue({ ml_item_id: 'MLC8', titulo: 'viejo', precio: 1, estado: 'publicado',
    publicado_en: new Date(enHorario.getTime() - 2 * 3600e3).toISOString() })
  const avisos = []
  const deps = { ...okDeps(), getQuota: async () => ({ usados: 97, total: 100 }) }
  const opts = { now: enHorario, deps, notify: async t => avisos.push(t) }
  assert.equal((await runIgPublisher(env, opts)).cupoLleno, true)
  assert.equal((await runIgPublisher(env, opts)).cupoLleno, true) // segundo tick: sin re-aviso
  assert.equal(avisos.length, 1)
  assert.match(avisos[0], /Cupo diario de Meta lleno \(97\/100/)
  assert.match(avisos[0], /\d{2}:\d{2}/) // hora estimada de reapertura
})

test('rush: cupo lleno → siesta sin pegarle a la Graph API hasta la reapertura', async () => {
  const env = mkEnv()
  await enqueueIg(env, item)
  await setRush(env)
  let consultas = 0
  const deps = { ...okDeps(), getQuota: async () => { consultas++; return { usados: 99, total: 100 } } }
  await runIgPublisher(env, { now: enHorario, deps })     // lleno → aviso + flag con reabre futuro
  const r = await runIgPublisher(env, { now: enHorario, deps })
  assert.equal(r.cupoLleno, true)
  assert.equal(consultas, 1) // el segundo tick durmió: no volvió a consultar el cupo
})

test('rush: al reabrirse el cupo publica y rearma el aviso', async () => {
  const env = mkEnv()
  for (const n of [1, 2]) await enqueueIg(env, { ...item, mlItemId: 'MLC' + n })
  await setRush(env)
  const avisos = []
  let usados = 99
  const deps = { ...okDeps(), getQuota: async () => ({ usados, total: 100 }) }
  const opts = { now: enHorario, deps, notify: async t => avisos.push(t) }
  await runIgPublisher(env, opts)                    // lleno → aviso 1
  usados = 10
  // pasó la hora estimada de reapertura → el gate deja consultar de nuevo
  await env.DB.seedConfig('rush_avisado', JSON.stringify({ reabre: new Date(enHorario.getTime() - 1000).toISOString() }))
  assert.equal((await runIgPublisher(env, opts)).publicados, 2) // se liberó → publica y borra flag
  usados = 99
  await enqueueIg(env, { ...item, mlItemId: 'MLC3' }) // con cola vacía el rush ni consulta el cupo
  await runIgPublisher(env, opts)                    // lleno de nuevo → aviso 2
  assert.equal(avisos.filter(a => /Cupo diario/.test(a)).length, 2)
})

test('rush: fuera de horario (madrugada Chile) no publica ni consulta cupo', async () => {
  const env = mkEnv()
  await enqueueIg(env, item)
  await setRush(env)
  const deps = { ...okDeps(), getQuota: async () => { throw new Error('no debía consultar') } }
  assert.equal((await runIgPublisher(env, { now: deMadrugada, deps })).publicados, 0)
})

test('enqueueStock: re-encola ítems cancelados (UPSERT), no los publicados', async () => {
  const env = { DB: new FakeDB(), SELLER_ID: 'S1' }
  env.DB.seedQueue({ ml_item_id: 'MLC1', titulo: 'VIEJO', precio: 999, permalink_ml: 'https://x/viejo', estado: 'cancelado', intentos: 2, ultimo_error: 'x' })
  env.DB.seedQueue({ ml_item_id: 'MLC2', titulo: 'B', precio: 2, estado: 'publicado' })
  const pages = [{ results: ['MLC1', 'MLC2'], paging: { total: 2 } }]
  const detail = [{ body: { id: 'MLC1', title: 'FRESCO', price: 1234, permalink: 'https://x/1', status: 'active' } },
                  { body: { id: 'MLC2', title: 'B', price: 2, permalink: 'https://x/2', status: 'active' } }]
  const fakeFetch = async (url) => ({ json: async () => url.includes('/items/search') ? pages[0] : detail })
  const r = await enqueueStock(env, { getToken: async () => 'T', mlFetch: fakeFetch })
  assert.equal(r.encolados, 1) // solo MLC1 (cancelado→pendiente); MLC2 publicado queda intacto
  const row = env.DB.queue.find(x => x.ml_item_id === 'MLC1')
  assert.equal(row.estado, 'pendiente'); assert.equal(row.intentos, 0); assert.equal(row.ultimo_error, null)
  assert.equal(row.titulo, 'FRESCO'); assert.equal(row.precio, 1234); assert.equal(row.permalink_ml, 'https://x/1')
  assert.equal(env.DB.queue.find(x => x.ml_item_id === 'MLC2').estado, 'publicado')
})

// ── Rehistorias y borrado de historias (2026-07-17) ──────────
import { requeueStories, borrarHistorias } from '../ig-queue.js'

test('requeueStories: re-encola publicados para solo-historia con prioridad por interacciones', async () => {
  const env = mkEnv()
  env.DB.seedQueue({ ml_item_id: 'MLC1', titulo: 'A', precio: 1, estado: 'publicado', ig_media_id: 'M1', ig_story_id: 'S1', publicado_en: new Date().toISOString() })
  env.DB.seedQueue({ ml_item_id: 'MLC2', titulo: 'B', precio: 1, estado: 'publicado', ig_media_id: 'M2', ig_story_id: 'S2', publicado_en: new Date().toISOString() })
  env.DB.seedQueue({ ml_item_id: 'MLC3', titulo: 'C', precio: 1, estado: 'cancelado' })
  env.DB.seedQueue({ ml_item_id: 'MLC4', titulo: 'D', precio: 1, estado: 'pendiente' })

  const r = await requeueStories(env, { getInteractions: async () => ({ M1: 2, M2: 9 }) })
  assert.equal(r.encoladas, 2)
  const [a, b, c, d] = env.DB.queue
  assert.equal(a.estado, 'pendiente')
  assert.equal(a.ig_media_id, 'M1')   // el feed NO se repite (idempotencia)
  assert.equal(a.ig_story_id, null)   // la historia sale de nuevo
  assert.equal(a.prioridad, 2)
  assert.equal(b.prioridad, 9)
  assert.equal(c.estado, 'cancelado') // intactos
  assert.equal(d.prioridad, 0)
})

test('rehistorias: el publisher saca primero la de más interacciones y publica SOLO historia', async () => {
  const env = mkEnv()
  env.DB.seedQueue({ ml_item_id: 'MLC1', titulo: 'Poco visto', precio: 1, estado: 'publicado', ig_media_id: 'M1', ig_story_id: 'S1', publicado_en: new Date().toISOString() })
  env.DB.seedQueue({ ml_item_id: 'MLC2', titulo: 'Popular', precio: 1, estado: 'publicado', ig_media_id: 'M2', ig_story_id: 'S2', publicado_en: new Date().toISOString() })
  await requeueStories(env, { getInteractions: async () => ({ M1: 1, M2: 50 }) })

  const publicadas = []
  const deps = {
    getItem: async () => ({ status: 'active', pictures: [{ secure_url: 'https://pic/1.jpg' }] }),
    publishImage: async (e, { story }) => { publicadas.push(story ? 'story' : 'feed'); return 'NEW' },
  }
  const avisos = []
  const r = await runIgPublisher(env, { force: true, max: 1, deps, notify: async t => avisos.push(t) })
  assert.equal(r.publicados, 1)
  assert.deepEqual(publicadas, ['story'])              // ni un solo feed repetido
  assert.equal(env.DB.queue[1].estado, 'publicado')    // salió el Popular (prioridad 50)
  assert.equal(env.DB.queue[1].ig_story_id, 'NEW')
  assert.equal(env.DB.queue[0].estado, 'pendiente')
  assert.match(avisos.join(' '), /Historia re-subida/)
})

test('borrarHistorias: borra las vivas (<24h), limpia ig_story_id y reporta errores', async () => {
  const env = mkEnv()
  const hace2h = new Date(Date.now() - 2 * 3600e3).toISOString()
  const hace30h = new Date(Date.now() - 30 * 3600e3).toISOString()
  env.DB.seedQueue({ ml_item_id: 'MLC1', titulo: 'A', precio: 1, estado: 'publicado', ig_media_id: 'M1', ig_story_id: 'S1', publicado_en: hace2h })
  env.DB.seedQueue({ ml_item_id: 'MLC2', titulo: 'B', precio: 1, estado: 'publicado', ig_media_id: 'M2', ig_story_id: 'S2', publicado_en: hace2h })
  env.DB.seedQueue({ ml_item_id: 'MLC3', titulo: 'C', precio: 1, estado: 'publicado', ig_media_id: 'M3', ig_story_id: 'S3', publicado_en: hace30h }) // ya expiró: no se toca

  const borrados = []
  const r = await borrarHistorias(env, { deleteMedia: async (e, id) => {
    if (id === 'S2') throw new Error('(#10) Application does not have permission for this action')
    borrados.push(id)
  } })
  assert.deepEqual(borrados, ['S1'])
  assert.equal(r.borradas, 1)
  assert.equal(r.errores, 1)
  assert.match(r.lastErr, /permission/)
  assert.equal(env.DB.queue[0].ig_story_id, null)  // borrada → limpia
  assert.equal(env.DB.queue[1].ig_story_id, 'S2')  // error real → conserva el id
  assert.equal(env.DB.queue[2].ig_story_id, 'S3')  // expirada hace >24h → fuera del alcance
  assert.equal(r.quedan, 1)
})

test('borrarHistorias: historia ya inexistente en IG limpia el id sin contar error', async () => {
  const env = mkEnv()
  env.DB.seedQueue({ ml_item_id: 'MLC1', titulo: 'A', precio: 1, estado: 'publicado', ig_media_id: 'M1', ig_story_id: 'S1', publicado_en: new Date().toISOString() })
  const r = await borrarHistorias(env, { deleteMedia: async () => { throw new Error('Object with ID does not exist') } })
  assert.equal(r.borradas, 0)
  assert.equal(r.errores, 0)
  assert.equal(env.DB.queue[0].ig_story_id, null)
  assert.equal(r.quedan, 0)
})
