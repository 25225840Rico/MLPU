const DEBUG = false
const log = (...a) => { if (DEBUG) console.log(...a) }

export async function compressImage(b64, maxW = 1024, quality = 0.82) {
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
      max_tokens: 500,
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
      'Eres experto en productos. Mira la imagen. Identifica: tipo exacto, marca, modelo, estado físico, 3-4 características.\nResponde SOLO JSON:\n{"product":"nombre específico","brand":"marca o null","model":"modelo o null","condition":"new o used","features":["f1","f2","f3"],"description":"2 oraciones: materiales, estado, uso"}',
      compressed, apiKey),
    ask('SEO',
      'Eres SEO expert MercadoLibre Chile. Mira la imagen. Título: marca + tipo + característica. Máx 60 chars. Sin "Vendo".\nResponde SOLO JSON: {"title":"título"}',
      compressed, apiKey),
    ask('Precio',
      'Eres experto en precios Chile. Mira la imagen. Estima precio justo en CLP para MercadoLibre según marca, tipo, estado.\nResponde SOLO JSON: {"price":15000}',
      compressed, apiKey),
    ask('Categoria',
      'Eres experto en taxonomía MercadoLibre Chile. Mira la imagen. 3 términos de búsqueda ESPECÍFICOS para la categoría.\nResponde SOLO JSON: {"searches":["término1","término2","término3"]}',
      compressed, apiKey)
  ])

  const result = {
    product:          vision.product    || 'Producto',
    brand:            vision.brand      || null,
    model:            vision.model      || null,
    condition:        vision.condition  || 'used',
    features:         vision.features   || [],
    description:      vision.description || '',
    title:            seo.title         || vision.product || 'Producto',
    price:            Number(price.price) || 10000,
    categorySearches: category.searches || []
  }
  return result
}

export async function fillAttributesWithAI(requiredAttrs, analysis, apiKey) {
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
      `Eres experto en MercadoLibre Chile. Producto analizado: marca="${analysis.brand||''}", modelo="${analysis.model||''}", tipo="${analysis.product||''}", condición="${analysis.condition||''}".
Asigna valores para estos atributos requeridos. Si tiene opciones (options), elige UNA de esa lista exactamente. Sin opciones, usa texto libre adecuado.
Atributos: ${JSON.stringify(attrList)}
Responde SOLO JSON: {"ID_ATTR": "valor_elegido", "OTRO_ID": "valor"}`,
      null, apiKey
    )
    return result || {}
  } catch {
    return {}
  }
}
