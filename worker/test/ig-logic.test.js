import test from 'node:test'
import assert from 'node:assert/strict'
import { fmtCLP, buildCaption, pickBestWindows, isInWindow, windowKey, FALLBACK_WINDOWS, maxResPicture, padImageUrl } from '../ig-logic.js'

test('fmtCLP separa miles con punto', () => {
  assert.equal(fmtCLP(12990), '$12.990')
  assert.equal(fmtCLP(990), '$990')
  assert.equal(fmtCLP(1250000), '$1.250.000')
})

test('buildCaption: título, precio, DISPONIBLE, link y hashtags en bloques', () => {
  const c = buildCaption({ titulo: 'Llanta Bronco R15', precio: 12000, link: 'https://ml.cl/x' })
  assert.equal(c,
    '🔧 Llanta Bronco R15\n\n💰 $12.000\n🟢 DISPONIBLE\n\n👉 Comprar: https://ml.cl/x\n\n' +
    '#repuestos #autos #desarme #repuestosusados #chile')
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

test('padImageUrl: feed 1080x1080 con contain, fondo blanco y q=95', () => {
  const u = padImageUrl('https://http2.mlstatic.com/a b.jpg')
  assert.ok(u.startsWith('https://wsrv.nl/?url=https%3A%2F%2Fhttp2.mlstatic.com%2Fa%20b.jpg'))
  assert.ok(u.includes('&w=1080&h=1080&fit=contain&cbg=white&output=jpg&q=95'))
})

test('padImageUrl: historia 1080x1920', () => {
  assert.ok(padImageUrl('https://x.com/f.jpg', true).includes('&w=1080&h=1920&fit=contain'))
})
