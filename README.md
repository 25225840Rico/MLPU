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
- `/ig horas [HH:MM …|auto]` — consulta o fija las ventanas horarias de publicación.
- `/ig parar` / `/ig seguir` — pausa/reanuda la publicación automática (la cola queda intacta).
- `/ig vaciar` — cancela todas las publicaciones pendientes de la cola.
- `/ig promo` — vista previa de la historia promocional (STOCK DISPONIBLE / couriers) con botón para subirla a IG.
