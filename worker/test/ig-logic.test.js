import test from 'node:test'
import assert from 'node:assert/strict'
import { fmtCLP, buildCaption, pickBestWindows, isInWindow, windowKey, FALLBACK_WINDOWS } from '../ig-logic.js'

test('fmtCLP separa miles con punto', () => {
  assert.equal(fmtCLP(12990), '$12.990')
  assert.equal(fmtCLP(990), '$990')
  assert.equal(fmtCLP(1250000), '$1.250.000')
})

test('buildCaption arma título, precio, link y hashtags', () => {
  const c = buildCaption({ titulo: 'Foco Hyundai Accent', precio: 19990, link: 'https://articulo.mercadolibre.cl/MLC-123' })
  assert.match(c, /^🔧 Foco Hyundai Accent\n💰 \$19\.990\n👉 https:\/\/articulo\.mercadolibre\.cl\/MLC-123\n\n#/)
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
