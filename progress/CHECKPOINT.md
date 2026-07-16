# CHECKPOINT — MLPU

**Última sesión:** 2026-07-15 (sesión 13, cierre) | **Rama:** main (478c1f5, pusheado; feature/mlpu-instagram mergeada y borrada) |
**Worker Version:** 483712dc | **Webhook:** ACTIVO | **Crons:** */30 (IG publisher) + 0 10 UTC (IG daily) | **Tests:** 35/35

## Fase actual: MLPU-INSTAGRAM — COMPLETO Y EN PRODUCCIÓN
Solo falta la prueba real por Telegram (con el usuario). Cuenta IG: **@topwheels.cl** (IG_USER_ID 17841476463162844).

## Qué se completó esta sesión (2026-07-15)
1. **Task 7 setup Meta**: secrets META_APP_ID/SECRET; token largo (60 días) sembrado en
   D1 `ig_config.meta_token` (renovación automática >45 días); IG_USER_ID real en wrangler.toml.
   Hallazgo: /me/accounts vacío → page/IG salen de debug_token→granular_scopes.
2. **Fase pausa/padding/promo** (spec `docs/superpowers/specs/2026-07-15-ig-pausa-padding-design.md`,
   plan `docs/superpowers/plans/2026-07-15-ig-pausa-padding-promo.md`, 7 tasks subagent-driven,
   review final "Ready to merge" tras fix f820796):
   - `/ig parar` / `/ig seguir` (flag pausado re-leído a mitad de tanda; cron diario nunca se pausa).
   - `/ig vaciar` + UPSERT en enqueueStock (re-encola cancelados refrescando titulo/precio/permalink).
   - Imágenes SIN recorte: padding blanco wsrv.nl (q=95) + máxima calidad (ML `-O`→`-F.jpg`);
     fallback 1 reintento con URL original SOLO ante errores de imagen (no rate-limit/token).
   - Caption feed: 🔧 título / 💰 precio / 🟢 DISPONIBLE / 👉 Comprar: link / hashtags.
   - `/ig promo`: vista previa por Telegram + botones [📤 Subir a historia][❌ Cancelar];
     PNG estático TOPWHEELS.CL (sin hashtags) en `/ig/promo.png` (static assets, `worker/public/ig/`);
     regenerar con `scripts/gen-promo-story.py`; publica raw (sin wsrv, ignora pausado).

## PRÓXIMO paso accionable (prueba real, usuario en t.me/Pulicadorlibre_bot)
1. `/ig promo` → probar ambos botones → verificar historia en @topwheels.cl.
2. `/ig stock` → `/ig cola` → `/ig ahora` → verificar feed (foto completa, caption nuevo) + historia.
3. `/ig parar` → `/ig ahora` (debe avisar pausado) → `/ig seguir`.
4. **SEGURIDAD**: rotar App Secret en panel Meta (quedó pegado en el chat) →
   `wrangler secret put META_APP_SECRET` con el nuevo.

## Decisiones clave de esta fase
- wsrv.nl como proxy de padding (WASM photon descartado: CPU/código; CF Images: pago).
- Token Meta vive en D1; secrets de app en wrangler.
- Promo estática commiteada (texto fijo); cambios = regenerar y redeploy.

## Bloqueos
- Ninguno de código. Prueba real y rotación de secret requieren al usuario.

## Pendientes heredados (fase bot catalogador)
- Prueba real flujo por lotes; 5 under_review (+20% al salir); alta esposa;
  BRAND de MLC4146267638; verificar descripción en próxima publicación real.
- TIENDA WEB (siguiente sub-proyecto, decisiones tomadas) · OPTIMIZER congelado.
