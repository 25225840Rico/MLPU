import test from 'node:test'
import assert from 'node:assert/strict'
import { enqueueIg, enqueueStock, listPendientes, quitarDeCola, getVentanas, runIgPublisher } from '../ig-queue.js'
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
