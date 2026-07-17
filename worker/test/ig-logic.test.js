import test from 'node:test'
import assert from 'node:assert/strict'
import { fmtCLP, buildCaption, pickBestWindows, isInWindow, windowKey, FALLBACK_WINDOWS, maxResPicture, liteImageUrl, cloudinaryBlurUrl } from '../ig-logic.js'

test('liteImageUrl: compositor propio en modo lite (con s=1 en historias)', () => {
  assert.equal(
    liteImageUrl('https://pub.test', 'https://http2.mlstatic.com/a-F.jpg', true),
    'https://pub.test/ig/img?u=' + encodeURIComponent('https://http2.mlstatic.com/a-F.jpg') + '&s=1&m=lite')
  assert.ok(!liteImageUrl('https://pub.test', 'https://x/y.jpg', false).includes('s=1'))
})

test('cloudinaryBlurUrl: feed 1080x1080 — fondo c_fill+e_blur y la misma foto c_fit encima', () => {
  const src = 'https://http2.mlstatic.com/a-F.jpg'
  const b64 = Buffer.from(src).toString('base64url')
  assert.equal(cloudinaryBlurUrl('nube1', src),
    'https://res.cloudinary.com/nube1/image/fetch/' +
    'w_1080,h_1080,c_fill,e_blur:2000/' +
    `l_fetch:${b64},w_1080,h_1080,c_fit/fl_layer_apply/` +
    'f_jpg,q_90/' + encodeURIComponent(src))
})

test('cloudinaryBlurUrl: historia 1080x1920 con banner l_disponible al sur', () => {
  const u = cloudinaryBlurUrl('nube1', 'https://x.com/f.jpg', true)
  assert.ok(u.includes('w_1080,h_1920,c_fill,e_blur:2000/'))
  assert.ok(u.includes(',w_1080,h_1920,c_fit/fl_layer_apply/'))
  assert.ok(u.includes('/l_disponible/fl_layer_apply,g_south,y_230/f_jpg,q_90/'))
})

test('fmtCLP separa miles con punto', () => {
  assert.equal(fmtCLP(12990), '$12.990')
  assert.equal(fmtCLP(990), '$990')
  assert.equal(fmtCLP(1250000), '$1.250.000')
})

test('buildCaption: título, precio, DISPONIBLE, DM y hashtags (sin link de ML)', () => {
  const c = buildCaption({ titulo: '2021 Ford Bronco Matchbox', precio: 12000 })
  assert.equal(c,
    '🏎️ 2021 Ford Bronco Matchbox\n\n💰 $12.000 · 🟢 DISPONIBLE\n📦 Envíos a todo Chile\n📩 Pídelo por DM\n\n' +
    '#hotwheels #matchbox #diecast #hotwheelschile #coleccionables #autosaescala #chile')
  assert.ok(!c.includes('http'))
})

test('pickBestWindows elige las 2 mejores horas con separación mínima', () => {
  const hourly = Object.fromEntries(Array.from({ length: 24 }, (_, h) => [String(h), 0]))
  hourly['20'] = 100; hourly['21'] = 95; hourly['13'] = 80
  // 21 se descarta por estar a <2h de 20 → gana 13
  assert.deepEqual(pickBestWindows(hourly), ['13:00', '20:00'])
})

test('pickBestWindows con datos vacíos devuelve fallback', () => {
  assert.deepEqual(pickBestWindows({}), FALLBACK_WINDOWS)
  assert.deepEqual(pickBestWindows(null), FALLBACK_WINDOWS)
})

test('isInWindow respeta la zona America/Santiago y el bloque de 60 min', () => {
  // 2026-07-13 es invierno en Chile: UTC-4. 16:30 UTC = 12:30 Chile.
  assert.equal(isInWindow(new Date('2026-07-13T16:30:00Z'), ['12:30', '20:00']), true)
  assert.equal(isInWindow(new Date('2026-07-13T17:29:00Z'), ['12:30', '20:00']), true)  // 13:29 Chile
  assert.equal(isInWindow(new Date('2026-07-13T17:30:00Z'), ['12:30', '20:00']), false) // 13:30 Chile
  assert.equal(isInWindow(new Date('2026-07-14T00:15:00Z'), ['12:30', '20:00']), true)  // 20:15 Chile
})

test('windowKey identifica la ventana activa con fecha local', () => {
  assert.equal(windowKey(new Date('2026-07-14T00:15:00Z'), ['12:30', '20:00']), '2026-07-13T20:00')
  assert.equal(windowKey(new Date('2026-07-13T10:00:00Z'), ['12:30', '20:00']), null)
})

test('maxResPicture: cambia -O.<ext> por -F.jpg en URLs mlstatic', () => {
  assert.equal(
    maxResPicture('https://http2.mlstatic.com/D_824754-MLC112921128350_072026-O.webp'),
    'https://http2.mlstatic.com/D_824754-MLC112921128350_072026-F.jpg')
  assert.equal(
    maxResPicture('https://http2.mlstatic.com/D_123-MLC456_072026-O.jpg'),
    'https://http2.mlstatic.com/D_123-MLC456_072026-F.jpg')
})

test('maxResPicture: deja intactas URLs que no calzan el patrón', () => {
  assert.equal(maxResPicture('https://http2.mlstatic.com/D_123-MLC456-F.webp'),
    'https://http2.mlstatic.com/D_123-MLC456-F.webp')
  assert.equal(maxResPicture('https://otro.cdn.com/foto-O.jpg'), 'https://otro.cdn.com/foto-O.jpg')
  assert.equal(maxResPicture(null), null)
})

test('blurImageUrl: arma la URL del compositor propio (feed e historia)', async () => {
  const { blurImageUrl } = await import('../ig-logic.js')
  assert.equal(blurImageUrl('https://pub.test', 'https://http2.mlstatic.com/a b.jpg'),
    'https://pub.test/ig/img?u=https%3A%2F%2Fhttp2.mlstatic.com%2Fa%20b.jpg')
  assert.equal(blurImageUrl('https://pub.test', 'https://x/f.jpg', true),
    'https://pub.test/ig/img?u=https%3A%2F%2Fx%2Ff.jpg&s=1')
})
