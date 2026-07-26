import test from 'node:test'
import assert from 'node:assert/strict'
import { recordOrderFromML, getOrder } from '../orders.js'

// KV falso: solo get/put/delete sobre un Map, que es todo lo que usa orders.js.
function fakeKV() {
  const m = new Map()
  return {
    _m: m,
    async get(k) { return m.has(k) ? m.get(k) : null },
    async put(k, v) { m.set(k, v) },
    async delete(k) { m.delete(k) },
  }
}

// Intercepta el fetch global (tgApi lo usa directo) y guarda los textos enviados.
// `ok` decide si Telegram acepta o rechaza el mensaje.
function stubTelegram({ ok = true, error = 'Bad Request: unsupported parse' } = {}) {
  const enviados = []
  const original = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    enviados.push(body.text)
    return { json: async () => (ok ? { ok: true, result: {} } : { ok: false, description: error }) }
  }
  return { enviados, restore() { globalThis.fetch = original } }
}

const env = () => ({ ML_ORDERS: fakeKV(), TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_CHAT_ID: '1' })

const ordenPagada = (extra = {}) => ({
  id: 777,
  status: 'paid',
  buyer: { first_name: 'Ana', last_name: 'Pérez' },
  total_amount: 15990,
  currency_id: 'CLP',
  order_items: [{ item: { title: 'Hot Wheels Camaro' }, quantity: 1 }],
  ...extra,
})

test('venta pagada: avisa a Telegram y marca alerted', async () => {
  const e = env()
  const tg = stubTelegram()
  try {
    await recordOrderFromML(e, ordenPagada(), null)
    assert.equal(tg.enviados.length, 1)
    assert.match(tg.enviados[0], /Nueva venta confirmada/)
    assert.equal((await getOrder(e, 777)).alerted, true)
  } finally { tg.restore() }
})

// El bug: `alerted:true` se persistia ANTES de intentar el envio, asi que un 429
// o un token vencido borraban la venta del radar para siempre (ML reintenta la
// notificacion, pero encontraba alerted:true y no volvia a avisar).
test('si Telegram falla, la orden NO queda marcada como avisada', async () => {
  const e = env()
  const tg = stubTelegram({ ok: false })
  try {
    await recordOrderFromML(e, ordenPagada(), null)
    assert.equal(tg.enviados.length, 1)
    assert.equal((await getOrder(e, 777)).alerted, false, 'debe quedar en false para reintentar')
  } finally { tg.restore() }

  // La siguiente notificacion de ML (misma orden) rescata el aviso perdido.
  const tg2 = stubTelegram({ ok: true })
  try {
    await recordOrderFromML(e, ordenPagada(), null)
    assert.equal(tg2.enviados.length, 1)
    assert.equal((await getOrder(e, 777)).alerted, true)
  } finally { tg2.restore() }
})

test('idempotencia: la segunda notificacion de una orden ya avisada no reenvia', async () => {
  const e = env()
  const tg = stubTelegram()
  try {
    await recordOrderFromML(e, ordenPagada(), null)
    await recordOrderFromML(e, ordenPagada(), null)
    assert.equal(tg.enviados.length, 1)
  } finally { tg.restore() }
})

test('orden sin pagar: se guarda pero no avisa', async () => {
  const e = env()
  const tg = stubTelegram()
  try {
    await recordOrderFromML(e, ordenPagada({ status: 'payment_required' }), null)
    assert.equal(tg.enviados.length, 0)
    assert.equal((await getOrder(e, 777)).status, 'payment_required')
  } finally { tg.restore() }
})

// parse_mode:'HTML' + un titulo con & o < = Telegram devuelve 400 y el aviso se pierde.
test('el aviso escapa & y < del nombre y del titulo', async () => {
  const e = env()
  const tg = stubTelegram()
  try {
    await recordOrderFromML(e, ordenPagada({
      buyer: { first_name: 'A&B', last_name: '<script>' },
      order_items: [{ item: { title: 'Hot Wheels & Matchbox <lote>' }, quantity: 2 }],
    }), null)
    const t = tg.enviados[0]
    assert.match(t, /A&amp;B &lt;script&gt;/)
    assert.match(t, /Hot Wheels &amp; Matchbox &lt;lote&gt;/)
    // Las etiquetas propias del mensaje siguen intactas.
    assert.match(t, /<b>Comprador:<\/b>/)
    assert.equal(/<script>/.test(t), false)
  } finally { tg.restore() }
})
