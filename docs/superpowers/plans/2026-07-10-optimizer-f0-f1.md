# MLPU-Optimizer F0+F1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** F0 (bootstrap: D1 + esquema + health check + sync de catálogo + cron) y F1 (pipeline nocturno de snapshots propios y de competencia + KPIs por Telegram), 100% solo-lectura hacia MercadoLibre.

**Architecture:** Se extiende el Worker `mlpu-proxy` existente con módulos nuevos en `worker/agents/` (contrato `run(ctx)`), una base D1 para todo lo histórico y un orquestador Job→Batch→Item que corre por cron en ventana nocturna respetando el presupuesto de subrequests. Telegram es la única UI (`/estado`, `/kpi`, `/agente sync`). Spec: `docs/superpowers/specs/2026-07-10-agente-optimizacion-ml-design.md`.

**Tech Stack:** Cloudflare Workers (JS + JSDoc, sin build), D1 (SQLite), KV existente, cron triggers, `node --test` para lógica pura, wrangler.

## Global Constraints

- JavaScript con JSDoc estricto. NO TypeScript, NO build step. Comentarios en español (estilo del repo).
- **F1 = CERO escrituras hacia MercadoLibre.** Solo GET a la API de ML. Ninguna tarea de este plan hace PUT/POST a `/items`.
- Todas las tablas llevan `seller_id`. Fechas/timestamps `TEXT` ISO-8601 UTC (`new Date().toISOString()`).
- KV solo efímero (tokens/locks). Todo lo persistente/histórico va a D1 (binding `env.DB`).
- Límites de plataforma = configuración en D1 (`feature_flags`), nunca hardcodeados en lógica: `BATCH_SIZE` (default 30), `SUBREQUEST_BUDGET` (default 45), `CRON_WINDOW_UTC` (default `"6-10"`).
- Reusar SIEMPRE: `getValidAccessToken(env)` (worker/index.js:99), `mlFetch(url, options, {retries})` (worker/ml-fetch.js:15), `tgSend(env, chatId, text, extra)` (worker/telegram-bot.js:54). No duplicar auth ni fetch.
- La API pública de ML se llama vía `https://api.mercadolibre.com`; el header `Authorization: Bearer <token>` va en todas las llamadas (el token ya existe; no crear flujos de auth nuevos).
- Tests: `node --test worker/test/` desde la raíz del repo. Lógica pura testeada sin red ni D1 real (stubs inyectados).
- Commits frecuentes, mensajes en español, terminar con `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Esquema D1, binding y documentación de secretos

**Files:**
- Create: `worker/migrations/0001_init.sql`
- Create: `worker/agents/README.md`
- Modify: `worker/wrangler.toml`

**Interfaces:**
- Consumes: nada (primera tarea).
- Produces: tablas D1 (nombres/columnas exactos abajo) y binding `env.DB` que usan todas las tareas siguientes.

- [ ] **Step 1: Crear la base D1 (una sola vez, remota)**

Run: `cd worker && npx wrangler d1 create mlpu-db`
Expected: imprime `database_id = "<uuid>"`. Copiar ese uuid para el Step 3.

- [ ] **Step 2: Escribir la migración inicial**

Crear `worker/migrations/0001_init.sql`:

```sql
-- MLPU-Optimizer: esquema inicial (spec 2026-07-10 §5).
CREATE TABLE IF NOT EXISTS listings (
  item_id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL,
  title TEXT, price REAL, listing_type TEXT, free_shipping INTEGER,
  status TEXT, sub_status TEXT, category_id TEXT, qty INTEGER,
  sold_total INTEGER, health REAL, permalink TEXT, attrs_json TEXT,
  min_price REAL, manual_override_until TEXT,
  first_seen TEXT NOT NULL, last_synced TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_listings_seller_status ON listings(seller_id, status);

CREATE TABLE IF NOT EXISTS listing_snapshots (
  item_id TEXT NOT NULL, snapshot_at TEXT NOT NULL, seller_id TEXT NOT NULL,
  price REAL, buy_box_price REAL, listing_type TEXT, shipping_mode TEXT,
  free_shipping INTEGER, status TEXT, qty INTEGER, sold_total INTEGER,
  visits INTEGER, health REAL,
  PRIMARY KEY (item_id, snapshot_at)
);

CREATE TABLE IF NOT EXISTS competitor_snapshots (
  item_id TEXT NOT NULL, snapshot_at TEXT NOT NULL, seller_id TEXT NOT NULL,
  category_id TEXT, sample_size INTEGER,
  price_min REAL, price_p25 REAL, price_median REAL, best_seller_price REAL,
  top5_json TEXT,
  PRIMARY KEY (item_id, snapshot_at)
);

CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY, seller_id TEXT NOT NULL,
  item_id TEXT, qty INTEGER, amount REAL, date TEXT, shipping_type TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_item_date ON orders(item_id, date);

CREATE TABLE IF NOT EXISTS opportunities (
  id INTEGER PRIMARY KEY AUTOINCREMENT, seller_id TEXT NOT NULL,
  item_id TEXT NOT NULL, type TEXT NOT NULL, score REAL,
  expected_gain REAL, confidence REAL, priority TEXT,
  evidence_json TEXT, status TEXT NOT NULL DEFAULT 'open', detected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opps_status_score ON opportunities(status, score);

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, seller_id TEXT NOT NULL,
  opportunity_id INTEGER, item_id TEXT NOT NULL, type TEXT NOT NULL,
  payload_json TEXT NOT NULL, estimated_impact_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  approved_by TEXT, approved_at TEXT, tg_message_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);

CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, seller_id TEXT NOT NULL,
  proposal_id INTEGER, item_id TEXT NOT NULL, field TEXT NOT NULL,
  before_json TEXT NOT NULL, after_json TEXT NOT NULL, applied_at TEXT NOT NULL,
  verified_at TEXT, verification_status TEXT NOT NULL DEFAULT 'pending',
  rolled_back_at TEXT, rollback_reason TEXT, impact_real_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_changes_item ON changes(item_id, applied_at);

CREATE TABLE IF NOT EXISTS experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, seller_id TEXT NOT NULL,
  item_id TEXT, hypothesis TEXT, variant_json TEXT,
  started TEXT, ended TEXT, kpi_before_json TEXT, kpi_after_json TEXT, verdict TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, seller_id TEXT NOT NULL,
  kind TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  items_total INTEGER DEFAULT 0, items_done INTEGER DEFAULT 0,
  subrequests INTEGER DEFAULT 0, llm_cost_usd REAL DEFAULT 0, error TEXT
);

CREATE TABLE IF NOT EXISTS job_batches (
  job_id INTEGER NOT NULL, batch_no INTEGER NOT NULL,
  items_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  retries INTEGER DEFAULT 0, error TEXT,
  PRIMARY KEY (job_id, batch_no)
);
CREATE INDEX IF NOT EXISTS idx_batches_job_status ON job_batches(job_id, status);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, seller_id TEXT NOT NULL,
  ts TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT, data_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_kind_ts ON events(kind, ts);

CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_metrics (
  date TEXT NOT NULL, seller_id TEXT NOT NULL,
  api_calls INTEGER DEFAULT 0, api_errors INTEGER DEFAULT 0,
  cron_duration_ms INTEGER DEFAULT 0, items_processed INTEGER DEFAULT 0,
  subrequests INTEGER DEFAULT 0, llm_calls INTEGER DEFAULT 0,
  llm_cost REAL DEFAULT 0, cache_hit_rate REAL,
  coverage_pct REAL, avg_analysis_age_h REAL,
  PRIMARY KEY (date, seller_id)
);
```

Nota de diseño: `job_batches` usa `items_json` (lista de item_ids del lote)
en lugar de `item_from`/`item_to` del spec — los IDs de ML no son rangos
contiguos; el reintento por batch exacto lo exige.

- [ ] **Step 3: Configurar binding y cron en wrangler.toml**

En `worker/wrangler.toml`, reemplazar el bloque `[triggers]` y añadir D1 al final:

```toml
# Cron: ventana nocturna del optimizador (06-09 UTC = 02:00-05:45 Chile
# invierno; la ventana efectiva la decide config CRON_WINDOW_UTC en D1).
[triggers]
crons = ["*/15 6-9 * * *"]

# D1: histórico del optimizador (listings, snapshots, jobs, events...).
# Creada con: wrangler d1 create mlpu-db
[[d1_databases]]
binding = "DB"
database_name = "mlpu-db"
database_id = "<uuid del Step 1>"
```

- [ ] **Step 4: Aplicar migraciones local y remoto, verificar**

Run: `cd worker && npx wrangler d1 migrations apply mlpu-db --local && npx wrangler d1 migrations apply mlpu-db --remote`
Luego: `npx wrangler d1 execute mlpu-db --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"`
Expected: lista con las 13 tablas (`changes, competitor_snapshots, events, experiments, feature_flags, job_batches, jobs, listing_snapshots, listings, opportunities, orders, proposals, system_metrics` + `d1_migrations`).

- [ ] **Step 5: Documentar bindings y secretos**

Crear `worker/agents/README.md`:

```markdown
# MLPU-Optimizer (agentes)

Módulos del agente de optimización. Contrato: cada agente exporta
`run(ctx)`. Spec: docs/superpowers/specs/2026-07-10-agente-optimizacion-ml-design.md

## Bindings (wrangler.toml)
- `DB`   — D1 `mlpu-db`: TODO lo histórico (ver migrations/).
- `ML_TOKENS` — KV: sesión OAuth de ML (existente; no tocar).
- `ML_ORDERS` — KV: órdenes del bot (existente).

## Secrets (wrangler secret put <NOMBRE>) — solo nombres, nunca valores
- `ML_CLIENT_ID`, `ML_CLIENT_SECRET` — OAuth MercadoLibre (existentes).
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — bot (existentes).
- `ANTHROPIC_API_KEY` — visión/LLM (existente; F0-F1 NO la usan).

## Config en D1 (feature_flags) — se siembra en el health check de F0
- `BATCH_SIZE` (30), `SUBREQUEST_BUDGET` (45), `CRON_WINDOW_UTC` ("6-10"),
  `KILL_SWITCH` ("false"), `DRY_RUN` ("true").

## Comandos
- Migraciones: `npx wrangler d1 migrations apply mlpu-db --remote`
- Deploy: `npx wrangler deploy`
- Telegram: `/estado` (salud), `/kpi` (digest), `/agente sync` (procesar un lote a demanda)
```

- [ ] **Step 6: Commit**

```bash
git add worker/migrations/0001_init.sql worker/agents/README.md worker/wrangler.toml
git commit -m "F0: esquema D1, binding DB, cron nocturno y doc de secretos"
```

---

### Task 2: `db.js` — acceso a D1 testeable

**Files:**
- Create: `worker/agents/db.js`
- Test: `worker/test/db.test.js`

**Interfaces:**
- Consumes: `env.DB` (D1Database: `.prepare(sql).bind(...args)` → `.run()/.first()/.all()`).
- Produces (usadas por Tasks 4-11):
  - `nowIso()` → string ISO UTC
  - `getFlag(db, key, fallback)` → Promise<string>; `setFlag(db, key, value)`
  - `upsertListing(db, l)` — l = fila completa de `listings` (objeto con las columnas)
  - `insertListingSnapshot(db, s)`, `insertCompetitorSnapshot(db, s)` — INSERT OR REPLACE
  - `insertOrderRow(db, o)` — INSERT OR IGNORE en `orders`
  - `logEvent(db, sellerId, kind, refId, data)` — inserta en `events`
  - `openJob(db, sellerId, kind)` → Promise<number> (id); `getRunningJob(db, sellerId, kind)` → Promise<{id,...}|null>
  - `bumpJob(db, jobId, {itemsDone, subrequests})`; `finishJob(db, jobId, status, error)`
  - `createBatches(db, jobId, itemIds, batchSize)`; `nextPendingBatch(db, jobId)` → Promise<{batch_no, items: string[]}|null>; `markBatch(db, jobId, batchNo, status, error)`
  - `upsertMetric(db, date, sellerId, patch)` — acumula contadores en `system_metrics`

- [ ] **Step 1: Escribir tests con un stub de D1**

Crear `worker/test/db.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nowIso, createBatches, upsertListing, logEvent } from '../agents/db.js'

// Stub mínimo de D1: registra cada prepare/bind y responde vacío.
function fakeDb(log) {
  return { prepare: (sql) => ({ bind: (...args) => {
    log.push({ sql, args })
    return { run: async () => ({ success: true }), first: async () => null,
             all: async () => ({ results: [] }) }
  } }) }
}

test('nowIso devuelve ISO-8601 UTC', () => {
  assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
})

test('createBatches parte los ids en lotes del tamaño configurado', async () => {
  const log = []
  await createBatches(fakeDb(log), 7, ['a','b','c','d','e'], 2)
  assert.equal(log.length, 3) // 2+2+1
  assert.deepEqual(JSON.parse(log[0].args[2]), ['a','b'])
  assert.deepEqual(JSON.parse(log[2].args[2]), ['e'])
  assert.equal(log[1].args[1], 1) // batch_no incremental desde 0
})

test('upsertListing pasa las columnas en el orden del SQL', async () => {
  const log = []
  await upsertListing(fakeDb(log), { item_id: 'MLC1', seller_id: 's', title: 't',
    price: 990, listing_type: 'gold_pro', free_shipping: 0, status: 'active',
    sub_status: '', category_id: 'MLC3398', qty: 1, sold_total: 0, health: 0.8,
    permalink: 'http://x', attrs_json: '{}', first_seen: 'F', last_synced: 'L' })
  assert.match(log[0].sql, /INSERT INTO listings/i)
  assert.equal(log[0].args[0], 'MLC1')
  assert.match(log[0].sql, /ON CONFLICT\(item_id\)/i)
})

test('logEvent serializa data como JSON', async () => {
  const log = []
  await logEvent(fakeDb(log), 's', 'PING', 'ref', { a: 1 })
  assert.equal(log[0].args[3], 'ref')
  assert.equal(JSON.parse(log[0].args[4]).a, 1)
})
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `node --test worker/test/db.test.js`
Expected: FAIL — `Cannot find module '../agents/db.js'`.

- [ ] **Step 3: Implementar `worker/agents/db.js`**

```js
/**
 * [OPTIMIZER] Acceso a D1. Funciones finas y testeables: reciben `db`
 * (D1Database) y hacen UNA operación. Nada de lógica de negocio aquí.
 * @typedef {import('@cloudflare/workers-types').D1Database} D1Database
 */

export const nowIso = () => new Date().toISOString()
export const today = () => nowIso().slice(0, 10)

// ── feature_flags (config + flags, spec §5) ──────────────────
export async function getFlag(db, key, fallback = null) {
  const row = await db.prepare('SELECT value FROM feature_flags WHERE key=?').bind(key).first()
  return row ? row.value : fallback
}
export async function setFlag(db, key, value) {
  await db.prepare(`INSERT INTO feature_flags (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .bind(key, String(value), nowIso()).run()
}

// ── listings ─────────────────────────────────────────────────
export async function upsertListing(db, l) {
  await db.prepare(`INSERT INTO listings (item_id,seller_id,title,price,listing_type,
    free_shipping,status,sub_status,category_id,qty,sold_total,health,permalink,
    attrs_json,first_seen,last_synced) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(item_id) DO UPDATE SET title=excluded.title, price=excluded.price,
    listing_type=excluded.listing_type, free_shipping=excluded.free_shipping,
    status=excluded.status, sub_status=excluded.sub_status,
    category_id=excluded.category_id, qty=excluded.qty, sold_total=excluded.sold_total,
    health=excluded.health, permalink=excluded.permalink, attrs_json=excluded.attrs_json,
    last_synced=excluded.last_synced`)
    .bind(l.item_id, l.seller_id, l.title, l.price, l.listing_type, l.free_shipping,
      l.status, l.sub_status, l.category_id, l.qty, l.sold_total, l.health,
      l.permalink, l.attrs_json, l.first_seen, l.last_synced).run()
}

// ── snapshots ────────────────────────────────────────────────
export async function insertListingSnapshot(db, s) {
  await db.prepare(`INSERT OR REPLACE INTO listing_snapshots (item_id,snapshot_at,
    seller_id,price,buy_box_price,listing_type,shipping_mode,free_shipping,status,
    qty,sold_total,visits,health) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(s.item_id, s.snapshot_at, s.seller_id, s.price, s.buy_box_price,
      s.listing_type, s.shipping_mode, s.free_shipping, s.status, s.qty,
      s.sold_total, s.visits, s.health).run()
}
export async function insertCompetitorSnapshot(db, s) {
  await db.prepare(`INSERT OR REPLACE INTO competitor_snapshots (item_id,snapshot_at,
    seller_id,category_id,sample_size,price_min,price_p25,price_median,
    best_seller_price,top5_json) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind(s.item_id, s.snapshot_at, s.seller_id, s.category_id, s.sample_size,
      s.price_min, s.price_p25, s.price_median, s.best_seller_price, s.top5_json).run()
}

// ── orders / events / metrics ────────────────────────────────
export async function insertOrderRow(db, o) {
  await db.prepare(`INSERT OR IGNORE INTO orders (order_id,seller_id,item_id,qty,
    amount,date,shipping_type) VALUES (?,?,?,?,?,?,?)`)
    .bind(o.order_id, o.seller_id, o.item_id, o.qty, o.amount, o.date, o.shipping_type).run()
}
export async function logEvent(db, sellerId, kind, refId, data = {}) {
  await db.prepare('INSERT INTO events (seller_id,ts,kind,ref_id,data_json) VALUES (?,?,?,?,?)')
    .bind(sellerId, nowIso(), kind, refId ?? null, JSON.stringify(data)).run()
}
export async function upsertMetric(db, date, sellerId, patch) {
  const cols = ['api_calls','api_errors','cron_duration_ms','items_processed',
                'subrequests','llm_calls','llm_cost']
  await db.prepare(`INSERT INTO system_metrics (date,seller_id) VALUES (?,?)
    ON CONFLICT(date,seller_id) DO NOTHING`).bind(date, sellerId).run()
  for (const c of cols) if (patch[c] != null)
    await db.prepare(`UPDATE system_metrics SET ${c}=${c}+? WHERE date=? AND seller_id=?`)
      .bind(patch[c], date, sellerId).run()
  for (const c of ['coverage_pct','avg_analysis_age_h','cache_hit_rate'])
    if (patch[c] != null)
      await db.prepare(`UPDATE system_metrics SET ${c}=? WHERE date=? AND seller_id=?`)
        .bind(patch[c], date, sellerId).run()
}

// ── jobs / batches (patrón Job→Batch→Item, spec §3) ──────────
export async function openJob(db, sellerId, kind) {
  const r = await db.prepare('INSERT INTO jobs (seller_id,kind,started_at) VALUES (?,?,?)')
    .bind(sellerId, kind, nowIso()).run()
  return r.meta.last_row_id
}
export async function getRunningJob(db, sellerId, kind) {
  return db.prepare(`SELECT * FROM jobs WHERE seller_id=? AND kind=? AND status='running'
    ORDER BY id DESC LIMIT 1`).bind(sellerId, kind).first()
}
export async function bumpJob(db, jobId, { itemsDone = 0, subrequests = 0 } = {}) {
  await db.prepare('UPDATE jobs SET items_done=items_done+?, subrequests=subrequests+? WHERE id=?')
    .bind(itemsDone, subrequests, jobId).run()
}
export async function finishJob(db, jobId, status, error = null) {
  await db.prepare('UPDATE jobs SET status=?, finished_at=?, error=? WHERE id=?')
    .bind(status, nowIso(), error, jobId).run()
}
export async function createBatches(db, jobId, itemIds, batchSize) {
  for (let i = 0, n = 0; i < itemIds.length; i += batchSize, n++) {
    await db.prepare('INSERT INTO job_batches (job_id,batch_no,items_json) VALUES (?,?,?)')
      .bind(jobId, n, JSON.stringify(itemIds.slice(i, i + batchSize))).run()
  }
  await db.prepare('UPDATE jobs SET items_total=? WHERE id=?').bind(itemIds.length, jobId).run()
}
export async function nextPendingBatch(db, jobId) {
  const row = await db.prepare(`SELECT * FROM job_batches WHERE job_id=? AND
    (status='pending' OR (status='failed' AND retries<3)) ORDER BY batch_no LIMIT 1`)
    .bind(jobId).first()
  return row ? { batch_no: row.batch_no, items: JSON.parse(row.items_json), retries: row.retries } : null
}
export async function markBatch(db, jobId, batchNo, status, error = null) {
  await db.prepare(`UPDATE job_batches SET status=?, error=?,
    retries=retries + CASE WHEN ?='failed' THEN 1 ELSE 0 END
    WHERE job_id=? AND batch_no=?`).bind(status, error, status, jobId, batchNo).run()
}
```

- [ ] **Step 4: Correr tests y verificar que pasan**

Run: `node --test worker/test/db.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/agents/db.js worker/test/db.test.js
git commit -m "F0: db.js, acceso D1 testeable (flags, listings, snapshots, jobs/batches)"
```

---

### Task 3: `normalizer.js` — API de ML → modelo interno

**Files:**
- Create: `worker/agents/normalizer.js`
- Test: `worker/test/normalizer.test.js`

**Interfaces:**
- Consumes: objetos crudos de la API de ML (ítem de `/items?ids=`, resultados de `/sites/MLC/search`).
- Produces (usadas por Tasks 5-6):
  - `normalizeItem(mlItem, sellerId, now)` → fila para `upsertListing` (con `first_seen: now`; el upsert conserva el original)
  - `snapshotFromListing(row, visits, now)` → fila para `insertListingSnapshot`
  - `competitorAggregates(searchResults, ownSellerId)` → `{ sample_size, price_min, price_p25, price_median, best_seller_price, top5_json }` o `null` si no hay muestra
  - `percentile(sortedNumbers, p)` → number (p en 0-1, interpolación lineal)

- [ ] **Step 1: Escribir tests**

Crear `worker/test/normalizer.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeItem, snapshotFromListing, competitorAggregates, percentile }
  from '../agents/normalizer.js'

const mlItem = { id: 'MLC1', title: 'Hot Wheels X', price: 12990,
  listing_type_id: 'gold_pro', status: 'active', sub_status: [],
  category_id: 'MLC3398', available_quantity: 1, sold_quantity: 2,
  permalink: 'https://p', health: 0.85,
  shipping: { mode: 'me2', free_shipping: false },
  attributes: [{ id: 'BRAND', value_name: 'Hot Wheels' }] }

test('normalizeItem mapea el ítem a la fila de listings', () => {
  const r = normalizeItem(mlItem, '283388639', '2026-07-10T00:00:00.000Z')
  assert.equal(r.item_id, 'MLC1')
  assert.equal(r.free_shipping, 0)         // boolean → 0/1
  assert.equal(r.sub_status, '')           // array → CSV
  assert.equal(JSON.parse(r.attrs_json).BRAND, 'Hot Wheels')
  assert.equal(r.first_seen, '2026-07-10T00:00:00.000Z')
})

test('snapshotFromListing arma la fila de snapshot con visitas', () => {
  const row = normalizeItem(mlItem, 's', 'T')
  const s = snapshotFromListing(row, 314, 'T2', 'me2')
  assert.equal(s.visits, 314); assert.equal(s.snapshot_at, 'T2')
  assert.equal(s.shipping_mode, 'me2'); assert.equal(s.price, 12990)
})

test('percentile interpola', () => {
  assert.equal(percentile([10, 20, 30, 40], 0.5), 25)
  assert.equal(percentile([10], 0.25), 10)
})

test('competitorAggregates excluye mis avisos y calcula agregados', () => {
  const results = [
    { id: 'A', price: 100, seller: { id: 999 }, sold_quantity: 50, permalink: 'pa', title: 'a' },
    { id: 'B', price: 200, seller: { id: 999 }, sold_quantity: 5, permalink: 'pb', title: 'b' },
    { id: 'C', price: 300, seller: { id: 283388639 }, sold_quantity: 9, permalink: 'pc', title: 'c' },
  ]
  const agg = competitorAggregates(results, '283388639')
  assert.equal(agg.sample_size, 2)         // el mío queda fuera
  assert.equal(agg.price_min, 100)
  assert.equal(agg.price_median, 150)
  assert.equal(agg.best_seller_price, 100) // el de más ventas
  assert.equal(JSON.parse(agg.top5_json).length, 2)
})

test('competitorAggregates devuelve null sin muestra', () => {
  assert.equal(competitorAggregates([], 's'), null)
  assert.equal(competitorAggregates([{ id: 'C', price: 1, seller: { id: 5 } }], '5'), null)
})
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `node --test worker/test/normalizer.test.js`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `worker/agents/normalizer.js`**

```js
/**
 * [OPTIMIZER] Normalizer: API de ML → modelo interno (spec §3).
 * El crudo NO se persiste; campos nuevos de ML se incorporan SOLO aquí.
 * Funciones puras, sin red ni D1.
 */

/** Ítem de /items?ids= → fila de `listings`. */
export function normalizeItem(it, sellerId, now) {
  const attrs = {}
  for (const a of it.attributes || []) if (a.value_name) attrs[a.id] = a.value_name
  return {
    item_id: it.id, seller_id: String(sellerId),
    title: it.title ?? null, price: it.price ?? null,
    listing_type: it.listing_type_id ?? null,
    free_shipping: it.shipping?.free_shipping ? 1 : 0,
    status: it.status ?? null,
    sub_status: (it.sub_status || []).join(','),
    category_id: it.category_id ?? null,
    qty: it.available_quantity ?? null, sold_total: it.sold_quantity ?? null,
    health: it.health ?? null, permalink: it.permalink ?? null,
    attrs_json: JSON.stringify(attrs),
    first_seen: now, last_synced: now,
  }
}

/** Fila de listings (+ visitas acumuladas de /items/visits) → snapshot. */
export function snapshotFromListing(row, visits, now, shippingMode = null) {
  return {
    item_id: row.item_id, snapshot_at: now, seller_id: row.seller_id,
    price: row.price, buy_box_price: null, listing_type: row.listing_type,
    shipping_mode: shippingMode, free_shipping: row.free_shipping,
    status: row.status, qty: row.qty, sold_total: row.sold_total,
    visits: visits ?? null, health: row.health,
  }
}

/** Percentil con interpolación lineal sobre lista ORDENADA. p en [0,1]. */
export function percentile(sorted, p) {
  if (!sorted.length) return null
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx), hi = Math.ceil(idx)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

/**
 * Resultados de /sites/MLC/search → agregados de competencia (spec §5).
 * Excluye avisos propios. Devuelve null si no queda muestra.
 */
export function competitorAggregates(results, ownSellerId) {
  const own = String(ownSellerId)
  const comps = (results || []).filter(r => String(r.seller?.id) !== own && r.price > 0)
  if (!comps.length) return null
  const prices = comps.map(c => c.price).sort((a, b) => a - b)
  const best = [...comps].sort((a, b) => (b.sold_quantity || 0) - (a.sold_quantity || 0))[0]
  const top5 = [...comps].sort((a, b) => (b.sold_quantity || 0) - (a.sold_quantity || 0))
    .slice(0, 5).map(c => ({ id: c.id, price: c.price, sold: c.sold_quantity || 0,
      seller: c.seller?.id ?? null, title: (c.title || '').slice(0, 60) }))
  return {
    sample_size: comps.length,
    price_min: prices[0],
    price_p25: percentile(prices, 0.25),
    price_median: percentile(prices, 0.5),
    best_seller_price: best.price,
    top5_json: JSON.stringify(top5),
  }
}
```

- [ ] **Step 4: Correr tests y verificar que pasan**

Run: `node --test worker/test/normalizer.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/agents/normalizer.js worker/test/normalizer.test.js
git commit -m "F1: normalizer puro (item→listing, snapshot, agregados de competencia)"
```

---

### Task 4: `mlapi.js` — cliente de lectura con contador de subrequests

**Files:**
- Create: `worker/agents/mlapi.js`
- Test: `worker/test/mlapi.test.js`

**Interfaces:**
- Consumes: `mlFetch(url, options, {retries})` de `../ml-fetch.js`; token vía parámetro.
- Produces (usadas por Tasks 5-7): un objeto `api` creado con `makeApi({ token, fetcher })`:
  - `api.get(path)` → Promise<any> (JSON; lanza Error con status si !ok)
  - `api.calls` → número de requests hechos (presupuesto de subrequests)
  - `api.errors` → número de respuestas !ok o excepciones
  - `fetcher` es inyectable en tests (default: `mlFetch`).
  - **Solo GET. Este módulo no expone métodos de escritura (F1 solo-lectura).**

- [ ] **Step 1: Escribir tests**

Crear `worker/test/mlapi.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeApi } from '../agents/mlapi.js'

const okFetcher = (body) => async () =>
  new Response(JSON.stringify(body), { status: 200 })

test('get devuelve JSON y cuenta llamadas', async () => {
  const api = makeApi({ token: 'T', fetcher: okFetcher({ hola: 1 }) })
  const d = await api.get('/users/me')
  assert.equal(d.hola, 1)
  assert.equal(api.calls, 1)
  assert.equal(api.errors, 0)
})

test('get lanza y cuenta errores con status no-ok', async () => {
  const api = makeApi({ token: 'T', fetcher: async () => new Response('{}', { status: 500 }) })
  await assert.rejects(() => api.get('/x'), /HTTP 500/)
  assert.equal(api.errors, 1)
})

test('get manda Authorization', async () => {
  let seen
  const api = makeApi({ token: 'TOK', fetcher: async (url, opts) => {
    seen = opts.headers.Authorization
    return new Response('{}', { status: 200 })
  } })
  await api.get('/items/MLC1')
  assert.equal(seen, 'Bearer TOK')
})
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `node --test worker/test/mlapi.test.js`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `worker/agents/mlapi.js`**

```js
/**
 * [OPTIMIZER] Cliente de LECTURA a la API de ML con contadores de
 * subrequests/errores (presupuesto por invocación, spec §3 y §7).
 * Sin métodos de escritura a propósito: F1 es solo-lectura.
 */
import { mlFetch } from '../ml-fetch.js'

const ML = 'https://api.mercadolibre.com'

/** @param {{ token: string, fetcher?: typeof mlFetch }} opts */
export function makeApi({ token, fetcher = mlFetch }) {
  const api = {
    calls: 0, errors: 0,
    /** GET autenticado; lanza con `HTTP <status>` si la respuesta no es ok. */
    async get(path) {
      api.calls++
      try {
        const r = await fetcher(`${ML}${path}`, {
          headers: { Authorization: `Bearer ${token}` } })
        if (!r.ok) { api.errors++; throw new Error(`HTTP ${r.status} en GET ${path}`) }
        return await r.json()
      } catch (e) {
        if (!/^HTTP \d+/.test(e.message)) api.errors++
        throw e
      }
    },
  }
  return api
}
```

- [ ] **Step 4: Correr tests y verificar que pasan**

Run: `node --test worker/test/mlapi.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/agents/mlapi.js worker/test/mlapi.test.js
git commit -m "F1: cliente ML de solo lectura con contadores de subrequests"
```

---

### Task 5: `collector.js` — estado propio + snapshots

**Files:**
- Create: `worker/agents/collector.js`
- Test: `worker/test/collector.test.js`

**Interfaces:**
- Consumes: `makeApi` (Task 4), `normalizeItem/snapshotFromListing` (Task 3), `upsertListing/insertListingSnapshot` (Task 2).
- Produces (usada por Task 7): `collectBatch(ctx, itemIds)` → Promise<{ done: number, visitsById: Record<string,number|null> }>.
  - `ctx = { db, api, sellerId, now }` (now: string ISO).
  - Endpoints: `GET /items?ids=<20 max>&attributes=id,title,price,listing_type_id,status,sub_status,category_id,available_quantity,sold_quantity,permalink,health,shipping,attributes` (multiget, respuesta `[{code, body}]`) y `GET /items/visits?ids=<20 max>` (respuesta `[{item_id|id, total_visits|total}]`; si falla, visits=null y se sigue — las visitas no bloquean el snapshot).

- [ ] **Step 1: Escribir tests**

Crear `worker/test/collector.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectBatch, chunk } from '../agents/collector.js'

function fakeDb(log) {
  return { prepare: (sql) => ({ bind: (...args) => {
    log.push({ sql, args })
    return { run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }
  } }) }
}
const item = (id, price) => ({ code: 200, body: { id, title: 't', price,
  listing_type_id: 'gold_pro', status: 'active', sub_status: [], category_id: 'MLC3398',
  available_quantity: 1, sold_quantity: 0, permalink: 'p', health: 1,
  shipping: { mode: 'me2', free_shipping: false }, attributes: [] } })

test('chunk parte en grupos de 20', () => {
  assert.deepEqual(chunk([1,2,3], 2), [[1,2],[3]])
})

test('collectBatch upsertea listing + snapshot por ítem con visitas', async () => {
  const log = []
  const api = { calls: 0, errors: 0, get: async (path) => {
    if (path.startsWith('/items/visits')) return [{ item_id: 'MLC1', total_visits: 42 }]
    if (path.startsWith('/items?ids=')) return [item('MLC1', 990)]
    throw new Error('ruta inesperada ' + path)
  } }
  const r = await collectBatch({ db: fakeDb(log), api, sellerId: 's', now: 'T' }, ['MLC1'])
  assert.equal(r.done, 1)
  assert.equal(r.visitsById.MLC1, 42)
  assert.ok(log.some(l => /INSERT INTO listings/i.test(l.sql)))
  const snap = log.find(l => /INSERT OR REPLACE INTO listing_snapshots/i.test(l.sql))
  assert.ok(snap); assert.ok(snap.args.includes(42))
})

test('collectBatch tolera fallo de visitas (null) sin abortar', async () => {
  const log = []
  const api = { calls: 0, errors: 0, get: async (path) => {
    if (path.startsWith('/items/visits')) throw new Error('HTTP 500')
    return [item('MLC2', 100)]
  } }
  const r = await collectBatch({ db: fakeDb(log), api, sellerId: 's', now: 'T' }, ['MLC2'])
  assert.equal(r.done, 1)
  assert.equal(r.visitsById.MLC2, null)
})
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `node --test worker/test/collector.test.js`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `worker/agents/collector.js`**

```js
/**
 * [OPTIMIZER-F1] Collector: estado propio del catálogo → listings +
 * listing_snapshots. SOLO lectura. Multiget de a 20 (límite de ML).
 */
import { normalizeItem, snapshotFromListing } from './normalizer.js'
import { upsertListing, insertListingSnapshot } from './db.js'

const ITEM_ATTRS = 'id,title,price,listing_type_id,status,sub_status,category_id,' +
  'available_quantity,sold_quantity,permalink,health,shipping,attributes'

/** Parte `arr` en grupos de `n`. */
export const chunk = (arr, n) =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n))

/**
 * Procesa un lote de item_ids: 1 multiget de ítems + 1 de visitas por cada
 * 20 ids, upsert de listing y snapshot por ítem.
 * @param {{db:any, api:{get:Function}, sellerId:string, now:string}} ctx
 */
export async function collectBatch(ctx, itemIds) {
  const { db, api, sellerId, now } = ctx
  let done = 0
  const visitsById = {}
  for (const ids of chunk(itemIds, 20)) {
    const multi = await api.get(`/items?ids=${ids.join(',')}&attributes=${ITEM_ATTRS}`)
    // Visitas acumuladas: best-effort, nunca bloquea el snapshot.
    let visits = []
    try { visits = await api.get(`/items/visits?ids=${ids.join(',')}`) }
    catch { /* visitas quedan null este ciclo */ }
    const vmap = {}
    for (const v of Array.isArray(visits) ? visits : [])
      vmap[v.item_id ?? v.id] = v.total_visits ?? v.total ?? null

    for (const entry of multi) {
      const it = entry.body
      if (entry.code !== 200 || !it?.id) continue
      const row = normalizeItem(it, sellerId, now)
      visitsById[it.id] = vmap[it.id] ?? null
      await upsertListing(db, row)
      await insertListingSnapshot(db,
        snapshotFromListing(row, visitsById[it.id], now, it.shipping?.mode ?? null))
      done++
    }
  }
  return { done, visitsById }
}
```

- [ ] **Step 4: Correr tests y verificar que pasan**

Run: `node --test worker/test/collector.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/agents/collector.js worker/test/collector.test.js
git commit -m "F1: collector (multiget items+visitas → listings y snapshots)"
```

---

### Task 6: `competitors.js` — agregados de competencia

**Files:**
- Create: `worker/agents/competitors.js`
- Test: `worker/test/competitors.test.js`

**Interfaces:**
- Consumes: `competitorAggregates` (Task 3), `insertCompetitorSnapshot` (Task 2), `api.get` (Task 4), `cleanTitle` de `../publisher.js:20` (limpia títulos, ya existe).
- Produces (usada por Task 7): `competitorsForItems(ctx, rows)` → Promise<number> (snapshots insertados). `rows` = [{ item_id, title, category_id }].
  - Endpoint: `GET /sites/MLC/search?q=<query>&category=<cat>&limit=50` (1 request por ítem — el costo dominante del ciclo).
  - `buildQuery(title)` → string (exportada para test): título limpiado, máx. 6 palabras, URL-encoded.

- [ ] **Step 1: Escribir tests**

Crear `worker/test/competitors.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildQuery, competitorsForItems } from '../agents/competitors.js'

function fakeDb(log) {
  return { prepare: (sql) => ({ bind: (...args) => {
    log.push({ sql, args })
    return { run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }
  } }) }
}

test('buildQuery limpia, corta a 6 palabras y codifica', () => {
  const q = buildQuery('Hot Wheels Nissan Skyline GT-R R34 Rápido Y Furioso 2013 Plateado')
  assert.equal(decodeURIComponent(q).split(' ').length, 6)
  assert.ok(!q.includes(' '))
})

test('competitorsForItems inserta un snapshot con agregados', async () => {
  const log = []
  const api = { calls: 0, errors: 0, get: async (path) => {
    assert.match(path, /^\/sites\/MLC\/search\?q=/)
    return { results: [
      { id: 'A', price: 100, seller: { id: 1 }, sold_quantity: 3, title: 'a' },
      { id: 'B', price: 300, seller: { id: 2 }, sold_quantity: 9, title: 'b' },
    ] }
  } }
  const n = await competitorsForItems(
    { db: fakeDb(log), api, sellerId: '999', now: 'T', siteId: 'MLC' },
    [{ item_id: 'MLC1', title: 'Hot Wheels X', category_id: 'MLC3398' }])
  assert.equal(n, 1)
  const ins = log.find(l => /competitor_snapshots/i.test(l.sql))
  assert.ok(ins)
  assert.equal(ins.args[4], 2)   // sample_size
  assert.equal(ins.args[7], 200) // price_median
})

test('sin resultados no inserta y no lanza', async () => {
  const log = []
  const api = { get: async () => ({ results: [] }) }
  const n = await competitorsForItems({ db: fakeDb(log), api, sellerId: 's', now: 'T', siteId: 'MLC' },
    [{ item_id: 'MLC1', title: 'x', category_id: 'c' }])
  assert.equal(n, 0)
  assert.equal(log.length, 0)
})
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `node --test worker/test/competitors.test.js`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `worker/agents/competitors.js`**

```js
/**
 * [OPTIMIZER-F1] Competencia: búsqueda pública oficial por ítem →
 * agregados diarios en competitor_snapshots (spec §5). 1 request/ítem.
 */
import { competitorAggregates } from './normalizer.js'
import { insertCompetitorSnapshot } from './db.js'
import { cleanTitle } from '../publisher.js'

/** Título → query de búsqueda: limpio, máx. 6 palabras, URL-encoded. */
export function buildQuery(title) {
  const words = cleanTitle(title || '').split(/\s+/).filter(Boolean).slice(0, 6)
  return encodeURIComponent(words.join(' '))
}

/**
 * @param {{db:any, api:{get:Function}, sellerId:string, now:string, siteId:string}} ctx
 * @param {Array<{item_id:string, title:string, category_id:string}>} rows
 * @returns {Promise<number>} snapshots insertados
 */
export async function competitorsForItems(ctx, rows) {
  const { db, api, sellerId, now, siteId } = ctx
  let inserted = 0
  for (const row of rows) {
    let agg = null
    try {
      const q = buildQuery(row.title)
      const cat = row.category_id ? `&category=${row.category_id}` : ''
      const res = await api.get(`/sites/${siteId}/search?q=${q}${cat}&limit=50`)
      agg = competitorAggregates(res.results, sellerId)
    } catch { continue } // la búsqueda de un ítem no tumba el batch
    if (!agg) continue
    await insertCompetitorSnapshot(db, { item_id: row.item_id, snapshot_at: now,
      seller_id: sellerId, category_id: row.category_id, ...agg })
    inserted++
  }
  return inserted
}
```

- [ ] **Step 4: Correr tests y verificar que pasan**

Run: `node --test worker/test/competitors.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/agents/competitors.js worker/test/competitors.test.js
git commit -m "F1: competencia (búsqueda oficial → agregados diarios por ítem)"
```

---

### Task 7: `orchestrator.js` — Job→Batch→Item con cursor y presupuesto

**Files:**
- Create: `worker/agents/orchestrator.js`
- Test: `worker/test/orchestrator.test.js`

**Interfaces:**
- Consumes: todo lo anterior (`db.js`, `collectBatch`, `competitorsForItems`, `makeApi`), `getValidAccessToken(env)` de `../index.js:99`.
- Produces (usadas por Tasks 8-9):
  - `runCycle(env, { force = false })` → Promise<{status:'done'|'partial'|'skipped'|'error', ...}> — UNA invocación: abre/reanuda el job diario `collect`, procesa a lo más 1 batch dentro del presupuesto, actualiza métricas; al agotar batches finaliza el job, calcula coverage y devuelve `{status:'done', digest:true}`.
  - `inWindow(hourUtc, windowStr)` → boolean (exportada para test; `windowStr` tipo `"6-10"`, fin exclusivo).
  - `seedJob(env, db, sellerId)` — crea job + batches con TODOS los item_ids del seller (paginando `GET /users/{id}/items/search?limit=100&offset=`).

- [ ] **Step 1: Escribir tests de la lógica pura**

Crear `worker/test/orchestrator.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inWindow } from '../agents/orchestrator.js'

test('inWindow respeta la ventana UTC con fin exclusivo', () => {
  assert.equal(inWindow(6, '6-10'), true)
  assert.equal(inWindow(9, '6-10'), true)
  assert.equal(inWindow(10, '6-10'), false)
  assert.equal(inWindow(5, '6-10'), false)
})

test('inWindow tolera config corrupta (default: cerrada)', () => {
  assert.equal(inWindow(6, 'garbage'), false)
})
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `node --test worker/test/orchestrator.test.js`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `worker/agents/orchestrator.js`**

```js
/**
 * [OPTIMIZER-F1] Orquestador nocturno: Job→Batch→Item con cursor en D1 y
 * presupuesto de subrequests por invocación (spec §3). Cada invocación de
 * cron procesa 1 batch; el ciclo se completa a lo largo de la ventana.
 * F1: SOLO lectura hacia ML.
 */
import { getValidAccessToken } from '../index.js'
import { makeApi } from './mlapi.js'
import { collectBatch } from './collector.js'
import { competitorsForItems } from './competitors.js'
import {
  getFlag, setFlag, nowIso, today, logEvent, upsertMetric,
  openJob, getRunningJob, bumpJob, finishJob,
  createBatches, nextPendingBatch, markBatch,
} from './db.js'

/** ¿La hora UTC cae dentro de "H1-H2" (fin exclusivo)? */
export function inWindow(hourUtc, windowStr) {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(windowStr || '')
  if (!m) return false
  return hourUtc >= Number(m[1]) && hourUtc < Number(m[2])
}

/** Crea el job del día con todos los item_ids del seller (paginado). */
export async function seedJob(env, db, sellerId, api) {
  const ids = []
  for (let offset = 0; ; offset += 100) {
    const page = await api.get(`/users/${sellerId}/items/search?limit=100&offset=${offset}`)
    ids.push(...(page.results || []))
    if (ids.length >= (page.paging?.total ?? ids.length) || !(page.results || []).length) break
  }
  const jobId = await openJob(db, sellerId, 'collect')
  const batchSize = Number(await getFlag(db, 'BATCH_SIZE', '30'))
  await createBatches(db, jobId, ids, batchSize)
  await logEvent(db, sellerId, 'JOB_STARTED', String(jobId), { items: ids.length })
  return jobId
}

/**
 * Una invocación del ciclo. `force=true` (comando /agente sync) ignora la
 * ventana horaria; el cron no.
 */
export async function runCycle(env, { force = false } = {}) {
  const db = env.DB
  const sellerId = env.SELLER_ID
  const t0 = Date.now()
  if ((await getFlag(db, 'KILL_SWITCH', 'false')) === 'true') return { status: 'skipped', reason: 'kill_switch' }
  const window = await getFlag(db, 'CRON_WINDOW_UTC', '6-10')
  if (!force && !inWindow(new Date().getUTCHours(), window)) return { status: 'skipped', reason: 'window' }

  const token = await getValidAccessToken(env)
  const api = makeApi({ token })
  const budget = Number(await getFlag(db, 'SUBREQUEST_BUDGET', '45'))

  try {
    // ¿Ya corrió completo hoy? (un job 'collect' terminado con started_at de hoy)
    let job = await getRunningJob(db, sellerId, 'collect')
    if (!job) {
      const doneToday = await db.prepare(`SELECT id FROM jobs WHERE seller_id=? AND
        kind='collect' AND status='done' AND started_at>=? LIMIT 1`)
        .bind(sellerId, today() + 'T00:00:00Z').first()
      if (doneToday && !force) return { status: 'skipped', reason: 'already_done' }
      const jobId = await seedJob(env, db, sellerId, api)
      job = { id: jobId }
    }

    const batch = await nextPendingBatch(db, job.id)
    if (!batch) {
      // Ciclo completo: cerrar job + coverage + avisar (el digest lo manda Task 8/11).
      await finishJob(db, job.id, 'done')
      const cov = await coverage(db, sellerId)
      await upsertMetric(db, today(), sellerId, { coverage_pct: cov.pct, avg_analysis_age_h: cov.ageH })
      await logEvent(db, sellerId, 'JOB_DONE', String(job.id), cov)
      return { status: 'done', jobId: job.id, coverage: cov }
    }

    try {
      const now = nowIso()
      const { done } = await collectBatch({ db, api, sellerId, now }, batch.items)
      // Competencia con el presupuesto restante (1 request/ítem).
      const remaining = Math.max(0, budget - api.calls)
      const rows = (await db.prepare(
        `SELECT item_id,title,category_id FROM listings WHERE item_id IN
         (${batch.items.map(() => '?').join(',')})`).bind(...batch.items).all()).results
      await competitorsForItems({ db, api, sellerId, now, siteId: env.ML_SITE_ID || 'MLC' },
        rows.slice(0, remaining))
      await markBatch(db, job.id, batch.batch_no, 'ok')
      await bumpJob(db, job.id, { itemsDone: done, subrequests: api.calls })
      return { status: 'partial', jobId: job.id, batch: batch.batch_no, done }
    } catch (e) {
      await markBatch(db, job.id, batch.batch_no, 'failed', e.message)
      await logEvent(db, sellerId, 'BATCH_FAILED', `${job.id}:${batch.batch_no}`, { error: e.message })
      return { status: 'error', jobId: job.id, batch: batch.batch_no, error: e.message }
    }
  } finally {
    await upsertMetric(db, today(), sellerId, {
      api_calls: api.calls, api_errors: api.errors,
      subrequests: api.calls, cron_duration_ms: Date.now() - t0 })
  }
}

/** Coverage y edad media del análisis (KPIs del sistema, spec §7). */
export async function coverage(db, sellerId) {
  const row = await db.prepare(`SELECT COUNT(*) total,
    SUM(CASE WHEN last_synced >= datetime('now','-1 day') THEN 1 ELSE 0 END) fresh,
    AVG((julianday('now') - julianday(last_synced)) * 24) age
    FROM listings WHERE seller_id=? AND status != 'closed'`).bind(sellerId).first()
  return { pct: row.total ? Math.round(100 * row.fresh / row.total) : 0,
           ageH: row.age == null ? null : Math.round(row.age * 10) / 10, total: row.total }
}
```

- [ ] **Step 4: Correr TODOS los tests**

Run: `node --test worker/test/`
Expected: PASS (todos; los de tasks anteriores siguen verdes).

- [ ] **Step 5: Commit**

```bash
git add worker/agents/orchestrator.js worker/test/orchestrator.test.js
git commit -m "F1: orquestador Job→Batch→Item con ventana, presupuesto y coverage"
```

---

### Task 8: Health check F0 + siembra de config

**Files:**
- Create: `worker/agents/health.js`
- Test: `worker/test/health.test.js`

**Interfaces:**
- Consumes: `getValidAccessToken` (index.js), `makeApi` (Task 4), `getFlag/setFlag` (Task 2), `coverage` (Task 7).
- Produces (usada por Task 10): `runHealthCheck(env)` → Promise<{ok:boolean, checks:Array<{name:string, ok:boolean, detail:string}>}>; `formatHealth(report, cov, job)` → string HTML para Telegram (exportada para test).
  - Checks: `oauth` (token obtenido), `ml_user` (GET /users/me devuelve id === SELLER_ID), `d1` (SELECT 1), `config` (siembra defaults si faltan: BATCH_SIZE=30, SUBREQUEST_BUDGET=45, CRON_WINDOW_UTC=6-10, KILL_SWITCH=false, DRY_RUN=true).

- [ ] **Step 1: Escribir tests del formateo y la siembra**

Crear `worker/test/health.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatHealth, DEFAULT_CONFIG } from '../agents/health.js'

test('DEFAULT_CONFIG tiene las 5 claves del spec', () => {
  assert.deepEqual(Object.keys(DEFAULT_CONFIG).sort(),
    ['BATCH_SIZE','CRON_WINDOW_UTC','DRY_RUN','KILL_SWITCH','SUBREQUEST_BUDGET'])
})

test('formatHealth marca verde/rojo y muestra coverage', () => {
  const txt = formatHealth(
    { ok: false, checks: [{ name: 'oauth', ok: true, detail: 'token ok' },
                          { name: 'd1', ok: false, detail: 'timeout' }] },
    { pct: 96, ageH: 11.2, total: 160 }, null)
  assert.match(txt, /✅ oauth/)
  assert.match(txt, /❌ d1/)
  assert.match(txt, /96%/)
})
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `node --test worker/test/health.test.js`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `worker/agents/health.js`**

```js
/**
 * [OPTIMIZER-F0] Health check: credenciales, permisos, D1 y siembra de la
 * configuración (los límites de plataforma viven aquí como config, no en
 * código — spec §9). Salida humana para /estado.
 */
import { getValidAccessToken } from '../index.js'
import { makeApi } from './mlapi.js'
import { getFlag, setFlag } from './db.js'

export const DEFAULT_CONFIG = {
  BATCH_SIZE: '30', SUBREQUEST_BUDGET: '45', CRON_WINDOW_UTC: '6-10',
  KILL_SWITCH: 'false', DRY_RUN: 'true',
}

export async function runHealthCheck(env) {
  const checks = []
  const push = (name, ok, detail) => checks.push({ name, ok, detail })

  let token = null
  try { token = await getValidAccessToken(env); push('oauth', true, 'token vigente') }
  catch (e) { push('oauth', false, e.message) }

  if (token) {
    try {
      const me = await makeApi({ token }).get('/users/me')
      const ok = String(me.id) === String(env.SELLER_ID)
      push('ml_user', ok, ok ? `seller ${me.id} (${me.nickname})` : `seller inesperado ${me.id}`)
    } catch (e) { push('ml_user', false, e.message) }
  } else push('ml_user', false, 'sin token')

  try { await env.DB.prepare('SELECT 1').first(); push('d1', true, 'responde') }
  catch (e) { push('d1', false, e.message) }

  try {
    for (const [k, v] of Object.entries(DEFAULT_CONFIG))
      if ((await getFlag(env.DB, k)) == null) await setFlag(env.DB, k, v)
    push('config', true, 'sembrada/completa')
  } catch (e) { push('config', false, e.message) }

  return { ok: checks.every(c => c.ok), checks }
}

/** Reporte para Telegram (HTML). `cov`/`job` pueden ser null. */
export function formatHealth(report, cov, job) {
  const lines = [`🩺 <b>Estado MLPU-Optimizer</b> — ${report.ok ? 'OK' : 'CON FALLAS'}`]
  for (const c of report.checks) lines.push(`${c.ok ? '✅' : '❌'} ${c.name}: ${c.detail}`)
  if (cov) lines.push(`📊 Coverage: ${cov.pct}% de ${cov.total} ítems · edad media ${cov.ageH ?? '?'} h`)
  if (job) lines.push(`⚙️ Job #${job.id} ${job.status}: ${job.items_done}/${job.items_total}`)
  return lines.join('\n')
}
```

- [ ] **Step 4: Correr tests y verificar que pasan**

Run: `node --test worker/test/health.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/agents/health.js worker/test/health.test.js
git commit -m "F0: health check (oauth, usuario, D1, siembra de config)"
```

---

### Task 9: `kpi.js` — digest diario para Telegram

**Files:**
- Create: `worker/agents/kpi.js`
- Test: `worker/test/kpi.test.js`

**Interfaces:**
- Consumes: D1 (queries sobre `listing_snapshots`, `orders`, `system_metrics`).
- Produces (usada por Task 10): `buildDigest(db, sellerId)` → Promise<string> (HTML Telegram); `formatDigest(data)` → string (pura, exportada para test) con `data = { date, totals: {items, active}, visits: {yesterday, prev}, orders: {count, amount}, movers: [{item_id,title,delta}], coverage: {pct, ageH} }`.
  - Visitas del día = suma de deltas entre los 2 últimos snapshots por ítem (las visitas de ML son acumuladas).

- [ ] **Step 1: Escribir test del formateo**

Crear `worker/test/kpi.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatDigest } from '../agents/kpi.js'

test('formatDigest arma el digest con deltas y flechas', () => {
  const txt = formatDigest({ date: '2026-07-11',
    totals: { items: 160, active: 144 },
    visits: { yesterday: 320, prev: 280 },
    orders: { count: 2, amount: 45980 },
    movers: [{ item_id: 'MLC1', title: 'Hot Wheels X', delta: 25 }],
    coverage: { pct: 98, ageH: 9.1 } })
  assert.match(txt, /📈 <b>MLPU — 2026-07-11<\/b>/)
  assert.match(txt, /320/)          // visitas de ayer
  assert.match(txt, /\+14%/)        // (320-280)/280
  assert.match(txt, /2 órdenes/)
  assert.match(txt, /98%/)
})

test('formatDigest tolera baseline cero (sin división por cero)', () => {
  const txt = formatDigest({ date: 'D', totals: { items: 1, active: 1 },
    visits: { yesterday: 5, prev: 0 }, orders: { count: 0, amount: 0 },
    movers: [], coverage: { pct: 100, ageH: 1 } })
  assert.match(txt, /5/)
  assert.doesNotMatch(txt, /NaN|Infinity/)
})
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `node --test worker/test/kpi.test.js`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `worker/agents/kpi.js`**

```js
/**
 * [OPTIMIZER-F1] KPIs: digest diario por Telegram. Las visitas de ML son
 * ACUMULADAS: el día = delta entre los 2 últimos snapshots de cada ítem.
 */
import { today } from './db.js'
import { coverage } from './orchestrator.js'

/** Deltas de visitas por ítem entre los 2 últimos snapshots. */
const DELTAS_SQL = `
  WITH ranked AS (
    SELECT item_id, visits, snapshot_at,
           ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY snapshot_at DESC) rn
    FROM listing_snapshots WHERE seller_id=? AND visits IS NOT NULL
  )
  SELECT a.item_id, (a.visits - b.visits) delta
  FROM ranked a JOIN ranked b ON a.item_id=b.item_id AND a.rn=1 AND b.rn=2`

export async function buildDigest(db, sellerId) {
  const totals = await db.prepare(`SELECT COUNT(*) items,
    SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) active
    FROM listings WHERE seller_id=? AND status!='closed'`).bind(sellerId).first()
  const deltas = (await db.prepare(DELTAS_SQL).bind(sellerId).all()).results
  const yesterday = deltas.reduce((s, d) => s + Math.max(0, d.delta || 0), 0)
  // Baseline: media de visitas diarias de los 7 días previos (system_metrics no
  // guarda visitas; se aproxima con el histórico de snapshots del período).
  const prevRow = await db.prepare(`SELECT (MAX(visits)-MIN(visits))/6.0 avg7
    FROM listing_snapshots WHERE seller_id=? AND snapshot_at < datetime('now','-1 day')
    AND snapshot_at >= datetime('now','-8 day')`).bind(sellerId).first()
  const ord = await db.prepare(`SELECT COUNT(*) count, COALESCE(SUM(amount),0) amount
    FROM orders WHERE seller_id=? AND date >= datetime('now','-1 day')`).bind(sellerId).first()
  const movers = deltas.filter(d => (d.delta || 0) > 0)
    .sort((a, b) => b.delta - a.delta).slice(0, 3)
  for (const m of movers) {
    const r = await db.prepare('SELECT title FROM listings WHERE item_id=?').bind(m.item_id).first()
    m.title = r?.title || m.item_id
  }
  const cov = await coverage(db, sellerId)
  return formatDigest({ date: today(), totals,
    visits: { yesterday, prev: Math.round(prevRow?.avg7 || 0) },
    orders: ord, movers, coverage: cov })
}

export function formatDigest(d) {
  const pct = d.visits.prev > 0
    ? `${d.visits.yesterday >= d.visits.prev ? '+' : ''}${Math.round(100 * (d.visits.yesterday - d.visits.prev) / d.visits.prev)}%`
    : 's/base'
  const lines = [
    `📈 <b>MLPU — ${d.date}</b>`,
    `📦 ${d.totals.items} publicaciones (${d.totals.active} activas)`,
    `👁 Visitas ayer: ${d.visits.yesterday} (${pct} vs media 7d)`,
    `🛒 ${d.orders.count} órdenes · $${Math.round(d.orders.amount).toLocaleString('es-CL')}`,
  ]
  if (d.movers.length) lines.push('🔥 ' + d.movers.map(m =>
    `${(m.title || '').slice(0, 30)} (+${m.delta})`).join(' · '))
  lines.push(`🩺 Coverage ${d.coverage.pct}% · edad media ${d.coverage.ageH ?? '?'} h`)
  return lines.join('\n')
}
```

- [ ] **Step 4: Correr tests y verificar que pasan**

Run: `node --test worker/test/kpi.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/agents/kpi.js worker/test/kpi.test.js
git commit -m "F1: KPIs (digest diario con deltas de visitas, órdenes y coverage)"
```

---

### Task 10: Cableado — cron, comandos de Telegram y órdenes a D1

**Files:**
- Modify: `worker/index.js` (handler `scheduled` ~línea 395; `handleMlNotification` — buscar `async function handleMlNotification`)
- Modify: `worker/telegram-bot.js` (dispatch de comandos de texto — buscar el bloque donde se manejan comandos tipo `/start`)

**Interfaces:**
- Consumes: `runCycle` (Task 7), `runHealthCheck`/`formatHealth` (Task 8), `buildDigest` (Task 9), `insertOrderRow`/`logEvent`/`getRunningJob` (Task 2), `coverage` (Task 7), `tgSend` (telegram-bot.js:54).
- Produces: cron activo; comandos `/estado`, `/kpi`, `/agente sync`; toda orden nueva insertada en D1.

- [ ] **Step 1: Enrutar el cron en `worker/index.js`**

En el objeto exportado por default, reemplazar el handler `scheduled`:

```js
  // Cron: ciclo nocturno del optimizador (F1). runScheduled (post-venta)
  // sigue APAGADO — se reactiva por flag cuando el usuario lo pida.
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const { runCycle } = await import('./agents/orchestrator.js')
      const r = await runCycle(env)
      if (r.status === 'done') {
        const { buildDigest } = await import('./agents/kpi.js')
        const { tgSend } = await import('./telegram-bot.js')
        await tgSend(env, env.TELEGRAM_CHAT_ID, await buildDigest(env.DB, env.SELLER_ID))
      }
    })().catch(e => console.log('[OPTIMIZER] cron error:', e.message)))
  },
```

Nota: imports dinámicos para no crear ciclos de import estático
(orchestrator importa `getValidAccessToken` desde index.js).

- [ ] **Step 2: Insertar órdenes en D1 al recibir la notificación**

En `worker/index.js`, dentro de `handleMlNotification`, después del punto donde
la orden ya fue obtenida de ML y procesada hacia KV (buscar la llamada a
`recordOrderFromML`), añadir el espejo a D1 (best-effort):

```js
    // Espejo en D1 para el optimizador (F1). Nunca bloquea el flujo KV.
    if (env.DB) {
      try {
        const { insertOrderRow, logEvent } = await import('./agents/db.js')
        await insertOrderRow(env.DB, {
          order_id: String(order.id), seller_id: String(env.SELLER_ID),
          item_id: order.order_items?.[0]?.item?.id ?? null,
          qty: order.order_items?.[0]?.quantity ?? null,
          amount: order.total_amount ?? null,
          date: order.date_created ?? new Date().toISOString(),
          shipping_type: order.shipping?.id ? 'me2' : null,
        })
        await logEvent(env.DB, String(env.SELLER_ID), 'ORDER_RECEIVED', String(order.id),
          { amount: order.total_amount })
      } catch (e) { console.log('[OPTIMIZER] espejo orden D1 falló:', e.message) }
    }
```

- [ ] **Step 3: Comandos en `worker/telegram-bot.js`**

En el dispatch de comandos de texto (mismo bloque donde se resuelven los
comandos existentes), añadir ANTES del fallback:

```js
  // ── Comandos del optimizador (F0/F1) ─────────────────────────
  if (text === '/estado') {
    const { runHealthCheck, formatHealth } = await import('./agents/health.js')
    const { coverage } = await import('./agents/orchestrator.js')
    const { getRunningJob } = await import('./agents/db.js')
    const report = await runHealthCheck(env)
    const cov = await coverage(env.DB, env.SELLER_ID).catch(() => null)
    const job = await getRunningJob(env.DB, env.SELLER_ID, 'collect').catch(() => null)
    return tgSend(env, chatId, formatHealth(report, cov, job), { reply_markup: MAIN_KB })
  }
  if (text === '/kpi') {
    const { buildDigest } = await import('./agents/kpi.js')
    return tgSend(env, chatId, await buildDigest(env.DB, env.SELLER_ID), { reply_markup: MAIN_KB })
  }
  if (text === '/agente sync') {
    const { runCycle } = await import('./agents/orchestrator.js')
    const r = await runCycle(env, { force: true })
    return tgSend(env, chatId,
      `⚙️ sync: <b>${r.status}</b>${r.batch != null ? ` · batch ${r.batch}` : ''}` +
      `${r.error ? `\n❌ ${esc(r.error)}` : ''}${r.coverage ? `\n📊 coverage ${r.coverage.pct}%` : ''}` +
      `${r.reason ? ` (${r.reason})` : ''}`, { reply_markup: MAIN_KB })
  }
```

(Los comandos usan `esc` y `MAIN_KB` ya definidos en telegram-bot.js.
Ubicar el bloque donde el bot ya compara `text === '...'` para comandos.)

- [ ] **Step 4: Verificación estática y tests**

Run: `node --check worker/index.js && node --check worker/telegram-bot.js && node --test worker/test/`
Expected: sin errores de sintaxis, todos los tests PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/index.js worker/telegram-bot.js
git commit -m "F0/F1: cableado — cron nocturno, /estado /kpi /agente sync, órdenes a D1"
```

---

### Task 11: Deploy y verificación end-to-end (DoD F0 + arranque F1)

**Files:**
- Modify: ninguno (operación); actualizar `SAVE.txt` y `progress/` al cierre.

**Interfaces:**
- Consumes: todo lo anterior desplegado.
- Produces: F0 en DoD verde; primer ciclo F1 corrido de punta a punta.

- [ ] **Step 1: Deploy**

Run: `cd worker && npx wrangler deploy`
Expected: deploy OK con los bindings `DB`, `ML_TOKENS`, `ML_ORDERS` y el cron `*/15 6-9 * * *` listados.

- [ ] **Step 2: Health check (DoD F0: OAuth, credenciales, D1, config)**

Mandar `/estado` al bot por Telegram.
Expected: 4 checks en ✅ (oauth, ml_user con seller 283388639, d1, config sembrada).

- [ ] **Step 3: Primer sync completo (DoD F0: catálogo 100% en `listings`)**

Mandar `/agente sync` repetidamente (cada respuesta procesa 1 batch, ~6 para 160 ítems) hasta recibir `status: done` con coverage.
Verificar: `cd worker && npx wrangler d1 execute mlpu-db --remote --command "SELECT COUNT(*) FROM listings; SELECT COUNT(*) FROM listing_snapshots; SELECT COUNT(*) FROM competitor_snapshots; SELECT kind, COUNT(*) FROM events GROUP BY kind"`
Expected: listings = total del catálogo (~160); snapshots ≥ listings; events con JOB_STARTED/JOB_DONE. **Cero eventos de escritura hacia ML** (solo existen kinds de lectura — DoD F1).

- [ ] **Step 4: Verificar cron y digest (día siguiente)**

Tras la primera ventana nocturna: confirmar por Telegram la llegada del digest matinal y `npx wrangler d1 execute mlpu-db --remote --command "SELECT id,status,items_done,items_total,subrequests FROM jobs ORDER BY id DESC LIMIT 3"`
Expected: job del día en `done` sin intervención manual (DoD F0: cron operativo; DoD F1: recuperación automática se prueba sola si algún batch falla — queda `failed` con `retries<3` y el siguiente cron lo retoma).

- [ ] **Step 5: Registrar el cierre**

Actualizar `SAVE.txt` y `progress/` (checkpoint del proyecto) con: F0 DoD verde, F1 en observación 7-14 días (criterios del Apéndice C del spec antes de diseñar F2).

```bash
git add SAVE.txt progress/
git commit -m "F0 completo y F1 en observación: registro de cierre"
```

---

## Self-Review (ejecutada al escribir el plan)

- **Cobertura del spec (F0/F1):** D1+migraciones (T1), config/límites como flags (T1/T8), health check (T8), catálogo sync (T7/T11), cron (T1/T10), snapshots propios (T5), competencia agregada (T6), Job→Batch→Item con reintento (T2/T7), órdenes→D1 (T10), KPIs+digest (T9/T10), coverage/edad (T7), eventos/auditoría (T2/T7/T10), cero escrituras (T4 sin métodos de escritura + verificación T11). DoD F0 completo en T11. Fuera de alcance explícito: manual_override, opportunities/proposals (F2).
- **Placeholders:** ninguno; todo paso con código lo incluye.
- **Consistencia de tipos/nombres:** `runCycle(env,{force})`, `collectBatch(ctx,itemIds)`, `competitorsForItems(ctx,rows)`, `makeApi({token,fetcher})`, `coverage(db,sellerId)` usados de forma idéntica en tasks consumidoras (T7/T10/T11 revisadas contra T2-T9).
