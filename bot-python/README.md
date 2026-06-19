# Bot de Postventa MercadoLibre (MLC) — Telegram

Bot privado de **un solo vendedor** para gestionar la postventa de MercadoLibre
Chile por **botonera inline**. Resuelve el bloqueo de cuentas NEWBIE
(`blocked_by_conversation_initiated_by_seller_limited`) usando la **Action Guide
API**: para iniciar la conversación elige un "motivo para comunicarse"
(plantilla o texto libre `OTHER`, máx 350 caracteres). Cuando el comprador
responde, la conversación se desbloquea y el bot usa `/messages` normal.

## Características

- 100 % botonera: el bot **nunca** pide texto libre en el flujo normal (solo al
  redactar un mensaje propio o responder a un comprador que ya escribió).
- Notificaciones push de **ventas nuevas** y de **respuestas del comprador**
  (polling configurable a ML).
- Mensajes rápidos editables (`config.QUICK_REPLIES`).
- Estados de pago/envío con emojis, tracking copiable con un tap.
- Manejo de errores de ML mapeado a español + aviso de token expirado.
- Persistencia en disco (sobrevive reinicios) y logs rotados a diario.

## Arquitectura

| Archivo          | Responsabilidad                                              |
|------------------|--------------------------------------------------------------|
| `config.py`      | Variables de entorno, mensajes rápidos, límites              |
| `ml_client.py`   | Cliente async de la API de ML (httpx) con reintentos         |
| `keyboards.py`   | Botoneras inline (`InlineKeyboardMarkup`) por estado         |
| `formatters.py`  | Cards HTML (escapando variables con `html.escape`)           |
| `handlers.py`    | Routing de callbacks, captura de texto, jobs de polling      |
| `main.py`        | Arranque, logging, registro de handlers y jobs               |

`callback_data` usa prefijos: `nav:` `ord:` `pv:` `msg:` `cfg:`.

## Setup en 5 pasos

### 1. Clonar e instalar dependencias

```bash
cd bot-python
python3.11 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### 2. Configurar variables de entorno

```bash
cp .env.example .env
```

Edita `.env`:
- `TELEGRAM_BOT_TOKEN` — de @BotFather.
- `AUTHORIZED_CHAT_ID` — tu chat id (pregúntaselo a @userinfobot).
- `ML_SELLER_ID` — tu user_id de ML.
- **Token de ML** — dos opciones:
  - **A) Directo:** `ML_ACCESS_TOKEN=APP_USR-...` (caduca ~6h; el bot avisa al expirar).
  - **B) Recomendada:** apunta al Worker proxy que renueva el token solo:
    ```
    ML_BASE_URL=https://mlpu-proxy.aronricocl.workers.dev/ml
    ML_USE_PROXY=true
    ```
    (deja `ML_ACCESS_TOKEN` vacío).

### 3. Probar en modo polling (local, sin servidor)

```bash
python main.py
```

Deja `WEBHOOK_URL` vacío. Escribe `/start` al bot en Telegram → debe aparecer el
menú principal. Las ventas nuevas llegan solas por el polling.

### 4. (Producción) Configurar webhook en un servidor Linux

Necesitas un dominio con HTTPS (puerto 443/8443/80/88) y certificado válido
(p. ej. Let's Encrypt + Nginx como reverse proxy hacia `WEBHOOK_PORT`).

En `.env`:
```
WEBHOOK_URL=https://tudominio.com
WEBHOOK_PORT=8443
WEBHOOK_SECRET=un-secreto-largo-aleatorio
```

Ejemplo de bloque Nginx:
```nginx
location /<TELEGRAM_BOT_TOKEN> {
    proxy_pass http://127.0.0.1:8443;
    proxy_set_header Host $host;
}
```

El bot registra el webhook automáticamente al arrancar (`run_webhook`).

### 5. Dejarlo corriendo como servicio (systemd)

`/etc/systemd/system/mlpu-bot.service`:
```ini
[Unit]
Description=Bot Postventa ML
After=network.target

[Service]
WorkingDirectory=/opt/mlpu-bot/bot-python
ExecStart=/opt/mlpu-bot/bot-python/.venv/bin/python main.py
Restart=always
EnvironmentFile=/opt/mlpu-bot/bot-python/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now mlpu-bot
sudo journalctl -u mlpu-bot -f      # logs en vivo
```

## Flujo de postventa (estados)

1. **Nueva venta** (push) → [💬 Contactar] [📋 Detalle] [✅ En preparación] [🔗 ML]
2. **Contactar** → opciones del Action Guide (las sin cap aparecen ⛔ deshabilitadas)
3. **Plantilla** (REQUEST_VARIANTS / REQUEST_BILLING_INFO) → confirmar → enviar
   **Texto libre** (OTHER) → mensajes rápidos o redactar → **preview** (contador 350)
4. **Preview** → [✅ Enviar] [✏️ Editar] [❌ Cancelar]
5. **Éxito** / 6. **Error** (mensaje en español + código)
7. **Respuesta del comprador** (push) → responder libremente (`/messages` normal)
8. **Detalle de orden** (pago, envío, tracking, estado de conversación)
9. **Menú principal** (`/start`, `/menu`)

## Notas sobre el límite de ML (cap)

La opción de texto libre `OTHER` suele tener **cap 1**: solo puedes iniciar **un**
mensaje hasta que el comprador responda. El bot muestra `⛔ (sin cap)` cuando el
cupo está agotado. Las plantillas (`REQUEST_VARIANTS`) tienen cap mayor.

## Seguridad

- El bot **solo** responde a `AUTHORIZED_CHAT_ID`; cualquier otro recibe
  *"Bot privado. Acceso no autorizado."*
- No subas `.env` ni `bot_state.pickle` al repo.
