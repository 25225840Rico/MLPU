# CHECKPOINT — MLPU + Bot de Telegram (post-venta ML)
**Última sesión:** 2026-06-18 | **Worker Version:** 7cc65193 (desplegado) | **Estado:** Módulo 1 (historial real ML) APLICADO + desplegado; sigue bloqueado por permiso ML (403) hasta re-autorizar

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

## PRÓXIMO PASO
1. **Módulo 2** (esperar OK del usuario): `worker/ml-messaging.js` — sendMessageToBuyer(packId,text) POST /marketplace/messages/packs/{pack}; getConversation. Botón 💬 Mensajes → submenu ✍️ directo / 💬 conversación / 📋 plantillas. NO tocar messaging.js. Hoy el botón 💬 Mensajes responde placeholder.
2. **Re-autorización ML pendiente del usuario** (OAuth scope `read`): sin eso, todo el historial real responde 403 (withMlGuard ya avisa qué hacer). Probar luego: `curl .../ml/orders/<id>` debe pasar de 403 a 404/200.
