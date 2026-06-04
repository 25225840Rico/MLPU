# Auditoría Tech Lead — 2026-06-04

Build base: 217.39KB / 68.38KB gzip · 0 errores. Tras fixes: 217.90KB / 68.55KB · 0 errores.

## Bugs CONFIRMADOS e implementados

### BUG-1 (ALTO) — Race del refresh_token entre isolates del Worker
- worker/index.js:93-110 (getValidAccessToken)
- Five Whys: la sesión se desloguea sola en uso multi-usuario → doble refresh concurrente → ML rota el refresh_token y el 2º refresh invalida la sesión → el mutex `refreshingPromise` solo coordina DENTRO de un isolate → Cloudflare crea varios isolates para celulares concurrentes → la coordinación vivía en memoria, no en KV (almacén compartido).
- Fix: dentro del lock, re-leer KV; si la copia fresca ya está vigente y no es refresh forzado por 401, reutilizarla en vez de rotar. KV actúa de árbitro best-effort.

### BUG-2 (MEDIO) — publishBatch sin validar draft
- App.jsx:885-905
- publish() valida selCat/título/precio; publishBatch accedía `draft.selCat.id` directo → TypeError "Cannot read null" o payload inválido a ML con mensaje críptico.
- Fix: validaciones equivalentes (selCat.id, título, precio≥1) al inicio del item; el error queda capturado por el catch del item con mensaje claro.

### BUG-3 (MEDIO) — Pérdida silenciosa de fotos
- App.jsx:769 (publish) y batch
- Spread condicional `...(pictures.length && { pictures })`: si todas las subidas fallan (red/timeout), publica SIN fotos sin avisar. Aviso ML de calidad nula, usuario no se entera.
- Fix: si imgs>0 y pictures==0 → abortar con error claro (publish vuelve a CONFIRM; batch marca el item como fallido).

## Descartados (con razón)
- Re-renders por poll 60s: 1 setState/60s, trivial. No es problema.
- Migración IIFE (App.jsx:330): corre antes de App(), solo reescribe key vieja, sin side effects.
- `cats` stale: `found` es local, reset() limpia. No persiste.
- editQty/editPrice: Math.max(1,...) y `||0` ya sanitizan NaN/negativos.
- XSS: sin dangerouslySetInnerHTML; permalinks van en href con rel noopener.
- analyze useCallback deps: [imgs, anthKey, beep] correctas.
- useEffect cleanup: stopCam/clearInterval/clearTimeout en unmount presentes.

## Deuda técnica (NO implementada)
- SEC: redirect_uri httpbin.org/get expone el `code` OAuth a un tercero en el redirect. Riesgo bajo (code de un solo uso + client_secret en Worker), pero ideal migrar a un redirect propio. NO tocado: el brief prohíbe cambiar ONBOARDING (riesgo auth).
- SEC: CORS `*` en Worker. Aceptable: el Worker no tiene cookies ni auth de origen; el token vive en KV server-side. Restringir a GitHub Pages sería defensa en profundidad.
- SEC: anthropic_key en localStorage — riesgo inherente a llamar Anthropic desde browser (dangerous-direct-browser-access). Es el modelo de la app; sin backend propio no hay alternativa sin reescribir arquitectura.
- PERF: imgs base64 en memoria (display+upload mismo array) — diferido PERF-02 ya anotado.
- Worker: el árbitro KV es best-effort (KV es eventualmente consistente). Solución dura requiere Durable Object. No justificado para 2 usuarios.
