const DEBUG = false
const log = (...a) => { if (DEBUG) console.log(...a) }

// Validador de título SEO según reglas oficiales de MercadoLibre
export function cleanTitle(title, maxLen = 60) {
  // F10: la clase de caracteres borraba guiones, puntos y barras, que son parte
  // del nombre real del producto ("RX-7" -> "RX 7", "1/64" -> "1 64",
  // "talla 42.5" -> "42 5"); y la lista negra tenia "full" como palabra suelta,
  // que se comia el "Full" de "Full HD". Se conservan - . / , y la lista negra
  // queda solo con frases promocionales, que es lo que ML realmente prohibe.
  return (title || '')
    .replace(/[^a-záéíóúüñA-ZÁÉÍÓÚÜÑ0-9\s\-./,]/g, ' ') // sin simbolos promocionales
    .replace(/\b(envío gratis|envio gratis|sin interés|sin interes|\d+\s*cuotas|descuento|oferta|promoción|promocion)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxLen)
}

// F6: antes era `Number(price.price) || 10000`. Con el formato chileno que suele
// devolver la IA eso publicaba a precio de regalo o inventaba uno:
//   "15.000"    -> Number() da 15      -> se publicaba a $15
//   "$15.000"   -> NaN                 -> $10.000 silencioso
//   "15000 CLP" -> NaN                 -> $10.000 silencioso
// El CLP no usa decimales, asi que nos quedamos solo con los digitos. Si el
// resultado no es creible devolvemos null: el borrador queda SIN precio y
// publishBatch (que exige >= 1) lo frena para que una persona lo revise, en vez
// de publicar una cifra inventada.
const PRECIO_MIN_CLP = 500
const PRECIO_MAX_CLP = 20_000_000
export function parsePrecioCLP(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= PRECIO_MIN_CLP && v <= PRECIO_MAX_CLP ? Math.round(v) : null
  if (typeof v !== 'string') return null
  const digitos = v.replace(/[^\d]/g, '')
  if (!digitos) return null
  const n = Number(digitos)
  return n >= PRECIO_MIN_CLP && n <= PRECIO_MAX_CLP ? n : null
}

async function compressImage(b64, maxW = 1024, quality = 0.82) {
  return new Promise(resolve => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, maxW / Math.max(img.width, img.height, 1))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', quality).split(',')[1])
    }
    img.onerror = () => resolve(b64)
    img.src = 'data:image/jpeg;base64,' + b64
  })
}

async function ask(agentName, system, imageB64, apiKey) {
  log(`[${agentName}] →`)
  const content = imageB64
    ? [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageB64 } },
        { type: 'text', text: 'Analiza y responde el JSON solicitado.' }
      ]
    : 'Responde el JSON solicitado según las instrucciones del sistema.'

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content }]
    })
  })

  if (!r.ok) {
    const e = await r.json()
    throw new Error(e.error?.message || `HTTP ${r.status}`)
  }

  const raw = (await r.json()).content?.[0]?.text || '{}'
  log(`[${agentName}] ←`, raw.slice(0, 80))

  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) throw new Error(`Respuesta inválida de ${agentName}`)
  try {
    return JSON.parse(match[0])
  } catch (e) {
    throw new Error(`JSON inválido de ${agentName}: ${e.message}`)
  }
}

export async function analyzeProduct(imageB64, apiKey) {
  if (!apiKey) throw new Error('Anthropic API key no configurada.')
  const compressed = await compressImage(imageB64)

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
      compressed, apiKey),
    ask('SEO',
      `Eres SEO expert MercadoLibre Chile. Mira la imagen y genera el título.

REGLAS DURAS DE TÍTULO MERCADOLIBRE:
- Formato: PRODUCTO + MARCA + MODELO + especificaciones clave
- Sin símbolos ni puntuación (solo palabras y números)
- Sin mencionar: envío gratis, cuotas, descuentos, FULL, stock, nuevo, usado
- Sin errores ortográficos, sin repeticiones
- Máximo 60 caracteres

Responde SOLO JSON: {"title":"título"}`,
      compressed, apiKey),
    ask('Precio',
      'Eres experto en precios Chile. Mira la imagen. Estima precio justo en CLP para MercadoLibre según marca, tipo, estado.\nResponde SOLO JSON: {"price":15000}',
      compressed, apiKey),
    ask('Categoria',
      'Eres experto en taxonomía MercadoLibre Chile. Mira la imagen. 3 términos de búsqueda ESPECÍFICOS para la categoría.\nResponde SOLO JSON: {"searches":["término1","término2","término3"]}',
      compressed, apiKey)
  ])

  const rawDesc = vision.description ||
                  [vision.product, vision.brand, vision.model, vision.condition]
                    .filter(Boolean).join(' · ') || ''
  // limpiar tags HTML si la IA los devolvió
  const description = rawDesc.replace(/<[^>]*>/g, '').trim()

  const result = {
    product:          vision.product    || 'Producto',
    brand:            vision.brand      || null,
    model:            vision.model      || null,
    condition:        vision.condition  || 'used',
    features:         vision.features   || [],
    description,
    title:            cleanTitle(seo.title || vision.product || 'Producto'),
    price:            parsePrecioCLP(price.price),
    categorySearches: category.searches || []
  }
  return result
}

export async function fillAttributesWithAI(requiredAttrs, analysis, apiKey, extra = {}) {
  if (!requiredAttrs?.length || !apiKey) return {}
  const attrList = requiredAttrs.map(a => ({
    id: a.id,
    name: a.name,
    type: a.value_type,
    options: (a.values || []).slice(0, 20).map(v => v.name)
  }))
  try {
    const result = await ask(
      'Atributos',
      `Eres experto en MercadoLibre Chile. Analiza el producto y asigna los atributos requeridos.

Datos del producto:
- Tipo: "${analysis.product||''}"
- Marca: "${analysis.brand||''}"
- Modelo: "${analysis.model||''}"
- Condición: "${analysis.condition||''}"
- Título ML: "${extra.title||analysis.title||''}"
- Descripción: "${extra.description||analysis.description||''}"
- Categoría ML: "${extra.categoryName||''}"

Atributos a completar: ${JSON.stringify(attrList)}

Reglas:
1. Si el atributo tiene opciones (options), elige EXACTAMENTE una de esa lista (mismo texto, sin variaciones).
2. Si no tiene opciones, usa texto libre preciso y conciso.
3. No inventes valores; si no puedes determinarlo con certeza, elige la opción más genérica disponible.

Responde SOLO JSON: {"ID_ATTR": "valor_elegido", "OTRO_ID": "valor"}`,
      null, apiKey
    )
    return result || {}
  } catch {
    return {}
  }
}
