# CHECKPOINT — MLPU

**Última sesión:** 2026-07-17 (sesión 15, 3 partes) | **Rama:** main (566c4e8, pusheado) |
**Worker Version:** efb1f801 (deploy 2026-07-17) | **Webhook:** ACTIVO |
**Crons:** * * * * * (IG publisher) + 0 10 UTC (IG daily) | **Tests:** 62/62 | **Build SPA:** OK

## Fase actual: MANTENIMIENTO + MEJORAS IG (todo en producción)
Rush IG sigue corriendo solo. Sesión 15 tuvo dos partes: (1) limpieza/
optimización del monorepo; (2) fix del banner DISPONIBLE intermitente en
historias + rediseño visual del banner y de la historia promocional.

## Qué se completó esta sesión (2026-07-17)
**Parte 1 — limpieza (commit edfa653):** código muerto fuera de
telegram-bot.js (sendHistory, hist:, pendingListText); mlGet de ml-history
unificado sobre mlFetch; sendIgPanel con 1 query GROUP BY; mensaje del candado
a 3 min; .gitignore para __pycache__/progress de bot-python y xlsx/csv de
datos; compressImage sin export en el SPA. Sin cambios de comportamiento.

**Parte 2 — banner + promo (commit e6ec795, deploy 5837d7b4):**
- CAUSA del "DISPONIBLE sale en unas historias y en otras no": el banner solo
  lo estampa el compositor blur propio (/ig/img); si fallaba, la cadena caía a
  wsrv/URL original → historia SIN banner.
- FIX: nuevo `composePad` en ig-image.js (fondo blanco plano vía
  `new PhotonImage(rawPixels)`, ~20% más barato que el blur) + modo `m=pad`
  en /ig/img + `padOwnImageUrl` en ig-logic. Cadena de historias ahora:
  blur → pad propio (CONSERVA banner) → wsrv → original. Feed sin cambios.
- Banner rediseñado (scripts/gen-disponible-banner.py): gradiente verde,
  borde blanco, sombra suave, punto "en vivo", tracking — legible sobre
  cualquier fondo (verificado sobre oscuro y claro).
- Promo rediseñada (scripts/gen-promo-story.py): fondo oscuro degradado,
  bandera a cuadros arriba, pill DISPONIBLE consistente con el banner,
  pills de couriers con gradiente, CTA "📩 PÍDELO POR DM" (emoji con fuente
  de emojis; antes salía tofu), dirección en 2 líneas (antes se desbordaba).
- Tests 57→59 (cadena de historia con pad + padOwnImageUrl).
- VERIFICADO EN PRODUCCIÓN: /ig/img?...&s=1&m=pad compone la foto real del
  ítem de prueba (Bronco) con el banner nuevo (HTTP 200, ~1.3 s);
  /ig/promo.png sirve el rediseño (106 KB).

## Parte 3 (mismo día): blur obligatorio + rehistorias + borrar historias
- **Blur SÍ O SÍ** (bd57138): cadena = blur completo → blur lite (downscale +
  gaussian + upscale directo, banner intacto); wsrv/URL original ELIMINADOS.
  Si ambos fallan, la fila reintenta (nunca publica sin blur).
- **/ig rehistorias** (🔁): re-encola lo publicado para SOLO historia (el
  feed no se repite: ig_media_id se conserva y la idempotencia lo salta),
  prioridad = likes+comentarios del feed (batch de 50); claimNext ordena por
  prioridad DESC. Columna ig_queue.prioridad migrada en remote (144 filas).
- **/ig borrarhistorias** (🧹): DELETE Graph v25 de las historias vivas
  (<24 h) en tandas de 35; si falta el permiso instagram_manage_contents el
  bot lo avisa (habría que regenerar el token de Meta).
- Commit 566c4e8, deploy efb1f801, 62/62 tests.

## PRÓXIMO paso accionable
1. **Prueba real Telegram**: 🧹 Borrar historias → 🔁 Rehistorias → 🔥 Rush YA.
   Si el borrado falla por permisos: regenerar token largo de Meta con
   `instagram_manage_contents` y re-sembrar ig_config.meta_token.
2. Probar /ig promo (diseño nuevo) y ver el banner en las historias del rush.
3. **SEGURIDAD (heredado s13)**: rotar App Secret en panel Meta →
   `wrangler secret put META_APP_SECRET`.
4. Decidir si re-publicar la Tundra (id 4).
5. Salud del rush: `SELECT estado,COUNT(*) FROM ig_queue GROUP BY estado`.

## Decisiones clave
- El pad propio entra SOLO en historias (el feed no lleva banner; wsrv basta).
- Lienzo blanco por constructor de PhotonImage (sin assets extra ni photon
  padding_*): barato y sin dependencias nuevas.
- runScheduled sigue apagado adrede; App.jsx no se refactoriza a fondo;
  tracking.js sigue con sonnet (decisión del usuario si abaratar a haiku).
- Checkered solo arriba en la promo: abajo la UI de IG tapa la zona.

## Bloqueos / pendientes
- Heredados: rotación App Secret (usuario), Tundra id 4, envío gratis
  obligatorio ≥ $19.990 (49 ítems Premium con envío gratis forzado).
