# MLPU-Instagram — Publicación automática en Instagram (feed + historias)

**Fecha:** 2026-07-13 · **Estado:** aprobado en brainstorming, pendiente revisión del spec
**Contexto:** sub-proyecto 1 de 2. El sub-proyecto 2 (MLPU-Tienda: web propia con
checkout MercadoPago + Webpay y sync bidireccional de stock con ML) queda para después.
El frente MLPU-Optimizer queda CONGELADO (sus docs siguen en `optimizer/docs/`).

## Objetivo

Cada producto que el bot publica en MercadoLibre se publica también en Instagram
(un post en el feed y una historia), en forma **programada a la mejor hora del día**
según las métricas de audiencia de la cuenta, sin intervención manual.

## Decisiones tomadas (con el usuario)

1. Publicación automática al publicar en ML — pero **encolada**, no inmediata.
2. Feed **e** historia, ambos programados a la mejor hora.
3. Mejor hora **automática según insights de IG** (seguidores conectados por hora),
   con fallback a horarios fijos configurables (12:30 y 20:00, hora de Chile)
   mientras la cuenta no entregue datos (la API exige un mínimo de audiencia, ~100 seguidores).
4. Imagen: **foto tal cual** (la que ya hospeda ML en URL pública); el precio va en el
   texto/caption, no sobre la imagen.
5. Cuenta Instagram Business vinculada a página de Facebook: **ya existe**.
6. Mientras no exista la tienda web, el link del caption apunta a la publicación de
   MercadoLibre; cuando la tienda esté viva se cambia a la URL del producto en el dominio propio.

## Arquitectura

Extiende el Worker de Cloudflare existente (`worker/`). Infra nueva: solo la base
**D1 `mlpu-db`** (que estaba planeada para el optimizer y ahora nace aquí) y dos
triggers cron. Sin servicios externos nuevos aparte de la Graph API de Meta.

### Componentes

**1. Cola de publicaciones (D1, tabla `ig_queue`)**
Al publicar exitosamente en ML (`worker/publisher.js`), se inserta una fila:
`ml_item_id, titulo, precio, foto_url (URL pública de ML), permalink_ml,
estado (pendiente|publicado|error|cancelado), intentos, creado_en, publicado_en,
ig_media_id, ig_story_id`.

**2. Selector de mejor hora (cron diario)**
Una vez al día lee de la Graph API la métrica de seguidores conectados por hora
(`online_followers`, permiso `instagram_manage_insights`) y guarda en D1
(tabla `ig_config`) las **2 mejores ventanas** del día. Si la API no entrega datos
(cuenta chica, métrica no disponible), usa el fallback configurable. Las ventanas
y el fallback se pueden ver/cambiar por comando de Telegram.

**3. Publicador (cron cada 30 min)**
Si la hora actual (zona América/Santiago) cae dentro de una ventana óptima y hay
filas `pendiente`:
- Publica hasta **3 productos por ventana** (tope anti-spam; el resto espera la
  ventana siguiente).
- Por producto: crea el contenedor de media del feed (imagen + caption), lo publica;
  luego el contenedor de historia (`media_type=STORIES`) y lo publica.
- Caption feed: `🔧 {título}\n💰 ${precio}\n👉 {link}` (+ 3-5 hashtags fijos de
  repuestos/autos configurables).
- Verifica antes de publicar que el ítem siga **activo en ML** (vía proxy `/ml/`);
  si está vendido/pausado → fila `cancelado`, no se publica.

**4. Manejo de errores y reintentos**
- Fallo de la API de IG → `intentos++`, queda `pendiente` para la próxima ventana.
- Al **3er fallo** → estado `error` y aviso por Telegram con el motivo.
- Éxito → aviso por Telegram: "📸 Subido a IG: {título} (feed + historia)".
- Respeto del límite de la API (50 publicaciones/24 h): con tope 3×2 ventanas
  jamás se alcanza; igual se cuenta y se frena si se acercara.

**5. Comandos de Telegram (en `worker/telegram-bot.js`)**
- `/ig cola` — lista pendientes con posición.
- `/ig quitar <n>` — saca un producto de la cola.
- `/ig ahora` — fuerza publicar los pendientes ya, ignorando la ventana.
- `/ig horas` — muestra ventanas vigentes (y si vienen de insights o fallback);
  permite fijar horarios manuales que anulan lo automático.

### Autenticación con Meta (setup único, guiado al implementar)
- App en Meta for Developers en modo Live con permisos
  `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`,
  `pages_read_engagement`.
- Token de larga duración (60 días) guardado como secret del Worker; un cron lo
  **auto-renueva** antes de expirar y avisa por Telegram si la renovación falla.

### Imagen y proporciones
Las fotos de ML son ~cuadradas, válidas para el feed (rango 4:5–1.91:1). Para
historias (9:16) IG centra/adapta la imagen automáticamente. **Contingencia** (solo
si IG rechaza alguna imagen en pruebas reales): módulo de padding con WASM
(photon) en el Worker para rellenar al ratio válido. No se implementa de entrada (YAGNI).

## Flujo

```
bot publica en ML ──► fila en ig_queue (pendiente)
cron diario ──► insights IG ──► 2 mejores ventanas (o fallback) en ig_config
cron 30min ──► ¿ventana activa y hay pendientes?
                ├─ ítem sigue activo en ML? ──no──► cancelado
                └─ sí ──► feed + historia en IG ──► publicado + aviso Telegram
                              └─ fallo ──► reintento próxima ventana (3 máx → error + aviso)
```

## Testing

- **Unit** (mismo runner que los tests actuales del worker): armado de caption,
  selección de ventana desde datos de insights simulados y desde fallback,
  transiciones de estado de la cola (pendiente/publicado/error/cancelado/reintentos),
  tope por ventana, exclusión de ítems vendidos.
- **Integración real (verificación final):** publicar un producto de prueba vía bot,
  ver la fila encolada, forzar `/ig ahora` y verificar en la cuenta real que
  aparecen el post del feed y la historia con caption correcto; luego una pasada
  esperando la ventana real.

## Fuera de alcance (este sub-proyecto)

- Tienda web, checkout y sync de stock (sub-proyecto MLPU-Tienda).
- Tarjetas de imagen con precio sobrepuesto.
- Reels/video, carruseles, respuestas a DMs de IG.
- Métricas de rendimiento por post (se puede sumar después con `instagram_manage_insights`).

## Requisitos del usuario (bloqueantes al implementar, no al planificar)

1. Acceso para crear la app en Meta for Developers (cuenta de Facebook admin de la página).
2. Confirmar el @ de la cuenta de Instagram Business a usar.
