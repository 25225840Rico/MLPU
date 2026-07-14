# CHECKPOINT — MLPU

**Última sesión:** 2026-07-14 | **Rama:** feature/mlpu-instagram (commit 8b50be0) |
**Worker Version:** 09ff897e | **Webhook:** ACTIVO | **Crons:** */30 (IG publisher) + 0 10 UTC (IG daily)

## Fase actual: MLPU-INSTAGRAM — código COMPLETO y DESPLEGADO
Falta SOLO la Task 7 (setup Meta con el usuario + prueba real).
- Spec: `docs/superpowers/specs/2026-07-13-mlpu-instagram-design.md`
- Plan: `docs/superpowers/plans/2026-07-13-mlpu-instagram.md` (Tasks 1-6 hechas)
- 22/22 tests (`npm test`, runner node --test nuevo en package.json).

## Qué hace
Cola en D1 `mlpu-db` (id 5145a70c-1c25-4904-a63a-4021b3bd19db, binding env.DB,
tablas ig_queue/ig_config). Al publicar por bot se encola; cron cada 30 min
publica feed+historia en IG dentro de ventanas óptimas (insights de IG vía
online_followers, fallback 12:30/20:00 Chile), máx 3 por ventana, 1 corrida por
ventana, 3 reintentos → error + aviso Telegram. Cron diario 10:00 UTC recalcula
ventanas y renueva token Meta (>45 días). Verifica ítem activo en ML antes de
publicar (si no → cancelado). Comandos: /ig stock (encola inventario activo ML,
~160 ítems, gotea ~6/día) · /ig cola · /ig quitar <id> · /ig ahora · /ig horas
[HH:MM…|auto]. Post-venta (runScheduled) sigue APAGADO adrede: scheduled() solo
rutea crons de IG.

## Archivos nuevos/tocados
worker/ig-logic.js, ig-api.js, ig-queue.js, schema-ig.sql,
worker/test/{smoke,ig-logic,ig-api,ig-queue}.test.js + fake-db.js,
telegram-bot.js (enqueue en runCatalogPublish + handleIgCommand),
index.js (scheduled rutea por event.cron), wrangler.toml (D1, crons, IG_USER_ID).

## PRÓXIMO paso accionable (Task 7, con el usuario — app Meta YA creada)
1. Pedir App ID + App Secret → `wrangler secret put META_APP_ID` / `META_APP_SECRET`.
2. Graph API Explorer: permisos instagram_basic, instagram_content_publish,
   instagram_manage_insights, pages_show_list, pages_read_engagement →
   GET /me/accounts → page id → GET /{page-id}?fields=instagram_business_account
   = IG_USER_ID; canjear token corto por largo (fb_exchange_token).
3. IG_USER_ID real en wrangler.toml (reemplaza PENDIENTE_TASK_7) + redeploy;
   sembrar token: REPLACE INTO ig_config ('meta_token','{"token":"…","obtenido_en":"…"}')
   vía `wrangler d1 execute mlpu-db --remote`.
4. Prueba real: /ig stock → /ig cola → /ig ahora → verificar feed+historia en la
   cuenta IG y avisos en Telegram. Si IG rechaza imagen por proporción → activar
   contingencia padding WASM (spec).
5. Al cerrar: superpowers:finishing-a-development-branch (merge a main), SAVE.txt.

## Decisiones clave de esta fase
- Prioridad del usuario: IG primero con stock ML existente; TIENDA WEB después
  (decidido: Worker+D1, MercadoPago Checkout Pro + Webpay Plus, sync bidireccional,
  catálogo en su dominio → nameservers a Cloudflare); OPTIMIZER CONGELADO
  (docs intactos en optimizer/docs/; la D1 mlpu-db nació aquí).
- Token Meta vive en D1 (Worker no escribe secrets); renovación automática.
- Foto tal cual (URL pública de ML), precio en caption; padding solo si IG rechaza.
- Import dinámico de index.js en ig-queue para no arrastrar el worker a los tests.

## Bloqueos
- Task 7 necesita al usuario: App ID/Secret y generar token (app Meta ya creada).

## Pendientes heredados (fase bot catalogador)
- Prueba real flujo por lotes; 5 under_review (+20% al salir); alta esposa;
  BRAND de MLC4146267638; verificar descripción en próxima publicación real.
