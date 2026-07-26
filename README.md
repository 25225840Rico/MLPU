# automl

Monorepo del proyecto MLPU: Worker de Cloudflare (`worker/`, proxy ML + bot de
Telegram + cola de publicación en Instagram) y bot de postventa en Python
(`bot-python/`, ver su propio README).

## Comandos `/ig` (bot de Telegram del Worker)

El bot de Telegram embebido en `worker/telegram-bot.js` expone el comando
`/ig` para administrar el inventario y la cola de publicación en Instagram:

- `/ig stock` — revisa el inventario activo en MercadoLibre y encola los productos nuevos para Instagram.
- `/ig cola` — muestra la cola de publicaciones pendientes.
- `/ig quitar <id>` — saca una publicación pendiente de la cola.
- `/ig ahora` — fuerza la publicación inmediata de la cola (sin esperar la ventana horaria).
- `/ig rehistorias` — re-encola TODO lo ya publicado para subir SOLO la historia de nuevo (el post del feed no se repite), priorizando los productos con más interacciones (likes + comentarios) en el feed; después se activa con `/ig rush` o el goteo.
- `/ig borrarhistorias` — borra de Instagram todas las historias vivas (las de las últimas 24 h; las más viejas expiran solas). Requiere el permiso `instagram_manage_contents` en el token de Meta.
- `/ig horas [HH:MM …|auto]` — consulta o fija las ventanas horarias de publicación.
- `/ig parar` / `/ig seguir` — pausa/reanuda la publicación automática (la cola queda intacta).
- `/ig vaciar` — cancela todas las publicaciones pendientes de la cola.
- `/ig promo` — vista previa de la historia promocional (STOCK DISPONIBLE / couriers) con botón para subirla a IG.
- `/ig solo drive|ml|off` — foco de fuente: publica solo el inventario propio de Drive, solo lo de ML, o ambos.
- `/ig rush [off]` / `/ig auto [min|off]` — subida continua vs. goteo cada N minutos.

## Pruebas

```bash
npm test        # suite del Worker (node --test, worker/test/*.test.js)
npm run test:spa # comprobaciones estáticas del SPA (scripts/verify-spa.mjs)
npm run test:all # ambas
```

El workflow de GitHub Pages (`.github/workflows/deploy.yml`) corre las dos antes
de construir: si algo falla, no se publica nada.

## Seguridad del Worker

Dos secrets **opcionales**. Mientras no existan, el Worker se comporta igual que
antes (los controles quedan en no-op), así que se pueden desplegar sin riesgo y
activar después.

| Secret | Qué protege | Cómo activarlo |
|---|---|---|
| `MLPU_KEY` | El proxy `/ml/*` inyecta el token de ML del vendedor: sin llave, cualquiera con la URL del Worker podía publicar, editar o leer la cuenta. Con el secret puesto, esas rutas exigen la cabecera `X-MLPU-Key` (o `?key=`) y responden 401 sin ella. | `npx wrangler secret put MLPU_KEY` y pegar el mismo valor en el SPA (Ajustes → «Llave del Worker»). |
| `TELEGRAM_WEBHOOK_SECRET` | El webhook del bot: sin él, cualquiera que conozca la URL puede inyectar updates falsos. El Worker valida la cabecera `X-Telegram-Bot-Api-Secret-Token` que Telegram devuelve en cada update. | `npx wrangler secret put TELEGRAM_WEBHOOK_SECRET`, desplegar y **volver a registrar el webhook**: `GET /tg/admin?action=set` (si no se re-registra, Telegram sigue mandando updates sin el token y el bot queda mudo). |

Rutas que quedan **abiertas a propósito** aunque `MLPU_KEY` esté configurada:
`/ml/auth/status` (solo dice si la sesión está viva), `/ml/notifications` (la
llama MercadoLibre) y `/ig/img` (lo consume Cloudinary; su whitelist de dominios
`mlstatic` es lo que evita convertirlo en un proxy de imágenes abierto — no
ampliarla). `GET /tg/admin?action=info` reporta qué secrets ve el Worker.
