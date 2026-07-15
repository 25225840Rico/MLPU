# MLPU-Instagram: pausa/vaciado de cola + imágenes sin recorte — Diseño

**Fecha:** 2026-07-15 · **Estado:** aprobado por el usuario
**Extiende:** `2026-07-13-mlpu-instagram-design.md` (tras la prueba real de Task 7)

## Problema
1. No hay forma de detener el publicador: si la cola tiene ~160 ítems encolados,
   solo se pueden quitar de a uno (`/ig quitar <id>`).
2. Instagram recorta las fotos de ML de forma arbitraria (feed e historias):
   la contingencia de padding prevista en la spec original se activa ahora.
3. La imagen publicada se ve muy comprimida: hoy se usa `pictures[0].secure_url`,
   que en ML es la variante `-O` (~500px). El usuario quiere máxima calidad.
4. Nuevo formato de caption del feed: precio + disponibilidad con emoji verde,
   bien formateado (aprobado por el usuario, ver Parte 3).

## Parte 1 — Pausa y vaciado

### Comandos nuevos (en `handleIgCommand`, telegram-bot.js)
- **`/ig parar`** — escribe `ig_config.pausado = {"desde": <ISO>}`. Responde confirmando.
- **`/ig seguir`** — borra la clave `pausado`. Responde confirmando.
- **`/ig vaciar`** — `UPDATE ig_queue SET estado='cancelado' WHERE estado='pendiente'`;
  responde cuántos canceló. Los ítems NO se borran (trazabilidad; `estado='cancelado'`
  ya existe en el esquema). Re-encolar después: `/ig stock`. **Ajuste necesario:**
  `ml_item_id` es UNIQUE y `enqueueStock` usa `INSERT OR IGNORE`, por lo que un
  cancelado bloquearía el re-encolado; el INSERT pasa a UPSERT:
  `ON CONFLICT(ml_item_id) DO UPDATE SET estado='pendiente', intentos=0,
  ultimo_error=NULL WHERE estado='cancelado'` (publicados/pendientes/error intactos).

### Comportamiento del publicador (`runIgPublisher`, ig-queue.js)
- Con `pausado` presente: el cron */30 y `/ig ahora` retornan sin publicar
  (`/ig ahora` avisa "está pausado, /ig seguir para reanudar").
- El flag se re-lee **antes de cada ítem** dentro de la tanda: una corrida en curso
  se detiene a mitad de camino si llega `/ig parar` (los ya publicados quedan publicados).
- El cron diario (ventanas + renovación de token) NO se pausa: la renovación del
  token Meta debe seguir aunque la publicación esté detenida.
- `/ig cola` muestra "⏸ PAUSADO (reanudar: /ig seguir)" en el encabezado cuando aplica.
- Ayuda de `/ig` actualizada con los 3 comandos.

## Parte 2 — Imágenes sin recorte (padding vía wsrv.nl)

### Enfoque elegido (Opción A)
En vez de pasar a la Graph API la URL de ML directa, se pasa una URL del proxy
público **wsrv.nl** (images.weserv.nl, gratuito, corre sobre Cloudflare) que rellena
con fondo blanco hasta la proporción exacta, sin recortar:

- **Feed (cuadrado 1:1):**
  `https://wsrv.nl/?url=<encodeURIComponent(fotoML)>&w=1080&h=1080&fit=contain&cbg=white&output=jpg&q=95`
- **Historia (9:16):**
  `https://wsrv.nl/?url=<...>&w=1080&h=1920&fit=contain&cbg=white&output=jpg&q=95`

Implementación: helper puro `padImageUrl(mlUrl, story)` en `ig-logic.js`;
`igPublishImage` (ig-api.js) lo aplica según `story`.

### Máxima calidad de origen (verificado con el CDN real el 2026-07-15)
La foto de partida deja de ser `pictures[0].secure_url` tal cual (variante `-O`,
500px, ~23 KB — la causa principal de la compresión visible):
- Helper puro `maxResPicture(url)` en `ig-logic.js`: si la URL mlstatic termina en
  `-O.<ext>`, la cambia a **`-F.jpg`** (tamaño máximo del original = `max_size`;
  medido: 900×1200 y 241 KB en JPEG vs 66 KB del webp). Si no calza el patrón,
  la devuelve intacta. El prefijo `2X_` NO aporta (verificado: mismo 900×1200).
- `q=95` en wsrv (default ~80) y JPEG de salida.
- Lienzo 1080 (recomendación de la Graph API); IG re-comprime siempre, pero
  partir del original completo + q=95 es la máxima calidad alcanzable por este canal.

### Fallback
Si la publicación con URL wsrv falla (wsrv caído o Graph API no pudo descargarla),
se **reintenta 1 vez de inmediato con la URL original de ML** antes de contar el
intento como fallido (mejor un post recortado que ninguno). El aviso de error por
Telegram existente no cambia.

### Descartadas
- **WASM photon en el Worker:** mucho código, CPU justa en plan free. Queda como
  plan B si wsrv.nl desaparece.
- **Cloudflare Images:** requiere zona/dominio propio o plan pago; sobredimensionado.

## Parte 3 — Caption del feed (formato aprobado)

`buildCaption` (ig-logic.js) pasa a producir, con línea en blanco entre bloques:

```
🔧 <TITULO>

💰 <PRECIO CLP>
🟢 DISPONIBLE

👉 Comprar: <link ML>

#repuestos #autos #desarme #repuestosusados #chile
```

La historia no lleva caption (limitación de la Graph API, sin cambio).

## Parte 4 — Historia promocional `/ig promo` (imagen aprobada por el usuario)

### Imagen
Estática, 1080×1920, generada UNA vez con `scripts/gen-promo-story.py` (Pillow) y
commiteada en `worker/assets/promo-story.png` (~60 KB). Contenido aprobado:
TOPWHEELS.CL arriba en rojo · "STOCK DISPONIBLE" gigante (negro/verde) ·
"ENVÍOS A TODO CHILE" 🚚📦 · píldoras STARKEN (verde), CHILEXPRESS (amarillo),
BLUE EXPRESS (azul) · "ENTREGAS EN OFICINA / La Poderosa 175 · Antofagasta".
SIN hashtags (pedido explícito). Cambios de texto futuros = regenerar y redeploy.

### Publicación
La Graph API exige URL pública: el Worker sirve el PNG en `GET /ig/promo.png`
vía Workers Static Assets (`[assets]` en wrangler.toml, binding `env.ASSETS`);
la historia se publica con esa URL (media_type STORIES, sin wsrv: ya es 9:16 exacto).

### Flujo Telegram (2 botones)
1. `/ig promo` → el bot manda la imagen al chat (sendPhoto con la URL pública)
   con teclado inline: **[📤 Subir a historia]** `ig:promo:go` · **[❌ Cancelar]** `ig:promo:no`.
2. `ig:promo:go` → publica la historia en @topwheels.cl, edita el mensaje a
   "✅ Historia promocional publicada". `ig:promo:no` → edita a "Cancelado".
3. Respeta el flag `pausado` NO: la promo es acción manual explícita, se publica
   igual aunque la cola esté pausada.
4. Errores: mismo manejo que el resto (aviso por Telegram, sin reintentos en cola;
   el usuario simplemente vuelve a tocar el botón).

## Errores y pruebas
- Tests nuevos (runner `node --test`, fakes existentes):
  - `padImageUrl`: URL correcta feed/historia, encoding de la URL de ML, q=95.
  - `maxResPicture`: convierte `-O.jpg` → `2X_…-F.jpg`; URL no-mlstatic queda intacta.
  - `buildCaption`: formato nuevo (🟢 DISPONIBLE, bloques separados).
  - `/ig promo`: sendPhoto con teclado inline; callbacks go/no (publica / cancela).
  - Publicador respeta `pausado` (no publica; corta a mitad de tanda).
  - `/ig vaciar` cancela solo pendientes y reporta el conteo.
  - Fallback: primer intento wsrv falla → segundo intento con URL original.
- Sin migración de esquema (clave nueva en `ig_config`, estado `cancelado` ya existe).

## Fuera de alcance
Matar la invocación en curso del Worker (imposible desde Telegram); padding con
colores/blur; recorte inteligente.
