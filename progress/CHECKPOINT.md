# CHECKPOINT — MLPU · Bot de Telegram = catalogador multi-operador

**Última sesión:** 2026-07-03 (sesión 7) | **Commit:** ce3a59e (main, pusheado) |
**Worker Version:** b67b83e1 | **Webhook:** ACTIVO | **Cron post-venta:** APAGADO

## Fase actual
El bot dejó de ser (solo) post-venta y ahora es el **catalogador/publicador**
que reemplaza al SPA "ML AutoPublisher": fotos por Telegram → IA → vista previa
editable → publica en la cuenta ML del admin. Multi-operador (él + esposa) sobre
UNA sola cuenta ML. Falta la prueba real de punta a punta.

## Completado en sesión 7 (2026-07-03)
1. Chequeo general: notificaciones orders_v2 → KV FUNCIONAN (pendiente C de
   sesión 6 cerrado por evidencia).
2. Bot fuera de servicio (d813d66): webhook borrado + cron [] + action=off.
   → Luego el webhook se REACTIVÓ para el catalogador (punto 5); cron sigue [].
3. Inventario → envío pagado por el comprador: 106 directas + 3 previas.
   40 rechazadas (envío gratis obligatorio ≥$19.990). De esas, 20 (≤$20.990)
   rebajadas a $19.980 y liberadas (8 vía variations: item.price.not_modifiable).
   Final: **129 pagado / 20 gratis** (las ≥$25.990, decisión del usuario).
4. Stock a 1 por producto: 68/69 OK; MLC1986993239 (under_review) no se pudo
   (reintentar al salir de revisión); 5 con stock 0 se dejaron en 0.
   Excel `inventario_ML_2026-07-03.xlsx` en la raíz de automl (2 hojas).
5. **Módulo catalogado** (ce3a59e): worker/publisher.js (puerto del SPA:
   analyzeProduct 4×haiku, domain_discovery, atributos IA, precios mercado,
   uploadPicture, createListing con free_shipping=false y qty=1 SIEMPRE) +
   telegram-bot.js (fotos→catalogar por defecto, sticker tras botón 📦 Despacho,
   preview con botones Publicar/Precio/Título/Categoría/Nuevo↔Usado, acceso
   multi-operador: admin + KV chats:allowed con Aprobar/Rechazar, aviso al admin
   cuando publica un operador). Verificado: node --check + webhook sintético.

## PRÓXIMO paso accionable
1. Usuario debe RECHAZAR la solicitud de acceso del chat 999999999 (prueba mía).
2. Prueba real: mandar fotos de un producto al bot → Analizar → Publicar.
3. Alta esposa: ella manda /start → admin aprueba → prueba desde su celular.
4. Si ML rechaza algo en la prueba real, ajustar payload en publisher.js.

## Decisiones clave
- Multi-OPERADOR, no multi-cuenta: todos publican en la cuenta ML del admin.
- Toda publicación del bot: envío pagado por comprador + stock 1 (no editable).
- Fotos sueltas = catalogar; despacho por sticker requiere botón 📦 Despacho.
- Cron post-venta sigue apagado; el Worker sí recibe notificaciones orders_v2.
- SPA queda como legacy en el repo (no borrar aún).
- ML: 200 puede IGNORAR free_shipping en PUT — verificar el valor, no el status.
- Items con variaciones: precio vía variations:[{id,price}], no PUT price.

## Bloqueos
- 20 publicaciones ≥$25.990 con envío gratis obligatorio (regla ML, sin palanca
  salvo bajar precio). 1 item under_review con stock 3.

## Datos de entorno
- Repo https://github.com/25225840Rico/MLPU (main) · código worker/.
- Worker https://mlpu-proxy.aronricocl.workers.dev · Version b67b83e1.
- KV: ML_TOKENS 1f6324c3659d4388bec284825c2864be (ml_session) ·
  ML_ORDERS d72bf35159b54eabadffafc521c1562b (+ chats:allowed, pending:<chat>).
- Bot t.me/Pulicadorlibre_bot · admin chat 1036420688 · seller 283388639 ·
  GUAR8622673 · MLC. Secrets: ANTHROPIC_API_KEY, ML_CLIENT_*, TELEGRAM_*.
