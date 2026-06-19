/**
 * [ML] fetch a la API de MercadoLibre con reintento ante rate-limit (429) o
 * indisponibilidad transitoria (503).
 *
 * El bot dispara ráfagas de llamadas (historial, scheduler, asignar tracking,
 * mensajería). ML responde 429 con facilidad; sin reintento, cualquier acción
 * caía con "HTTP 429". Este helper centraliza la política: respeta el header
 * Retry-After si viene; si no, backoff exponencial corto (0.3 / 0.6 / 1.2 s).
 *
 * Es un reemplazo directo de `fetch(url, options)` (misma firma + devuelve el
 * Response). Usalo para TODA llamada a api.mercadolibre.com.
 */
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

export async function mlFetch(url, options = {}, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, options)
    if ((r.status === 429 || r.status === 503) && attempt < retries) {
      const ra = parseInt(r.headers.get('retry-after') || '', 10)
      const waitMs = Number.isFinite(ra) ? ra * 1000 : Math.min(2000, 300 * 2 ** attempt)
      await sleep(waitMs)
      continue
    }
    return r
  }
}
