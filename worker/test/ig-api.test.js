import test from 'node:test'
import assert from 'node:assert/strict'
import { getMetaToken, igPublishImage, fetchOnlineFollowers, maybeRefreshMetaToken } from '../ig-api.js'
import { FakeDB } from './fake-db.js'

const envBase = () => ({ IG_USER_ID: '17841400000000000', META_APP_ID: 'app1', META_APP_SECRET: 'sec1', PUBLIC_URL: 'https://pub.test', DB: new FakeDB() })

function stubFetch(handler) {
  const calls = []
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts })
    return handler(String(url), opts)
  }
  return calls
}
const okJson = data => ({ ok: true, json: async () => data })

test('getMetaToken lanza si no hay token', async () => {
  await assert.rejects(() => getMetaToken(new FakeDB()), /sin token de Meta/)
})

test('igPublishImage feed: media + media_publish', async () => {
  const env = envBase()
  await env.DB.seedConfig('meta_token', JSON.stringify({ token: 'TOK', obtenido_en: new Date().toISOString() }))
  const calls = stubFetch(url =>
    url.includes('/media_publish') ? okJson({ id: 'MEDIA9' }) : okJson({ id: 'CONT1' }))
  const id = await igPublishImage(env, { imageUrl: 'https://http2.mlstatic.com/x.jpg', caption: 'hola' })
  assert.equal(id, 'MEDIA9')
  // contenedor → consulta de status_code (poll) → media_publish
  assert.equal(calls.length, 3)
  assert.match(calls[0].url, /\/17841400000000000\/media$/)
  assert.match(calls[1].url, /fields=status_code/)
  assert.match(String(calls[0].opts.body), /caption=hola/)
  assert.ok(!String(calls[0].opts.body).includes('media_type'))
})

test('igPublishImage story manda media_type=STORIES y sin caption', async () => {
  const env = envBase()
  await env.DB.seedConfig('meta_token', JSON.stringify({ token: 'TOK', obtenido_en: new Date().toISOString() }))
  const calls = stubFetch(url =>
    url.includes('/media_publish') ? okJson({ id: 'ST1' }) : okJson({ id: 'CONT2' }))
  const id = await igPublishImage(env, { imageUrl: 'https://x/y.jpg', story: true })
  assert.equal(id, 'ST1')
  assert.match(String(calls[0].opts.body), /media_type=STORIES/)
  assert.ok(!String(calls[0].opts.body).includes('caption='))
})

test('igPublishImage propaga el error de la Graph API', async () => {
  const env = envBase()
  await env.DB.seedConfig('meta_token', JSON.stringify({ token: 'TOK', obtenido_en: new Date().toISOString() }))
  stubFetch(() => ({ ok: false, json: async () => ({ error: { message: 'token expirado' } }) }))
  await assert.rejects(() => igPublishImage(env, { imageUrl: 'https://x/y.jpg', caption: 'c' }), /token expirado/)
})

// Helpers para los tests de igPublishImage con padding/wsrv (Task 3).
async function makeEnv() {
  const env = envBase()
  await env.DB.seedConfig('meta_token', JSON.stringify({ token: 'TOK', obtenido_en: new Date().toISOString() }))
  return env
}

function mockGraphOk() {
  return stubFetch(url => url.includes('/media_publish') ? okJson({ id: 'P1' }) : okJson({ id: 'C1' }))
}

test('igPublishImage: usa el compositor blur propio con variante -F.jpg para el feed', async () => {
  const calls = mockGraphOk()
  const env = await makeEnv()
  await igPublishImage(env, { imageUrl: 'https://http2.mlstatic.com/D_1-MLC2_072026-O.webp', caption: 'hola' })
  const body = calls[0].opts.body
  const img = new URLSearchParams(body).get('image_url')
  assert.ok(img.startsWith('https://pub.test/ig/img?u='))
  assert.ok(img.includes(encodeURIComponent('D_1-MLC2_072026-F.jpg')))
  assert.ok(!img.includes('s=1'))
})

test('igPublishImage story: el compositor recibe s=1', async () => {
  const calls = mockGraphOk()
  const env = await makeEnv()
  await igPublishImage(env, { imageUrl: 'https://http2.mlstatic.com/D_1-MLC2_072026-O.webp', story: true })
  const img = new URLSearchParams(calls[0].opts.body).get('image_url')
  assert.ok(img.startsWith('https://pub.test/ig/img?u='))
  assert.ok(img.endsWith('&s=1'))
})

test('igPublishImage: cadena de fallback blur → wsrv → URL original', async () => {
  let mediaCalls = 0
  const calls = stubFetch(url => {
    if (url.includes('/media_publish')) return okJson({ id: 'P1' })
    mediaCalls++
    if (mediaCalls <= 2) return { ok: true, json: async () => ({ error: { message: 'Media download failed: bad image url' } }) }
    return okJson({ id: 'C1' })
  })
  const env = await makeEnv()
  const id = await igPublishImage(env, { imageUrl: 'https://http2.mlstatic.com/D_1-MLC2_072026-O.webp', caption: 'x' })
  assert.equal(id, 'P1')
  const img1 = new URLSearchParams(calls[0].opts.body).get('image_url')
  const img2 = new URLSearchParams(calls[1].opts.body).get('image_url')
  const img3 = new URLSearchParams(calls[2].opts.body).get('image_url')
  assert.ok(img1.startsWith('https://pub.test/ig/img?u='))
  assert.ok(img2.startsWith('https://wsrv.nl/?url='))
  assert.equal(img3, 'https://http2.mlstatic.com/D_1-MLC2_072026-O.webp')
})

test('igPublishImage story: cadena blur → pad propio (banner) → wsrv → original', async () => {
  let mediaCalls = 0
  const calls = stubFetch(url => {
    if (url.includes('/media_publish')) return okJson({ id: 'P1' })
    mediaCalls++
    if (mediaCalls <= 3) return { ok: true, json: async () => ({ error: { message: 'Media download failed: bad image url' } }) }
    return okJson({ id: 'C1' })
  })
  const env = await makeEnv()
  const id = await igPublishImage(env, { imageUrl: 'https://http2.mlstatic.com/D_1-MLC2_072026-O.webp', story: true })
  assert.equal(id, 'P1')
  const imgs = calls.filter(c => c.url.endsWith('/media'))
    .map(c => new URLSearchParams(c.opts.body).get('image_url'))
  assert.equal(imgs.length, 4)
  assert.ok(imgs[0].startsWith('https://pub.test/ig/img?u=') && !imgs[0].includes('m=pad'))
  assert.ok(imgs[1].startsWith('https://pub.test/ig/img?u=') && imgs[1].includes('s=1') && imgs[1].includes('m=pad'))
  assert.ok(imgs[2].startsWith('https://wsrv.nl/?url='))
  assert.equal(imgs[3], 'https://http2.mlstatic.com/D_1-MLC2_072026-O.webp')
})

test('igPublishImage: si el error es rate-limit/token, NO reintenta y lanza', async () => {
  let mediaCalls = 0
  stubFetch(url => {
    if (url.includes('/media_publish')) return okJson({ id: 'P1' })
    mediaCalls++
    return { ok: true, json: async () => ({ error: { message: '(#4) Application request limit reached' } }) }
  })
  const env = await makeEnv()
  await assert.rejects(
    () => igPublishImage(env, { imageUrl: 'https://http2.mlstatic.com/D_1-MLC2_072026-O.webp', caption: 'x' }),
    /Application request limit reached/
  )
  assert.equal(mediaCalls, 1) // no hubo segundo intento
})

test('igPublishImage raw: publica la URL tal cual (sin wsrv)', async () => {
  const calls = mockGraphOk()
  const env = await makeEnv()
  await igPublishImage(env, { imageUrl: 'https://mlpu-proxy.aronricocl.workers.dev/ig/promo.png', story: true, raw: true })
  const p = new URLSearchParams(calls[0].opts.body)
  assert.equal(p.get('image_url'), 'https://mlpu-proxy.aronricocl.workers.dev/ig/promo.png')
  assert.equal(p.get('media_type'), 'STORIES')
})

test('fetchOnlineFollowers suma por hora y devuelve null si no hay métrica', async () => {
  const env = envBase()
  await env.DB.seedConfig('meta_token', JSON.stringify({ token: 'TOK', obtenido_en: new Date().toISOString() }))
  stubFetch(() => okJson({ data: [{ name: 'online_followers', values: [
    { value: { 12: 10, 20: 50 } }, { value: { 12: 5, 20: 30 } },
  ] }] }))
  assert.deepEqual(await fetchOnlineFollowers(env), { 12: 15, 20: 80 })
  stubFetch(() => okJson({ data: [] }))
  assert.equal(await fetchOnlineFollowers(env), null)
})

test('maybeRefreshMetaToken renueva solo si tiene más de 45 días', async () => {
  const env = envBase()
  const viejo = new Date(Date.now() - 50 * 24 * 3600 * 1000).toISOString()
  await env.DB.seedConfig('meta_token', JSON.stringify({ token: 'OLD', obtenido_en: viejo }))
  stubFetch(() => okJson({ access_token: 'NEW' }))
  assert.equal(await maybeRefreshMetaToken(env), true)
  assert.equal(JSON.parse(await env.DB.getConfig('meta_token')).token, 'NEW')
  // recién renovado → no vuelve a renovar
  assert.equal(await maybeRefreshMetaToken(env), false)
})

test('igPublishImage reintenta media_publish mientras Meta procesa el contenedor', async () => {
  const { _setRetryBaseMs } = await import('../ig-api.js')
  _setRetryBaseMs(1)
  const env = await makeEnv()
  let publishCalls = 0
  const calls = stubFetch(url => {
    if (url.includes('/media_publish')) {
      publishCalls++
      return publishCalls < 3
        ? { ok: false, json: async () => ({ error: { message: 'Media ID is not available' } }) }
        : okJson({ id: 'PUB_OK' })
    }
    return okJson({ id: 'CONT9' })
  })
  const id = await igPublishImage(env, { imageUrl: 'https://http2.mlstatic.com/a-O.jpg', caption: 'x' })
  assert.equal(id, 'PUB_OK')
  assert.equal(publishCalls, 3)
  assert.equal(calls.filter(c => c.url.endsWith('/media')).length, 1) // un solo contenedor, sin fallback
  _setRetryBaseMs(1500)
})
