# CHECKPOINT — MLPU · Bot de Telegram = catalogador multi-operador

**Última sesión:** 2026-07-10 (sesión 11) | **Commit:** ca12962 (main, pusheado) |
**Worker Version:** fb6a8228 | **Webhook:** ACTIVO | **Cron post-venta:** APAGADO

## Fase actual (NUEVO FRENTE: MLPU-Optimizer)
Diseño CERRADO y plan LISTO — pendiente solo ARRANCAR la implementación.
- Spec v1.0 aprobado: `optimizer/docs/2026-07-10-agente-optimizacion-ml-design.md`
  (incluye apéndices DoD, riesgos, criterios salida DRY_RUN).
- Plan F0+F1 (11 tareas TDD): `optimizer/docs/2026-07-10-optimizer-f0-f1.md`.
- Todo el optimizador vive en subcarpeta única `optimizer/` (pedido del usuario).
- Commits: 4c2754f (spec), 69e23fa (plan), f93a873 (reestructura). Sin push aún.
**Próximo paso al retomar:** usuario elige ejecución (subagent-driven
recomendada / inline) → ejecutar Task 1 del plan (crear D1 `mlpu-db` +
esquema + binding). Resumen de decisiones también en HANDOFF.txt (1-7).

## Fase previa (bot catalogador)
Bot catalogador OPERATIVO con flujo por lotes (fotos mezcladas → un Analizar →
IA agrupa por producto → una preview por producto). NUEVA REGLA vigente desde
esta sesión: **todas las publicaciones salen en la MÁXIMA categoría disponible
(gold_pro Premium → gold_special Clásica → free) y SIEMPRE con envío pagado
por el comprador** (regla fija, sin toggle).
Sigue pendiente la prueba real del flujo por lotes en Telegram.

## Completado en sesión 11 (2026-07-10)
0. **INVENTARIO COMPLETO migrado (160 ítems, vía proxy /ml/ del Worker)**:
   160/160 en Premium (gold_pro); envío por comprador en 109; en 51 ítems
   (precio ≥ $19.990) ML FUERZA envío gratis y no se puede desactivar por
   API (verificado re-leyendo cada ítem). Única falla: MLC1986993239
   (under_review, no editable; ya era Premium). Excel nuevo:
   `inventario_ML_2026-07-10.xlsx` (160 filas + Resumen). Detalle por ítem:
   `progress/log/inventory-report-2026-07-10.json`.
1. **worker/publisher.js**: `pickListingType` invertido — antes prefería lo
   más barato (free primero), ahora gold_pro → gold_special → free; fallback
   ante error de API: gold_pro. `createListing` fija
   `shipping: { me2, free_shipping: false, local_pick_up: false }` (se
   eliminó `draft.freeShipping`). `estimateProfit` ya no estima costo de
   envío gratis (nunca aplica); net = precio − comisión.
2. **worker/telegram-bot.js**: eliminado el callback `cat:ship:` y el botón
   "Cambiar a envío gratis" de la preview; textos fijos "envío a cargo del
   comprador"; preview muestra el tipo de publicación real (Premium/Clásica/
   gratuita); ayuda actualizada.
3. **src/App.jsx (SPA)**: `listingType` por defecto `gold_pro` en los 3
   puntos (estado inicial, borrador nuevo, carga de borrador); el selector
   manual Gratuita/Clásica/Premium sigue disponible. Build vite OK.
4. Deploy Worker fb6a8228 verificado; commit ca12962 pusheado a main;
   SAVE.txt actualizado.

## PRÓXIMO paso accionable
1. **Prueba real del flujo por lotes**: fotos mezcladas de 2-3 autos, un
   Analizar, verificar separación + previews + publicaciones independientes,
   y ahora también que salgan como **Premium** con envío por comprador.
2. Pendientes previos: 5 under_review (subir +20% y pasar a la categoría
   correspondiente al salir de revisión — la regla nueva dice Premium);
   alta esposa; BRAND de MLC4146267638; verificar descripción en la próxima
   publicación real.

## Decisiones clave (vigentes)
- **2026-07-10: listing_type = el MÁS caro disponible (Premium) y envío
  SIEMPRE pagado por el comprador, sin toggle** (reemplaza "más barato").
- Lotes: álbum = producto; fotos sueltas se agrupan hasta cierre explícito.
- Fotos en claves KV individuales (nunca read-modify-write compartido).
- Multi-OPERADOR, no multi-cuenta; stock default 1 editable; descripciones
  plain text sanitizadas.
- Cron post-venta apagado; Worker sí recibe orders_v2.

## Bloqueos
- PR #1 (cotizador-costos) sigue esperando URL+anon-key Supabase.
- CERRADO SIN SALIDA (2026-07-10): envío gratis obligatorio ≥ $19.990 en
  MLC — probado en vivo: modo custom y "a acordar" ignorados (200 y
  revierte), Clásica también forzada, downgrade a 'free' bloqueado (400),
  y costo vendedor $6.300 igual en Clásica y Premium. Los 51 ítems quedan
  Premium + envío gratis; única salida = precio < $19.990 (a $19.989 se
  libera, verificado). Los 2 ítems que estaban justo en $19.990 se bajaron
  a $19.989 → Premium + envío por comprador (111/160). Quedan 49 forzados
  (precio > $19.990). Detalle: log/2026-07-10.md partes 3-4.
- Riesgo menor: KV list eventualmente consistente (conteo de fotos puede
  quedar corto si Analizar entra en el mismo segundo que la última foto).

## Datos de entorno
- Repo https://github.com/25225840Rico/MLPU (main) · código worker/.
- Worker https://mlpu-proxy.aronricocl.workers.dev · Version fb6a8228.
- KV: ML_TOKENS 1f6324c3659d4388bec284825c2864be · ML_ORDERS
  d72bf35159b54eabadffafc521c1562b (chats:allowed, pending:<chat>,
  lotp:/lotd:/lotm:/lotcur: por lote).
- Bot t.me/Pulicadorlibre_bot · admin chat 1036420688 · seller 283388639 ·
  GUAR8622673 · MLC. Secrets: ANTHROPIC_API_KEY, ML_CLIENT_*, TELEGRAM_*.
