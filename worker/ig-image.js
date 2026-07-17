/**
 * [IG] Compositor de imágenes (spec Parte 5): la foto completa centrada sobre
 * la MISMA foto ampliada a cubrir el lienzo y blurreada. Corre en el Worker
 * con photon (WASM); si el CPU del plan no alcanza o algo falla, ig-api cae
 * a wsrv (padding blanco) y luego a la URL original.
 */
import { PhotonImage, resize, crop, gaussian_blur, watermark, SamplingFilter } from '@cf-wasm/photon'

// Lienzo IG: feed 1:1, historia 9:16.
export function canvasSize(story = false) {
  return { W: 1080, H: story ? 1920 : 1080 }
}

// Estampa la foto (contain, centrada) y el banner sobre un lienzo ya armado,
// libera la memoria WASM y devuelve el JPEG final (Uint8Array).
function finishCanvas(canvas, src, bannerBytes) {
  const W = canvas.get_width(), H = canvas.get_height()
  const sw = src.get_width(), sh = src.get_height()
  const contain = Math.min(W / sw, H / sh)
  const fw = Math.round(sw * contain), fh = Math.round(sh * contain)
  const fg = resize(src, fw, fh, SamplingFilter.CatmullRom)
  watermark(canvas, fg, BigInt(Math.round((W - fw) / 2)), BigInt(Math.round((H - fh) / 2)))

  const toFree = [src, fg]
  if (bannerBytes) {
    const banner = PhotonImage.new_from_byteslice(bannerBytes)
    // centrado, a ~230 px del borde inferior (sobre la zona segura de la UI de IG)
    watermark(canvas, banner,
      BigInt(Math.round((W - banner.get_width()) / 2)),
      BigInt(H - banner.get_height() - 230))
    toFree.push(banner)
  }

  const out = canvas.get_bytes_jpeg(90)
  toFree.push(canvas)
  for (const im of toFree) im.free()
  return out
}

// Compone el JPEG final a partir de los bytes de la foto original.
// El blur del fondo se hace barato: downscale 1/8 + gaussian chico + upscale.
// bannerBytes (PNG con alfa, opcional): se estampa centrado abajo (historias).
export function composeBlur(bytes, story = false, bannerBytes = null) {
  const { W, H } = canvasSize(story)
  const src = PhotonImage.new_from_byteslice(bytes)
  const sw = src.get_width(), sh = src.get_height()

  const cover = Math.max(W / sw, H / sh)
  const bw = Math.ceil(sw * cover), bh = Math.ceil(sh * cover)
  const small = resize(src, Math.max(1, Math.round(bw / 8)), Math.max(1, Math.round(bh / 8)), SamplingFilter.Triangle)
  gaussian_blur(small, 2)
  const bgBig = resize(small, bw, bh, SamplingFilter.Triangle)
  small.free()
  const cx = Math.floor((bw - W) / 2), cy = Math.floor((bh - H) / 2)
  const canvas = crop(bgBig, cx, cy, cx + W, cy + H)
  bgBig.free()

  return finishCanvas(canvas, src, bannerBytes)
}

// Variante barata del blur (fallback): el fondo se difumina igual, pero el
// upscale va DIRECTO al tamaño del lienzo (sin el intermedio "cover" más
// grande ni crop). La distorsión de aspecto del fondo es invisible bajo el
// blur. El fondo blur y el banner se conservan SIEMPRE (requisito del negocio).
export function composeLite(bytes, story = false, bannerBytes = null) {
  const { W, H } = canvasSize(story)
  const src = PhotonImage.new_from_byteslice(bytes)
  const small = resize(src, Math.max(1, Math.round(W / 8)), Math.max(1, Math.round(H / 8)), SamplingFilter.Triangle)
  gaussian_blur(small, 3)
  const canvas = resize(small, W, H, SamplingFilter.Triangle)
  small.free()
  return finishCanvas(canvas, src, bannerBytes)
}

// GET /ig/img?u=<url mlstatic encodeada>[&s=1][&m=lite] — no es un proxy
// abierto: solo acepta fotos del CDN de ML. En historias estampa el banner
// DISPONIBLE. m=lite: blur barato (fallback del compositor completo).
export async function igImageProxy(request, env) {
  const url = new URL(request.url)
  let src
  try { src = new URL(url.searchParams.get('u') || '') } catch { return new Response('u inválida', { status: 400 }) }
  if (!/(^|\.)mlstatic\.com$/.test(src.hostname)) return new Response('solo imágenes de mlstatic.com', { status: 403 })
  const story = url.searchParams.get('s') === '1'
  const lite  = url.searchParams.get('m') === 'lite'

  const r = await fetch(src, { cf: { cacheTtl: 86400, cacheEverything: true } })
  if (!r.ok) return new Response(`no pude bajar la imagen (${r.status})`, { status: 502 })
  const bytes = new Uint8Array(await r.arrayBuffer())

  let bannerBytes = null
  if (story && env?.ASSETS) {
    // el banner vive en los static assets del propio Worker (env.ASSETS)
    const b = await env.ASSETS.fetch(new Request(`${url.origin}/ig/disponible.png`))
    if (b.ok) bannerBytes = new Uint8Array(await b.arrayBuffer())
  }
  const jpeg = lite ? composeLite(bytes, story, bannerBytes) : composeBlur(bytes, story, bannerBytes)
  return new Response(jpeg, {
    headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' },
  })
}
