"""
formatters.py — Construcción de los mensajes HTML (cards) del bot.

Regla de oro: TODA variable dinámica pasa por html.escape() antes de
insertarse. parse_mode=HTML siempre (nunca MarkdownV2).
"""
import html
from datetime import datetime

import config

SEP = "──────────────────────"


def esc(value) -> str:
    """Escapa cualquier valor para insertarlo seguro en HTML de Telegram."""
    return html.escape(str(value if value is not None else ""))


def money(amount) -> str:
    try:
        return f"{int(float(amount)):,}".replace(",", ".")
    except (TypeError, ValueError):
        return esc(amount)


# ── Mapas de estado ───────────────────────────────────────────
PAYMENT_STATUS = {
    "paid": "✅ Pagado",
    "approved": "✅ Pagado",
    "payment_required": "⏳ Pago pendiente",
    "payment_in_process": "🔄 Procesando pago",
    "partially_paid": "⚠️ Pago parcial",
}

SHIPMENT_STATUS = {
    "ready_to_ship": "📦 Listo para envío",
    "pending": "📦 Pendiente",
    "handling": "⏰ En preparación",
    "shipped": "🚚 En camino",
    "delivered": "✅ Entregado",
    "not_delivered": "❌ No entregado",
    "cancelled": "🚫 Cancelado",
}

ERROR_MESSAGES = {
    "limit_exceeded": "Cap agotado — espera que el comprador responda primero",
    "forbidden": "Conversación bloqueada — revisa el estado de la orden",
    "bad_request": "Texto demasiado largo — máximo 350 caracteres",
    "conflict": "Solicitud en proceso — espera 3 segundos y reintenta",
    "server_error": "Error interno de MercadoLibre — reintenta en 1 minuto",
    "token_expired": "El token de MercadoLibre expiró — renuévalo",
    "timeout": "MercadoLibre no respondió a tiempo — reintenta",
    "http_error": "Error inesperado de MercadoLibre",
}


def map_error(res: dict) -> tuple[str, str]:
    """Devuelve (descripción legible, código) a partir de una respuesta ml_client."""
    code = res.get("error_code") or "http_error"
    desc = ERROR_MESSAGES.get(code, res.get("error") or "Error desconocido")
    status = res.get("status") or "—"
    return desc, str(status)


def _now_parts() -> tuple[str, str]:
    now = datetime.now()
    return now.strftime("%H:%M"), now.strftime("%d/%m/%Y")


# ── ESTADO 1 — Nueva venta ────────────────────────────────────
def fmt_new_sale(o: dict) -> str:
    hora, fecha = _now_parts()
    return (
        "🛒 <b>Nueva venta</b>\n"
        f"{SEP}\n"
        f"📦 <b>{esc(o.get('product'))}</b>\n"
        f"💰 <b>${money(o.get('amount'))} CLP</b>\n"
        f"👤 {esc(o.get('buyer_name'))}\n"
        f"🆔 Orden <code>#{esc(o.get('order_id'))}</code>\n"
        f"📬 {esc(o.get('shipping_type'))}\n"
        f"{SEP}\n"
        f"🕐 {hora} — {fecha}"
    )


# ── ESTADO 2 — Contactar comprador ────────────────────────────
def fmt_contact_options(o: dict) -> str:
    return (
        "💬 <b>Contactar comprador</b>\n"
        f"{SEP}\n"
        f"👤 {esc(o.get('buyer_name'))}\n"
        f"🆔 Orden <code>#{esc(o.get('order_id'))}</code>\n"
        f"{SEP}\n"
        "⚠️ Cuenta NEWBIE: usa plantilla o campo libre (máx 350 caracteres)\n\n"
        "Selecciona el motivo:"
    )


# ── ESTADO 3A — Confirmar plantilla ───────────────────────────
TEMPLATE_NAMES = {
    "REQUEST_VARIANTS": "REQUEST_VARIANTS",
    "REQUEST_BILLING_INFO": "REQUEST_BILLING_INFO",
}


def fmt_template_confirm(o: dict, option_id: str) -> str:
    return (
        "📋 <b>Confirmar envío de plantilla</b>\n"
        f"{SEP}\n"
        f"👤 Para: {esc(o.get('buyer_name'))}\n"
        f"📌 Tipo: {esc(option_id)}\n"
        f"{SEP}\n"
        "💬 Mensaje predefinido de MercadoLibre\n"
        "(el comprador verá el texto estándar de ML)\n"
        f"{SEP}\n"
        "¿Confirmas el envío?"
    )


# ── ESTADO 3B — Mensaje libre (intro) ─────────────────────────
def fmt_free_text_intro(o: dict) -> str:
    return (
        "✏️ <b>Mensaje libre al comprador</b>\n"
        f"{SEP}\n"
        f"👤 {esc(o.get('buyer_name'))} — Orden <code>#{esc(o.get('order_id'))}</code>\n"
        "⚠️ Máximo 350 caracteres\n"
        f"{SEP}\n"
        "Selecciona un mensaje rápido o escribe uno:"
    )


# ── ESTADO 4 — Preview ────────────────────────────────────────
def fmt_preview(o: dict, text: str) -> str:
    n = len(text)
    cuenta = f"📊 {n} / {config.MAX_MESSAGE_LENGTH} caracteres"
    if n > config.MAX_MESSAGE_LENGTH:
        cuenta += "\n⚠️ <b>Excede el límite — recorta el mensaje</b>"
    return (
        "👁 <b>Preview del mensaje</b>\n"
        f"{SEP}\n"
        f"📤 Para: {esc(o.get('buyer_name'))}\n"
        f"🆔 Orden <code>#{esc(o.get('order_id'))}</code>\n"
        f"{SEP}\n"
        f"💬 \"{esc(text)}\"\n"
        f"{SEP}\n"
        f"{cuenta}"
    )


# ── ESTADO 5 — Éxito ──────────────────────────────────────────
def fmt_success(o: dict) -> str:
    hora, _ = _now_parts()
    return (
        "✅ <b>Mensaje enviado</b>\n"
        f"{SEP}\n"
        f"👤 {esc(o.get('buyer_name'))}\n"
        f"🆔 Orden <code>#{esc(o.get('order_id'))}</code>\n"
        f"🕐 {hora}\n"
        f"{SEP}\n"
        "El comprador recibirá una notificación.\n"
        "Cuando responda, te avisaré aquí."
    )


# ── ESTADO 6 — Error ──────────────────────────────────────────
def fmt_error(o: dict, res: dict) -> str:
    desc, status = map_error(res)
    return (
        "❌ <b>Error al enviar</b>\n"
        f"{SEP}\n"
        f"🆔 Orden <code>#{esc(o.get('order_id'))}</code>\n"
        f"⚠️ {esc(desc)}\n"
        f"{SEP}\n"
        f"Código: <code>{esc(status)}</code>"
    )


# ── ESTADO 7 — Mensaje recibido del comprador ─────────────────
def fmt_buyer_message(o: dict, texto: str) -> str:
    return (
        "💬 <b>Respuesta del comprador</b>\n"
        f"{SEP}\n"
        f"👤 {esc(o.get('buyer_name'))}\n"
        f"🆔 Orden <code>#{esc(o.get('order_id'))}</code>\n"
        f"{SEP}\n"
        f"\"{esc(texto)}\"\n"
        f"{SEP}\n"
        "🟢 Ahora puedes responder libremente"
    )


# ── ESTADO 8 — Detalle de orden ───────────────────────────────
def fmt_order_detail(o: dict) -> str:
    pago = PAYMENT_STATUS.get(o.get("status"), f"❔ {esc(o.get('status'))}")
    envio = SHIPMENT_STATUS.get(o.get("shipment_status"), "—")
    tracking = o.get("tracking") or "—"
    conv = o.get("conversation") or "—"
    return (
        "📋 <b>Detalle de orden</b>\n"
        f"{SEP}\n"
        f"🆔 <code>#{esc(o.get('order_id'))}</code>\n"
        f"📦 {esc(o.get('product'))}\n"
        f"🔢 Cantidad: {esc(o.get('quantity'))}\n"
        f"{SEP}\n"
        f"💰 Total: ${money(o.get('amount'))} CLP\n"
        f"💳 Pago: {pago}\n"
        f"{SEP}\n"
        f"🚚 Envío: {esc(o.get('shipping_type'))}\n"
        f"📍 Tracking: <code>{esc(tracking)}</code>\n"
        f"📊 Estado: {envio}\n"
        f"{SEP}\n"
        f"💬 Conversación: {esc(conv)}"
    )


# ── ESTADO 9 — Menú principal ─────────────────────────────────
def fmt_main_menu(seller_name: str, ventas_hoy: int, monto_hoy, pendientes: int) -> str:
    hora, fecha = _now_parts()
    return (
        "🏪 <b>Panel de Postventa ML</b>\n"
        f"{SEP}\n"
        f"Hola, {esc(seller_name)}\n"
        f"{fecha} — {hora}\n"
        f"{SEP}\n"
        f"📊 Hoy: {ventas_hoy} ventas — ${money(monto_hoy)} CLP\n"
        f"💬 Pendientes: {pendientes} sin responder"
    )
