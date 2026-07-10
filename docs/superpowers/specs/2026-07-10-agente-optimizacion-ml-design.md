# Agente autónomo de optimización MercadoLibre (MLPU-Optimizer)

**Fecha:** 2026-07-10 · **Estado:** v1.0 — aprobado, listo para implementación
**Proyecto base:** MLPU (`C:\Users\aronr\OneDrive\Documentos\PROYECTOS\automl`)

## 1. Objetivo

Sistema autónomo que optimiza la cuenta de MercadoLibre del usuario
(seller 283388639, GUAR8622673, sitio MLC): recolecta datos propios y de
competencia por API oficial, detecta oportunidades, propone mejoras con
impacto estimado, las aplica **solo tras aprobación explícita por Telegram**,
mide el resultado real contra el estimado, revierte si empeora y aprende de
la comparación. Todo auditable, reversible y dentro de los ToS de ML.

Prioridades: costo operativo mínimo (US$0 de infraestructura), alta
automatización, confiabilidad, modularidad, mantenimiento por una persona.

## 2. Decisión de stack (enfoque elegido)

**Extender MLPU**, no construir aparte. Se descartó el stack
Python/FastAPI/PostgreSQL/Redis/Docker (US$15-40/mes, duplica OAuth/proxy/
aprobaciones ya construidos) y la variante "análisis en PC local" (depende
del PC encendido, segunda base de código).

- **Cloudflare Worker** existente (`mlpu-proxy`): scheduler (cron),
  pipeline, aplicación de cambios, bot de Telegram.
- **Cloudflare D1** (SQLite serverless, free tier): TODO lo histórico y
  analítico. Es la única pieza de infraestructura nueva.
- **KV** existente: solo efímero — tokens OAuth, locks, caché corta,
  config de arranque. La caché de análisis va en D1/Cache API, no en KV
  (su límite de escrituras diarias es el más bajo del free tier).
- **JavaScript con JSDoc estricto** (no TypeScript): consistencia con los
  ~10 módulos `.js` actuales, sin build step. Contratos tipados vía
  `@typedef` (Context, Result, Proposal, etc.).
- **Telegram** como única UI (digest, aprobaciones, alertas, comandos).
- **GitHub + wrangler deploy** como CI/CD (flujo actual del repo).

## 3. Arquitectura

```
Cron (ventana nocturna) ──► Orchestrator (job → batches → items)
                                │
   ┌────────────┬───────────────┼───────────────┬──────────────┐
   ▼            ▼               ▼               ▼              ▼
collector → normalizer → competitors → scoring → proposal
   (API ML)   (API→modelo)  (búsqueda      (oportunidades  (payload +
                             pública        con score,      impacto
                             oficial,       gain,           estimado)
                             agregados)     confidence)         │
                                                                ▼
rollback ◄── monitor ◄── applier ◄── approval (Telegram: digest diario,
 (re-PUT      (ventana     (PUT +      Aprobar/Rechazar/Aprobar todo)
  before_json) 7 días,      relectura,
  auto solo    real vs      guardrails)
  precio)      estimado)
                                │
                                ▼
                       D1 (histórico) + events (event store) + KV (efímero)
```

**Agentes = módulos JS** en `worker/agents/`, cada uno exporta
`run(context) → Promise<Result>`: `collector.js`, `normalizer.js`,
`competitors.js`, `scoring.js`, `proposal.js`, `approval.js`, `applier.js`,
`monitor.js`, `rollback.js`, más `orchestrator.js` (job/batch/cursor) y
`db.js` (acceso D1). No son microservicios.

**Pipeline por tandas (límite de subrequests por invocación):** el cron
corre cada 15 min en ventana 02:00–06:00; cada invocación toma un batch
(~30 ítems, dimensionado por el límite vigente de subrequests) desde el
cursor persistido. Estado `job → job_batches → items`: un batch fallido se
reintenta solo, sin reiniciar el ciclo. Estado propio y visitas van por
multiget (20 ítems/request); la búsqueda de competencia es 1 request/ítem
(el costo dominante).

**Normalizer separado del Collector:** la respuesta cruda de ML no se
persiste; el Normalizer mapea API → modelo interno. Campos nuevos de ML se
incorporan tocando solo el Normalizer.

## 4. Fases

| Fase | Entrega | Criterio de salida |
|---|---|---|
| **F0** | Bootstrap: crear D1 + esquema, health check de credenciales/permisos, **verificación automática de límites de plataforma** (subrequests, invocaciones, D1/KV) guardada como config, sync inicial del catálogo, webhooks verificados, flags iniciales | Health check verde; catálogo completo en `listings` |
| **F1** | Collector + snapshots diarios + tablero KPIs por Telegram (visitas, ventas, conversión, salud por ítem). **Solo lectura** | ≥7 días de snapshots continuos; digest matinal estable |
| **F2** | Competencia + scoring + propuestas de PRECIO + approval + applier + monitor + rollback. **100% determinístico, sin LLM.** Se estrena en `DRY_RUN` ≥1 semana | Primer ciclo completo propuesta→aprobación→apply→verificación→monitor con impacto real registrado |
| **F3** | SEO/calidad de fichas: títulos, atributos faltantes, fotos. **Único módulo con LLM** (claude-haiku-4-5), mismo ciclo de aprobación | Propuestas de ficha con impacto medible en visitas |
| **F4** | Rotación/inventario (stock muerto, aging) + experimentos A/B formales | Requiere semanas de histórico de F1 |

Cada fase entrega valor por sí sola. No se inicia F3/F4 sin histórico
suficiente. F2 solo pasa de `DRY_RUN` a real con aprobación del usuario.

## 5. Modelo de datos (D1)

Todas las tablas llevan `seller_id` (tenant natural de ML: da
multi-cuenta/multi-país sin migración). Fechas `TEXT` ISO-8601 UTC.

**Estado actual**
- `listings` — espejo del catálogo: `item_id` PK, `seller_id`, `title`,
  `price`, `listing_type`, `free_shipping`, `status`, `sub_status`,
  `category_id`, `qty`, `sold_total`, `health`, `permalink`, `attrs_json`,
  `min_price`, `manual_override_until`, `first_seen`, `last_synced`.

**Histórico (el activo del sistema)**
- `listing_snapshots` — PK `(item_id, snapshot_at)`: `price`,
  `buy_box_price`, `listing_type`, `shipping_mode`, `free_shipping`,
  `status`, `qty`, `sold_total`, `visits`, `health`. `snapshot_at` es
  timestamp UTC (permite pasar de diario a 6/12 h o snapshots pre/post
  cambio sin migrar). ~200 bytes/fila.
- `competitor_snapshots` — PK `(item_id, snapshot_at)`: `category_id`,
  `sample_size`, `price_min`, `price_p25`, `price_median`,
  `best_seller_price`, `top5_json` (evidencia: 5 avisos más relevantes).
  Agregados, nunca cada competidor individual.
- `orders` — `order_id` PK, `item_id`, `qty`, `amount`, `date`,
  `shipping_type`. Alimentada por las notificaciones `orders_v2` que el
  Worker ya recibe.

**Ciclo de decisión**
- `opportunities` — `id`, `item_id`, `type` (price_high, price_low,
  no_visits, missing_attrs, dead_stock…), `score`, `expected_gain`,
  `confidence`, `priority`, `evidence_json`, `status`, `detected_at`.
- `proposals` — `id`, `opportunity_id`, `item_id`, `type`, `payload_json`
  (cambio exacto), `estimated_impact_json` (predicción cuantificada),
  `status` (pending → approved/rejected/expired → applied/failed),
  `approved_by`, `approved_at`, `tg_message_id`. Expiran a las 72 h.
  Absorbe la tabla `approvals` (1 propuesta = a lo más 1 decisión).
- `changes` — `id`, `proposal_id`, `item_id`, `field`, `before_json`
  (estado completo previo = rollback de un toque), `after_json`,
  `applied_at`, `verified_at`, `verification_status`
  (verified/pending/failed/timeout), `rolled_back_at`, `rollback_reason`,
  `impact_real_json`. **Nunca se borra** (memoria del sistema).
- `experiments` (F4) — `id`, `item_id`, `hypothesis`, `variant_json`,
  `started`, `ended`, `kpi_before_json`, `kpi_after_json`, `verdict`.

**Operación**
- `jobs` — `id`, `kind`, `started_at`, `finished_at`, `status`,
  `items_total`, `items_done`, `subrequests`, `llm_cost_usd`, `error`.
- `job_batches` — `job_id`, `batch_no`, `item_from`, `item_to`, `status`,
  `retries`, `error`.
- `events` — **event store de dominio**, append-only: `ts`, `kind`
  (PRICE_CHANGED, PRICE_ROLLBACK, PROPOSAL_CREATED, PROPOSAL_APPROVED,
  PROPOSAL_REJECTED, ORDER_RECEIVED, STOCK_UPDATED, MANUAL_OVERRIDE,
  KILL_SWITCH_ON…), `ref_id`, `data_json`.
- `feature_flags` — `key`, `value`, `updated_at`. Incluye AUTO_PRICE,
  AUTO_TITLE, KILL_SWITCH, DRY_RUN, APPROVAL_MODE (manual/auto), y los
  límites de plataforma verificados en F0.
- `system_metrics` — por día: `api_calls`, `api_errors`, `cron_duration`,
  `items_processed`, `subrequests`, `llm_calls`, `llm_cost`,
  `cache_hit_rate`, `coverage_pct`, `avg_analysis_age_h`.

**Índices:** `listings(seller_id,status)`; PKs compuestas en snapshots;
`opportunities(status,score)`; `proposals(status)`;
`job_batches(job_id,status)`; `orders(item_id,date)`;
`changes(item_id,applied_at)`; `events(kind,ts)`.

**Retención:** snapshots y `changes` permanentes (archivar antes que
borrar si algún día falta espacio); `events` poda a 180 días;
`jobs`/`job_batches` a 90.

## 6. Guardrails y reglas de negocio

Configurables en D1 (`feature_flags`/config), editables sin redeploy.

**Precio — una propuesta se genera solo si pasa todas:**
- `MAX_PRICE_DELTA_PCT` = ±10% por movimiento.
- Cooldown 7 días entre cambios de precio del mismo ítem.
- `min_price` por ítem (default precio actual −25% hasta cargar costos).
- Terminación 990/989 (convención del proyecto).
- **Regla del umbral $19.990** (verificada empíricamente 2026-07-10):
  cruzar el umbral en cualquier dirección cuantifica en
  `estimated_impact_json` el efecto del envío gratis obligatorio
  (~$6.300/venta a cargo del vendedor). El umbral vive en config.

**Estado — verificadas al proponer Y al aplicar:**
- `under_review`/`sub_status` no vacío: intocable.
- Orden pendiente de entrega: sin cambios de precio.
- Ítems con variaciones: precio vía `variations:[{id,price}]` (PUT de
  `price` directo falla; regla ya aprendida).
- `manual_override`: si el Collector detecta que el estado real difiere
  del último `after_json` aplicado por el agente (cambio manual del
  operador en ML), congela la automatización de ese ítem 7 días
  (configurable) y emite evento MANUAL_OVERRIDE.

**Applier — límites duros que ninguna aprobación cruza:**
1. Solo `proposals` con `status=approved` no expiradas.
2. Verificación por relectura tras cada PUT (`verification_status`);
   un HTTP 200 no cuenta como éxito (ML revierte en silencio).
3. Aborta el batch tras 3 fallas consecutivas.
4. **Circuit breaker global:** ≥10 errores 5xx o ≥20% de error en la
   última hora → KILL_SWITCH automático + aviso; modo lectura hasta
   revisión humana.
5. `KILL_SWITCH` (comando `/pausar`): congela toda escritura a ML.
6. `DRY_RUN`: pipeline completo y notificaciones sin ejecutar PUTs.

**Aprobación:** digest diario matinal por Telegram (resumen + detalle por
propuesta con evidencia: mediana, `sample_size`, visitas 14 días, impacto
estimado) con Aprobar / Rechazar / Aprobar todo. `APPROVAL_MODE`:
`manual` (default: todo pasa por el usuario) o `auto` (solo propuestas con
`confidence` alta, impacto bajo y dentro de límites se aplican solas y se
avisan con botón Deshacer; el resto sigue pidiendo aprobación). Se parte
en `manual`; `auto` se habilita cuando la comparación estimado-vs-real
demuestre calibración.

**Monitor y rollback (calidad de evidencia primero):**
- Señal primaria: visitas (con el volumen actual las ventas no dan señal
  de corto plazo; conversión se evalúa a 30 días).
- Ventana de observación 7 días vs baseline de los 14 previos.
- Rollback automático **solo de precio** y solo si: caída de visitas >40%
  **y** `baseline_visits ≥ MIN_BASELINE_VISITS` (default 50,
  configurable). Con muestra insuficiente: alerta con botón "Revertir".
- Cambios no-precio: nunca rollback automático; alerta con botón.
- `MAX_ACTIVE_OBSERVATIONS` = 10: con 10 cambios en ventana de
  observación no se generan nuevos cambios de precio (atribución limpia).
- Al cerrar la ventana, el Monitor escribe `impact_real_json` junto al
  estimado → el sistema aprende y calibra `confidence`.

**Degradación ordenada** cuando cualquier límite se acerca (invocaciones,
subrequests, ventana nocturna, presupuesto LLM): 1º analizar solo ítems
con ventas/visitas recientes → 2º solo ítems con oportunidades abiertas →
3º completar el resto la noche siguiente. El sistema nunca se detiene por
completo; la cobertura degradada queda visible en `system_metrics`.

## 7. Presupuestos y KPIs del propio sistema

Tres presupuestos separados, monitoreados en `system_metrics`:
- **Infraestructura:** US$0 objetivo (free tier).
- **LLM:** < US$3/mes; al llegar al tope, los módulos LLM (solo F3) se
  auto-apagan por flag y avisan. F1/F2 son 100% determinísticos (US$0).
- **API ML:** sin costo económico hoy, pero con límites de uso — se mide
  `api_calls`/`api_errors` para detectar throttling o cambios de política.

KPIs de salud del sistema (en el digest semanal):
- **Optimization Coverage** = ítems analizados / total (objetivo ≥95%/24 h).
- **Average Analysis Age** (horas desde el último análisis por ítem).
- Precisión predictiva: error medio estimado-vs-real de las propuestas.

## 8. Costos por escala

Estimaciones con los límites vigentes al momento del diseño (ver §9: se
verifican en F0 y se revisan periódicamente; no son verdades permanentes).
El costo dominante del ciclo es 1 búsqueda de competencia por ítem.

| Escala | Infra | LLM (F3) | Total/mes | Nota |
|---|---|---|---|---|
| 100 | US$0 | ~US$0,20 | ~US$0,20 | 4 batches/noche |
| 500 | US$0 | ~US$0,80 | ~US$0,80 | 17 batches |
| 1.000 | US$0 | ~US$1,50 | ~US$1,50 | cron pasa a cada 5 min en la ventana |
| 5.000 | US$0-5 | ~US$3 (tope) | US$0-8 | ampliar ventana o Workers Paid (US$5/mes: lotes ~20× mayores) |

Primer cuello real: la ventana horaria del cron cerca de 3.000-5.000
ítems. D1 (~0,4 GB/año a 5.000 ítems) y las invocaciones diarias quedan
lejos de sus límites. Dominio propio: innecesario (opcional, US$10/año).

## 9. Supuestos y restricciones

- Solo APIs oficiales de MercadoLibre, autenticadas vía el OAuth existente
  del Worker; la competencia se consulta por el endpoint público oficial
  de búsqueda. **Sin scraping, sin APIs privadas, sin eludir
  autenticación.**
- El sistema actúa únicamente sobre cuentas autorizadas por el usuario
  (hoy: seller 283388639). Multi-cuenta futura = filas nuevas con otro
  `seller_id`, previa autorización OAuth de esa cuenta.
- Los límites de Cloudflare (subrequests/invocación, invocaciones/día,
  escrituras D1/KV, CPU) y de la API de ML son **los vigentes al momento
  del diseño**: F0 los verifica mediante health check, los persiste como
  configuración y el sistema los relee periódicamente. Ningún límite
  numérico de este documento debe hardcodearse.
- Telegram es la única interfaz de operación; la allowlist de chats
  existente (`chats:allowed`) controla el acceso.
- Toda mutación sobre ML queda registrada en `changes` + `events`
  (auditoría completa) y es reversible vía `before_json`.
- Los tokens nunca salen del Worker/KV; secrets vía `wrangler secret`.

## 10. Testing y operación

- **Tests:** unitarios con `node --test` para lógica pura (scoring,
  guardrails, normalizer, cálculo de impacto) con fixtures de respuestas
  reales de ML; el applier se prueba contra el ítem de prueba designado
  (patrón ya usado: MLC4146267638) antes de habilitar el catálogo.
- **Estreno seguro:** F2 corre en `DRY_RUN` ≥1 semana; comparar las
  propuestas simuladas contra el juicio del usuario antes de armar.
- **Runbook:** `/pausar` (KILL_SWITCH), `/estado` (job actual, cobertura,
  presupuestos), botón Revertir en cada cambio aplicado, reintento por
  batch fallido; `jobs`/`system_metrics` son la primera parada de debug.
- **Monitoreo:** digest matinal (negocio) + alertas inmediatas (circuit
  breaker, rollback, presupuesto) + resumen semanal (KPIs del sistema).

## 11. Roadmap posterior (no comprometido)

Multi-cuenta/multi-país (ya soportado por el esquema), posición en
búsqueda (`search_position_history`), costos reales por ítem para margen
verdadero, Workers Paid + Queues a gran escala, panel web de solo lectura
sobre D1 si Telegram queda chico.

## Apéndice A — Definition of Done por fase

**F0:**
- OAuth funcionando (token fresco obtenido vía el flujo existente).
- Credenciales y permisos de la cuenta validados contra la API.
- Límites de plataforma verificados y persistidos como configuración.
- Health check en verde y consultable por Telegram (`/estado`).
- Cron operativo (job de prueba completo en `jobs`).
- D1 inicializada con migraciones reproducibles (SQL versionado en repo).
- Catálogo completo en `listings`.
- Secretos documentados (nombres y propósito, nunca valores) en el repo.

**F1:**
- 100% del catálogo sincronizado a diario.
- `listing_snapshots` y `competitor_snapshots` generándose correctamente.
- KPIs visibles en el digest de Telegram.
- Optimization Coverage > 95% y Average Analysis Age < 24 h sostenidos.
- **Cero escrituras hacia MercadoLibre** (verificable en `events`).
- Recuperación automática tras interrupciones (batch fallido se reintenta
  sin intervención; ciclo incompleto continúa la noche siguiente).
- Auditoría completa en `events`.

(F2-F4 definirán su DoD en sus respectivos planes de implementación,
siguiendo este mismo formato.)

## Apéndice B — Riesgos

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Cambios en la API de ML | Alto | F0 verifica capacidades; Normalizer aísla el modelo interno; circuit breaker |
| Cambios en límites de Cloudflare | Medio | Límites como configuración dinámica + degradación ordenada |
| Caída/timeout del Worker a mitad de ciclo | Medio | Estado Job→Batch→Item: reintento solo del batch fallido |
| OAuth expirado o rotado | Alto | Renovación automática existente; health check de F0 lo detecta |
| D1 temporalmente indisponible | Bajo | Reintentos exponenciales; el ciclo se completa la noche siguiente |
| ML acepta un cambio y lo revierte en silencio | Alto | Verificación por relectura post-PUT (regla ya probada en producción) |
| Cambio manual del operador pisado por el agente | Medio | `manual_override` congela el ítem 7 días |

## Apéndice C — Criterios para habilitar F2 (salir de DRY_RUN)

F2 no se habilita por plazo, sino por estabilidad demostrada. Todos:
- 7-14 días de histórico consistente (sin huecos de snapshots).
- Optimization Coverage ≥ 95% sostenido.
- Errores del Collector < 1%.
- Errores del Applier en DRY_RUN < 1%.
- Ningún rollback inesperado en las simulaciones.
- Validación manual del usuario de varias propuestas representativas
  (las simuladas coinciden con su juicio de negocio).

La transición posterior a `APPROVAL_MODE=auto` (solo tipos de cambio de
bajo riesgo) exige además calibración demostrada estimado-vs-real.
