# CHECKPOINT — MLPU

**Última sesión:** 2026-07-16 (sesión 14) | **Rama:** main (cd8d257, SIN push) |
**Worker Version:** 0d4712e2 | **Webhook:** ACTIVO | **Crons:** */30 (IG publisher) + 0 10 UTC (IG daily) | **Tests:** 46/46

## Fase actual: MLPU-INSTAGRAM — FIX ANTI-DUPLICADOS DESPLEGADO
El 15/07 la prueba real duplicó posts en el feed y dejó filas inconsistentes.
Post-mortem completo + fix en producción. Falta la prueba real del usuario.

## Qué se completó esta sesión (2026-07-16)
1. **Diagnóstico con evidencia** (D1 + Graph API): 3 causas raíz —
   (a) sin idempotencia: historia fallaba → reintento re-subía el MISMO feed;
   (b) sin lock/claim: /ig ahora repetido o cruzado con el cron publicaba las
   mismas filas; Worker cortado dejaba filas `pendiente` con el post ya en IG;
   (c) poll de Meta de solo 15 s → "Media ID is not available".
2. **Fix (commit cd8d257, deploy 0d4712e2)**: claim atómico por fila (estado
   `publicando` + RETURNING + columna `claimed_en`), feed idempotente
   (ig_media_id se guarda apenas sale), historia best-effort (su fallo no
   repite el feed), lock entre corridas (TTL 10 min), recovery de filas
   colgadas >15 min, poll ~60 s, `/ig ahora [n]` (1-10).
3. **Datos remotos corregidos**: Viper (id 12) marcado publicado con su media_id
   real; ids 2-3 reseteados a pendiente. Estado: 134 pendientes · 10 publicados · 0 error.
4. Tests 40→46 (6 nuevos anti-duplicados); FakeDB extendido.

## PRÓXIMO paso accionable
1. `git push` (commit cd8d257 quedó local).
2. Prueba real (t.me/Pulicadorlibre_bot): `/ig ahora 1` → verificar feed+historia
   en @topwheels.cl sin duplicados; mandar `/ig ahora` dos veces seguidas debe
   responder "ya hay una publicación en curso".
3. **SEGURIDAD (heredado s13)**: rotar App Secret en panel Meta →
   `wrangler secret put META_APP_SECRET`.
4. Decidir si re-publicar la Tundra (id 4): DB dice publicado pero el usuario
   borró el post del feed.

## Decisiones clave de esta fase
- Historia es best-effort: nunca justifica repetir el feed.
- Claim por fila = garantía dura anti-duplicados; lock global = solo UX.
- Cadena de imagen blur→wsrv→original se mantiene (no era la causa).

## Bloqueos
- Ninguno de código. Prueba real y rotación de secret requieren al usuario.

## Pendientes heredados (fase bot catalogador)
- Prueba real flujo por lotes; 5 under_review (+20% al salir); alta esposa;
  BRAND de MLC4146267638; verificar descripción en próxima publicación real.
- TIENDA WEB (siguiente sub-proyecto, decisiones tomadas) · OPTIMIZER congelado.
