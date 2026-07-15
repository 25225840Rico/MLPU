# IG: pausa/vaciado, imágenes sin recorte en máxima calidad, caption nuevo y /ig promo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Comandos para pausar/vaciar la cola de IG, publicar fotos completas (padding blanco vía wsrv.nl) en máxima calidad (variante `-F.jpg` de ML), caption 🟢 DISPONIBLE y comando `/ig promo` con vista previa + botón de publicación de la historia promocional.

**Architecture:** Todo extiende el módulo MLPU-Instagram existente del Worker `mlpu-proxy`: helpers puros en `ig-logic.js`, transformación de imagen + fallback en `ig-api.js`, flag `pausado` y vaciado en `ig-queue.js`/D1, comandos y callbacks en `telegram-bot.js`, PNG promocional servido por Workers Static Assets.

**Tech Stack:** Cloudflare Workers + D1, Telegram Bot API, Instagram Graph API v21.0, wsrv.nl (proxy de imágenes), tests con `node --test` y `FakeDB`.

**Spec:** `docs/superpowers/specs/2026-07-15-ig-pausa-padding-design.md`

## Global Constraints

- Repo: `C:\Users\aronr\OneDrive\Documentos\PROYECTOS\automl`, rama `feature/mlpu-instagram`. Trabajar sobre esa rama.
- Tests: `cd worker && npm test` (runner `node --test`). Los 22 tests existentes deben seguir pasando en cada task.
- Textos de usuario en español de Chile, HTML parse_mode en Telegram (escapar con `esc()`).
- wsrv feed: `w=1080&h=1080&fit=contain&cbg=white&output=jpg&q=95`; historia: `w=1080&h=1920&…` (mismos parámetros).
- Variante de máxima calidad ML: sufijo `-O.<ext>` → `-F.jpg` (verificado; NO usar prefijo `2X_`).
- Caption feed EXACTO (bloques separados por línea en blanco): `🔧 <TITULO>\n\n💰 <PRECIO>\n🟢 DISPONIBLE\n\n👉 Comprar: <link>\n\n<HASHTAGS>`.
- La promo (`/ig promo`) se publica SIN wsrv (ya es 9:16) y aunque la cola esté pausada.
- El cron diario (ventanas + renovación de token) NUNCA se pausa.
- No tocar el flujo post-venta (sigue apagado) ni los comandos ML existentes.

---

### Task 1: Helpers de imagen en ig-logic (`maxResPicture`, `padImageUrl`)

**Files:**
- Modify: `worker/ig-logic.js` (agregar al final)
- Test: `worker/test/ig-logic.test.js` (append)

**Interfaces:**
- Consumes: nada nuevo.
- Produces: `maxResPicture(url: string) => string` y `padImageUrl(url: string, story?: boolean) => string`, exportadas desde `./ig-logic.js` (Task 3 las importa en ig-api.js).

- [ ] **Step 1: Escribir tests que fallan** — append en `worker/test/ig-logic.test.js` (respetar los imports existentes del archivo; agregar `maxResPicture, padImageUrl` al import de `../ig-logic.js`):

```js
test('maxResPicture: cambia -O.<ext> por -F.jpg en URLs mlstatic', () => {
  assert.equal(
    maxResPicture('https://http2.mlstatic.com/D_824754-MLC112921128350_072026-O.webp'),
    'https://http2.mlstatic.com/D_824754-MLC112921128350_072026-F.jpg')
  assert.equal(
    maxResPicture('https://http2.mlstatic.com/D_123-MLC456_072026-O.jpg'),
    'https://http2.mlstatic.com/D_123-MLC456_072026-F.jpg')
})

test('maxResPicture: deja intactas URLs que no calzan el patrón', () => {
  assert.equal(maxResPicture('https://http2.mlstatic.com/D_123-MLC456-F.webp'),
    'https://http2.mlstatic.com/D_123-MLC456-F.webp')
  assert.equal(maxResPicture('https://otro.cdn.com/foto-O.jpg'), 'https://otro.cdn.com/foto-O.jpg')
  assert.equal(maxResPicture(null), null)
})

test('padImageUrl: feed 1080x1080 con contain, fondo blanco y q=95', () => {
  const u = padImageUrl('https://http2.mlstatic.com/a b.jpg')
  assert.ok(u.startsWith('https://wsrv.nl/?url=https%3A%2F%2Fhttp2.mlstatic.com%2Fa%20b.jpg'))
  assert.ok(u.includes('&w=1080&h=1080&fit=contain&cbg=white&output=jpg&q=95'))
})

test('padImageUrl: historia 1080x1920', () => {
  assert.ok(padImageUrl('https://x.com/f.jpg', true).includes('&w=1080&h=1920&fit=contain'))
})
```

- [ ] **Step 2: Verificar que fallan** — Run: `cd worker && npm test`. Expected: FAIL (`maxResPicture is not defined` / no exportada).

- [ ] **Step 3: Implementar** — append en `worker/ig-logic.js`:

```js
// Variante de máxima resolución del CDN de ML: pictures[].secure_url llega como
// '-O' (~500px); '-F.jpg' es el original completo (= max_size). Verificado 2026-07-15.
export function maxResPicture(url) {
  if (typeof url !== 'string' || !/\bmlstatic\.com\//.test(url)) return url
  return url.replace(/-O\.(jpe?g|webp|png)$/i, '-F.jpg')
}

// URL del proxy wsrv.nl que rellena con blanco hasta la proporción exacta de IG
// (feed 1:1, historia 9:16) sin recortar. q=95 porque el default (~80) degrada visible.
export function padImageUrl(url, story = false) {
  return `https://wsrv.nl/?url=${encodeURIComponent(url)}` +
    `&w=1080&h=${story ? 1920 : 1080}&fit=contain&cbg=white&output=jpg&q=95`
}
```

- [ ] **Step 4: Verificar que pasan** — Run: `cd worker && npm test`. Expected: PASS (26 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/ig-logic.js worker/test/ig-logic.test.js
git commit -m "feat(ig): helpers maxResPicture y padImageUrl (calidad máxima + padding wsrv)"
```

---

### Task 2: Caption nuevo del feed (🟢 DISPONIBLE)

**Files:**
- Modify: `worker/ig-logic.js:13-15` (`buildCaption`)
- Test: `worker/test/ig-logic.test.js` (actualizar el test existente de buildCaption)

**Interfaces:**
- Consumes: `fmtCLP`, `HASHTAGS` (existentes).
- Produces: `buildCaption({ titulo, precio, link }) => string` con el formato nuevo (misma firma; ig-queue.js no cambia).

- [ ] **Step 1: Actualizar el test existente de `buildCaption`** en `worker/test/ig-logic.test.js` para exigir el formato nuevo (reemplazar el assert del test actual; si valida por partes, dejarlo así):

```js
test('buildCaption: título, precio, DISPONIBLE, link y hashtags en bloques', () => {
  const c = buildCaption({ titulo: 'Llanta Bronco R15', precio: 12000, link: 'https://ml.cl/x' })
  assert.equal(c,
    '🔧 Llanta Bronco R15\n\n💰 $12.000\n🟢 DISPONIBLE\n\n👉 Comprar: https://ml.cl/x\n\n' +
    '#repuestos #autos #desarme #repuestosusados #chile')
})
```

- [ ] **Step 2: Verificar que falla** — Run: `cd worker && npm test`. Expected: FAIL (formato viejo).

- [ ] **Step 3: Implementar** — reemplazar `buildCaption` en `worker/ig-logic.js`:

```js
export function buildCaption({ titulo, precio, link }) {
  return `🔧 ${titulo}\n\n💰 ${fmtCLP(precio)}\n🟢 DISPONIBLE\n\n👉 Comprar: ${link}\n\n${HASHTAGS}`
}
```

- [ ] **Step 4: Verificar que pasa** — Run: `cd worker && npm test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/ig-logic.js worker/test/ig-logic.test.js
git commit -m "feat(ig): caption del feed con 🟢 DISPONIBLE y bloques separados"
```

---

### Task 3: igPublishImage con padding, máxima calidad, fallback y modo raw

**Files:**
- Modify: `worker/ig-api.js:35-44` (`igPublishImage`) + import
- Test: `worker/test/ig-api.test.js` (append; seguir el patrón de mocks del archivo)

**Interfaces:**
- Consumes: `maxResPicture`, `padImageUrl` de `./ig-logic.js` (Task 1).
- Produces: `igPublishImage(env, { imageUrl, caption, story = false, raw = false }) => Promise<string>`. Con `raw: true` publica `imageUrl` tal cual (lo usa la promo en Task 7). Sin `raw`, publica `padImageUrl(maxResPicture(imageUrl), story)` y ante un error reintenta UNA vez con `imageUrl` original.

- [ ] **Step 1: Tests que fallan** — append en `worker/test/ig-api.test.js`. Seguir el patrón existente del archivo para mockear `fetch` global (los tests actuales de igPublishImage ya lo hacen: capturan las llamadas a `/media` y `/media_publish`). Casos:

```js
test('igPublishImage: usa wsrv + variante -F.jpg para el feed', async (t) => {
  const calls = mockGraphOk(t)   // helper/patrón existente en el archivo: fetch fake que responde {id:'C1'} y {id:'P1'}
  const env = makeEnv()          // patrón existente: { DB: fakeDb con meta_token sembrado, IG_USER_ID: 'IGU' }
  await igPublishImage(env, { imageUrl: 'https://http2.mlstatic.com/D_1-MLC2_072026-O.webp', caption: 'hola' })
  const body = calls[0].body     // URLSearchParams del primer POST (…/media)
  const img = new URLSearchParams(body).get('image_url')
  assert.ok(img.startsWith('https://wsrv.nl/?url='))
  assert.ok(img.includes(encodeURIComponent('D_1-MLC2_072026-F.jpg')))
  assert.ok(img.includes('h%3D1080') || img.includes('h=1080'))
})

test('igPublishImage: si wsrv falla reintenta con la URL original', async (t) => {
  // fetch fake: la 1ª llamada a /media devuelve {error:{message:'bad image'}}, después todo OK
  const calls = mockGraphFirstMediaFails(t)
  const env = makeEnv()
  const id = await igPublishImage(env, { imageUrl: 'https://http2.mlstatic.com/D_1-MLC2_072026-O.webp', caption: 'x' })
  assert.equal(id, 'P1')
  const img2 = new URLSearchParams(calls[1].body).get('image_url')
  assert.equal(img2, 'https://http2.mlstatic.com/D_1-MLC2_072026-O.webp')
})

test('igPublishImage raw: publica la URL tal cual (sin wsrv)', async (t) => {
  const calls = mockGraphOk(t)
  const env = makeEnv()
  await igPublishImage(env, { imageUrl: 'https://mlpu-proxy.aronricocl.workers.dev/ig/promo.png', story: true, raw: true })
  const p = new URLSearchParams(calls[0].body)
  assert.equal(p.get('image_url'), 'https://mlpu-proxy.aronricocl.workers.dev/ig/promo.png')
  assert.equal(p.get('media_type'), 'STORIES')
})
```

(Si el archivo no tiene helpers `mockGraphOk`/`makeEnv` con esos nombres, crear helpers locales equivalentes siguiendo el estilo de los tests existentes de igPublishImage — no duplicar lógica en cada test.)

- [ ] **Step 2: Verificar que fallan** — Run: `cd worker && npm test`. Expected: FAIL (image_url llega sin wsrv / no hay reintento / `raw` ignorado).

- [ ] **Step 3: Implementar** — en `worker/ig-api.js`, agregar import y reemplazar `igPublishImage`:

```js
import { maxResPicture, padImageUrl } from './ig-logic.js'
```

```js
// Publica una imagen como post de feed (con caption) o historia (story: true).
// Sin raw: pasa por wsrv.nl (padding blanco, sin recorte) partiendo de la variante
// -F.jpg de ML; si wsrv o la descarga fallan, reintenta una vez con la URL original.
export async function igPublishImage(env, { imageUrl, caption, story = false, raw = false }) {
  const token = await getMetaToken(env.DB)
  const attempt = async (img) => {
    const cont = await graphPost(`${env.IG_USER_ID}/media`, {
      image_url: img,
      ...(story ? { media_type: 'STORIES' } : { caption }),
      access_token: token,
    })
    const pub = await graphPost(`${env.IG_USER_ID}/media_publish`, { creation_id: cont.id, access_token: token })
    return pub.id
  }
  if (raw) return attempt(imageUrl)
  try {
    return await attempt(padImageUrl(maxResPicture(imageUrl), story))
  } catch (e) {
    log('padding falló, reintento con la URL original:', e.message)
    return attempt(imageUrl)
  }
}
```

- [ ] **Step 4: Verificar que pasan** — Run: `cd worker && npm test`. Expected: PASS (todos, incluidos los viejos de ig-api: si alguno asertaba la URL exacta sin wsrv, actualizarlo al comportamiento nuevo).

- [ ] **Step 5: Commit**

```bash
git add worker/ig-api.js worker/test/ig-api.test.js
git commit -m "feat(ig): padding wsrv + variante -F.jpg con fallback y modo raw en igPublishImage"
```

---

### Task 4: Pausa de la cola (`/ig parar`, `/ig seguir`)

**Files:**
- Modify: `worker/ig-queue.js` (helpers + `runIgPublisher`)
- Modify: `worker/telegram-bot.js:393-437` (`handleIgCommand`) y `:25` (import)
- Test: `worker/test/ig-queue.test.js` (append)

**Interfaces:**
- Consumes: `getConfig`/`setConfig` internos de ig-queue.js.
- Produces: `isPausado(env) => Promise<boolean>` y `setPausado(env, on: boolean) => Promise<void>` exportadas de `./ig-queue.js`; `runIgPublisher` devuelve `{ publicados, pausado?: true }`.

- [ ] **Step 1: Tests que fallan** — append en `worker/test/ig-queue.test.js` (usar `FakeDB` y el patrón de deps inyectadas del archivo):

```js
test('runIgPublisher: con pausado activo no publica nada', async () => {
  const env = { DB: new FakeDB() }
  env.DB.seedQueue({ ml_item_id: 'MLC1', titulo: 'A', precio: 1000, permalink_ml: 'https://x/1' })
  await setPausado(env, true)
  const r = await runIgPublisher(env, { force: true, deps: { publishImage: async () => { throw new Error('no debía publicar') }, getItem: async () => ({ status: 'active', pictures: [{ secure_url: 'https://f/1.jpg' }] }) } })
  assert.deepEqual(r, { publicados: 0, pausado: true })
})

test('runIgPublisher: /ig parar a mitad de tanda corta el resto', async () => {
  const env = { DB: new FakeDB() }
  env.DB.seedQueue({ ml_item_id: 'MLC1', titulo: 'A', precio: 1, permalink_ml: 'https://x/1' })
  env.DB.seedQueue({ ml_item_id: 'MLC2', titulo: 'B', precio: 2, permalink_ml: 'https://x/2' })
  let published = 0
  const r = await runIgPublisher(env, { force: true, deps: {
    getItem: async () => ({ status: 'active', pictures: [{ secure_url: 'https://f/1.jpg' }] }),
    publishImage: async () => { if (++published === 2) await setPausado(env, true); return 'M' + published },
  } })
  // el ítem 1 se publica (feed+historia = 2 llamadas, pausa al final); el ítem 2 ya no arranca
  assert.equal(r.publicados, 1)
  assert.equal(r.pausado, true)
})

test('setPausado(false) reanuda', async () => {
  const env = { DB: new FakeDB() }
  await setPausado(env, true)
  await setPausado(env, false)
  assert.equal(await isPausado(env), false)
})
```

- [ ] **Step 2: Verificar que fallan** — Run: `cd worker && npm test`. Expected: FAIL (`setPausado is not defined`).

- [ ] **Step 3: Implementar en `worker/ig-queue.js`** — después de `getVentanas`:

```js
export async function isPausado(env) {
  return !!(await getConfig(env.DB, 'pausado'))
}

export async function setPausado(env, on) {
  if (on) return setConfig(env.DB, 'pausado', { desde: new Date().toISOString() })
  await env.DB.prepare("DELETE FROM ig_config WHERE clave='pausado'").run()
}
```

En `runIgPublisher`, primera línea del cuerpo (antes de `const { horas }`):

```js
  if (await isPausado(env)) return { publicados: 0, pausado: true }
```

Y dentro del `for`, como primera instrucción del loop (antes del `try`):

```js
    if (await isPausado(env)) return { publicados, pausado: true }
```

(FakeDB ya soporta `DELETE FROM ig_config` con clave en el SQL y `REPLACE INTO ig_config`; no necesita cambios.)

- [ ] **Step 4: Comandos en `worker/telegram-bot.js`** — agregar `isPausado, setPausado` al import de `./ig-queue.js` (línea 25). En `handleIgCommand`, antes de la línea final de ayuda:

```js
  if (sub === 'parar') {
    await setPausado(env, true)
    return tgSend(env, chatId, '⏸ Publicación en Instagram PAUSADA (los crons no suben nada). Reanudar: /ig seguir · Vaciar la cola: /ig vaciar')
  }
  if (sub === 'seguir') {
    await setPausado(env, false)
    return tgSend(env, chatId, '▶️ Publicación en Instagram reanudada: la cola sigue en las próximas ventanas.')
  }
```

En el handler de `cola` (línea 398), antes de armar la respuesta, calcular el encabezado:

```js
    const pausada = await isPausado(env) ? '⏸ <b>PAUSADO</b> (reanudar: /ig seguir)\n\n' : ''
```

y anteponer `${pausada}` al texto de ambas respuestas de `cola` (vacía y con ítems).

En el handler de `ahora` (línea 415), tras obtener `r`:

```js
    if (r.pausado) return tgSend(env, chatId, '⏸ La cola está pausada; no publiqué nada. Reanudar: /ig seguir')
```

Actualizar la línea de ayuda final a:

```js
  return tgSend(env, chatId, 'Comandos: /ig stock · /ig cola · /ig quitar <id> · /ig vaciar · /ig ahora · /ig parar · /ig seguir · /ig horas · /ig promo')
```

- [ ] **Step 5: Verificar** — Run: `cd worker && npm test`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add worker/ig-queue.js worker/telegram-bot.js worker/test/ig-queue.test.js
git commit -m "feat(ig): /ig parar y /ig seguir — flag pausado respetado dentro de la tanda"
```

---

### Task 5: `/ig vaciar` + re-encolado de cancelados en enqueueStock

**Files:**
- Modify: `worker/ig-queue.js` (`vaciarCola` nueva; `enqueueStock` UPSERT)
- Modify: `worker/telegram-bot.js` (`handleIgCommand` + import)
- Modify: `worker/test/fake-db.js` (soportar UPDATE masivo y UPSERT)
- Test: `worker/test/ig-queue.test.js` (append)

**Interfaces:**
- Consumes: FakeDB.
- Produces: `vaciarCola(env) => Promise<number>` (cantidad cancelada), exportada de `./ig-queue.js`.

- [ ] **Step 1: Tests que fallan** — append en `worker/test/ig-queue.test.js`:

```js
test('vaciarCola: cancela todos los pendientes y devuelve el conteo', async () => {
  const env = { DB: new FakeDB() }
  env.DB.seedQueue({ ml_item_id: 'MLC1', titulo: 'A', precio: 1 })
  env.DB.seedQueue({ ml_item_id: 'MLC2', titulo: 'B', precio: 2 })
  env.DB.seedQueue({ ml_item_id: 'MLC3', titulo: 'C', precio: 3, estado: 'publicado' })
  assert.equal(await vaciarCola(env), 2)
  assert.ok(env.DB.queue.every(r => r.ml_item_id === 'MLC3' ? r.estado === 'publicado' : r.estado === 'cancelado'))
})

test('enqueueStock: re-encola ítems cancelados (UPSERT), no los publicados', async () => {
  const env = { DB: new FakeDB(), SELLER_ID: 'S1' }
  env.DB.seedQueue({ ml_item_id: 'MLC1', titulo: 'A', precio: 1, estado: 'cancelado', intentos: 2, ultimo_error: 'x' })
  env.DB.seedQueue({ ml_item_id: 'MLC2', titulo: 'B', precio: 2, estado: 'publicado' })
  const pages = [{ results: ['MLC1', 'MLC2'], paging: { total: 2 } }]
  const detail = [{ body: { id: 'MLC1', title: 'A', price: 1, permalink: 'https://x/1', status: 'active' } },
                  { body: { id: 'MLC2', title: 'B', price: 2, permalink: 'https://x/2', status: 'active' } }]
  const fakeFetch = async (url) => ({ json: async () => url.includes('/items/search') ? pages[0] : detail })
  const r = await enqueueStock(env, { getToken: async () => 'T', mlFetch: fakeFetch })
  assert.equal(r.encolados, 1) // solo MLC1 (cancelado→pendiente); MLC2 publicado queda intacto
  const row = env.DB.queue.find(x => x.ml_item_id === 'MLC1')
  assert.equal(row.estado, 'pendiente'); assert.equal(row.intentos, 0); assert.equal(row.ultimo_error, null)
  assert.equal(env.DB.queue.find(x => x.ml_item_id === 'MLC2').estado, 'publicado')
})
```

- [ ] **Step 2: Verificar que fallan** — Run: `cd worker && npm test`. Expected: FAIL (`vaciarCola is not defined`; UPSERT no soportado).

- [ ] **Step 3: Implementar `vaciarCola`** en `worker/ig-queue.js` (después de `quitarDeCola`):

```js
export async function vaciarCola(env) {
  const r = await env.DB.prepare(
    "UPDATE ig_queue SET estado='cancelado' WHERE estado='pendiente'").run()
  return r.meta?.changes ?? 0
}
```

Y en `enqueueStock`, reemplazar el `INSERT OR IGNORE` (líneas 135-137) por:

```js
      const res = await env.DB.prepare(
        `INSERT INTO ig_queue (ml_item_id, titulo, precio, permalink_ml) VALUES (?, ?, ?, ?)
         ON CONFLICT(ml_item_id) DO UPDATE SET estado='pendiente', intentos=0, ultimo_error=NULL
         WHERE ig_queue.estado='cancelado'`)
        .bind(b.id, b.title, Math.round(Number(b.price)) || 0, b.permalink || null).run()
```

- [ ] **Step 4: Soporte en `worker/test/fake-db.js`** — dentro de `run()`:

Antes del branch `INSERT OR IGNORE INTO ig_queue`, agregar:

```js
    if (sql.includes('ON CONFLICT(ml_item_id)')) {
      const [ml_item_id, titulo, precio, permalink_ml] = args
      const row = db.queue.find(r => r.ml_item_id === ml_item_id)
      if (!row) { db.seedQueue({ ml_item_id, titulo, precio, permalink_ml, creado_en: new Date().toISOString() }); changes = 1 }
      else if (row.estado === 'cancelado') { Object.assign(row, { estado: 'pendiente', intentos: 0, ultimo_error: null }); changes = 1 }
      return { success: true, meta: { changes } }
    }
```

Y en el branch `UPDATE ig_queue`, ANTES de la lógica por id, agregar el caso masivo:

```js
    } else if (sql.includes('UPDATE ig_queue') && sql.includes("WHERE estado='pendiente'") && !args.length) {
      for (const r of db.queue) if (r.estado === 'pendiente') { r.estado = 'cancelado'; changes++ }
```

(cuidando que el branch por-id existente quede después y sin romperse).

- [ ] **Step 5: Comando en `worker/telegram-bot.js`** — agregar `vaciarCola` al import de `./ig-queue.js`. En `handleIgCommand`, junto a los otros subcomandos:

```js
  if (sub === 'vaciar') {
    const n = await vaciarCola(env)
    return tgSend(env, chatId, n
      ? `🗑 Cola vaciada: ${n} publicación(es) pendiente(s) canceladas. Re-encolar el inventario: /ig stock`
      : 'La cola ya estaba vacía.')
  }
```

- [ ] **Step 6: Verificar** — Run: `cd worker && npm test`. Expected: PASS (todos).

- [ ] **Step 7: Commit**

```bash
git add worker/ig-queue.js worker/telegram-bot.js worker/test/fake-db.js worker/test/ig-queue.test.js
git commit -m "feat(ig): /ig vaciar + re-encolado de cancelados vía UPSERT en enqueueStock"
```

---

### Task 6: Servir la imagen promocional (Static Assets + PUBLIC_URL)

**Files:**
- Modify: `worker/wrangler.toml`
- Move: `worker/assets/promo-story.png` → `worker/public/ig/promo.png`
- Modify: `docs/superpowers/specs/2026-07-15-ig-pausa-padding-design.md` (ruta del asset)

**Interfaces:**
- Produces: URL pública `https://mlpu-proxy.aronricocl.workers.dev/ig/promo.png` y var `env.PUBLIC_URL` (Task 7 las usa).

- [ ] **Step 1: Mover el PNG**

```bash
mkdir -p worker/public/ig
git mv worker/assets/promo-story.png worker/public/ig/promo.png
```

- [ ] **Step 2: wrangler.toml** — en `[vars]` agregar:

```toml
PUBLIC_URL = "https://mlpu-proxy.aronricocl.workers.dev"
```

y al final del archivo:

```toml
# Assets estáticos (imagen de la historia promocional /ig promo).
# Con `main` presente, los paths que matchean un asset se sirven directo;
# el resto sigue yendo al fetch handler de index.js.
[assets]
directory = "./public"
```

- [ ] **Step 3: Actualizar la spec** — en `docs/superpowers/specs/2026-07-15-ig-pausa-padding-design.md`, Parte 4, cambiar `worker/assets/promo-story.png` por `worker/public/ig/promo.png` y quitar la mención al binding `env.ASSETS` (no hace falta binding: assets-first routing).

- [ ] **Step 4: Deploy y verificación real**

```bash
cd worker && npx wrangler deploy
curl -s -o /dev/null -w "%{http_code} %{content_type} %{size_download}\n" https://mlpu-proxy.aronricocl.workers.dev/ig/promo.png
```

Expected: `200 image/png <~60000>`. Verificar también que el webhook sigue vivo:
`curl -s -o /dev/null -w "%{http_code}\n" https://mlpu-proxy.aronricocl.workers.dev/ml/sites/MLC` (cualquier respuesta ≠ 404 de assets; el 200/4xx del proxy ML está bien).

- [ ] **Step 5: Commit**

```bash
git add worker/wrangler.toml worker/public/ig/promo.png docs/superpowers/specs/2026-07-15-ig-pausa-padding-design.md
git commit -m "feat(ig): sirve promo.png vía static assets + PUBLIC_URL"
```

---

### Task 7: `/ig promo` con vista previa y botones

**Files:**
- Modify: `worker/telegram-bot.js` (`handleIgCommand` + `handleCallback` + ayuda de /start línea ~327)
- Modify: `README.md` (sección de comandos /ig)
- Test: `worker/test/ig-queue.test.js` o smoke: no aplica test unitario del bot (el bot no tiene harness); la lógica publicable ya está testeada vía `igPublishImage raw` (Task 3). Verificación real en Step 4.

**Interfaces:**
- Consumes: `igPublishImage` con `raw: true` (Task 3); `env.PUBLIC_URL` (Task 6); `tgApi`, `tgSend`, `esc` existentes.
- Produces: subcomando `promo` y callbacks `ig:promo:go` / `ig:promo:no`.

- [ ] **Step 1: Import** — en `worker/telegram-bot.js`, agregar `igPublishImage` al import de `./ig-api.js` (si no existe, crear la línea junto a los imports de ig-queue/ig-logic, línea ~26):

```js
import { igPublishImage } from './ig-api.js'
```

- [ ] **Step 2: Subcomando en `handleIgCommand`**:

```js
  if (sub === 'promo') {
    return tgApi(env, 'sendPhoto', {
      chat_id: chatId,
      photo: `${env.PUBLIC_URL}/ig/promo.png`,
      caption: '📢 Vista previa de la historia promocional. ¿La subo a Instagram?',
      reply_markup: { inline_keyboard: [[
        { text: '📤 Subir a historia', callback_data: 'ig:promo:go' },
        { text: '❌ Cancelar', callback_data: 'ig:promo:no' },
      ]] },
    })
  }
```

- [ ] **Step 3: Callbacks en `handleCallback`** (worker/telegram-bot.js:495, junto a los otros `if (data === …)`):

```js
  if (data === 'ig:promo:go') {
    const edit = (caption) => tgApi(env, 'editMessageCaption',
      { chat_id: chatId, message_id: cq.message.message_id, caption })
    try {
      // raw + sin chequear pausado: es una acción manual explícita y el PNG ya es 9:16.
      await igPublishImage(env, { imageUrl: `${env.PUBLIC_URL}/ig/promo.png`, story: true, raw: true })
      return edit('✅ Historia promocional publicada en Instagram.')
    } catch (e) {
      return edit(`❌ No pude publicar la promo: ${e.message.slice(0, 150)}. Tocá /ig promo para reintentar.`)
    }
  }
  if (data === 'ig:promo:no') {
    return tgApi(env, 'editMessageCaption',
      { chat_id: chatId, message_id: cq.message.message_id, caption: 'Cancelado. La promo no se publicó.' })
  }
```

- [ ] **Step 4: Ayuda y README** — actualizar la línea de ayuda de `/start` (telegram-bot.js:327) a:

```js
    '📸 /ig — Instagram: stock, cola, quitar, vaciar, ahora, parar, seguir, horas, promo.\n\n' +
```

y en `README.md`, en la sección de comandos `/ig`, documentar los 4 nuevos:

```markdown
- `/ig parar` / `/ig seguir` — pausa/reanuda la publicación automática (la cola queda intacta).
- `/ig vaciar` — cancela todas las publicaciones pendientes de la cola.
- `/ig promo` — vista previa de la historia promocional (STOCK DISPONIBLE / couriers) con botón para subirla a IG.
```

- [ ] **Step 5: Tests + deploy**

```bash
cd worker && npm test        # Expected: PASS (todos)
npx wrangler deploy          # Expected: deploy OK con [assets]
```

- [ ] **Step 6: Verificación real por Telegram (con el usuario)** — `/ig promo` → llega la foto con 2 botones → [❌ Cancelar] edita el caption → `/ig promo` de nuevo → [📤 Subir a historia] → historia visible en @topwheels.cl. Además `/ig parar` → `/ig ahora` responde pausado → `/ig seguir`.

- [ ] **Step 7: Commit**

```bash
git add worker/telegram-bot.js README.md
git commit -m "feat(ig): /ig promo con vista previa y botones de publicación"
```

---

## Self-Review (hecho al escribir el plan)

- **Cobertura de la spec:** Parte 1 → Tasks 4-5; Parte 2 (wsrv + calidad + fallback) → Tasks 1 y 3; Parte 3 (caption) → Task 2; Parte 4 (promo) → Tasks 6-7; ajuste UPSERT → Task 5; ayuda/README → Tasks 4 y 7. Sin huecos.
- **Consistencia de firmas:** `isPausado/setPausado/vaciarCola` (ig-queue), `maxResPicture/padImageUrl` (ig-logic), `igPublishImage({...raw})` (ig-api) usadas con los mismos nombres en todas las tasks.
- **Nota para el implementador:** los nombres de helpers de mocks en Task 3 (`mockGraphOk`, `makeEnv`) son descriptivos; usar los del archivo real si ya existen con otro nombre.
