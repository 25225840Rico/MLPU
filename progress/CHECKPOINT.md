# CHECKPOINT — MLPU

**Última sesión:** 2026-07-16 (sesión 14) | **Rama:** main (1423030, pusheado) |
**Worker Version:** d4c96a82 | **Webhook:** ACTIVO | **Crons:** */15 (IG publisher) + 0 10 UTC (IG daily) | **Tests:** 56/56

## Fase actual: MLPU-INSTAGRAM — MODO RUSH EN PRODUCCIÓN
Anti-duplicados + `/ig auto` (goteo) + `/ig rush` desplegados. **RUSH ACTIVO**:
3 productos por tick de 15 min (09:00–23:00 Chile) hasta llenar el cupo REAL de
Meta (100/24 h, historias cuentan → ~48 ítems/día); al llenarse avisa la hora
de reapertura y retoma solo. 133 pendientes → cola vacía en ~3 días.

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

## Qué se completó (parte 2, mismo día)
`/ig ahora 5` moría: Cloudflare corta el background del webhook (~50 s) → lock
pegado y fila en 'publicando' (evidencia D1: id 2 salió UNA vez — el fix
anti-duplicados funcionó — y murió reclamando id 3). Solución: **goteo por cron**
(`/ig auto <min>` / `off`, 1 por tick, corridas cortas = confiables), cron */15,
lock TTL 5 min, aviso al vaciar la cola. Commit af09e1d, deploy 60bd0749.

## PRÓXIMO paso accionable
1. ✔ RUSH VERIFICADO (tick 15:30 UTC: ids 3, 13, 14 con feed+historia, 0 errores,
   0 duplicados). Solo seguimiento: alerta de cupo lleno hoy en la tarde y
   chequeo de salud de ig_queue al retomar (query en HANDOFF.txt).
2. **SEGURIDAD (heredado s13)**: rotar App Secret en panel Meta →
   `wrangler secret put META_APP_SECRET`.
3. Decidir si re-publicar la Tundra (id 4): DB dice publicado pero el usuario
   borró el post del feed.

## Decisiones clave de esta fase
- Historia es best-effort: nunca justifica repetir el feed.
- Claim por fila = garantía dura anti-duplicados; lock global = solo UX.
- Tandas largas en un invoke = frágiles; goteo 1/tick por cron = robusto.
- Intervalo 90 min por el límite de Meta (~25 posts por API/24h, feed+historia
  cuentan): ~9 ítems/día. El usuario puede ajustar con /ig auto NN (mín 15).
- Cadena de imagen blur→wsrv→original se mantiene (no era la causa).

## Bloqueos
- Ninguno de código. Prueba real y rotación de secret requieren al usuario.

## Pendientes heredados (fase bot catalogador)
- Prueba real flujo por lotes; 5 under_review (+20% al salir); alta esposa;
  BRAND de MLC4146267638; verificar descripción en próxima publicación real.
- TIENDA WEB (siguiente sub-proyecto, decisiones tomadas) · OPTIMIZER congelado.
