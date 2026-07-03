/**
 * [ML-PUB] Catalogado y publicación de productos desde el bot de Telegram.
 *
 * Porta el pipeline del SPA "ML AutoPublisher" (src/agents/orchestrator.js +
 * App.jsx publish) al Worker:
 *   foto(s) → análisis IA (visión/SEO/precio/categoría en paralelo) →
 *   domain_discovery → atributos requeridos por IA → subir fotos → crear ítem.
 *
 * Reglas fijas del negocio (decisión 2026-07-03):
 *   - shipping SIEMPRE { mode: 'me2', free_shipping: false } (paga el comprador).
 *   - available_quantity SIEMPRE 1 (una unidad por producto).
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

// ── Llamada a Anthropic (imagen opcional) ─────────────────────
async function ask(agentName, system, imageB64, apiKey) {
  const content = imageB64
    ? [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageB64 } },
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
      max_tokens: 1024,
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

// ── Análisis del producto (4 agentes en paralelo) ─────────────
export async function analyzeProduct(imageB64, apiKey) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY no configurada en el Worker.')

  const [vision, seo, price, category] = await Promise.all([
    ask('Vision',
      `Eres experto en productos y copywriting para MercadoLibre Chile. Mira la imagen. Identifica: tipo exacto, marca, modelo, estado físico, 3-4 características.

Para el campo "description" genera una descripción en TEXTO PLANO (SIN HTML) siguiendo esta estructura:

ESTRUCTURA OBLIGATORIA:
1. Primera línea: gancho con marca+modelo+tipo + beneficio principal (con keywords SEO)
2. BENEFICIOS CLAVE\\n✓ [beneficio 1]\\n✓ [beneficio 2]\\n✓ [beneficio 3]
3. ESPECIFICACIONES\\n▪ [spec 1]\\n▪ [spec 2]
4. Una línea de confianza/garantía
5. Cierre con llamado a la acción

REGLAS:
- Solo texto plano + emojis moderados: ✅ ⚡ 📦 🛡️ ⭐
- Separadores: ━━━━━━━━
- Viñetas: ✓ ▪
- 150-400 palabras
- Keywords principales en las primeras 2 líneas
- NO tags HTML (< >)
- NO mencionar envío gratis ni garantía a menos que el producto lo incluya
- NO keyword stuffing

Responde SOLO JSON:
{"product":"nombre específico","brand":"marca o null","model":"modelo o null","condition":"new o used","features":["f1","f2","f3"],"description":"descripción persuasiva en texto plano según la estructura"}`,
      imageB64, apiKey),
    ask('SEO',
      `Eres SEO expert MercadoLibre Chile. Mira la imagen y genera el título.

REGLAS DURAS DE TÍTULO MERCADOLIBRE:
- Formato: PRODUCTO + MARCA + MODELO + especificaciones clave
- Sin símbolos ni puntuación (solo palabras y números)
- Sin mencionar: envío gratis, cuotas, descuentos, FULL, stock, nuevo, usado
- Sin errores ortográficos, sin repeticiones
- Máximo 60 caracteres

Responde SOLO JSON: {"title":"título"}`,
      imageB64, apiKey),
    ask('Precio',
      'Eres experto en precios Chile. Mira la imagen. Estima precio justo en CLP para MercadoLibre según marca, tipo, estado.\nResponde SOLO JSON: {"price":15000}',
      imageB64, apiKey),
    ask('Categoria',
      'Eres experto en taxonomía MercadoLibre Chile. Mira la imagen. 3 términos de búsqueda ESPECÍFICOS para la categoría.\nResponde SOLO JSON: {"searches":["término1","término2","término3"]}',
      imageB64, apiKey),
  ])

  const rawDesc = vision.description ||
    [vision.product, vision.brand, vision.model, vision.condition].filter(Boolean).join(' · ') || ''

  return {
    product:          vision.product   || 'Producto',
    brand:            vision.brand     || null,
    model:            vision.model     || null,
    condition:        vision.condition || 'used',
    features:         vision.features  || [],
    description:      rawDesc.replace(/<[^>]*>/g, '').trim(),
    title:            cleanTitle(seo.title || vision.product || 'Producto'),
    price:            Number(price.price) || 10000,
    categorySearches: category.searches || [],
  }
}

// ── Categorías reales vía domain_discovery ────────────────────
export async function discoverCategories(searches) {
  const found = [], seen = new Set()
  for (const q of (searches || []).slice(0, 3)) {
    try {
      const r = await mlFetch(`${ML}/sites/MLC/domain_discovery/search?q=${encodeURIComponent(q)}`)
      const data = await r.json()
      const items = Array.isArray(data) ? data : [data]
      for (const c of items.slice(0, 2)) {
        if (c?.category_id && !seen.has(c.category_id)) {
          seen.add(c.category_id)
          found.push({ id: c.category_id, name: c.category_name || q })
        }
      }
    } catch (e) { log('domain_discovery falló:', e.message) }
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
    options: (a.values || []).slice(0, 20).map(v => v.name),
  }))
  try {
    return await ask('Atributos',
      `Eres experto en MercadoLibre Chile. Analiza el producto y asigna los atributos requeridos.

Datos del producto:
- Tipo: "${analysis.product || ''}"
- Marca: "${analysis.brand || ''}"
- Modelo: "${analysis.model || ''}"
- Condición: "${analysis.condition || ''}"
- Título ML: "${extra.title || analysis.title || ''}"
- Descripción: "${extra.description || analysis.description || ''}"
- Categoría ML: "${extra.categoryName || ''}"

Atributos a completar: ${JSON.stringify(attrList)}

Reglas:
1. Si el atributo tiene opciones (options), elige EXACTAMENTE una de esa lista (mismo texto, sin variaciones).
2. Si no tiene opciones, usa texto libre preciso y conciso.
3. No inventes valores; si no puedes determinarlo con certeza, elige la opción más genérica disponible.

Responde SOLO JSON: {"ID_ATTR": "valor_elegido", "OTRO_ID": "valor"}`,
      null, apiKey) || {}
  } catch {
    return {}
  }
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
export async function createListing(token, draft) {
  const attributes = Object.entries(draft.attrValues || {})
    .filter(([, v]) => v?.toString().trim())
    .map(([id, value_name]) => ({ id, value_name: value_name.toString() }))

  const payload = {
    title:              (draft.title || '').slice(0, 60),
    category_id:        draft.categoryId,
    price:              draft.price,
    currency_id:        'CLP',
    available_quantity: 1,
    buying_mode:        'buy_it_now',
    condition:          draft.condition || 'used',
    listing_type_id:    'free',
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
  if (draft.description?.trim()) {
    try {
      await mlFetch(`${ML}/items/${data.id}/description`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ plain_text: draft.description.trim() }),
      })
    } catch (e) { log('descripción falló:', e.message) }
  }

  return data // { id, permalink, ... }
}
