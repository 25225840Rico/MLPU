const KEY = import.meta.env.VITE_ANTHROPIC_KEY

async function ask(system, userText, imageB64 = null) {
  const content = imageB64
    ? [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageB64 } },
        { type: 'text', text: userText }
      ]
    : userText

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system,
      messages: [{ role: 'user', content }]
    })
  })
  if (!r.ok) { const e = await r.json(); throw new Error(e.error?.message || r.statusText) }
  const raw = (await r.json()).content?.[0]?.text || '{}'
  return JSON.parse(raw.replace(/```json|```/g, '').trim())
}

export async function analyzeProduct(imageB64) {
  const [vision, seo, price, category] = await Promise.all([
    ask(
      'Eres experto en productos. Analiza la imagen y responde SOLO JSON: {"product":"nombre producto","brand":"marca o null","condition":"new o used","features":["f1","f2"]}',
      'Analiza este producto.',
      imageB64
    ),
    ask(
      'Eres SEO expert MercadoLibre Chile. Responde SOLO JSON: {"title":"título máx 60 chars con marca modelo característica"}',
      'Crea título SEO para MercadoLibre Chile.'
    ),
    ask(
      'Eres experto en precios Chile. Responde SOLO JSON: {"price":número_entero_CLP}',
      'Estima precio competitivo en CLP para MercadoLibre.'
    ),
    ask(
      'Eres experto en categorías MercadoLibre Chile. Responde SOLO JSON: {"searches":["búsqueda1","búsqueda2","búsqueda3"]}',
      'Dame 3 términos de búsqueda de categoría para este producto.'
    )
  ])

  return {
    product: vision.product || 'Producto',
    brand: vision.brand,
    condition: vision.condition || 'used',
    features: vision.features || [],
    title: seo.title || vision.product || 'Producto',
    price: price.price || 10000,
    categorySearches: category.searches || []
  }
}
