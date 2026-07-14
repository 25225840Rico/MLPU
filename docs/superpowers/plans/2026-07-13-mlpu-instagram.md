# MLPU-Instagram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cada producto que el bot publica en MercadoLibre se encola y se publica automáticamente en Instagram (post de feed + historia) en la mejor hora del día según insights de la cuenta, con fallback configurable.

**Architecture:** Se extiende el Worker de Cloudflare existente (`worker/`, nombre `mlpu-proxy`). Nueva base D1 `mlpu-db` con tablas `ig_queue` (cola) e `ig_config` (ventanas, token de Meta, estado). Dos crons: cada 30 min corre el publicador (solo actúa dentro de una ventana óptima), y uno diario recalcula ventanas desde insights y renueva el token. Los módulos nuevos separan lógica pura (testeable) de llamadas a la Graph API.

**Tech Stack:** Cloudflare Workers (JS ESM, sin TypeScript), D1 (SQLite), Instagram Graph API v21.0, Telegram Bot API (ya integrado), `node --test` como runner (cero dependencias nuevas).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-13-mlpu-instagram-design.md`.
- Zona horaria de negocio: `America/Santiago`. Fallback de ventanas: `12:30` y `20:00`.
- Ventana = bloque de 60 min desde la hora elegida. Máximo **3 productos por ventana** (una sola corrida por ventana, ver `ultima_corrida`).
- Máximo **3 intentos** por producto; al 3er fallo → estado `error` + aviso Telegram.
- El post-venta (`runScheduled` de `scheduler.js`) sigue **APAGADO**: el nuevo `scheduled()` NO debe invocarlo.
- Caption: `🔧 {título}\n💰 ${precio CLP con puntos}\n👉 {permalink de ML}` + hashtags fijos. (El link pasará a la tienda propia cuando exista; hoy es el permalink de ML.)
- Estados de `ig_queue.estado`: `pendiente | publicado | error | cancelado`.
- Código y comentarios en español, siguiendo el estilo del worker existente (JS plano, sin clases, `log`/`logErr`).
- Commits frecuentes, mensajes `feat:`/`test:`/`chore:` como el historial del repo.

## Estructura de archivos

- Create: `worker/schema-ig.sql` — DDL de `ig_queue` + `ig_config`.
- Create: `worker/ig-logic.js` — lógica pura: caption, formato CLP, elección de ventanas, isInWindow.
- Create: `worker/ig-api.js` — cliente Graph API: publicar imagen (feed/story), insights, token (leer/renovar desde D1).
- Create: `worker/ig-queue.js` — cola D1: encolar, listar, `runIgPublisher`, `runIgDaily`, con dependencias inyectables.
- Create: `worker/test/ig-logic.test.js`, `worker/test/ig-api.test.js`, `worker/test/ig-queue.test.js`, `worker/test/fake-db.js`.
- Modify: `worker/telegram-bot.js` — encolar tras publicar (en `runCatalogPublish`, ~línea 1375) + comandos `/ig`.
- Modify: `worker/index.js` — `scheduled()` rutea por `event.cron` (~línea 395).
- Modify: `worker/wrangler.toml` — binding D1, var `IG_USER_ID`, crons.
- Modify: `package.json` — script `"test"`.

---

### Task 1: Runner de tests + esquema D1

**Files:**
- Modify: `package.json`
- Create: `worker/schema-ig.sql`
- Create: `worker/test/smoke.test.js`
- Modify: `worker/wrangler.toml`

**Interfaces:**
- Produces: base D1 `mlpu-db` con binding `env.DB`; tablas `ig_queue` e `ig_config`; comando `npm test` que corre `node --test worker/test/`.

- [ ] **Step 1: Script de test + smoke test que falla**

En `package.json`, dentro de `"scripts"`, agregar:

```json
"test": "node --test worker/test/"
```

Crear `worker/test/smoke.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('schema-ig.sql define ig_queue e ig_config', () => {
  const sql = readFileSync(new URL('../schema-ig.sql', import.meta.url), 'utf8')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ig_queue/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ig_config/)
})
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npm test`
Expected: FAIL (`ENOENT ... schema-ig.sql`)

- [ ] **Step 3: Crear el esquema**

`worker/schema-ig.sql`:

```sql
-- Cola de publicaciones a Instagram (spec 2026-07-13-mlpu-instagram-design.md)
CREATE TABLE IF NOT EXISTS ig_queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ml_item_id   TEXT NOT NULL UNIQUE,
  titulo       TEXT NOT NULL,
  precio       INTEGER NOT NULL,
  permalink_ml TEXT,
  estado       TEXT NOT NULL DEFAULT 'pendiente', -- pendiente|publicado|error|cancelado
  intentos     INTEGER NOT NULL DEFAULT 0,
  ultimo_error TEXT,
  ig_media_id  TEXT,
  ig_story_id  TEXT,
  creado_en    TEXT NOT NULL DEFAULT (datetime('now')),
  publicado_en TEXT
);

-- Config clave/valor (JSON en valor): ventanas, ventanas_manual, meta_token, ultima_corrida
CREATE TABLE IF NOT EXISTS ig_config (
  clave          TEXT PRIMARY KEY,
  valor          TEXT NOT NULL,
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `npm test`
Expected: PASS (1 test)

- [ ] **Step 5: Crear la D1 y el binding**

```bash
cd worker && npx wrangler d1 create mlpu-db
```

Copiar el `database_id` devuelto y agregar a `worker/wrangler.toml` (después de los kv_namespaces):

```toml
# D1: cola y config de Instagram (MLPU-Instagram).
[[d1_databases]]
binding = "DB"
database_name = "mlpu-db"
database_id = "<id devuelto por wrangler d1 create>"
```

Aplicar el esquema (local y remoto):

```bash
npx wrangler d1 execute mlpu-db --file=schema-ig.sql
npx wrangler d1 execute mlpu-db --remote --file=schema-ig.sql
```

Verificar: `npx wrangler d1 execute mlpu-db --remote --command "SELECT name FROM sqlite_master WHERE type='table'"`
Expected: `ig_queue`, `ig_config` en la lista.

- [ ] **Step 6: Commit**

```bash
git add package.json worker/schema-ig.sql worker/test/smoke.test.js worker/wrangler.toml
git commit -m "feat(ig): esquema D1 mlpu-db + runner de tests node --test"
```

---

### Task 2: Lógica pura (`worker/ig-logic.js`)

**Files:**
- Create: `worker/ig-logic.js`
- Test: `worker/test/ig-logic.test.js`

**Interfaces:**
- Produces:
  - `fmtCLP(n: number): string` — `12990 → '$12.990'`
  - `buildCaption({ titulo, precio, link }): string`
  - `HASHTAGS: string` — línea fija de hashtags
  - `FALLBACK_WINDOWS: string[]` — `['12:30', '20:00']`
  - `pickBestWindows(hourly: Record<string, number>, count = 2, minSepHours = 2): string[]` — devuelve `['HH:00', ...]` orden ascendente
  - `isInWindow(date: Date, windows: string[], tz = 'America/Santiago'): boolean`
  - `windowKey(date: Date, windows: string[], tz = 'America/Santiago'): string|null` — `'2026-07-13T20:00'` si estamos dentro de una ventana, si no `null`

- [ ] **Step 1: Tests que fallan**

`worker/test/ig-logic.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { fmtCLP, buildCaption, pickBestWindows, isInWindow, windowKey, FALLBACK_WINDOWS } from '../ig-logic.js'

test('fmtCLP separa miles con punto', () => {
  assert.equal(fmtCLP(12990), '$12.990')
  assert.equal(fmtCLP(990), '$990')
  assert.equal(fmtCLP(1250000), '$1.250.000')
})

test('buildCaption arma título, precio, link y hashtags', () => {
  const c = buildCaption({ titulo: 'Foco Hyundai Accent', precio: 19990, link: 'https://articulo.mercadolibre.cl/MLC-123' })
  assert.match(c, /^🔧 Foco Hyundai Accent\n💰 \$19\.990\n👉 https:\/\/articulo\.mercadolibre\.cl\/MLC-123\n\n#/)
})

test('pickBestWindows elige las 2 mejores horas con separación mínima', () => {
  const hourly = Object.fromEntries(Array.from({ length: 24 }, (_, h) => [String(h), 0]))
  hourly['20'] = 100; hourly['21'] = 95; hourly['13'] = 80
  // 21 se descarta por estar a <2h de 20 → gana 13
  assert.deepEqual(pickBestWindows(hourly), ['13:00', '20:00'])
})

test('pickBestWindows con datos vacíos devuelve fallback', () => {
  assert.deepEqual(pickBestWindows({}), FALLBACK_WINDOWS)
  assert.deepEqual(pickBestWindows(null), FALLBACK_WINDOWS)
})

test('isInWindow respeta la zona America/Santiago y el bloque de 60 min', () => {
  // 2026-07-13 es invierno en Chile: UTC-4. 16:30 UTC = 12:30 Chile.
  assert.equal(isInWindow(new Date('2026-07-13T16:30:00Z'), ['12:30', '20:00']), true)
  assert.equal(isInWindow(new Date('2026-07-13T17:29:00Z'), ['12:30', '20:00']), true)  // 13:29 Chile
  assert.equal(isInWindow(new Date('2026-07-13T17:30:00Z'), ['12:30', '20:00']), false) // 13:30 Chile
  assert.equal(isInWindow(new Date('2026-07-14T00:15:00Z'), ['12:30', '20:00']), true)  // 20:15 Chile
})

test('windowKey identifica la ventana activa con fecha local', () => {
  assert.equal(windowKey(new Date('2026-07-14T00:15:00Z'), ['12:30', '20:00']), '2026-07-13T20:00')
  assert.equal(windowKey(new Date('2026-07-13T10:00:00Z'), ['12:30', '20:00']), null)
})
```

- [ ] **Step 2: Correr y verificar que fallan**

Run: `npm test`
Expected: FAIL (`Cannot find module ... ig-logic.js`)

- [ ] **Step 3: Implementar `worker/ig-logic.js`**

```js
/**
 * [IG] Lógica pura de MLPU-Instagram: caption, ventanas horarias y formato.
 * Sin fetch ni D1 acá — todo testeable con node --test.
 */

export const FALLBACK_WINDOWS = ['12:30', '20:00']
export const HASHTAGS = '#repuestos #autos #desarme #repuestosusados #chile'

export function fmtCLP(n) {
  return '$' + Math.round(Number(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

export function buildCaption({ titulo, precio, link }) {
  return `🔧 ${titulo}\n💰 ${fmtCLP(precio)}\n👉 ${link}\n\n${HASHTAGS}`
}

// hourly: { '0': n, ..., '23': n } (seguidores conectados por hora, de insights).
// Elige `count` horas pico con separación mínima para no publicar dos veces seguidas.
export function pickBestWindows(hourly, count = 2, minSepHours = 2) {
  const entries = Object.entries(hourly || {})
    .map(([h, v]) => [Number(h), Number(v) || 0])
    .filter(([h]) => Number.isInteger(h) && h >= 0 && h <= 23)
  if (!entries.some(([, v]) => v > 0)) return FALLBACK_WINDOWS
  entries.sort((a, b) => b[1] - a[1])
  const picked = []
  for (const [h] of entries) {
    const sep = x => Math.min(Math.abs(h - x), 24 - Math.abs(h - x))
    if (picked.every(p => sep(p) >= minSepHours)) picked.push(h)
    if (picked.length === count) break
  }
  return picked.sort((a, b) => a - b).map(h => `${String(h).padStart(2, '0')}:00`)
}

// Fecha y hora locales en la zona dada → { fecha: 'YYYY-MM-DD', minutos: 0..1439 }
function localParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const get = t => parts.find(p => p.type === t).value
  return {
    fecha: `${get('year')}-${get('month')}-${get('day')}`,
    minutos: Number(get('hour')) * 60 + Number(get('minute')),
  }
}

function activeWindow(date, windows, tz) {
  const { minutos } = localParts(date, tz)
  return (windows || []).find(w => {
    const [h, m] = w.split(':').map(Number)
    const start = h * 60 + m
    return minutos >= start && minutos < start + 60
  }) || null
}

export function isInWindow(date, windows, tz = 'America/Santiago') {
  return activeWindow(date, windows, tz) !== null
}

// Clave única de la ventana activa (para correr UNA vez por ventana): 'YYYY-MM-DDTHH:MM'.
export function windowKey(date, windows, tz = 'America/Santiago') {
  const w = activeWindow(date, windows, tz)
  return w ? `${localParts(date, tz).fecha}T${w}` : null
}
```

- [ ] **Step 4: Correr y verificar que pasan**

Run: `npm test`
Expected: PASS (todos)

- [ ] **Step 5: Commit**

```bash
git add worker/ig-logic.js worker/test/ig-logic.test.js
git commit -m "feat(ig): lógica pura de caption y ventanas horarias"
```

---

### Task 3: Cliente Graph API (`worker/ig-api.js`)

**Files:**
- Create: `worker/ig-api.js`
- Test: `worker/test/ig-api.test.js`

**Interfaces:**
- Consumes: `env.DB` (D1, tabla `ig_config`), `env.IG_USER_ID`, `env.META_APP_ID`, `env.META_APP_SECRET`.
- Produces:
  - `getMetaToken(db): Promise<string>` — lee `ig_config.meta_token` (JSON `{ token, obtenido_en }`); lanza `Error('sin token de Meta')` si falta.
  - `igPublishImage(env, { imageUrl, caption, story = false }): Promise<string>` — crea contenedor + publica; devuelve el media id.
  - `fetchOnlineFollowers(env): Promise<Record<string, number>|null>` — mapa hora→conectados (suma de últimos días) o `null` si la métrica no está disponible.
  - `maybeRefreshMetaToken(env): Promise<boolean>` — si el token tiene >45 días lo renueva (fb_exchange_token) y lo guarda; `true` si renovó.
  - Los tests stubean `globalThis.fetch`.

- [ ] **Step 1: Tests que fallan**

`worker/test/ig-api.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { getMetaToken, igPublishImage, fetchOnlineFollowers, maybeRefreshMetaToken } from '../ig-api.js'
import { FakeDB } from './fake-db.js'

const envBase = () => ({ IG_USER_ID: '17841400000000000', META_APP_ID: 'app1', META_APP_SECRET: 'sec1', DB: new FakeDB() })

function stubFetch(handler) {
  const calls = []
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts })
    return handler(String(url), opts)
  }
  return calls
}
const okJson = data => ({ ok: true, json: async () => data })

test('getMetaToken lanza si no hay token', async () => {
  await assert.rejects(() => getMetaToken(new FakeDB()), /sin token de Meta/)
})

test('igPublishImage feed: media + media_publish', async () => {
  const env = envBase()
  await env.DB.seedConfig('meta_token', JSON.stringify({ token: 'TOK', obtenido_en: new Date().toISOString() }))
  const calls = stubFetch(url =>
    url.includes('/media_publish') ? okJson({ id: 'MEDIA9' }) : okJson({ id: 'CONT1' }))
  const id = await igPublishImage(env, { imageUrl: 'https://http2.mlstatic.com/x.jpg', caption: 'hola' })
  assert.equal(id, 'MEDIA9')
  assert.equal(calls.length, 2)
  assert.match(calls[0].url, /\/17841400000000000\/media$/)
  assert.match(String(calls[0].opts.body), /caption=hola/)
  assert.ok(!String(calls[0].opts.body).includes('media_type'))
})

test('igPublishImage story manda media_type=STORIES y sin caption', async () => {
  const env = envBase()
  await env.DB.seedConfig('meta_token', JSON.stringify({ token: 'TOK', obtenido_en: new Date().toISOString() }))
  const calls = stubFetch(url =>
    url.includes('/media_publish') ? okJson({ id: 'ST1' }) : okJson({ id: 'CONT2' }))
  const id = await igPublishImage(env, { imageUrl: 'https://x/y.jpg', story: true })
  assert.equal(id, 'ST1')
  assert.match(String(calls[0].opts.body), /media_type=STORIES/)
  assert.ok(!String(calls[0].opts.body).includes('caption='))
})

test('igPublishImage propaga el error de la Graph API', async () => {
  const env = envBase()
  await env.DB.seedConfig('meta_token', JSON.stringify({ token: 'TOK', obtenido_en: new Date().toISOString() }))
  stubFetch(() => ({ ok: false, json: async () => ({ error: { message: 'token expirado' } }) }))
  await assert.rejects(() => igPublishImage(env, { imageUrl: 'https://x/y.jpg', caption: 'c' }), /token expirado/)
})

test('fetchOnlineFollowers suma por hora y devuelve null si no hay métrica', async () => {
  const env = envBase()
  await env.DB.seedConfig('meta_token', JSON.stringify({ token: 'TOK', obtenido_en: new Date().toISOString() }))
  stubFetch(() => okJson({ data: [{ name: 'online_followers', values: [
    { value: { 12: 10, 20: 50 } }, { value: { 12: 5, 20: 30 } },
  ] }] }))
  assert.deepEqual(await fetchOnlineFollowers(env), { 12: 15, 20: 80 })
  stubFetch(() => okJson({ data: [] }))
  assert.equal(await fetchOnlineFollowers(env), null)
})

test('maybeRefreshMetaToken renueva solo si tiene más de 45 días', async () => {
  const env = envBase()
  const viejo = new Date(Date.now() - 50 * 24 * 3600 * 1000).toISOString()
  await env.DB.seedConfig('meta_token', JSON.stringify({ token: 'OLD', obtenido_en: viejo }))
  stubFetch(() => okJson({ access_token: 'NEW' }))
  assert.equal(await maybeRefreshMetaToken(env), true)
  assert.equal(JSON.parse(await env.DB.getConfig('meta_token')).token, 'NEW')
  // recién renovado → no vuelve a renovar
  assert.equal(await maybeRefreshMetaToken(env), false)
})
```

`worker/test/fake-db.js` — stub mínimo de D1 (solo lo que usan los módulos IG):

```js
// FakeDB: imita el subset de la API de D1 que usan ig-api.js e ig-queue.js.
// Soporta las queries por texto (match por fragmento), suficiente para unit tests.
export class FakeDB {
  constructor() { this.config = new Map(); this.queue = []; this.nextId = 1 }

  async seedConfig(clave, valor) { this.config.set(clave, valor) }
  async getConfig(clave) { return this.config.get(clave) }
  seedQueue(row) {
    const r = { id: this.nextId++, estado: 'pendiente', intentos: 0, ultimo_error: null,
      ig_media_id: null, ig_story_id: null, publicado_en: null, ...row }
    this.queue.push(r); return r
  }

  prepare(sql) {
    const db = this
    return { bind(...args) { return makeStmt(db, sql, args) }, ...makeStmt(db, sql, []) }
  }
}

function makeStmt(db, sql, args) {
  const run = async () => {
    if (sql.includes('INSERT OR IGNORE INTO ig_queue')) {
      const [ml_item_id, titulo, precio, permalink_ml] = args
      if (!db.queue.some(r => r.ml_item_id === ml_item_id))
        db.seedQueue({ ml_item_id, titulo, precio, permalink_ml, creado_en: new Date().toISOString() })
    } else if (sql.includes('INSERT INTO ig_config') || sql.includes('REPLACE INTO ig_config')) {
      db.config.set(args[0], args[1])
    } else if (sql.includes('UPDATE ig_queue')) {
      const id = args[args.length - 1]
      const row = db.queue.find(r => r.id === id)
      if (row) {
        if (sql.includes("estado='publicado'")) Object.assign(row, { estado: 'publicado', ig_media_id: args[0], ig_story_id: args[1], publicado_en: new Date().toISOString() })
        else if (sql.includes("estado='cancelado'")) row.estado = 'cancelado'
        else if (sql.includes('intentos=intentos+1')) { row.intentos++; row.ultimo_error = args[0]; if (row.intentos >= 3) row.estado = 'error' }
        else if (sql.includes("estado='cancelado' WHERE")) row.estado = 'cancelado'
      }
    }
    return { success: true }
  }
  const all = async () => {
    if (sql.includes('FROM ig_queue')) {
      let rows = db.queue.filter(r => r.estado === 'pendiente')
      const m = sql.match(/LIMIT (\d+)/)
      if (m) rows = rows.slice(0, Number(m[1]))
      return { results: rows }
    }
    return { results: [] }
  }
  const first = async () => {
    if (sql.includes('FROM ig_config')) {
      const v = db.config.get(args[0])
      return v === undefined ? null : { valor: v }
    }
    return null
  }
  return { run, all, first, bind(...a) { return makeStmt(db, sql, a) } }
}
```

- [ ] **Step 2: Correr y verificar que fallan**

Run: `npm test`
Expected: FAIL (`Cannot find module ... ig-api.js`)

- [ ] **Step 3: Implementar `worker/ig-api.js`**

```js
/**
 * [IG] Cliente de la Instagram Graph API (Meta).
 * El token de larga duración vive en D1 (ig_config.meta_token) porque el
 * Worker no puede escribir secrets; se renueva vía fb_exchange_token.
 */

const GRAPH = 'https://graph.facebook.com/v21.0'
const REFRESH_AFTER_MS = 45 * 24 * 3600 * 1000 // renovar a los 45 días (expira a los 60)
const log = (...a) => console.log('[IG]', ...a)

export async function getMetaToken(db) {
  const row = await db.prepare('SELECT valor FROM ig_config WHERE clave=?').bind('meta_token').first()
  if (!row) throw new Error('sin token de Meta (seed ig_config.meta_token)')
  return JSON.parse(row.valor).token
}

async function saveMetaToken(db, token) {
  await db.prepare('REPLACE INTO ig_config (clave, valor) VALUES (?, ?)')
    .bind('meta_token', JSON.stringify({ token, obtenido_en: new Date().toISOString() })).run()
}

async function graphPost(path, params) {
  const r = await fetch(`${GRAPH}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  })
  const data = await r.json()
  if (!r.ok || data.error) throw new Error(data.error?.message || `Graph API ${r.status}`)
  return data
}

// Publica una imagen como post de feed (con caption) o como historia (story: true).
// Dos pasos de la API: crear contenedor → media_publish. Devuelve el media id.
export async function igPublishImage(env, { imageUrl, caption, story = false }) {
  const token = await getMetaToken(env.DB)
  const cont = await graphPost(`${env.IG_USER_ID}/media`, {
    image_url: imageUrl,
    ...(story ? { media_type: 'STORIES' } : { caption }),
    access_token: token,
  })
  const pub = await graphPost(`${env.IG_USER_ID}/media_publish`, { creation_id: cont.id, access_token: token })
  return pub.id
}

// Seguidores conectados por hora (metric online_followers). La API entrega un
// valor por día; se suman los días devueltos. null si la cuenta aún no da datos.
export async function fetchOnlineFollowers(env) {
  const token = await getMetaToken(env.DB)
  const url = `${GRAPH}/${env.IG_USER_ID}/insights?metric=online_followers&period=lifetime&access_token=${encodeURIComponent(token)}`
  const r = await fetch(url)
  const data = await r.json()
  if (!r.ok || data.error) throw new Error(data.error?.message || `insights ${r.status}`)
  const values = data.data?.[0]?.values
  if (!values?.length) return null
  const hourly = {}
  for (const v of values) for (const [h, n] of Object.entries(v.value || {}))
    hourly[h] = (hourly[h] || 0) + (Number(n) || 0)
  return Object.keys(hourly).length ? hourly : null
}

// Renueva el token de larga duración si tiene más de 45 días. true si renovó.
export async function maybeRefreshMetaToken(env) {
  const row = await env.DB.prepare('SELECT valor FROM ig_config WHERE clave=?').bind('meta_token').first()
  if (!row) throw new Error('sin token de Meta (seed ig_config.meta_token)')
  const { token, obtenido_en } = JSON.parse(row.valor)
  if (Date.now() - Date.parse(obtenido_en) < REFRESH_AFTER_MS) return false
  const url = `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token` +
    `&client_id=${encodeURIComponent(env.META_APP_ID)}&client_secret=${encodeURIComponent(env.META_APP_SECRET)}` +
    `&fb_exchange_token=${encodeURIComponent(token)}`
  const r = await fetch(url)
  const data = await r.json()
  if (!r.ok || data.error || !data.access_token) throw new Error(data.error?.message || 'no se pudo renovar el token')
  await saveMetaToken(env.DB, data.access_token)
  log('token de Meta renovado')
  return true
}
```

- [ ] **Step 4: Correr y verificar que pasan**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/ig-api.js worker/test/ig-api.test.js worker/test/fake-db.js
git commit -m "feat(ig): cliente Graph API (publicar, insights, renovación de token)"
```

---

### Task 4: Cola y orquestación (`worker/ig-queue.js`)

**Files:**
- Create: `worker/ig-queue.js`
- Test: `worker/test/ig-queue.test.js`

**Interfaces:**
- Consumes: `ig-logic.js` (todo), `ig-api.js` (`igPublishImage`, `fetchOnlineFollowers`, `maybeRefreshMetaToken`), `env.DB`.
- Produces:
  - `enqueueIg(env, { mlItemId, titulo, precio, permalink }): Promise<void>` — INSERT OR IGNORE.
  - `listPendientes(env): Promise<Array<row>>`
  - `quitarDeCola(env, id): Promise<boolean>` — marca `cancelado`.
  - `getVentanas(env): Promise<{ horas: string[], origen: string }>` — prioridad `ventanas_manual` > `ventanas` (insights) > fallback.
  - `runIgPublisher(env, { force = false, now = new Date(), notify = async () => {}, deps } = {}): Promise<{ publicados: number }>`
  - `runIgDaily(env, notify): Promise<void>`
  - `enqueueStock(env, deps = {}): Promise<{ total: number, encolados: number }>` — carga inicial: pagina `users/{SELLER_ID}/items/search?status=active`, multiget `items?ids=...` (de a 20) y hace INSERT OR IGNORE de cada activo; devuelve cuántos encoló de nuevo.
  - `deps` (para tests): `{ publishImage, getItem }`. `getItem(env, mlItemId)` por defecto usa `getValidAccessToken` (de `./index.js`) + `mlFetch` (de `./ml-fetch.js`) contra `https://api.mercadolibre.com/items/{id}` y devuelve el JSON del ítem. El import de `./index.js` es un ciclo aceptado: `scheduler.js` ya usa el mismo patrón.

- [ ] **Step 1: Tests que fallan**

`worker/test/ig-queue.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { enqueueIg, listPendientes, getVentanas, runIgPublisher } from '../ig-queue.js'
import { FakeDB } from './fake-db.js'

const mkEnv = () => ({ DB: new FakeDB(), IG_USER_ID: 'IGU', TELEGRAM_CHAT_ID: '1' })
const item = { mlItemId: 'MLC1', titulo: 'Foco Accent', precio: 19990, permalink: 'https://ml/MLC1' }
// deps de prueba: ítem activo en ML con foto, publicación IG que devuelve ids.
const okDeps = () => ({
  getItem: async () => ({ status: 'active', pictures: [{ secure_url: 'https://pic/1.jpg' }] }),
  publishImage: async (env, { story }) => (story ? 'ST1' : 'FEED1'),
})
// Lunes 2026-07-13 20:15 Chile (UTC-4) → dentro de la ventana fallback 20:00.
const enVentana = new Date('2026-07-14T00:15:00Z')

test('enqueueIg encola una vez (dedupe por ml_item_id)', async () => {
  const env = mkEnv()
  await enqueueIg(env, item)
  await enqueueIg(env, item)
  assert.equal((await listPendientes(env)).length, 1)
})

test('getVentanas prioriza manual > insights > fallback', async () => {
  const env = mkEnv()
  assert.deepEqual((await getVentanas(env)).horas, ['12:30', '20:00'])
  await env.DB.seedConfig('ventanas', JSON.stringify({ horas: ['13:00', '21:00'], origen: 'insights' }))
  assert.deepEqual((await getVentanas(env)).horas, ['13:00', '21:00'])
  await env.DB.seedConfig('ventanas_manual', JSON.stringify({ horas: ['09:00'] }))
  assert.deepEqual((await getVentanas(env)).horas, ['09:00'])
})

test('runIgPublisher fuera de ventana no publica; force sí', async () => {
  const env = mkEnv()
  await enqueueIg(env, item)
  const fuera = new Date('2026-07-13T10:00:00Z') // 06:00 Chile
  assert.equal((await runIgPublisher(env, { now: fuera, deps: okDeps() })).publicados, 0)
  assert.equal((await runIgPublisher(env, { now: fuera, force: true, deps: okDeps() })).publicados, 1)
})

test('runIgPublisher publica feed + historia y notifica', async () => {
  const env = mkEnv()
  await enqueueIg(env, item)
  const avisos = []
  const r = await runIgPublisher(env, { now: enVentana, deps: okDeps(), notify: async t => avisos.push(t) })
  assert.equal(r.publicados, 1)
  assert.equal((await listPendientes(env)).length, 0)
  assert.match(avisos.join(' '), /Subido a IG/)
})

test('runIgPublisher corre UNA vez por ventana', async () => {
  const env = mkEnv()
  await enqueueIg(env, item)
  await runIgPublisher(env, { now: enVentana, deps: okDeps() })
  await enqueueIg(env, { ...item, mlItemId: 'MLC2' })
  // misma ventana 30 min después → no publica el segundo
  const r = await runIgPublisher(env, { now: new Date('2026-07-14T00:45:00Z'), deps: okDeps() })
  assert.equal(r.publicados, 0)
})

test('ítem no activo en ML → cancelado sin publicar', async () => {
  const env = mkEnv()
  await enqueueIg(env, item)
  const deps = { ...okDeps(), getItem: async () => ({ status: 'paused', pictures: [] }) }
  const r = await runIgPublisher(env, { now: enVentana, deps })
  assert.equal(r.publicados, 0)
  assert.equal((await listPendientes(env)).length, 0)
})

test('fallo de IG suma intento; al 3ro pasa a error y avisa', async () => {
  const env = mkEnv()
  await enqueueIg(env, item)
  const avisos = []
  const deps = { ...okDeps(), publishImage: async () => { throw new Error('boom') } }
  for (const _ of [1, 2, 3])
    await runIgPublisher(env, { force: true, deps, notify: async t => avisos.push(t) })
  const row = env.DB.queue[0]
  assert.equal(row.intentos, 3)
  assert.equal(row.estado, 'error')
  assert.match(avisos.join(' '), /boom/)
})
```

- [ ] **Step 2: Correr y verificar que fallan**

Run: `npm test`
Expected: FAIL (`Cannot find module ... ig-queue.js`)

- [ ] **Step 3: Implementar `worker/ig-queue.js`**

```js
/**
 * [IG] Cola de publicaciones a Instagram y orquestación de los crons.
 * runIgPublisher: corre cada 30 min; solo actúa dentro de una ventana óptima,
 * una vez por ventana y con tope de 3 productos.
 * runIgDaily: recalcula ventanas desde insights y renueva el token de Meta.
 */
import { buildCaption, isInWindow, windowKey, pickBestWindows, FALLBACK_WINDOWS } from './ig-logic.js'
import { igPublishImage, fetchOnlineFollowers, maybeRefreshMetaToken } from './ig-api.js'
import { mlFetch } from './ml-fetch.js'
import { getValidAccessToken } from './index.js' // mismo patrón (ciclo tolerado) que scheduler.js

const MAX_POR_VENTANA = 3
const MAX_INTENTOS = 3
const log    = (...a) => console.log('[IG]', ...a)
const logErr = (...a) => console.error('[IG]', ...a)

async function getConfig(db, clave) {
  const row = await db.prepare('SELECT valor FROM ig_config WHERE clave=?').bind(clave).first()
  return row ? JSON.parse(row.valor) : null
}
const setConfig = (db, clave, obj) =>
  db.prepare('REPLACE INTO ig_config (clave, valor) VALUES (?, ?)').bind(clave, JSON.stringify(obj)).run()

export async function enqueueIg(env, { mlItemId, titulo, precio, permalink }) {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO ig_queue (ml_item_id, titulo, precio, permalink_ml) VALUES (?, ?, ?, ?)')
    .bind(mlItemId, titulo, Math.round(Number(precio)) || 0, permalink || null).run()
}

export async function listPendientes(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM ig_queue WHERE estado='pendiente' ORDER BY id LIMIT 50").all()
  return results || []
}

export async function quitarDeCola(env, id) {
  const r = await env.DB.prepare(
    "UPDATE ig_queue SET estado='cancelado' WHERE id=? AND estado='pendiente'").bind(Number(id)).run()
  return (r.meta?.changes ?? 1) > 0 // FakeDB no trae meta → asume ok
}

export async function getVentanas(env) {
  const manual = await getConfig(env.DB, 'ventanas_manual')
  if (manual?.horas?.length) return { horas: manual.horas, origen: 'manual' }
  const auto = await getConfig(env.DB, 'ventanas')
  if (auto?.horas?.length) return { horas: auto.horas, origen: auto.origen || 'insights' }
  return { horas: FALLBACK_WINDOWS, origen: 'fallback' }
}

async function getItemDefault(env, mlItemId) {
  const token = await getValidAccessToken(env)
  const r = await mlFetch(`https://api.mercadolibre.com/items/${mlItemId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return r.json()
}

export async function runIgPublisher(env, { force = false, now = new Date(), notify = async () => {}, deps = {} } = {}) {
  const publishImage = deps.publishImage || igPublishImage
  const getItem      = deps.getItem      || getItemDefault
  const { horas } = await getVentanas(env)

  if (!force) {
    const key = windowKey(now, horas)
    if (!key) return { publicados: 0 }
    const ultima = await getConfig(env.DB, 'ultima_corrida')
    if (ultima?.key === key) return { publicados: 0 } // ya corrió en esta ventana
    await setConfig(env.DB, 'ultima_corrida', { key })
  }

  const { results } = await env.DB.prepare(
    "SELECT * FROM ig_queue WHERE estado='pendiente' ORDER BY id LIMIT " + MAX_POR_VENTANA).all()
  let publicados = 0

  for (const row of results || []) {
    try {
      const item = await getItem(env, row.ml_item_id)
      if (item.status !== 'active') {
        await env.DB.prepare("UPDATE ig_queue SET estado='cancelado' WHERE id=?").bind(row.id).run()
        log(`${row.ml_item_id} ya no está activo (${item.status}) → cancelado`)
        continue
      }
      const foto = item.pictures?.[0]?.secure_url
      if (!foto) throw new Error('el ítem no tiene fotos en ML')
      const caption = buildCaption({ titulo: row.titulo, precio: row.precio, link: row.permalink_ml || `https://articulo.mercadolibre.cl/${row.ml_item_id}` })
      const feedId  = await publishImage(env, { imageUrl: foto, caption })
      const storyId = await publishImage(env, { imageUrl: foto, story: true })
      await env.DB.prepare(
        "UPDATE ig_queue SET estado='publicado', ig_media_id=?, ig_story_id=?, publicado_en=datetime('now') WHERE id=?")
        .bind(feedId, storyId, row.id).run()
      publicados++
      await notify(`📸 Subido a IG: ${row.titulo} (feed + historia)`)
    } catch (e) {
      logErr(row.ml_item_id, e.message)
      await env.DB.prepare(
        "UPDATE ig_queue SET intentos=intentos+1, ultimo_error=?, estado=CASE WHEN intentos+1>=" + MAX_INTENTOS +
        " THEN 'error' ELSE 'pendiente' END WHERE id=?").bind(e.message.slice(0, 300), row.id).run()
      const intentos = row.intentos + 1
      if (intentos >= MAX_INTENTOS) await notify(`❌ IG: "${row.titulo}" falló ${MAX_INTENTOS} veces y quedó en error: ${e.message}`)
    }
  }
  return { publicados }
}

// Carga inicial: encola todo el inventario activo de ML que no esté ya en la
// cola (o publicado). La cola lo gotea a MAX_POR_VENTANA por ventana.
export async function enqueueStock(env, deps = {}) {
  const getToken = deps.getToken || (() => getValidAccessToken(env))
  const doFetch  = deps.mlFetch  || mlFetch
  const token = await getToken()
  const auth = { headers: { Authorization: `Bearer ${token}` } }
  const ids = []
  for (let offset = 0; ; offset += 50) {
    const r = await doFetch(`https://api.mercadolibre.com/users/${env.SELLER_ID}/items/search?status=active&limit=50&offset=${offset}`, auth)
    const data = await r.json()
    ids.push(...(data.results || []))
    if (ids.length >= (data.paging?.total || 0) || !(data.results || []).length) break
  }
  let encolados = 0
  for (let i = 0; i < ids.length; i += 20) {
    const r = await doFetch(`https://api.mercadolibre.com/items?ids=${ids.slice(i, i + 20).join(',')}&attributes=id,title,price,permalink,status`, auth)
    const lote = await r.json()
    for (const it of Array.isArray(lote) ? lote : []) {
      const b = it.body
      if (b?.status !== 'active') continue
      const res = await env.DB.prepare(
        'INSERT OR IGNORE INTO ig_queue (ml_item_id, titulo, precio, permalink_ml) VALUES (?, ?, ?, ?)')
        .bind(b.id, b.title, Math.round(Number(b.price)) || 0, b.permalink || null).run()
      encolados += (res.meta?.changes ?? 1)
    }
  }
  return { total: ids.length, encolados }
}

export async function runIgDaily(env, notify = async () => {}) {
  try {
    const hourly = await fetchOnlineFollowers(env)
    const horas = hourly ? pickBestWindows(hourly) : FALLBACK_WINDOWS
    await setConfig(env.DB, 'ventanas', {
      horas, origen: hourly ? 'insights' : 'fallback', calculado_en: new Date().toISOString(),
    })
    log('ventanas del día:', horas.join(', '), hourly ? '(insights)' : '(fallback)')
  } catch (e) {
    logErr('insights:', e.message)
    await notify(`⚠️ IG: no pude calcular las ventanas de hoy (${e.message}); sigo con las últimas conocidas.`)
  }
  try {
    await maybeRefreshMetaToken(env)
  } catch (e) {
    logErr('token:', e.message)
    await notify(`⚠️ IG: falló la renovación del token de Meta: ${e.message}`)
  }
}
```

Nota para el implementador: el `FakeDB` de `worker/test/fake-db.js` (Task 3) matchea las queries por fragmento de texto; si al implementar cambia la redacción SQL, ajustar el FakeDB en el mismo commit para que los fragmentos coincidan (`INSERT OR IGNORE INTO ig_queue`, `REPLACE INTO ig_config`, `UPDATE ig_queue`, `FROM ig_queue`, `FROM ig_config`, `estado='publicado'`, `estado='cancelado'`, `intentos=intentos+1`, `LIMIT n`).

- [ ] **Step 4: Correr y verificar que pasan**

Run: `npm test`
Expected: PASS (todos los archivos)

- [ ] **Step 5: Commit**

```bash
git add worker/ig-queue.js worker/test/ig-queue.test.js worker/test/fake-db.js
git commit -m "feat(ig): cola D1 + publicador por ventanas + cron diario de insights"
```

---

### Task 5: Integración con el bot de Telegram

**Files:**
- Modify: `worker/telegram-bot.js` (encolar en `runCatalogPublish` ~línea 1375; comandos en el dispatcher de texto ~línea 255; ayuda en `sendStart`)

**Interfaces:**
- Consumes: `enqueueIg`, `listPendientes`, `quitarDeCola`, `getVentanas`, `runIgPublisher` de `./ig-queue.js`; `fmtCLP` de `./ig-logic.js`.
- Produces: comandos `/ig cola`, `/ig quitar <id>`, `/ig ahora`, `/ig horas [HH:MM HH:MM | auto]`.

Sin unit tests propios (es cableado sobre módulos ya testeados); la verificación es la prueba real de la Task 7.

- [ ] **Step 1: Imports**

Al inicio de `worker/telegram-bot.js`, junto a los imports existentes:

```js
import { enqueueIg, enqueueStock, listPendientes, quitarDeCola, getVentanas, runIgPublisher } from './ig-queue.js'
import { fmtCLP } from './ig-logic.js'
```

- [ ] **Step 2: Encolar tras publicar**

En `runCatalogPublish`, inmediatamente después de `await deleteLot(env, chatId, lotId)` y ANTES del `tgSend` de "🎉 ¡Publicado!":

```js
  // Encolar para Instagram (spec MLPU-Instagram): sale en la próxima ventana óptima.
  let igEncolado = false
  try {
    await enqueueIg(env, { mlItemId: item.id, titulo: d.title, precio: d.price, permalink: item.permalink })
    igEncolado = true
  } catch (e) { logErr('ig enqueue:', e.message) }
```

Y en el array del mensaje "🎉 ¡Publicado!" agregar la línea condicional:

```js
    igEncolado ? '📸 En cola para Instagram (sale en la próxima hora punta) · /ig cola' : null,
```

(y cerrar el array con `.filter(Boolean).join('\n')` como hace `sendOrderDetail`).

- [ ] **Step 3: Comandos /ig**

En el dispatcher de texto (junto a `/ordenes`, `/pendientes`, ~línea 270):

```js
  if (text === '/ig' || text.startsWith('/ig ')) return handleIgCommand(env, chatId, text.slice(3).trim())
```

Y la función (ubicarla cerca de `sendOrdersList`):

```js
// ── Instagram: cola y ventanas ─────────────────────────────────
async function handleIgCommand(env, chatId, args) {
  const notify = t => tgSend(env, chatId, t)
  const [sub, ...rest] = args.split(/\s+/).filter(Boolean)

  if (sub === 'cola' || !sub) {
    const rows = await listPendientes(env)
    if (!rows.length) return tgSend(env, chatId, '📭 La cola de Instagram está vacía.')
    const lines = rows.map((r, i) =>
      `${i + 1}. <code>${r.id}</code> ${esc(r.titulo)} — ${fmtCLP(r.precio)}${r.intentos ? ` (${r.intentos} intento/s fallido/s)` : ''}`)
    return tgSend(env, chatId, `📸 <b>Cola de Instagram (${rows.length})</b>\n\n${lines.join('\n')}\n\nQuitar: /ig quitar &lt;id&gt; · Publicar ya: /ig ahora`)
  }
  if (sub === 'stock') {
    await tgSend(env, chatId, '⏳ Revisando el inventario activo en ML…')
    const r = await enqueueStock(env)
    return tgSend(env, chatId, `📦 Inventario: ${r.total} activos en ML, <b>${r.encolados} encolados nuevos</b> para IG (a ~6/día en horas punta). Mirá /ig cola.`)
  }
  if (sub === 'quitar') {
    const ok = await quitarDeCola(env, rest[0])
    return tgSend(env, chatId, ok ? `🗑 Quitado de la cola (id ${esc(rest[0] || '')}).` : `No encontré el id ${esc(rest[0] || '¿?')} pendiente. Mirá /ig cola.`)
  }
  if (sub === 'ahora') {
    await tgSend(env, chatId, '⏳ Publicando la cola de Instagram ya…')
    const r = await runIgPublisher(env, { force: true, notify })
    return tgSend(env, chatId, r.publicados ? `✅ Publiqué ${r.publicados} producto(s) en IG.` : 'No había nada publicable en la cola.')
  }
  if (sub === 'horas') {
    if (rest[0] === 'auto') {
      await env.DB.prepare("DELETE FROM ig_config WHERE clave='ventanas_manual'").run()
      return tgSend(env, chatId, '🕐 Ventanas en modo automático (insights de IG, fallback 12:30/20:00).')
    }
    if (rest.length) {
      const horas = rest.filter(h => /^\d{1,2}:\d{2}$/.test(h))
      if (!horas.length) return tgSend(env, chatId, 'Formato: /ig horas 12:30 20:00 (o "/ig horas auto")')
      await env.DB.prepare('REPLACE INTO ig_config (clave, valor) VALUES (?, ?)')
        .bind('ventanas_manual', JSON.stringify({ horas })).run()
      return tgSend(env, chatId, `🕐 Ventanas manuales fijadas: ${horas.join(', ')} (hora de Chile). Volver a automático: /ig horas auto`)
    }
    const v = await getVentanas(env)
    return tgSend(env, chatId, `🕐 Ventanas vigentes: <b>${v.horas.join(', ')}</b> (origen: ${v.origen}).\nCambiar: /ig horas 12:30 20:00 · Automático: /ig horas auto`)
  }
  return tgSend(env, chatId, 'Comandos: /ig cola · /ig quitar <id> · /ig ahora · /ig horas')
}
```

- [ ] **Step 4: Ayuda**

En `sendStart` (texto de ayuda), agregar una línea: `📸 /ig — cola y horarios de Instagram`.

- [ ] **Step 5: Verificar que nada se rompió**

Run: `npm test` → PASS. Además `node --check worker/telegram-bot.js` → sin errores de sintaxis.

- [ ] **Step 6: Commit**

```bash
git add worker/telegram-bot.js
git commit -m "feat(ig): encolar al publicar + comandos /ig en el bot"
```

---

### Task 6: Crons y despliegue

**Files:**
- Modify: `worker/index.js` (`scheduled()`, ~línea 395)
- Modify: `worker/wrangler.toml` (crons + var `IG_USER_ID`)

**Interfaces:**
- Consumes: `runIgPublisher`, `runIgDaily` de `./ig-queue.js`; `tgSend` de `./telegram-bot.js`.

- [ ] **Step 1: Rutear `scheduled()` por cron**

En `worker/index.js`, agregar el import y reemplazar el handler:

```js
import { runIgPublisher, runIgDaily } from './ig-queue.js'
```

```js
  // Crons: '*/30 * * * *' publica la cola de IG dentro de ventanas óptimas;
  // '0 10 * * *' (06:00 Chile) recalcula ventanas y renueva token de Meta.
  // OJO: el post-venta (runScheduled) sigue APAGADO adrede — no agregarlo acá.
  async scheduled(event, env, ctx) {
    const notify = t => tgSend(env, env.TELEGRAM_CHAT_ID, t)
    if (event.cron === '0 10 * * *') ctx.waitUntil(runIgDaily(env, notify))
    else ctx.waitUntil(runIgPublisher(env, { notify }))
  },
```

(`tgSend` ya se importa en index.js; si no, agregar `import { tgSend } from './telegram-bot.js'`.)

- [ ] **Step 2: wrangler.toml**

Reemplazar el bloque de triggers (conservando el comentario histórico del post-venta):

```toml
# Crons de MLPU-Instagram. El scheduler post-venta sigue APAGADO
# (scheduled() ya no lo invoca; ver index.js).
[triggers]
crons = ["*/30 * * * *", "0 10 * * *"]
```

Y en `[vars]` agregar (el valor real lo entrega el usuario en la Task 7; dejarlo documentado):

```toml
IG_USER_ID = "PENDIENTE_TASK_7"
```

- [ ] **Step 3: Verificar y desplegar**

```bash
npm test                     # PASS
node --check worker/index.js # sin errores
cd worker && npx wrangler deploy
```

Expected: deploy OK con los 2 crons listados y binding DB.

- [ ] **Step 4: Commit**

```bash
git add worker/index.js worker/wrangler.toml
git commit -m "feat(ig): crons de publicador (30min) y diario (insights+token)"
```

---

### Task 7: Setup de Meta + verificación real (con el usuario)

**Files:** ninguno nuevo (config remota + SAVE.txt/progress al cierre).

Esta task es interactiva: requiere al usuario (la app de Meta ya está creada).

- [ ] **Step 1: Credenciales de la app**

Pedir al usuario, desde el panel de la app en developers.facebook.com: **App ID** y **App Secret** (Settings → Basic). Guardarlos:

```bash
cd worker
npx wrangler secret put META_APP_ID
npx wrangler secret put META_APP_SECRET
```

- [ ] **Step 2: IG User ID + token de larga duración**

Guiar al usuario en el Graph API Explorer (developers.facebook.com/tools/explorer):
1. Seleccionar la app; pedir permisos `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`; generar el User Token autorizando la página de Facebook vinculada.
2. `GET /me/accounts` → tomar el `id` de la página → `GET /{page-id}?fields=instagram_business_account` → ese `id` es el **IG_USER_ID**.
3. Canjear el token corto por uno de larga duración:
   `GET /oauth/access_token?grant_type=fb_exchange_token&client_id={APP_ID}&client_secret={APP_SECRET}&fb_exchange_token={token_corto}`

Configurar: `IG_USER_ID` real en `wrangler.toml` (reemplazar `PENDIENTE_TASK_7`), redeploy, y sembrar el token:

```bash
npx wrangler d1 execute mlpu-db --remote --command \
"REPLACE INTO ig_config (clave, valor) VALUES ('meta_token', '{\"token\":\"<TOKEN_LARGO>\",\"obtenido_en\":\"<ISO_AHORA>\"}')"
```

- [ ] **Step 3: Prueba real (verificación final del spec)**

1. Publicar un producto de prueba vía bot (flujo normal por lotes).
2. `/ig cola` → debe aparecer encolado, y el mensaje de publicación debe incluir "📸 En cola para Instagram".
3. `/ig ahora` → verificar EN LA CUENTA de Instagram: post en feed con caption `🔧 … 💰 … 👉 …` + historia con la misma foto; y el aviso "📸 Subido a IG" en Telegram.
4. `/ig horas` → muestra ventanas (fallback al inicio). Esperar la corrida diaria (o forzar con otro producto y ventana manual `/ig horas HH:MM` cercana) para verificar la publicación programada sin `force`.
5. Si IG rechaza alguna imagen por proporción, activar la contingencia del spec (padding WASM) como tarea nueva.

- [ ] **Step 4: Cierre**

Actualizar `SAVE.txt` y `progress/CHECKPOINT.md` (checkpoint de cierre) y commit final:

```bash
git add SAVE.txt progress/
git commit -m "chore: cierre MLPU-Instagram (deploy + verificación real)"
```
