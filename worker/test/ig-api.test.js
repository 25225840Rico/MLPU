import test from 'node:test'
import assert from 'node:assert/strict'
import { getMetaToken, igPublishImage, fetchOnlineFollowers, maybeRefreshMetaToken } from '../ig-api.js'
import { FakeDB } from './fake-db.js'

const envBase = () => ({ IG_USER_ID: '17841400000000000', META_APP_ID: 'app1', META_APP_SECRET: 'sec1', DB: new FakeDB() })

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
  assert.equal(calls.length, 2)
  assert.match(calls[0].url, /\/17841400000000000\/media$/)
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
