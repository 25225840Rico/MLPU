"""
config.py — Configuración central del bot de postventa ML (MLC).

Todas las credenciales y parámetros se leen de variables de entorno.
Carga un archivo .env si está presente (python-dotenv).
"""
import os

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:  # dotenv es opcional en producción si las vars ya están seteadas
    pass


def _require(name: str) -> str:
    val = os.getenv(name)
    if not val:
        raise RuntimeError(f"Falta la variable de entorno obligatoria: {name}")
    return val


# ── Tokens / credenciales ─────────────────────────────────────
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
ML_ACCESS_TOKEN = os.getenv("ML_ACCESS_TOKEN", "")
ML_SELLER_ID = os.getenv("ML_SELLER_ID", "")
# Solo este chat puede operar el bot (uso privado de un único vendedor).
AUTHORIZED_CHAT_ID = int(os.getenv("AUTHORIZED_CHAT_ID", "0"))

# ── Config MercadoLibre ───────────────────────────────────────
# Por defecto pega directo a la API de ML con ML_ACCESS_TOKEN (Bearer).
# ALTERNATIVA recomendada: apuntar ML_BASE_URL al Worker proxy MLPU
# (https://mlpu-proxy.aronricocl.workers.dev/ml) que renueva el token solo;
# en ese caso ML_ACCESS_TOKEN puede quedar vacío (el proxy lo inyecta).
ML_BASE_URL = os.getenv("ML_BASE_URL", "https://api.mercadolibre.com").rstrip("/")
ML_SITE_ID = os.getenv("ML_SITE_ID", "MLC")
ML_TAG = os.getenv("ML_TAG", "post_sale")
# True cuando ML_BASE_URL es el Worker proxy (no manda Authorization, lo pone el proxy).
ML_USE_PROXY = os.getenv("ML_USE_PROXY", "false").lower() in ("1", "true", "yes")

# ── Config del bot ────────────────────────────────────────────
# Si WEBHOOK_URL está definido se corre en modo webhook; si no, en modo polling.
WEBHOOK_URL = os.getenv("WEBHOOK_URL", "").rstrip("/")
WEBHOOK_PORT = int(os.getenv("WEBHOOK_PORT", "8443"))
WEBHOOK_LISTEN = os.getenv("WEBHOOK_LISTEN", "0.0.0.0")
WEBHOOK_SECRET = os.getenv("WEBHOOK_SECRET", "")  # secret_token de Telegram (opcional)

# Cada cuánto el bot consulta ML por ventas nuevas y mensajes entrantes.
POLL_INTERVAL_SECONDS = int(os.getenv("POLL_INTERVAL", "60"))

# Timeout de las llamadas HTTP a ML (segundos) y reintentos.
ML_TIMEOUT = float(os.getenv("ML_TIMEOUT", "10"))
ML_MAX_RETRIES = int(os.getenv("ML_MAX_RETRIES", "2"))

# ── Mensajes rápidos editables (texto libre, opción OTHER) ────
QUICK_REPLIES = {
    "confirmando": "Hola, estamos confirmando los datos de tu pedido y lo prepararemos a la brevedad. Muchas gracias por tu compra.",
    "listo_envio": "Hola, tu pedido ya está listo para ser despachado. Te avisaré cuando el courier lo retire. Muchas gracias.",
    "24h": "Hola, estamos preparando tu pedido. En las próximas 24 horas estará listo para despacho. Gracias por esperar.",
    "enviado_hoy": "Hola, tu pedido fue despachado hoy. Puedes seguir el envío con el número de tracking que aparece en tu compra.",
    "confirmar_variante": "Hola, para preparar tu pedido necesito confirmar algunos detalles del producto. ¿Podrías indicarme tu preferencia?",
    "boleta": "Hola, ¿necesitas boleta o factura para esta compra? Indícame y la incluyo en el despacho.",
}

# Etiquetas cortas de cada mensaje rápido para los botones (ESTADO 3B).
QUICK_REPLY_LABELS = {
    "confirmando": "📦 Confirmando tu pedido",
    "listo_envio": "🚚 Listo para envío",
    "24h": "⏰ Preparando en 24h",
    "enviado_hoy": "✅ Enviado hoy",
    "confirmar_variante": "📸 ¿Confirmas color/talla?",
    "boleta": "🧾 ¿Necesitas boleta?",
}

# ── Límites ───────────────────────────────────────────────────
MAX_MESSAGE_LENGTH = 350
MAX_BUTTONS_PER_ROW = 3

# ── Logging ───────────────────────────────────────────────────
LOG_DIR = os.getenv("LOG_DIR", "logs")
LOG_FILE = os.path.join(LOG_DIR, "bot.log")
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")

# Archivo de persistencia (estado de conversación + órdenes/mensajes vistos).
PERSISTENCE_FILE = os.getenv("PERSISTENCE_FILE", "bot_state.pickle")


def validate() -> None:
    """Valida que la configuración mínima esté presente. Llamar al arrancar."""
    _require("TELEGRAM_BOT_TOKEN")
    _require("ML_SELLER_ID")
    if AUTHORIZED_CHAT_ID == 0:
        raise RuntimeError("Falta AUTHORIZED_CHAT_ID (id del chat del vendedor).")
    if not ML_USE_PROXY and not ML_ACCESS_TOKEN:
        raise RuntimeError(
            "Falta ML_ACCESS_TOKEN. Defínelo, o usa ML_USE_PROXY=true con ML_BASE_URL apuntando al Worker proxy."
        )
