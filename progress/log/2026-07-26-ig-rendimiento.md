# 2026-07-26 — Instagram: más rápido, más cantidad, más eficiente

Objetivo de Aron (textual): *"enfoca las mejoras a la publicación y automatización
en instagram, quiero que sea, más rápido, más cantidad, no se rompa nada, y
además más eficiente y rápido"*.

Estado final: **`npm test` 109/109 · `verify-spa.mjs` 28/28 · `npm run build` OK ·
`node --check` OK en los 4 módulos tocados.** Nada desplegado (ver "Pendiente de
autorización").

---

## 1. El cuello de botella real (diagnóstico)

Una fila podía gastar **hasta 64 subrequests** (32 por imagen × 2 imágenes) contra
el límite de **50 por invocación** del plan Free de Cloudflare. Una sola imagen
lenta reventaba la invocación entera, mataba la corrida y dejaba filas reclamadas
(`estado='publicando'`) durante 10 minutos. Por eso `RUSH_POR_TICK` estaba puesto
en 3 "a ojo": no era una decisión de negocio, era miedo al límite.

## 2. Qué se cambió

| # | Cambio | Archivo | Efecto medido/estimado |
|---|--------|---------|------------------------|
| 1 | Poll adaptativo del contenedor (0,5→1→2→4→8 s, tope 12) en vez de 30×2 s fijos | `ig-api.js` | 32 → **14 subrequests por imagen**; el caso normal responde ~4× más rápido |
| 2 | Presupuesto explícito de subrequests por invocación | `ig-budget.js` (nuevo) | la corrida **corta limpio** antes de reventar; ninguna fila queda a medias |
| 3 | `RUSH_POR_TICK` 3 → **6** (exportada, los tests miden contra ella) | `ig-queue.js` | cupo diario de Meta lleno en **~8 ticks** en vez de ~17 |
| 4 | Lock ANTES de consultar el cupo | `ig-queue.js` | **~60 llamadas Graph/hora menos** (rate limit de Meta: 200/h) |
| 5 | Cadena de fallback sin eslabones condenados para fotos que no son de ML | `ig-api.js` | 2 contenedores muertos menos **por cada foto de Drive** |
| 6 | Graph API unificada en v25.0 (había v21 y v25 conviviendo) | `ig-api.js` | v20 caduca el 24-sep-2026; error 2635 sin aviso previo |
| 7 | **Aviso agrupado por corrida** en vez de uno por fila | `ig-queue.js` | 6 subrequests → 1 por tick, y 6 notificaciones → 1 |
| 8 | **Historias on/off** (`/ig historias off`) | `ig-queue.js`, `telegram-bot.js` | **~48 → ~96 productos/día** y el doble de filas por tick |
| 9 | `/ig reintentar` + botón: rescata las filas en `error` | `ig-queue.js`, `telegram-bot.js` | antes quedaban muertas para siempre = cantidad perdida |
| 10 | `.catch` en los `ctx.waitUntil` del cron | `index.js` | un publisher que lanzaba moría **en silencio** con el panel diciendo "🔥 RUSH activo" |
| 11 | El panel cuenta `publicando` y `error` | `telegram-bot.js` | las filas en vuelo ya no desaparecen de la cuenta sin explicación |
| 12 | `/ig horas` valida rango real (aceptaba `25:99`) y avisa lo descartado | `telegram-bot.js` | una ventana imposible dejaba la cola sin publicar y sin decir por qué |
| 13 | 3 índices para `ig_queue` | `schema-ig.sql`, `migrate-indices.sql` | **no aplicados** (ver abajo) |

## 3. Números

- **Por fila (caso típico):** ~7 subrequests con historia, ~4 sin ella.
- **Por tick del cron** (`* * * * *`, confirmado en `wrangler.toml`): hasta 6
  productos con historias, hasta 12 sin ellas.
- **Techo diario** (cupo de Meta = 100/24 h, las historias también cuentan,
  verificado en @topwheels.cl): **~48 productos/día** con historias,
  **~96/día** sin ellas.

## 4. Lo que se decidió NO hacer (y por qué)

- **Paralelizar feed + historia:** el post-mortem del 2026-07-15 fue justamente
  historias duplicadas, y el techo real es el cupo de Meta, no la latencia por
  fila. No compra nada y reabre el bug que costó una jornada.
- **502 cuando falta el banner de la historia:** haría que la cadena cayera al
  último eslabón y publicara la foto **cruda**, sin blur ni banner. Peor.
- **Abrir `/ig/img` a cualquier host:** la whitelist de mlstatic es deliberada —
  abrirla lo convierte en proxy de imágenes abierto y revive el error 1102 de CPU
  que obligó a migrar a Cloudinary.
- **Reutilizar entre feed e historia el eslabón que funcionó:** ahorraría 1-2
  subrequests, pero saltarse Cloudinary por un fallo pasajero deja la historia
  **sin banner "DISPONIBLE"**, que es requisito del negocio.

## 5. Autorizado por Aron ("haz todo lo pendiente") y EJECUTADO el 2026-07-26

- **Índices en la D1 remota: APLICADOS.**
  `npx wrangler d1 execute mlpu-db --remote --file=migrate-indices.sql` (desde
  `worker/`) → 3 queries, 1290 filas escritas. Verificado con
  `EXPLAIN QUERY PLAN` sobre la consulta real de `claimNext`:
  `SEARCH ig_queue USING COVERING INDEX ix_ig_queue_claim (fuente=?)`.
  Antes recorría las 567 filas de `ig_queue` en cada reclamo (hasta 5 por tick,
  cada minuto).
  Ojo: el nombre de la base es **`mlpu-db`**, no `mlpu` (el comentario del .sql
  decía mal el nombre; corregido).
- **Worker DESPLEGADO.** Version ID `9411faca-195b-4020-9e39-dc788a6726ef`.
  Incluye todo lo de esta sesión: L1-L5 (rendimiento IG), L6 (escape HTML de
  Telegram), L7 (alerta de venta que se perdía), L8 (SPA) y L10 (seguridad).
- **Verificación en vivo tras el deploy:**
  `/ml/auth/status` → `active:true`; `/tg/admin?action=info` → webhook registrado
  en `/tg/webhook`, `pending_update_count: 0`, y el bloque nuevo `seguridad`
  reportando `webhook_secret_en_worker:false`, `mlpu_key_en_worker:false`.
- **L10 desplegado en modo inerte, a propósito.** Los dos secrets son opcionales:
  mientras no existan, `exigirLlave()` y la guardia del webhook son no-ops y el
  Worker se comporta exactamente como antes. Por eso el deploy no podía romper
  nada aunque L10 viajara dentro.

### 5.1 Git y CI

- Commit `a0bff32` (todo lo anterior) + `79fd135` (arreglo de la CI), pusheados
  a `main`.
- La primera corrida de la CI **falló**, y bien: el script de tests tenía el
  patrón entre comillas (`"worker/test/*.test.js"`), así que en Linux bash no lo
  expandía y Node 20 tampoco (los globs en `--test` llegaron en v22) →
  `Could not find worker/test/*.test.js`. Sin comillas lo expande bash en Linux
  y Node en Windows. Runner subido a Node 22 de paso.
- Corrida siguiente **verde**: `test` → `build` → `deploy`.
- SPA publicado y verificado: `https://25225840rico.github.io/MLPU/` responde
  200 y sirve `assets/index-Bm5LMGp7.js`, el mismo hash del build local.

## 6. Lo que queda EN MANOS DE ARON (no lo puedo hacer yo)

Activar la seguridad exige elegir valores secretos y tocar el teléfono:

1. `npx wrangler secret put MLPU_KEY` (desde `worker/`) y pegar **el mismo
   valor** en el SPA: Ajustes → «Llave del Worker (MLPU_KEY)». Si se pone el
   secret y no se pega la llave en el SPA, el proxy responde 401 y la app deja
   de publicar hasta que se pegue.
2. `npx wrangler secret put TELEGRAM_WEBHOOK_SECRET` → `npx wrangler deploy` →
   **volver a registrar el webhook**: `GET /tg/admin?action=set`. Sin ese último
   paso Telegram sigue mandando updates sin el token y el bot queda mudo.

Estado real de la cola al cierre (D1 remota): drive 294 publicado / 118
pendiente · ml 90 publicado / 55 pendiente. No publica desde las 14:11 UTC
porque el **cupo de Meta está lleno**: `ig_config.rush_avisado` marca reapertura
el 2026-07-27T13:29:21Z. Es la siesta esperada, no una falla.
