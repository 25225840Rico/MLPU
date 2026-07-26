import test from 'node:test'
import assert from 'node:assert/strict'
import { enqueueIg, enqueueStock, listPendientes, quitarDeCola, vaciarCola, getVentanas, runIgPublisher, isPausado, setPausado, getAuto, setAuto, setRush, getFoco, setFoco, RUSH_POR_TICK, reintentarErrores, getHistorias, setHistorias } from '../ig-queue.js'
import { FakeDB } from './fake-db.js'

// Los mocks de notify devuelven { ok: true } como el notify real (index.js:446
// devuelve la promesa de tgSend, que resuelve a {ok:true|false} y nunca lanza).
// Desde el fix #7 hay flags que solo se persisten si el aviso salió (CONTRATO 4.6).
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

test('fuente drive: publica con image_url y caption propios, sin consultar ML', async () => {
  const env = mkEnv()
  env.DB.seedQueue({
    ml_item_id: 'hw-1', titulo: 'Bburago Enzo Ferrari', precio: 0, fuente: 'drive',
    image_url: 'https://mlpu-proxy.dev/img/drive/ABC', caption: '🏎️ Bburago Enzo\n💬 por DM',
  })
  let getItemCalls = 0
  const capturado = []
  const deps = {
    getItem: async () => { getItemCalls++; throw new Error('no debe consultar ML para fuente drive') },
    publishImage: async (e, { imageUrl, caption, story }) => { capturado.push({ imageUrl, caption, story }); return story ? 'ST1' : 'FEED1' },
  }
  const r = await runIgPublisher(env, { now: enVentana, deps })
  assert.equal(r.publicados, 1)
  assert.equal(getItemCalls, 0)                                   // nunca tocó ML
  assert.equal(capturado[0].imageUrl, 'https://mlpu-proxy.dev/img/drive/ABC')
  assert.equal(capturado[0].caption, '🏎️ Bburago Enzo\n💬 por DM') // usó el caption de la fila
  assert.equal(env.DB.queue[0].ig_media_id, 'FEED1')
  assert.equal(env.DB.queue[0].ig_story_id, 'ST1')
})

test('foco drive: rush publica SOLO drive y no toca las filas de ML', async () => {
  const env = mkEnv()
  // Mezcla: 2 de ML (id menor, saldrían primero sin foco) + 2 de Drive.
  await enqueueIg(env, { mlItemId: 'MLC9', titulo: 'Foco ML', precio: 9990 })
  await enqueueIg(env, { mlItemId: 'MLC8', titulo: 'Otro ML', precio: 8990 })
  env.DB.seedQueue({ ml_item_id: 'hw-1', titulo: 'Auto Drive 1', precio: 0, fuente: 'drive', image_url: 'https://p/1', caption: 'c1' })
  env.DB.seedQueue({ ml_item_id: 'hw-2', titulo: 'Auto Drive 2', precio: 0, fuente: 'drive', image_url: 'https://p/2', caption: 'c2' })
  await setFoco(env, 'drive')
  assert.equal(await getFoco(env), 'drive')
  const publicados = []
  const deps = {
    getItem: async () => { throw new Error('no debe consultar ML con foco drive') },
    publishImage: async (e, { imageUrl, story }) => { if (!story) publicados.push(imageUrl); return story ? 'ST' : 'FEED' },
  }
  // force = corre sin depender de ventana/rush; el foco igual aplica.
  await runIgPublisher(env, { force: true, max: 10, deps })
  const estados = Object.fromEntries(env.DB.queue.map(r => [r.ml_item_id, r.estado]))
  assert.deepEqual(publicados, ['https://p/1', 'https://p/2'])       // solo drive
  assert.equal(estados['hw-1'], 'publicado')
  assert.equal(estados['hw-2'], 'publicado')
  assert.equal(estados['MLC9'], 'pendiente')                         // ML intacto
  assert.equal(estados['MLC8'], 'pendiente')
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
  const r = await runIgPublisher(env, { now: enVentana, deps: okDeps(), notify: async t => { avisos.push(t); return { ok: true } } })
  assert.equal(r.publicados, 1)
  assert.equal((await listPendientes(env)).length, 0)
  assert.equal(env.DB.queue[0].ig_media_id, 'FEED1')
  assert.equal(env.DB.queue[0].ig_story_id, 'ST1')
  assert.match(avisos.join(' '), /Subido a IG/)
})

// notify() termina en tgSend con parse_mode:'HTML'. Un titulo de ML con "&" o
// "<" hacia que Telegram devolviera 400 y el aviso se perdia entero: la foto
// salia publicada pero en el chat no aparecia nada.
test('el aviso escapa & y < del titulo del producto', async () => {
  const env = mkEnv()
  await enqueueIg(env, { mlItemId: 'MLC5', titulo: 'Hot Wheels & Matchbox <lote 3>', precio: 9990 })
  const avisos = []
  await runIgPublisher(env, { now: enVentana, deps: okDeps(), notify: async t => { avisos.push(t); return { ok: true } } })
  assert.match(avisos.join(' '), /Hot Wheels &amp; Matchbox &lt;lote 3&gt;/)
  assert.equal(/&(?!amp;|lt;|gt;)/.test(avisos.join(' ')), false, 'no debe quedar un & suelto')
})

test('el aviso de fallo definitivo tambien escapa el titulo y el error', async () => {
  const env = mkEnv()
  await enqueueIg(env, { mlItemId: 'MLC6', titulo: 'Auto A&B', precio: 9990 })
  env.DB.queue[0].intentos = 2                      // el claim lo sube a 3 = MAX_INTENTOS
  const avisos = []
  const deps = {
    getItem: async () => ({ status: 'active', pictures: [{ secure_url: 'https://pic/1.jpg' }] }),
    publishImage: async () => { throw new Error('IG rechazó <media> & cortó') },
  }
  await runIgPublisher(env, { force: true, deps, notify: async t => { avisos.push(t); return { ok: true } } })
  const fallo = avisos.find(t => t.includes('quedó en error'))
  assert.ok(fallo, 'debe avisar el fallo definitivo')
  assert.match(fallo, /Auto A&amp;B/)
  assert.match(fallo, /IG rechazó &lt;media&gt; &amp; cortó/)
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
    await runIgPublisher(env, { force: true, deps, notify: async t => { avisos.push(t); return { ok: true } } })
  const row = env.DB.queue[0]
  assert.equal(row.intentos, 3)
  assert.equal(row.estado, 'error')
  assert.match(avisos.join(' '), /boom/)
})

test('reintentarErrores rescata las filas muertas y respeta el foco', async () => {
  const env = mkEnv()
  await enqueueIg(env, item)
  const deps = { ...okDeps(), publishImage: async () => { throw new Error('boom') } }
  for (const _ of [1, 2, 3]) await runIgPublisher(env, { force: true, deps })
  assert.equal(env.DB.queue[0].estado, 'error')

  // Con foco en la otra fuente NO se toca (la fila es 'ml' por defecto).
  assert.equal(await reintentarErrores(env, 'drive'), 0)
  assert.equal(env.DB.queue[0].estado, 'error')

  assert.equal(await reintentarErrores(env, null), 1)
  const row = env.DB.queue[0]
  assert.equal(row.estado, 'pendiente')
  assert.equal(row.intentos, 0, 'vuelve con sus 3 oportunidades enteras')
  assert.equal(row.ultimo_error, null)
  // y ahora sí publica
  assert.equal((await runIgPublisher(env, { force: true, deps: okDeps() })).publicados, 1)
})

test('reintentarErrores conserva ig_media_id (el feed ya subido no se repite)', async () => {
  const env = mkEnv()
  env.DB.seedQueue({ ml_item_id: 'MLC9', titulo: 'medio subido', precio: 1000,
    estado: 'error', intentos: 3, ig_media_id: 'FEEDYA', ultimo_error: 'historia: boom' })
  assert.equal(await reintentarErrores(env), 1)
  assert.equal(env.DB.queue[0].ig_media_id, 'FEEDYA')
  let feeds = 0
  const deps = { ...okDeps(), publishImage: async (e, { story }) => { if (!story) feeds++; return story ? 'ST9' : 'FEED9' } }
  await runIgPublisher(env, { force: true, deps })
  assert.equal(feeds, 0, 'no debe volver a publicar el feed')
  assert.equal(env.DB.queue[0].ig_story_id, 'ST9')
})

test('enqueueStock pagina, filtra activos y dedupea', async () => {
  const env = mkEnv()
  await enqueueIg(env, { mlItemId: 'MLC10', titulo: 'ya estaba', precio: 1000, permalink: 'x' })
  // el mock imita un Response real: `ok`/`status` incluidos (enqueueStock los mira desde B15)
  const fetchMock = async (url) => {
    if (url.includes('/items/search')) {
      return { ok: true, status: 200, json: async () => ({ results: ['MLC10', 'MLC11', 'MLC12'], paging: { total: 3 } }) }
    }
    // multiget: MLC12 viene pausado → no se encola
    return { ok: true, status: 200, json: async () => ([
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
  const r = await runIgPublisher(env, { force: true, deps, notify: async t => { avisos.push(t); return { ok: true } } })
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

// Umbral real de produccion: RECOVERY_MIN = 10 min (ig-queue.js:186). El titulo
// decia 15 min, que no existe en ninguna parte del codigo.
test('recovery: fila colgada en publicando >10 min vuelve a pendiente y sale', async () => {
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
  await runIgPublisher(env, { now: enHorario, deps: okDeps(), notify: async t => { avisos.push(t); return { ok: true } } })
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

// ── Modo rush: exprime el cupo diario de Meta, RUSH_POR_TICK por tick ──

test('rush: publica RUSH_POR_TICK por tick mientras el cupo alcance', async () => {
  const env = mkEnv()
  // Se encola una fila MÁS del tope para comprobar que el tope corta de verdad.
  const total = RUSH_POR_TICK + 2
  for (let n = 1; n <= total; n++) await enqueueIg(env, { ...item, mlItemId: 'MLC' + n })
  await setRush(env)
  const deps = { ...okDeps(), getQuota: async () => ({ usados: 10, total: 100 }) }
  const r = await runIgPublisher(env, { now: enHorario, deps })
  // El tope subió de 3 (2026-07-26) gracias al poll adaptativo de ig-api.js, al
  // aviso agrupado y al corte por presupuesto de ig-budget.js. Se compara contra
  // la constante y no contra un número copiado: si vuelve a moverse, este test
  // sigue midiendo lo que importa. Los stubs de deps no gastan presupuesto real.
  assert.equal(r.publicados, RUSH_POR_TICK)
  assert.equal((await listPendientes(env)).length, total - RUSH_POR_TICK)
})

test('rush: la tanda avisa UNA vez, no una por fila', async () => {
  const env = mkEnv()
  for (let n = 1; n <= 3; n++) await enqueueIg(env, { ...item, mlItemId: 'MLC' + n })
  await setRush(env)
  const avisos = []
  const deps = { ...okDeps(), getQuota: async () => ({ usados: 10, total: 100 }) }
  const r = await runIgPublisher(env, { now: enHorario, deps, notify: async t => { avisos.push(t); return { ok: true } } })
  assert.equal(r.publicados, 3)
  // 3 publicaciones → 1 solo mensaje (antes: 3 subrequests y 3 notificaciones).
  // El otro aviso de la corrida es el de "cola vacía", que no es por fila.
  const deTanda = avisos.filter(t => t.includes('Subido a IG'))
  assert.equal(deTanda.length, 1)
  assert.match(deTanda[0], /3 publicaciones en esta tanda/)
  // y ninguna se pierde: el resumen trae una línea por producto publicado
  assert.equal(deTanda[0].match(/Subido a IG/g).length, 3)
})

test('una sola publicación conserva el mensaje individual de siempre', async () => {
  const env = mkEnv()
  await enqueueIg(env, item)
  const avisos = []
  await runIgPublisher(env, { now: enVentana, deps: okDeps(), notify: async t => { avisos.push(t); return { ok: true } } })
  assert.equal(avisos.length, 1)
  assert.match(avisos[0], /^📸 Subido a IG:/)
  assert.ok(!avisos[0].includes('tanda'), 'sin encabezado de tanda cuando hay una sola')
})

// ── Historias on/off: la palanca de volumen ───────────────────────────────

test('historias apagadas: publica solo el feed y no gasta cupo en la historia', async () => {
  const env = mkEnv()
  await enqueueIg(env, item)
  await setHistorias(env, false)
  assert.equal(await getHistorias(env), false)
  const subidas = []
  const deps = { ...okDeps(), publishImage: async (e, { story }) => { subidas.push(story ? 'story' : 'feed'); return story ? 'ST1' : 'FEED1' } }
  const avisos = []
  const r = await runIgPublisher(env, { now: enVentana, deps, notify: async t => { avisos.push(t); return { ok: true } } })
  assert.equal(r.publicados, 1)
  assert.deepEqual(subidas, ['feed'], 'no debe crear el contenedor de la historia')
  assert.equal(env.DB.queue[0].estado, 'publicado')
  assert.equal(env.DB.queue[0].ig_story_id, null)
  assert.match(avisos[0], /solo feed — historias apagadas/)
})

test('historias apagadas: el mismo cupo de Meta rinde el doble de productos', async () => {
  const env = mkEnv()
  for (let n = 1; n <= 12; n++) await enqueueIg(env, { ...item, mlItemId: 'MLC' + n })
  await setRush(env)
  await setHistorias(env, false)
  // libres: 100-91=9; menos reserva 4 → 5. Con historias serían 2 productos;
  // sin ellas, 5 (cada uno gasta 1 sola unidad del cupo).
  const deps = { ...okDeps(), getQuota: async () => ({ usados: 91, total: 100 }) }
  assert.equal((await runIgPublisher(env, { now: enHorario, deps })).publicados, 5)
})

test('historias encendidas es el default (nada cambia sin tocar nada)', async () => {
  const env = mkEnv()
  assert.equal(await getHistorias(env), true)
  await setHistorias(env, false)
  await setHistorias(env, true)
  assert.equal(await getHistorias(env), true)
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
  const opts = { now: enHorario, deps, notify: async t => { avisos.push(t); return { ok: true } } }
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
  // notify explícito: la siesta arranca cuando el aviso SE ENTREGA (CONTRATO 4.6).
  const notify = async () => ({ ok: true })
  await runIgPublisher(env, { now: enHorario, deps, notify })  // lleno → aviso + flag con reabre futuro
  const r = await runIgPublisher(env, { now: enHorario, deps, notify })
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
  const opts = { now: enHorario, deps, notify: async t => { avisos.push(t); return { ok: true } } }
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
  const fakeFetch = async (url) => ({ ok: true, status: 200, json: async () => url.includes('/items/search') ? pages[0] : detail })
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
  const r = await runIgPublisher(env, { force: true, max: 1, deps, notify: async t => { avisos.push(t); return { ok: true } } })
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
