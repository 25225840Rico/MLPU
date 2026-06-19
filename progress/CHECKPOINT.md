# CHECKPOINT — MLPU + Bot de Telegram (post-venta ML)
**Última sesión:** 2026-06-19 | **Worker Version:** b1f2236b (desplegado) | **Estado:** CERRADO. Mensajería al comprador ARREGLADA (Action Guide); scheduler con reintento+aviso; bot Python standalone creado y VERIFICADO que arranca (build_app OK con PTB 21.6: 4 handlers + 2 jobs; 13 botoneras callback<=64b; html.escape OK). Todo pusheado a main (aff52ae). Sin trabajo pendiente de código.

## Sesión 2026-06-19 — Fix mensajería + bot Python
**SÍNTOMA:** el bot dejó de enviar mensajes a compradores y el automático de "preparación".
**CAUSA RAÍZ:** ML bloquea que un vendedor NEWBIE INICIE conversación con POST directo a `/messages`
(`conversation_status: blocked / blocked_by_conversation_initiated_by_seller_limited`). No era el token
(verificado en vivo: token activo, /orders y /users/me 200). Es política de ML para reputación baja.
**FIX (desplegado, Version b1f2236b):**
- `worker/messaging.js`: `sendBuyerMessage` ahora usa la **Action Guide API**. Consulta
  `GET /messages/action_guide/packs/{pack}?tag=post_sale`; si hay opción FREE_TEXT `OTHER`
  (char_limit 350, cap_available) envía vía `POST .../action_guide/packs/{pack}/option`
  `{option_id:"OTHER", text}`. Con adjuntos→clásico. Cupo agotado→intenta clásico y si no
  devuelve `{ok:false, need_buyer_reply:true}`. Conversación abierta→clásico. Helpers nuevos:
  postClassicMessage, getActionGuideOptions, postActionGuideOption.
- `worker/scheduler.js`: **FIX A** flags de idempotencia (shipped_msg_sent, ig_cta_sent,
  review_msg_sent) solo se marcan si el envío SALIÓ → reintenta hasta lograrlo, no pierde
  mensajes. **FIX B** avisa por Telegram el motivo (entregado/cupo agotado/error) vía
  `msgStatusLine`, una sola vez por estado (sin spam). CTA Instagram acortado a ≤350 sin HTML.
- Verificado en vivo (2 agentes): 3 estados reales — conv. virgen→Action Guide OK;
  conv. abierta→clásico OK; cupo agotado sin respuesta→need_buyer_reply (límite real de ML).
**NUEVO:** `bot-python/` — bot standalone python-telegram-bot v21 (async, botonera inline, FSM
de texto, polling de ventas/mensajes, Action Guide nativo). 9 archivos: config/ml_client/
keyboards/formatters/handlers/main + .env.example/requirements/README. Compila OK. Puede usar
el Worker proxy (ML_USE_PROXY) para no gestionar token. NO desplegado aún (lo corre el usuario).
**LÍMITE ML conocido:** cap OTHER = 1 por pack hasta que el comprador responda; solo 1 mensaje
de inicio se entrega, el resto queda pendiente (reintenta solo al abrirse la conversación).

## Estado
Bot de Telegram dentro del Worker `mlpu-proxy` (webhook + Cron 10 min + KV). Bot `t.me/Pulicadorlibre_bot`, chat 1036420688.
- Pasos 1-5 + evidencia + scheduler: DESPLEGADOS y funcionando.
- Bug `ctx.waitUntil` (respuestas no llegaban): CORREGIDO (ahora `await work`).
- Botonera: ReplyKeyboard `MAIN_KB` + inline `callback_data` en `handleCallback`. Historial KV + paginado.
- Cron pasado a **cada 10 min** (`*/10 * * * *`).
- Orden de prueba TEST-1001: BORRADA. KV de órdenes vacío.

## BLOQUEADOR 403 ÓRDENES — ✅ RESUELTO 2026-06-18
El 403 PolicyAgent en `/orders` NO era el token: la app MLPublisher (3829359465845583)
tenía el permiso **"Venta y envíos de un producto" en "Sin acceso"**. 
FIX aplicado por el usuario en panel ML (developers.mercadolibre.cl → Editar app → scopes):
activó **"Venta y envíos"** y **"Comunicaciones pre y post ventas"** = Lectura y escritura;
tópicos orders_v2/messages/shipments/Post Purchase; PKCE OFF; redirect httpbin OK. Luego
re-autorizó (3er code) → `/ml/auth/init` → token nuevo en KV (ACTIVO ~6h).
VERIFICADO EN VIVO: `/orders/search` → 200 con ventas reales; `/orders/{id}` trae nombre
completo del comprador (ML ya lo entrega directo, sin fallback); `/shipments/{id}` → status
+ tracking. Ej real: orden 2000017007883684, Carolina Godoy, Hot Wheels $15.990, ship
ready_to_ship, tracking 713094097866. **El historial real (Módulo 1) ya funciona end-to-end.**

## Módulo 1 (historial real desde ML) — COMPLETADO y desplegado
- `worker/ml-history.js`: getOrderHistory, getOrdersByDateRange, searchOrderByBuyer, getOrderDetail, todayRange, monthRange (resuelve comprador con GET /users/{id}, fallback nickname, delay 100ms, log [ML-HISTORY]).
- `telegram-bot.js`: import ml-history; MAIN_KB con 📋 Historial / 💬 Mensajes / ℹ️ Ayuda; pending await_search; routing + alias /historial y /buscar; callbacks hmenu/hlast/hsearch/hday/hmonth/vord/ship; funciones nuevas withMlGuard, sendHistoryMenu, sendMlLast (paginado 10), runMlSearch, sendMlRange (hoy/mes con total $), sendMlDetail, sendShipment, fmtOrderLine, ordersListMarkup.
- `wrangler.toml`: [vars] SELLER_ID="283388639", ML_SITE_ID="MLC".
- Sintaxis `node --check` OK en los 3 módulos. **Desplegado** (Version 7cc65193, vars bindeadas, webhook responde "ok"). Cambios SOLO en working tree (sin commit).

## Módulo 2 (mensajería directa) — COMPLETADO y desplegado
- `worker/ml-messaging.js`: sendMessageToBuyer(env,orderId,text), getConversation(env,orderId),
  TEMPLATES (despachado/en_camino/recibido/calificacion) + TEMPLATE_LABELS. Resuelve
  seller/buyer/pack desde la orden. Reusa messaging.js (no lo toca). Verificado read-only: la
  lectura de conversación responde 200 (pack_id correcto; nota: ML puede marcar la conversación
  `blocked_by_conversation_initiated_by_seller_limited` según política, no es bug).
- `telegram-bot.js`: botón 💬 Mensajes → submenú (✍️ directo / 💬 conversación / 📋 plantillas);
  plantillas con vista previa + confirmación; estados await_msg_order/await_conv_order/
  await_tmpl_order/confirm_tmpl. Panel /start actualizado a los menús nuevos.

## Auto-renovación de token + re-auth desde Telegram — COMPLETADO
- index.js: `exchangeAuthCode` y `buildAuthUrl` reutilizables. El refresh ya era automático
  (getValidAccessToken + cron 10min). Ahora si el token cae, el scheduler avisa por Telegram
  con la URL lista, y el usuario reconecta pegando el code en el chat (`/reauth` o pegar TG-...).

## CTA Instagram post-venta — COMPLETADO
- scheduler.js: al ENTREGAR, mensaje persuasivo al comprador para seguir @topwheels.cl y subir
  historia (igStoryCta). Recordatorio de reseña a 48h enfocado en calificación. Textos en
  español neutro/chileno (tuteo, sin voseo).

## Git
- Repo 25225840Rico/MLPU, rama main. Worker versionado por 1ª vez (antes solo working tree).
- .gitignore: excluye .wrangler/ y worker/progress/. Sin secrets en el repo (van por wrangler secret).

## PRÓXIMO PASO (2026-06-19 — todo lo pedido HECHO/desplegado/pusheado: commit aff52ae)
- Verificación real (usuario): en la próxima venta, confirmar que el mensaje al comprador
  sale por Action Guide. El Worker ya está vivo (Version b1f2236b).
- Bot Python (opcional): `cd bot-python && cp .env.example .env`, poner tokens, `python main.py`
  (o `ML_USE_PROXY=true` apuntando al Worker proxy para no gestionar token). NO desplegado aún.
- Límite ML conocido (no bug): cap OTHER=1 → 1 mensaje de inicio por venta hasta que el
  comprador responda; el scheduler reintenta solo al abrirse la conversación.
- Futuro opcional: Módulo 3 (reclamos/Post Purchase); acortar más plantillas si se acercan a 350.
