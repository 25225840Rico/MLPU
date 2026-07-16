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

// Compone el JPEG final (Uint8Array) a partir de los bytes de la foto original.
// El blur del fondo se hace barato: downscale 1/8 + gaussian chico + upscale.
export function composeBlur(bytes, story = false) {
  const { W, H } = canvasSize(story)
  const src = PhotonImage.new_from_byteslice(bytes)
  const sw = src.get_width(), sh = src.get_height()

  const cover = Math.max(W / sw, H / sh)
  const bw = Math.ceil(sw * cover), bh = Math.ceil(sh * cover)
  const small = resize(src, Math.max(1, Math.round(bw / 8)), Math.max(1, Math.round(bh / 8)), SamplingFilter.Triangle)
  gaussian_blur(small, 2)
  const bgBig = resize(small, bw, bh, SamplingFilter.Triangle)
  const cx = Math.floor((bw - W) / 2), cy = Math.floor((bh - H) / 2)
  const canvas = crop(bgBig, cx, cy, cx + W, cy + H)

  const contain = Math.min(W / sw, H / sh)
  const fw = Math.round(sw * contain), fh = Math.round(sh * contain)
  const fg = resize(src, fw, fh, SamplingFilter.CatmullRom)
  watermark(canvas, fg, BigInt(Math.round((W - fw) / 2)), BigInt(Math.round((H - fh) / 2)))

  const out = canvas.get_bytes_jpeg(90)
  for (const im of [src, small, bgBig, canvas, fg]) im.free()
  return out
}

// GET /ig/img?u=<url mlstatic encodeada>[&s=1] — no es un proxy abierto:
// solo acepta fotos del CDN de ML.
export async function igImageProxy(request) {
  const url = new URL(request.url)
  let src
  try { src = new URL(url.searchParams.get('u') || '') } catch { return new Response('u inválida', { status: 400 }) }
  if (!/(^|\.)mlstatic\.com$/.test(src.hostname)) return new Response('solo imágenes de mlstatic.com', { status: 403 })
  const story = url.searchParams.get('s') === '1'

  const r = await fetch(src, { cf: { cacheTtl: 86400, cacheEverything: true } })
  if (!r.ok) return new Response(`no pude bajar la imagen (${r.status})`, { status: 502 })
  const bytes = new Uint8Array(await r.arrayBuffer())
  const jpeg = composeBlur(bytes, story)
  return new Response(jpeg, {
    headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' },
  })
}
