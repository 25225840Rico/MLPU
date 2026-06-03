// Resize image to max 1024px before sending to API (saves bandwidth and avoids timeouts)
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
  console.log(`[${agentName}] → enviando request a Claude...`)
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
      max_tokens: 400,
      system,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageB64 } },
          { type: 'text', text: 'Analiza la imagen y responde el JSON solicitado.' }
        ]
      }]
    })
  })

  if (!r.ok) {
    const e = await r.json()
    console.error(`[${agentName}] ✗ HTTP ${r.status}:`, e)
    throw new Error(e.error?.message || `HTTP ${r.status}`)
  }

  const raw = (await r.json()).content?.[0]?.text || '{}'
  console.log(`[${agentName}] ← respuesta cruda:`, raw)

  try {
    const match = raw.match(/\{[\s\S]*\}/)
    const parsed = JSON.parse(match ? match[0] : '{}')
    console.log(`[${agentName}] ✓ parseado:`, parsed)
    return parsed
  } catch (e) {
    console.error(`[${agentName}] ✗ JSON parse falló. Raw:`, raw)
    throw new Error(`JSON inválido del agente ${agentName}: ${e.message}`)
  }
}

export async function analyzeProduct(imageB64, apiKey) {
  if (!apiKey) throw new Error('Anthropic API key no configurada. Vuelve al inicio y agrégala.')

  console.log('[orchestrator] Comprimiendo imagen...')
  const compressed = await compressImage(imageB64)
  console.log(`[orchestrator] Imagen lista. Lanzando 4 agentes en paralelo...`)

  const [vision, seo, price, category] = await Promise.all([

    ask('Vision', `Eres experto en productos. Mira la imagen con detalle.
Identifica: tipo exacto de producto, marca visible (si no hay marca escribe null), modelo si aparece, estado físico del producto, 3-4 características clave.
Responde SOLO JSON sin texto ni markdown:
{"product":"nombre específico","brand":"marca exacta o null","model":"modelo o null","condition":"new o used","features":["feat1","feat2","feat3"],"description":"2 oraciones describiendo el producto, materiales, estado y uso"}`, compressed, apiKey),

    ask('SEO', `Eres especialista en SEO de MercadoLibre Chile.
Mira la imagen e identifica el producto. Crea un título que incluya: marca + tipo de producto + característica principal.
Máximo 60 caracteres. Sin símbolos innecesarios. Sin "Vendo" ni "Precio".
Responde SOLO JSON sin texto ni markdown:
{"title":"título optimizado aquí"}`, compressed, apiKey),

    ask('Precio', `Eres experto en precios del mercado chileno.
Mira la imagen del producto. Estima el precio justo en MercadoLibre Chile (CLP) para este producto según: marca, tipo, estado visible, demanda en Chile.
Responde SOLO JSON sin texto ni markdown:
{"price":15000}
(reemplaza el número por el precio real estimado, solo el número entero sin puntos ni comas)`, compressed, apiKey),

    ask('Categoria', `Eres experto en la taxonomía de MercadoLibre Chile.
Mira la imagen. Identifica la categoría exacta del producto.
Dame 3 términos de búsqueda ESPECÍFICOS (no genéricos) para encontrar esta categoría en MercadoLibre Chile.
Por ejemplo si es un iPhone: "iPhone 14 smartphone", no solo "teléfono".
Responde SOLO JSON sin texto ni markdown:
{"searches":["término específico 1","término específico 2","término específico 3"]}`, compressed, apiKey)

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

  console.log('[orchestrator] ✓ Análisis completo:', result)
  return result
}
