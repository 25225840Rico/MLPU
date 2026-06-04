# CHECKPOINT — ML AutoPublisher
**Última sesión:** 2026-06-04 | **HEAD:** `f4793cc` | **Estado:** Producción activa

## Fase actual
Sistema completo y estable. Multi-usuario, reglas ML oficiales implementadas.

## Completado hoy (resumen de commits)
- `7ee44e5` Calidad ML: CropScreen 1:1, fillAttributes+contexto, stock default 3
- `30dc51c` Token ML centralizado en Worker KV (multi-usuario)
- `2bc1e7a` Fix migración URL Worker + meta mobile-web-app-capable
- `0fdb4e5` Fix domain_discovery → llama ML directo (sin auth)
- `b97b31e` Fix race condition KV + clamp CropScreen imágenes pequeñas
- `6d49733` Fix categorías sin ID + ciclo ONBOARDING bloqueado
- `e6dc027` Fix /sites/ PUBLIC_PATHS → listing_prices necesita auth
- `e9219c3` Easter egg Paola Bilotta + UX Consensus Engine 12 agentes
- `80906e7` Auditoría ingeniería senior: BUG-1 race multi-isolate, BUG-2 batch, BUG-3 fotos
- `e4e87aa` Botón copiar link para Paola en ONBOARDING
- `4fdb868` Modo automático batch + fix descripción vacía
- `f4793cc` Reglas oficiales ML: descripción 2 pasos, SEO título, desc persuasiva, score calidad, hints fotos

## Próximo paso
1. Recargar app en celular → ONBOARDING → Paso 1+2 → sembrar KV
2. Probar flujo completo: modo automático → borradores → publicar
3. Verificar score de calidad en pantalla SUCCESS tras publicar real

## Diferidos
- PERF-02: separar imgsDisplay/imgsUpload
- UX-02: modal confirmación Config con fotos activas
- redirect_uri httpbin → URL propia (seguridad menor)

## Stack
React+Vite · GitHub Pages `/MLPU/` · Worker `mlpu-proxy.aronricocl.workers.dev`
KV `1f6324c3659d4388bec284825c2864be` · Claude Haiku x4 · OAuth ML Chile
