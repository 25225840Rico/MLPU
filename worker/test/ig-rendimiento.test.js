/**
 * Rendimiento y robustez del pipeline de Instagram (2026-07-26).
 * Cubre los cambios de velocidad/cantidad: versión única de la Graph API,
 * poll adaptativo del contenedor, presupuesto de subrequests del plan Free y
 * cadena de fallback sin eslabones muertos para las fotos que no son de ML.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { igPublishImage, igDeleteMedia, _setPollMs } from '../ig-api.js'
import { runIgPublisher, setRush } from '../ig-queue.js'
import { iniciarPresupuesto, gastar, hayPara, restante, _estado, TOPE_FREE } from '../ig-budget.js'
import { FakeDB } from './fake-db.js'

const IG_USER = '17841400000000000'
async function mkEnv(extra = {}) {
  const env = { IG_USER_ID: IG_USER, PUBLIC_URL: 'https://pub.test', DB: new FakeDB(), ...extra }
  await env.DB.seedConfig('meta_token', JSON.stringify({ token: 'TOK', obtenido_en: new Date().toISOString() }))
  return env
}
function stubFetch(handler) {
  const calls = []
  globalThis.fetch = async (url, opts = {}) => { calls.push({ url: String(url), opts }); return handler(String(url), opts) }
  return calls
}
const okJson = data => ({ ok: true, json: async () => data })
const urlsMedia = calls => calls.filter(c => c.url.endsWith('/media'))
  .map(c => new URLSearchParams(c.opts.body).get('image_url'))

// ── #3: una sola versión de la Graph API ──────────────────────────────────

test('toda la Graph API usa v25.0 (v20 se apaga el 24-sep-2026)', async () => {
  iniciarPresupuesto()
  const env = await mkEnv()
  const calls = stubFetch(url => url.includes('/media_publish') ? okJson({ id: 'P' }) : okJson({ id: 'C' }))
  await igPublishImage(env, { imageUrl: 'https://http2.mlstatic.com/a-O.jpg', caption: 'x' })
  await igDeleteMedia(env, 'MEDIA_1')
  assert.ok(calls.length >= 4)
  for (const c of calls) assert.match(c.url, /graph\.facebook\.com\/v25\.0\//, `versión vieja en ${c.url}`)
})

// ── #1: cadena de fallback sin eslabones imposibles ───────────────────────

test('foto que no es de ML: la cadena salta el compositor propio (solo acepta mlstatic)', async () => {
  iniciarPresupuesto()
  const env = await mkEnv({ CLOUDINARY_CLOUD: 'nube1' })
  let media = 0
  const calls = stubFetch(url => {
    if (url.includes('/media_publish')) return okJson({ id: 'P' })
    media++
    return media === 1
      ? { ok: true, json: async () => ({ error: { message: 'Media download failed: bad image url' } }) }
      : okJson({ id: 'C' })
  })
  const drive = 'https://mlpu-proxy.aronricocl.workers.dev/drive/foto1.jpg'
  assert.equal(await igPublishImage(env, { imageUrl: drive, caption: 'hw' }), 'P')
  const imgs = urlsMedia(calls)
  // Antes: cloudinary → /ig/img (403) → /ig/img&m=lite (403) → original = 4
  // intentos, 2 de ellos condenados de antemano en CADA foto de Drive.
  assert.equal(imgs.length, 2)
  assert.ok(imgs[0].startsWith('https://res.cloudinary.com/nube1/'))
  assert.equal(imgs[1], drive)
  assert.ok(!imgs.some(u => u.includes('/ig/img')), 'no debe intentar el compositor propio')
})

test('foto de ML: la cadena completa sigue intacta (4 eslabones)', async () => {
  iniciarPresupuesto()
  const env = await mkEnv({ CLOUDINARY_CLOUD: 'nube1' })
  const calls = stubFetch(url => url.includes('/media_publish')
    ? okJson({ id: 'P' })
    : { ok: true, json: async () => ({ error: { message: 'Media download failed' } }) })
  await assert.rejects(() => igPublishImage(env,
    { imageUrl: 'https://http2.mlstatic.com/D_1-MLC2_072026-O.webp', story: true }))
  const imgs = urlsMedia(calls)
  assert.equal(imgs.length, 4)
  assert.ok(imgs[1].includes('/ig/img') && !imgs[1].includes('m=lite'))
  assert.ok(imgs[2].includes('m=lite'))
})

// ── Poll adaptativo ───────────────────────────────────────────────────────

test('el poll del contenedor tiene tope de 12 consultas (antes 30) y publica igual', async () => {
  iniciarPresupuesto()
  _setPollMs(1)
  const env = await mkEnv()
  let polls = 0
  stubFetch(url => {
    if (url.includes('/media_publish')) return okJson({ id: 'PUB' })
    if (url.includes('fields=status_code')) { polls++; return okJson({ status_code: 'IN_PROGRESS' }) }
    return okJson({ id: 'CONT' })
  })
  assert.equal(await igPublishImage(env, { imageUrl: 'https://x/y.jpg', caption: 'c', raw: true }), 'PUB')
  assert.equal(polls, 12)
  _setPollMs(null)
})

test('el contenedor listo al primer poll no espera de más', async () => {
  iniciarPresupuesto()
  _setPollMs(null)
  const env = await mkEnv()
  let polls = 0
  const t0 = Date.now()
  stubFetch(url => {
    if (url.includes('/media_publish')) return okJson({ id: 'PUB' })
    if (url.includes('fields=status_code')) { polls++; return okJson({ status_code: 'FINISHED' }) }
    return okJson({ id: 'CONT' })
  })
  await igPublishImage(env, { imageUrl: 'https://x/y.jpg', caption: 'c', raw: true })
  assert.equal(polls, 1)
  assert.ok(Date.now() - t0 < 400, 'no debe dormir si Meta ya terminó')
})

test('contenedor en ERROR sigue abortando (no publica basura)', async () => {
  iniciarPresupuesto()
  const env = await mkEnv()
  stubFetch(url => url.includes('fields=status_code')
    ? okJson({ status_code: 'ERROR' })
    : okJson({ id: 'CONT' }))
  await assert.rejects(() => igPublishImage(env, { imageUrl: 'https://x/y.jpg', caption: 'c', raw: true }),
    /quedó en ERROR/)
})

// ── Presupuesto de subrequests ────────────────────────────────────────────

test('el presupuesto cuenta, corta y se reinicia', () => {
  iniciarPresupuesto(TOPE_FREE)
  const { tope } = _estado()
  assert.ok(tope < TOPE_FREE, 'debe dejar colchón para lo que no pasa por el contador')
  assert.equal(hayPara(tope), true)
  assert.equal(gastar(tope - 1), true)
  assert.equal(restante(), 1)
  assert.equal(gastar(5), false)      // pasarse se detecta
  assert.equal(restante(), 0)         // y nunca es negativo
  iniciarPresupuesto(TOPE_FREE)
  assert.equal(restante(), tope)
})

test('sin presupuesto, waitForContainer deja de consultar y publica con lo que hay', async () => {
  iniciarPresupuesto(12)              // tope efectivo 6
  _setPollMs(1)
  const env = await mkEnv()
  let polls = 0, publicado = false
  stubFetch(url => {
    if (url.includes('/media_publish')) { publicado = true; return okJson({ id: 'PUB' }) }
    if (url.includes('fields=status_code')) { polls++; return okJson({ status_code: 'IN_PROGRESS' }) }
    return okJson({ id: 'CONT' })
  })
  assert.equal(await igPublishImage(env, { imageUrl: 'https://x/y.jpg', caption: 'c', raw: true }), 'PUB')
  assert.ok(polls <= 2, `debe cortar al quedarse sin presupuesto (polls=${polls})`)
  assert.ok(publicado, 'aun sin presupuesto para consultar, intenta publicar')
  _setPollMs(null)
  iniciarPresupuesto()
})

test('un tick que no tiene el lock no le pega a la Graph API', async () => {
  const env = { IG_USER_ID: IG_USER, DB: new FakeDB() }
  env.DB.seedQueue({ ml_item_id: 'MLC1', titulo: 'p', precio: 1000, estado: 'pendiente' })
  await setRush(env)
  // Otra corrida ya está trabajando (lock vivo).
  await env.DB.seedConfig('corriendo', JSON.stringify({ hasta: new Date(Date.now() + 60e3).toISOString() }))
  let consultasDeCupo = 0
  const deps = {
    getQuota: async () => { consultasDeCupo++; return { usados: 0, total: 100 } },
    getItem: async () => ({ status: 'active', pictures: [{ secure_url: 'https://x/y.jpg' }] }),
    publishImage: async () => 'M1',
  }
  const r = await runIgPublisher(env, { now: new Date('2026-07-20T18:00:00Z'), deps })
  assert.equal(r.enCurso, true)
  assert.equal(consultasDeCupo, 0, 'el cupo se consulta recién con el lock en la mano')
})

test('el publisher corta la corrida antes de reventar el límite de subrequests', async () => {
  const env = { IG_USER_ID: IG_USER, DB: new FakeDB() }
  for (let n = 1; n <= 5; n++)
    env.DB.seedQueue({ ml_item_id: 'MLC' + n, titulo: 'p' + n, precio: 1000, estado: 'pendiente' })
  await setRush(env)
  const deps = {
    getQuota: async () => ({ usados: 0, total: 100 }),
    getItem: async () => ({ status: 'active', pictures: [{ secure_url: 'https://x/y.jpg' }] }),
    // Cada foto quema 11 subrequests: con 44 disponibles no entran las 5 filas.
    publishImage: async () => { gastar(11); return 'M' + Math.random() },
  }
  const now = new Date('2026-07-20T18:00:00Z')   // 14:00 Chile, dentro de horario
  const r = await runIgPublisher(env, { now, deps })
  assert.ok(r.publicados >= 1 && r.publicados < 5,
    `debe publicar lo que cabe y dejar el resto pendiente (publicados=${r.publicados})`)
  const pend = env.DB.queue.filter(x => x.estado === 'pendiente').length
  assert.equal(r.publicados + pend, 5, 'ninguna fila puede quedar reclamada a medias')
  iniciarPresupuesto()
})
