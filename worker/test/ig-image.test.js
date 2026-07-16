import test from 'node:test'
import assert from 'node:assert/strict'
import { igImageProxy, canvasSize } from '../ig-image.js'

test('canvasSize: feed 1080x1080, historia 1080x1920', () => {
  assert.deepEqual(canvasSize(false), { W: 1080, H: 1080 })
  assert.deepEqual(canvasSize(true), { W: 1080, H: 1920 })
})

test('igImageProxy rechaza URLs que no son de mlstatic (no es proxy abierto)', async () => {
  const r = await igImageProxy(new Request('https://w.test/ig/img?u=' + encodeURIComponent('https://evil.com/x.jpg')))
  assert.equal(r.status, 403)
  const r2 = await igImageProxy(new Request('https://w.test/ig/img?u=notaurl'))
  assert.equal(r2.status, 400)
  const r3 = await igImageProxy(new Request('https://w.test/ig/img?u=' + encodeURIComponent('https://fakemlstatic.com/x.jpg')))
  assert.equal(r3.status, 403)
})
