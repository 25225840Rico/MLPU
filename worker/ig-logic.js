/**
 * [IG] Lógica pura de MLPU-Instagram: caption, ventanas horarias y formato.
 * Sin fetch ni D1 acá — todo testeable con node --test.
 */

export const FALLBACK_WINDOWS = ['12:30', '20:00']
export const HASHTAGS = '#hotwheels #matchbox #diecast #hotwheelschile #coleccionables #autosaescala #chile'

export function fmtCLP(n) {
  return '$' + Math.round(Number(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

// Sin link de ML (pedido del usuario 2026-07-15): la compra se guía por DM.
export function buildCaption({ titulo, precio }) {
  return `🏎️ ${titulo}\n\n💰 ${fmtCLP(precio)} · 🟢 DISPONIBLE\n📦 Envíos a todo Chile\n📩 Pídelo por DM\n\n${HASHTAGS}`
}

// hourly: { '0': n, ..., '23': n } (seguidores conectados por hora, de insights).
// Elige `count` horas pico con separación mínima para no publicar dos veces seguidas.
export function pickBestWindows(hourly, count = 2, minSepHours = 2) {
  const entries = Object.entries(hourly || {})
    .map(([h, v]) => [Number(h), Number(v) || 0])
    .filter(([h]) => Number.isInteger(h) && h >= 0 && h <= 23)
  if (!entries.some(([, v]) => v > 0)) return FALLBACK_WINDOWS
  entries.sort((a, b) => b[1] - a[1])
  const picked = []
  for (const [h] of entries) {
    const sep = x => Math.min(Math.abs(h - x), 24 - Math.abs(h - x))
    if (picked.every(p => sep(p) >= minSepHours)) picked.push(h)
    if (picked.length === count) break
  }
  return picked.sort((a, b) => a - b).map(h => `${String(h).padStart(2, '0')}:00`)
}

// Fecha y hora locales en la zona dada → { fecha: 'YYYY-MM-DD', minutos: 0..1439 }
function localParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const get = t => parts.find(p => p.type === t).value
  return {
    fecha: `${get('year')}-${get('month')}-${get('day')}`,
    minutos: Number(get('hour')) * 60 + Number(get('minute')),
  }
}

function activeWindow(date, windows, tz) {
  const { minutos } = localParts(date, tz)
  return (windows || []).find(w => {
    const [h, m] = w.split(':').map(Number)
    const start = h * 60 + m
    return minutos >= start && minutos < start + 60
  }) || null
}

export function isInWindow(date, windows, tz = 'America/Santiago') {
  return activeWindow(date, windows, tz) !== null
}

// Horario permitido del modo automático (goteo): 09:00–22:59 hora de Chile,
// para no publicar de madrugada (se ve bot y rinde peor).
export const AUTO_DESDE_MIN = 9 * 60
export const AUTO_HASTA_MIN = 23 * 60
export function enHorarioAuto(date, tz = 'America/Santiago') {
  const { minutos } = localParts(date, tz)
  return minutos >= AUTO_DESDE_MIN && minutos < AUTO_HASTA_MIN
}

// Clave única de la ventana activa (para correr UNA vez por ventana): 'YYYY-MM-DDTHH:MM'.
export function windowKey(date, windows, tz = 'America/Santiago') {
  const w = activeWindow(date, windows, tz)
  return w ? `${localParts(date, tz).fecha}T${w}` : null
}

// Variante de máxima resolución del CDN de ML: pictures[].secure_url llega como
// '-O' (~500px); '-F.jpg' es el original completo (= max_size). Verificado 2026-07-15.
export function maxResPicture(url) {
  if (typeof url !== 'string' || !/\bmlstatic\.com\//.test(url)) return url
  return url.replace(/-O\.(jpe?g|webp|png)$/i, '-F.jpg')
}

// URL del compositor propio (fondo = misma foto blurreada, spec Parte 5).
export function blurImageUrl(publicUrl, url, story = false) {
  return `${publicUrl}/ig/img?u=${encodeURIComponent(url)}${story ? '&s=1' : ''}`
}

// URL del proxy wsrv.nl que rellena con blanco hasta la proporción exacta de IG
// (feed 1:1, historia 9:16) sin recortar. q=95 porque el default (~80) degrada visible.
// Queda como fallback del compositor blur.
export function padImageUrl(url, story = false) {
  return `https://wsrv.nl/?url=${encodeURIComponent(url)}` +
    `&w=1080&h=${story ? 1920 : 1080}&fit=contain&cbg=white&output=jpg&q=95`
}
