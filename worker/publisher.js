/**
 * [ML-PUB] Catalogado y publicación de productos desde el bot de Telegram.
 *
 * Porta el pipeline del SPA "ML AutoPublisher" (src/agents/orchestrator.js +
 * App.jsx publish) al Worker:
 *   foto(s) → análisis IA (UN agente detallado con hasta 3 fotos) →
 *   domain_discovery → atributos requeridos por IA → subir fotos → crear ítem.
 *
 * Reglas fijas del negocio (decisión 2026-07-03):
 *   - shipping SIEMPRE { mode: 'me2', free_shipping: false } (paga el comprador).
 *   - available_quantity: 1 por defecto, editable desde la vista previa del bot.
 */

import { mlFetch } from './ml-fetch.js'

const ML = 'https://api.mercadolibre.com'
const log = (...a) => console.log('[ML-PUB]', ...a)

// ── Validador de título SEO (reglas de ML) ────────────────────
export function cleanTitle(title, maxLen = 60) {
  return (title || '')
    .replace(/[^a-záéíóúüñA-ZÁÉÍÓÚÜÑ0-9\s]/g, ' ')
    .replace(/\b(envío gratis|cuotas|descuento|full|stock|nuevo|usado|reacondicionado)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxLen)
}

// ML rechaza la descripción si trae emojis o símbolos decorativos (✓ ▪ ━ ⭐ …):
// "The description must be in plain text". Se degrada a texto plano puro.
export function sanitizeDescription(text) {
  return (text || '')
    .replace(/[✓✔▪•►◦]/g, '-')
    .replace(/[━─═—]{2,}/g, '')
    .replace(/[^\w\sáéíóúüñÁÉÍÓÚÜÑ.,;:()%$/+'"¡!¿?#&@*=-]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ── Llamada a Anthropic (imágenes opcionales: string o array) ──
async function ask(agentName, system, imageB64, apiKey) {
  const images = imageB64 ? (Array.isArray(imageB64) ? imageB64 : [imageB64]) : []
  const content = images.length
    ? [
        ...images.map(data => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })),
        { type: 'text', text: 'Analiza y responde el JSON solicitado.' },
      ]
    : 'Responde el JSON solicitado según las instrucciones del sistema.'

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system,
      messages: [{ role: 'user', content }],
    }),
  })
  if (!r.ok) {
    const e = await r.json().catch(() => ({}))
    throw new Error(e.error?.message || `Anthropic HTTP ${r.status}`)
  }
  const raw = (await r.json()).content?.[0]?.text || '{}'
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) throw new Error(`Respuesta inválida de ${agentName}`)
  return JSON.parse(match[0])
}

// ── Análisis del producto (UN agente detallado, hasta 3 fotos) ─
// Antes eran 4 llamadas en paralelo que subían la misma imagen 4 veces; una
// sola llamada con todas las fotos es más rápida, más barata y más coherente
// (título/precio/categoría salen del mismo entendimiento del producto).
export async function analyzeProduct(imagesB64, apiKey) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY no configurada en el Worker.')

  const a = await ask('Analista',
    `Eres un catalogador experto de MercadoLibre Chile. Vas a recibir una o más fotos DEL MISMO producto (distintos ángulos, empaque, etiquetas). Examínalas TODAS con lupa antes de responder.

IDENTIFICACIÓN (lo más importante):
- LEE los logos, textos y etiquetas visibles LETRA POR LETRA. La marca es la que está IMPRESA, no la más famosa del rubro: Matchbox NO es Hot Wheels, Majorette NO es Matchbox, Casio NO es Citizen, etc. Si el logo se lee, transcríbelo EXACTO.
- Si ninguna foto muestra la marca de forma legible, brand = null. NUNCA adivines una marca "parecida".
- model: código/nombre de modelo impreso (caja, base, etiqueta) si existe.
- Extrae todo dato técnico visible: escala, material, color, talla, capacidad, año, serie, número de pieza, contenido del empaque.
- condition: "new" solo si se ve sellado/empaque original intacto; si hay señales de uso, "used".

TÍTULO (campo "title"), reglas duras de ML:
- Formato: Producto + Marca + Modelo + spec clave. Máx 60 caracteres.
- Solo palabras y números (sin símbolos ni puntuación).
- Sin: envío gratis, cuotas, descuentos, FULL, stock, nuevo, usado.

PRECIO (campo "price"): precio justo de venta en CLP para el mercado chileno según marca, tipo, estado y valor de colección si aplica. Sé realista con productos usados.

CATEGORÍA (campo "searches"): 3 términos de búsqueda MUY específicos para encontrar la categoría exacta en MercadoLibre (ej: "auto colección die-cast 1:64", no "juguete").

DESCRIPCIÓN (campo "description"), TEXTO PLANO — ML RECHAZA emojis y símbolos decorativos (✓ ▪ ━ ⭐), usa solo letras, números, puntuación básica y viñetas con guion (-):
1. Gancho: marca + modelo + tipo + beneficio principal (keywords SEO en las 2 primeras líneas).
2. BENEFICIOS CLAVE: 3-4 viñetas.
3. ESPECIFICACIONES: TODAS las specs visibles en las fotos (marca, modelo, escala, material, color, dimensiones, serie, contenido).
4. Una línea de confianza y un cierre con llamado a la acción.
- 150-400 palabras. Sin HTML. No mencionar envío gratis ni garantías que el producto no incluya. No keyword stuffing.

Responde SOLO JSON:
{"product":"tipo específico","brand":"marca EXACTA impresa o null","model":"modelo o null","condition":"new|used","features":["5-6 características concretas"],"specs":{"ESCALA":"1:64","COLOR":"...","MATERIAL":"..."},"title":"título ML","price":15000,"searches":["t1","t2","t3"],"description":"descripción detallada"}`,
    imagesB64, apiKey)

  const rawDesc = a.description ||
    [a.product, a.brand, a.model, a.condition].filter(Boolean).join(' · ') || ''

  return {
    product:          a.product   || 'Producto',
    brand:            a.brand     || null,
    model:            a.model     || null,
    condition:        a.condition || 'used',
    features:         a.features  || [],
    specs:            a.specs     || {},
    description:      rawDesc.replace(/<[^>]*>/g, '').trim(),
    title:            cleanTitle(a.title || a.product || 'Producto'),
    price:            Number(a.price) || 10000,
    categorySearches: a.searches || [],
  }
}

// ── Categorías reales vía domain_discovery ────────────────────
export async function discoverCategories(searches) {
  // Las 3 búsquedas en paralelo (antes secuenciales); el orden de preferencia
  // se conserva al recorrer los resultados en el orden original.
  const results = await Promise.all((searches || []).slice(0, 3).map(async q => {
    try {
      const r = await mlFetch(`${ML}/sites/MLC/domain_discovery/search?q=${encodeURIComponent(q)}`)
      const data = await r.json()
      return { q, items: Array.isArray(data) ? data : [data] }
    } catch (e) { log('domain_discovery falló:', e.message); return { q, items: [] } }
  }))

  const found = [], seen = new Set()
  for (const { q, items } of results) {
    for (const c of items.slice(0, 2)) {
      if (c?.category_id && !seen.has(c.category_id)) {
        seen.add(c.category_id)
        found.push({ id: c.category_id, name: c.category_name || q })
      }
    }
  }
  return found.slice(0, 5)
}

// ── Atributos requeridos de la categoría + relleno por IA ─────
export async function getRequiredAttrs(categoryId) {
  const r = await mlFetch(`${ML}/categories/${categoryId}/attributes`)
  if (!r.ok) return []
  const data = await r.json()
  return (Array.isArray(data) ? data : []).filter(a => a.tags?.required && !a.tags?.fixed)
}

export async function fillAttributesWithAI(requiredAttrs, analysis, apiKey, extra = {}) {
  if (!requiredAttrs?.length || !apiKey) return {}
  const attrList = requiredAttrs.map(a => ({
    id: a.id,
    name: a.name,
    type: a.value_type,
    options: (a.values || []).slice(0, 60).map(v => v.name),
  }))
  let out = {}
  try {
    out = await ask('Atributos',
      `Eres experto en MercadoLibre Chile. Analiza el producto y asigna los atributos requeridos.

Datos del producto (fuente de verdad, salen de las fotos reales):
- Tipo: "${analysis.product || ''}"
- Marca: "${analysis.brand || ''}"
- Modelo: "${analysis.model || ''}"
- Condición: "${analysis.condition || ''}"
- Características: ${JSON.stringify(analysis.features || [])}
- Specs detectadas: ${JSON.stringify(analysis.specs || {})}
- Título ML: "${extra.title || analysis.title || ''}"
- Descripción: "${extra.description || analysis.description || ''}"
- Categoría ML: "${extra.categoryName || ''}"

Atributos a completar: ${JSON.stringify(attrList)}

Reglas:
1. Si el atributo tiene opciones (options) y alguna coincide con el dato real, usa EXACTAMENTE ese texto de la lista.
2. La MARCA es SAGRADA: usa la marca dada arriba TAL CUAL. Si no aparece en las opciones, escríbela igual como texto libre. PROHIBIDO sustituirla por otra marca "parecida" o más conocida.
3. Si no tiene opciones, usa texto libre preciso y conciso basado en los datos/specs.
4. No inventes valores: si un dato no se puede determinar, omite ese atributo del JSON (no lo rellenes por rellenar).

Responde SOLO JSON: {"ID_ATTR": "valor_elegido", "OTRO_ID": "valor"}`,
      null, apiKey) || {}
  } catch {
    out = {}
  }

  // Cinturón de seguridad: la marca detectada en las fotos manda SIEMPRE,
  // aunque la IA de atributos haya elegido otra cosa (caso Matchbox→Hot Wheels).
  if (analysis.brand?.trim()) {
    for (const a of requiredAttrs) {
      if (a.id === 'BRAND' || /marca/i.test(a.name || '')) out[a.id] = analysis.brand.trim()
    }
  }
  return out
}

// ── Precios de mercado en la categoría (referencia) ───────────
export async function getMarketPrices(categoryId, query) {
  try {
    const r = await mlFetch(`${ML}/sites/MLC/search?category=${categoryId}&q=${encodeURIComponent(query || '')}&limit=20`)
    const data = await r.json()
    const prices = (data.results || []).map(i => i.price).filter(p => p > 0).sort((a, b) => a - b)
    if (!prices.length) return null
    const mid = Math.floor(prices.length / 2)
    return {
      min: prices[0], max: prices[prices.length - 1],
      avg: Math.round(prices.reduce((s, p) => s + p, 0) / prices.length),
      median: prices.length % 2 ? prices[mid] : Math.round((prices[mid - 1] + prices[mid]) / 2),
      count: prices.length,
    }
  } catch { return null }
}

// ── Subir foto a ML (multipart) ───────────────────────────────
export async function uploadPicture(token, arrayBuffer) {
  const form = new FormData()
  form.append('file', new Blob([arrayBuffer], { type: 'image/jpeg' }), 'product.jpg')
  const r = await mlFetch(`${ML}/pictures/items/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  if (!r.ok) {
    const e = await r.json().catch(() => ({}))
    throw new Error(e.message || `subida de foto HTTP ${r.status}`)
  }
  return (await r.json()).id
}

// ── Crear la publicación ──────────────────────────────────────
// draft: { title, price, description, condition, categoryId, attrValues, pictureIds }
// El tipo "free" no existe en todas las categorías (p.ej. MLC3398 solo ofrece
// gold_*). Se consulta lo disponible y se elige lo más barato: free → Clásica.
async function pickListingType(token, categoryId) {
  try {
    // El user id viene embebido al final del token: APP_USR-<app>-<...>-<user_id>
    const userId = token.split('-').pop()
    if (!/^\d+$/.test(userId)) throw new Error('user id no derivable del token')
    const r = await mlFetch(`${ML}/users/${userId}/available_listing_types?category_id=${categoryId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const ids = ((await r.json()).available || []).map(t => t.id)
    for (const pref of ['free', 'gold_special', 'gold_pro']) {
      if (ids.includes(pref)) return pref
    }
    if (ids.length) return ids[0]
  } catch (e) { log('available_listing_types falló:', e.message) }
  return 'free'
}

export async function createListing(token, draft) {
  const attributes = Object.entries(draft.attrValues || {})
    .filter(([, v]) => v?.toString().trim())
    .map(([id, value_name]) => ({ id, value_name: value_name.toString() }))

  const listingType = await pickListingType(token, draft.categoryId)
  if (listingType !== 'free') log(`listing_type para ${draft.categoryId}: ${listingType} (free no disponible)`)

  const payload = {
    title:              (draft.title || '').slice(0, 60),
    category_id:        draft.categoryId,
    price:              draft.price,
    currency_id:        'CLP',
    available_quantity: Math.max(1, Math.round(Number(draft.qty)) || 1),
    buying_mode:        'buy_it_now',
    condition:          draft.condition || 'used',
    listing_type_id:    listingType,
    ...(draft.pictureIds?.length && { pictures: draft.pictureIds.map(id => ({ id })) }),
    ...(attributes.length && { attributes }),
    // Envío SIEMPRE a cargo del comprador.
    shipping: { mode: 'me2', free_shipping: false, local_pick_up: false },
    sale_terms: [
      { id: 'WARRANTY_TYPE', value_name: 'Garantía del vendedor' },
      { id: 'WARRANTY_TIME', value_name: '30 días' },
    ],
  }

  const r = await mlFetch(`${ML}/items`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await r.json()
  if (!r.ok) {
    const causes = (data.cause || []).map(c => c.message || c.code || JSON.stringify(c)).join(' | ')
    throw new Error(`${data.message || 'error ML'}${causes ? ': ' + causes : ''}`)
  }

  // Descripción va en endpoint separado; si falla no bloquea (el ítem ya existe).
  const plainDesc = sanitizeDescription(draft.description)
  if (plainDesc) {
    try {
      const rd = await mlFetch(`${ML}/items/${data.id}/description`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ plain_text: plainDesc }),
      })
      if (!rd.ok) log('descripción rechazada:', JSON.stringify(await rd.json().catch(() => ({}))).slice(0, 300))
    } catch (e) { log('descripción falló:', e.message) }
  }

  return data // { id, permalink, ... }
}
