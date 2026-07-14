/**
 * [IG] Lógica pura de MLPU-Instagram: caption, ventanas horarias y formato.
 * Sin fetch ni D1 acá — todo testeable con node --test.
 */

export const FALLBACK_WINDOWS = ['12:30', '20:00']
export const HASHTAGS = '#repuestos #autos #desarme #repuestosusados #chile'

export function fmtCLP(n) {
  return '$' + Math.round(Number(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

export function buildCaption({ titulo, precio, link }) {
  return `🔧 ${titulo}\n💰 ${fmtCLP(precio)}\n👉 ${link}\n\n${HASHTAGS}`
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

// Clave única de la ventana activa (para correr UNA vez por ventana): 'YYYY-MM-DDTHH:MM'.
export function windowKey(date, windows, tz = 'America/Santiago') {
  const w = activeWindow(date, windows, tz)
  return w ? `${localParts(date, tz).fecha}T${w}` : null
}
