/**
 * Cloudflare Worker — Proxy para MercadoLibre API
 * Resuelve el bloqueo CORS en endpoints autenticados desde el navegador.
 *
 * Endpoints proxeados:
 *   POST /ml/pictures/items/upload  →  POST api.mercadolibre.com/pictures/items/upload
 *   POST /ml/items                  →  POST api.mercadolibre.com/items
 *   GET  /ml/*                      →  GET  api.mercadolibre.com/*
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
}

export default {
  async fetch(request) {
    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }

    const url = new URL(request.url)

    // Solo acepta rutas /ml/*
    if (!url.pathname.startsWith('/ml/')) {
      return new Response('Not found', { status: 404 })
    }

    const mlPath  = url.pathname.replace(/^\/ml/, '')
    const mlUrl   = `https://api.mercadolibre.com${mlPath}${url.search}`

    // Reenviar headers (sin los de Cloudflare)
    const fwdHeaders = new Headers()
    const skip = new Set(['host', 'cf-ray', 'cf-connecting-ip', 'x-forwarded-for',
                          'x-real-ip', 'cf-ipcountry', 'cf-visitor'])
    for (const [k, v] of request.headers.entries()) {
      if (!skip.has(k.toLowerCase())) fwdHeaders.set(k, v)
    }

    const upstream = await fetch(mlUrl, {
      method: request.method,
      headers: fwdHeaders,
      body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : undefined,
    })

    // Construir respuesta con CORS headers
    const resHeaders = new Headers(upstream.headers)
    for (const [k, v] of Object.entries(CORS)) resHeaders.set(k, v)

    return new Response(upstream.body, {
      status:     upstream.status,
      statusText: upstream.statusText,
      headers:    resHeaders,
    })
  }
}
