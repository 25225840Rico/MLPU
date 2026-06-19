/**
 * [ML-HISTORY] Historial de ventas desde la API de MercadoLibre.
 *
 * Endpoints usados (reusan el token de ML del KV vía getValidAccessToken):
 *   GET /orders/search?seller={id}&sort=date_desc&limit=50&offset=0
 *       → lista de órdenes del vendedor (paging.total trae el total).
 *       Filtros: order.status, order.date_created.from / .to
 *   GET /users/{buyer_id}
 *       → con Mercado Envíos 2 (ME2) el nombre completo del comprador NO viene
 *         en /orders (solo buyer.id y buyer.nickname). Se resuelve con esta 2ª
 *         llamada. Si ML restringe datos personales (403), se usa el nickname.
 *   GET /shipments/{id}
 *       → estado de envío + tracking para el detalle de una orden.
 *
 * Rate limit ML: 1500 req/min → al paginar se intercala un delay de 100 ms.
 * NO toca módulos existentes; solo lee de ML.
 */
import { getValidAccessToken } from './index.js'

const ML_API  = 'https://api.mercadolibre.com'
const log      = (...a) => console.log('[ML-HISTORY]', ...a)
const logErr   = (...a) => console.error('[ML-HISTORY]', ...a)
const sleep    = (ms) => new Promise(r => setTimeout(r, ms))
const isoML    = (d) => d.toISOString().replace('Z', '-00:00') // formato fecha que acepta ML

async function mlGet(token, path) {
  const r = await fetch(`${ML_API}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  const data = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, data }
}

// Lanza un Error con .status para que el bot pueda detectar el 403 de permisos.
function httpError(prefix, res) {
  const e = new Error(`${prefix} HTTP ${res.status}${res.data?.message ? ` — ${res.data.message}` : ''}`)
  e.status = res.status
  return e
}

// ── Seller id: de la var de entorno SELLER_ID o de /users/me ──
let _sellerId = null
export async function getSellerId(env, token) {
  if (_sellerId) return _sellerId
  if (env.SELLER_ID) { _sellerId = String(env.SELLER_ID); return _sellerId }
  const r = await mlGet(token, '/users/me')
  if (!r.ok) throw httpError('/users/me', r)
  _sellerId = String(r.data.id)
  return _sellerId
}

// ── Resolver nombre del comprador (cache para no repetir GET /users/{id}) ──
const _buyerCache = new Map()
async function resolveBuyerName(token, buyer = {}) {
  const direct = [buyer.first_name, buyer.last_name].filter(Boolean).join(' ').trim()
  if (direct) return direct
  const nick = buyer.nickname || 'Comprador'
  if (!buyer.id) return nick
  if (_buyerCache.has(buyer.id)) return _buyerCache.get(buyer.id)

  // 2ª llamada: en ME2 el nombre no viene en /orders.
  const u = await mlGet(token, `/users/${buyer.id}`)
  let name = nick
  if (u.ok) {
    name = [u.data.first_name, u.data.last_name].filter(Boolean).join(' ').trim() || u.data.nickname || nick
  } else if (u.status === 403) {
    log(`/users/${buyer.id} 403 → uso nickname (ML restringe datos personales)`)
  }
  _buyerCache.set(buyer.id, name)
  return name
}

// ── Map de orden ML → forma compacta que usa el bot ──
function mapOrder(order) {
  const item = order.order_items?.[0] || {}
  return {
    order_id:        String(order.id),
    pack_id:         order.pack_id ?? null,
    fecha:           order.date_created || null,
    estado:          order.status || 'unknown',
    producto:        item.item?.title || 'Producto',
    cantidad:        item.quantity || 1,
    monto:           order.total_amount ?? null,
    currency:        order.currency_id || 'CLP',
    buyer_id:        order.buyer?.id ?? null,
    buyer_nickname:  order.buyer?.nickname || null,
    shipment_id:     order.shipping?.id ?? null,
    tracking_number: null,         // ML no lo entrega en /orders; se trae del shipment
    _buyer:          order.buyer || {},
  }
}

async function resolveNamesInPlace(token, orders) {
  for (const o of orders) {
    o.buyer_name = await resolveBuyerName(token, o._buyer)
    delete o._buyer
  }
  return orders
}

// ── Historial paginado simple ──
export async function getOrderHistory(env, { limit = 50, offset = 0, status = null, resolveNames = true } = {}) {
  const token  = await getValidAccessToken(env)
  const seller = await getSellerId(env, token)
  let path = `/orders/search?seller=${seller}&sort=date_desc&limit=${limit}&offset=${offset}`
  if (status) path += `&order.status=${status}`
  const res = await mlGet(token, path)
  if (!res.ok) throw httpError('/orders/search', res)

  const total  = res.data.paging?.total ?? 0
  const orders = (res.data.results || []).map(mapOrder)
  if (resolveNames) await resolveNamesInPlace(token, orders)
  log(`historial: ${orders.length}/${total} (offset ${offset})`)
  return { total, orders }
}

// ── Historial por rango de fechas, con paginación automática ──
export async function getOrdersByDateRange(env, fromDate, toDate) {
  const token  = await getValidAccessToken(env)
  const seller = await getSellerId(env, token)
  const from = encodeURIComponent(isoML(fromDate))
  const to   = encodeURIComponent(isoML(toDate))

  const all = []
  let offset = 0, total = Infinity
  while (offset < total) {
    const path = `/orders/search?seller=${seller}&sort=date_desc&limit=50&offset=${offset}` +
                 `&order.date_created.from=${from}&order.date_created.to=${to}`
    const res = await mlGet(token, path)
    if (!res.ok) throw httpError('/orders/search', res)
    total = res.data.paging?.total ?? 0
    const batch = (res.data.results || []).map(mapOrder)
    all.push(...batch)
    offset += 50
    if (!batch.length) break
    if (offset < total) await sleep(100) // rate limit
  }
  await resolveNamesInPlace(token, all)
  return { total: all.length, orders: all }
}

// ── Buscar por nombre/nickname del comprador (filtra sobre el historial reciente) ──
export async function searchOrderByBuyer(env, query) {
  const { orders } = await getOrderHistory(env, { limit: 50, offset: 0 })
  const q = (query || '').toLowerCase().trim()
  return orders.filter(o =>
    (o.buyer_name || '').toLowerCase().includes(q) ||
    (o.buyer_nickname || '').toLowerCase().includes(q))
}

// ── Detalle de una orden puntual (incluye estado de envío + tracking) ──
export async function getOrderDetail(env, orderId) {
  const token = await getValidAccessToken(env)
  const res = await mlGet(token, `/orders/${orderId}`)
  if (!res.ok) throw httpError(`/orders/${orderId}`, res)
  const o = mapOrder(res.data)
  o.buyer_name = await resolveBuyerName(token, res.data.buyer)
  delete o._buyer
  if (o.shipment_id) {
    const s = await mlGet(token, `/shipments/${o.shipment_id}`)
    if (s.ok) {
      o.ship_status      = s.data.status || null
      o.tracking_number  = s.data.tracking_number || null
    }
  }
  return o
}

// ── Rangos de fecha útiles para "hoy" / "este mes" ──
export function todayRange() {
  const n = new Date()
  return {
    from: new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), 0, 0, 0)),
    to:   new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), 23, 59, 59)),
  }
}
export function monthRange() {
  const n = new Date()
  return {
    from: new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1, 0, 0, 0)),
    to:   new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 0, 23, 59, 59)),
  }
}
