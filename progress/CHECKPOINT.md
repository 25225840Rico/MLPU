# CHECKPOINT — MLPU

## Sesión 19 (2026-07-26) — auditoría, refinamiento y DESPLIEGUE

**Worker desplegado:** version `9411faca-195b-4020-9e39-dc788a6726ef`.
**Tests:** 116/116 (`npm test`) + 28 comprobaciones del SPA (`npm run test:spa`) + `vite build` OK.

Cerrado en esta sesión (detalle: `progress/log/2026-07-26-ig-rendimiento.md`):
- **Rendimiento IG (L1-L5):** presupuesto de subrequests del plan Free, Graph API
  unificada, fallback de la fuente `drive` reparado, `runIgPublisher` blindado en
  `waitUntil`, filas colgadas en `publicando` con `claimed_en NULL`, race de
  historia duplicada, `/ig vaciar` respetando el foco de fuente.
- **Índices en D1 remota APLICADOS** (`ix_ig_queue_claim` parcial + `estado` +
  `publicado_en`). `claimNext` ya no escanea las 567 filas: verificado con
  `EXPLAIN QUERY PLAN` → `COVERING INDEX ix_ig_queue_claim`.
- **L6 escape HTML de Telegram:** ~25 interpolaciones de texto libre (títulos de
  ML, nombres y mensajes de compradores, errores) iban sin escapar a
  `parse_mode:'HTML'`; un solo `&` tumbaba el mensaje ENTERO con 400. `esc()` se
  mudó a `ig-logic.js` (módulo hoja) para no crear ciclos de imports. Los
  `text:` de los botones y el `editMessageCaption` quedan SIN escapar a
  propósito (son texto plano; escaparlos mostraría `&amp;` literal).
- **L7 alerta de venta perdida:** `alerted:true` se persistía ANTES de intentar
  el aviso; si Telegram fallaba, la venta quedaba marcada y la notificación se
  perdía para siempre. Ahora la marca se escribe solo tras `res.ok` (un aviso
  duplicado es preferible a una venta invisible). 5 tests nuevos.
- **L8 SPA:** ganancia real del historial (descuenta comisión y envío; sin dato
  guarda `null` y muestra "—"), fotos sin reescalar por sobre la fuente,
  `QuotaExceededError` de borradores ya no se traga, atributos faltantes del lote
  reportados con nombre.
- **L10 seguridad, desplegado en modo INERTE:** `MLPU_KEY` (gate del proxy
  `/ml/*`, comparación en tiempo constante) y `secret_token` del webhook de
  Telegram. Ambos secrets son OPCIONALES: mientras no existan, todo se comporta
  igual que antes. Falta que Aron los cree (ver más abajo).
- **CI:** el workflow de Pages ahora corre `npm test` + `npm run test:spa` antes
  de construir. Docs de seguridad en `README.md` y en `worker/wrangler.toml`.

**En manos de Aron (yo no puedo hacerlo):**
1. `npx wrangler secret put MLPU_KEY` y pegar el MISMO valor en el SPA
   (Ajustes → «Llave del Worker»). Si se pone el secret y no se pega la llave,
   el proxy responde 401 y la app deja de publicar.
2. `npx wrangler secret put TELEGRAM_WEBHOOK_SECRET` → `npx wrangler deploy` →
   **re-registrar el webhook** con `GET /tg/admin?action=set`. Sin ese paso el
   bot queda mudo.

**Cola al cierre (D1 remota):** drive 294 publicado / 118 pendiente · ml 90
publicado / 55 pendiente. Sin publicar desde 14:11 UTC por **cupo de Meta
lleno** (`rush_avisado.reabre` = 2026-07-27T13:29:21Z): siesta esperada.

---

**Última sesión previa:** 2026-07-19 (sesión 17 — rebaja IG -35% + retiro 370Z) |
**Rama:** main | **Worker:** sin cambios de código (solo datos en D1) |
**Crons:** * * * * * (IG publisher) + 0 10 UTC (IG daily) | **Rush:** ACTIVO (siesta por cupo hasta ~22:02 UTC 19-jul)

## Fase actual: OPERACIÓN IG — campaña de rebaja -35% (solo Instagram)

## Qué se completó esta sesión (2026-07-19)
- **Backup previo completo** de ig_queue (145 filas: id, ml_item_id, titulo,
  precio, estado, ig_media_id, ig_story_id, publicado_en) en
  `progress/log/2026-07-19-ig-backup-precola.json`. Es la ÚNICA fuente para
  revertir precios y para los media ids de los 370Z.
- **Rebaja -35% SOLO IG**: `UPDATE ig_queue SET precio=(CAST(precio*0.65 AS
  INTEGER)/10)*10` en 142 filas (todas menos los 3 370Z). Rango pasó de
  $4.990–$66.990 a $3.240–$43.540 (ej: 23990→15590, 19989→12990).
  MercadoLibre NO se tocó (la rebaja es solo IG, pedido del usuario).
- **370Z retirados de la operación IG** (ids 19 rojo, 35 amarillo, 72 azul,
  $23.990 c/u): filas con ig_media_id/ig_story_id en NULL + nota en
  ultimo_error → publisher/rehistorias/enqueueStock ya no los tocan jamás.
  Sus historias ya habían expirado solas (>24 h).
- **Verificado en Graph API**: los 3 posts 370Z del feed tienen 0 likes /
  0 comentarios (nada de engagement que perder al borrarlos).
- **DELETE de los 3 posts del feed FALLÓ**: error (#10) Insufficient
  permissions. `/me/permissions` confirma que el token tiene instagram_basic,
  instagram_content_publish, instagram_manage_insights, pages_* — pero NO
  `instagram_manage_contents` (ya lo advertía la sesión 15).

## PRÓXIMO paso accionable (VER progress/HANDOFF.txt — es el vigente)
1. **Borrar los 3 posts 370Z del feed VÍA API** (el usuario exige API, no
   navegador; el intento por navegador se canceló sin borrar nada).
   Espera: token del Explorer CON `instagram_manage_contents` (el 2º token
   que pegó traía 18 permisos pero no ese). Al recibirlo: verificar
   /me/permissions → GET caption (debe decir 370z) → DELETE de
   18202783930363115 / 18105270200278426 / 17883367044454857.
   Pestaña del Explorer quedó abierta en Chrome; sesión IG activa.
2. **Decidir qué hacer con los 142 posts ya publicados con precio VIEJO en el
   caption**: la Graph API NO permite editar captions. Opciones: borrar y
   republicar con la infra (rush lo re-sube con caption -35% en ~3 días de
   cupo; engagement actual es bajísimo) o editar a mano/navegador.
3. OJO `/ig stock`: los ítems NUEVOS que encole entran con precio ML SIN el
   -35% (enqueueStock copia el precio de ML). La rebaja solo vive en las
   filas ya actualizadas.
4. Heredados: rotar App Secret Meta (s13) · Tundra id 4 · under_review +20%.

## Decisiones clave
- Redondeo de la rebaja: precio*0.65 truncado a la DECENA (precios "chilenos":
  23990→15590, no 15593). Reversión exacta = restaurar desde el backup.
- Los 370Z NO reciben -35%: se retiran de IG (siguen activos en ML).
- Estado "retirado" = publicado + media ids NULL (ningún flujo lo re-publica;
  enqueueStock solo resucita canceladas → tampoco vuelven por /ig stock).

## Bloqueos
- DELETE de media vía API bloqueado hasta regenerar el token de Meta con
  `instagram_manage_contents` (requiere login del usuario en Meta).
- Captions de posts publicados NO editables por API (límite duro de Meta).
