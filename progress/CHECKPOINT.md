# CHECKPOINT — MLPU

**Última sesión:** 2026-07-15 | **Rama:** feature/mlpu-instagram (commit 0957051, sin push) |
**Worker Version:** 65bcbb83 | **Webhook:** ACTIVO | **Crons:** */30 (IG publisher) + 0 10 UTC (IG daily)

## Fase actual: MLPU-INSTAGRAM — Task 7 setup Meta COMPLETO; falta SOLO la prueba real
- Spec: `docs/superpowers/specs/2026-07-13-mlpu-instagram-design.md`
- Plan: `docs/superpowers/plans/2026-07-13-mlpu-instagram.md` (Tasks 1-6 hechas; Task 7 pasos 1-3 hechos)
- 22/22 tests (`npm test`).

## Qué se completó esta sesión (2026-07-15)
- Secrets `META_APP_ID` y `META_APP_SECRET` subidos al Worker mlpu-proxy (app "topwheelsapp", id 2257279951741292).
- Token generado por el usuario en Graph API Explorer. OJO: `/me/accounts` devolvió VACÍO
  aunque los permisos estaban granted; el page id y el IG user salieron de
  `debug_token` → granular_scopes (page 660949953775866 "TopWheels", IG 17841476463162844).
- Cuenta IG confirmada: **@topwheels.cl** (287 seguidores), business account de la página.
- Token corto canjeado por token largo (fb_exchange_token, ~60 días) y sembrado en
  D1 remota `ig_config.meta_token` como JSON {token, obtenido_en} (verificado con SELECT).
- `IG_USER_ID = "17841476463162844"` en wrangler.toml (reemplazó PENDIENTE_TASK_7) + redeploy
  (Version 65bcbb83). Commit 0957051 en la rama.
- Token largo verificado vivo contra Graph API (GET al IG user OK).
- `ig_config.ultima_corrida` ya registra corridas del cron (ventana 12:30 de hoy) — el cron corre bien.

## PRÓXIMO paso accionable (Task 7 paso 4 — prueba real, con el usuario en Telegram)
1. Usuario en t.me/Pulicadorlibre_bot: `/ig stock` → `/ig cola` → `/ig ahora`.
2. Verificar feed + historia en @topwheels.cl y avisos en Telegram.
3. Si IG rechaza imagen por proporción → activar contingencia padding WASM (spec).
4. Al pasar la prueba: superpowers:finishing-a-development-branch (merge a main, push), SAVE.txt.

## Seguridad pendiente
- El App Secret y el token corto quedaron pegados en el chat de la sesión: recomendar al
  usuario ROTAR el App Secret en el panel Meta al cerrar la puesta en marcha y
  actualizar `wrangler secret put META_APP_SECRET` con el nuevo.

## Decisiones clave de la fase (sin cambios)
- IG primero con stock ML; TIENDA WEB después (Worker+D1, MP Checkout Pro + Webpay Plus);
  OPTIMIZER CONGELADO. Token Meta vive en D1 con renovación automática (>45 días).
- Foto tal cual (URL pública ML), precio en caption; padding solo si IG rechaza.
- Post-venta (runScheduled) sigue APAGADO adrede: scheduled() solo rutea crons de IG.

## Bloqueos
- Prueba real requiere al usuario en Telegram (comandos /ig). Nada más de código.

## Pendientes heredados (fase bot catalogador)
- Prueba real flujo por lotes; 5 under_review (+20% al salir); alta esposa;
  BRAND de MLC4146267638; verificar descripción en próxima publicación real.
