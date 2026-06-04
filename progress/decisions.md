2026-06-03 - Tema blanco con azul #2563eb como primario - El amarillo ML (#ffe234) era demasiado agresivo como color de acción; se usa solo para branding. El azul mejora legibilidad y contraste en mobile.
2026-06-03 - Borradores comprimidos a 480px (no full res) - localStorage tiene límite de 5MB; guardar imgs full podría saturarlo con pocos borradores.
2026-06-03 - publishBatch() secuencial, no paralelo - ML puede rechazar publicaciones simultáneas del mismo usuario; secuencial es más seguro y permite mostrar progreso real.
2026-06-03 - exchangeCode() via proxy existente - No requiere cambios al Cloudflare Worker; POST /ml/oauth/token ya está cubierto por la ruta /ml/* del proxy.
2026-06-04 - BUG-01 revertido (saltar ONBOARDING) - Saltarse ONBOARDING cuando hay token en LS causaba token expirado → comisiones $0 → margen 100%. ONBOARDING es checkpoint de validación; no saltar.
2026-06-04 - cropSquareForML() como safety net en publish, no en UI - El recorte visible lo hace CropScreen; cropSquareForML es fallback silencioso para subidas sin recorte previo.
2026-06-04 - CropScreen insertado entre captura y PREVIEW para todos los orígenes - Cámara, FullscreenCamera y archivos importados pasan por CROP; usuario puede omitir si no quiere recortar.
2026-06-04 - CropScreen forzado a solo ratio 1:1 - ML siempre muestra fotos en cuadrado; ofrecer otros ratios confundía al usuario porque el recorte automático posterior (cropSquareForML) quedaba mal encuadrado sin que el usuario lo controlara.
2026-06-04 - fillAttributesWithAI recibe extra={title,description,categoryName} - El prompt con solo brand/model/condition producía valores genéricos o incorrectos; más contexto reduce errores en atributos requeridos y baja las preguntas de compradores.
2026-06-04 - Stock default 3 (antes 1) + hint visual - ML penaliza publicaciones con stock 1; el default bajo pasaba desapercibido y el vendedor perdía ventas al agotar stock rápido.
2026-06-04 - Token ML vive en Cloudflare Worker KV, no en localStorage de cada celular - Dos usuarios en la misma cuenta ML se pisaban al renovar token en paralelo; KV centralizado elimina el conflicto y ningún celular ve el token en texto plano.
2026-06-04 - Client Secret se mueve al Worker como secret de Wrangler, no en frontend - Exponerlo en localStorage o código JS era un riesgo de seguridad; el Worker lo guarda cifrado en Cloudflare.
2026-06-04 - Migración IIFE al cargar app para URL Worker vieja→nueva - Evita que usuarios con localStorage viejo sigan apuntando a broad-pond sin tener que hacer nada manual.
2026-06-04 - Descripción ML en 2 pasos (POST /items sin description, luego POST /items/{id}/description) - API ML rechaza description dentro del POST /items desde 2021; separarlo evita errores silenciosos de publicación.
2026-06-04 - cleanTitle() aplica reglas duras ML antes de publicar - Títulos con símbolos o palabras prohibidas (envío gratis, nuevo, usado) causan moderación automática en ML; mejor limpiarlos en cliente.
2026-06-04 - max_tokens orchestrator 500→1024 - Descripción persuasiva de 150-400 palabras se truncaba con límite anterior; costo marginal justificado por calidad del output.
2026-06-04 - Modo automático engancha en onCrop (no en capture) - Mantiene CropScreen visible para que el usuario confirme el encuadre; saltar CropScreen completamente sería demasiado agresivo para el flujo.
