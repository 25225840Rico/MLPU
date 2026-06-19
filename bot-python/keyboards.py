"""
keyboards.py — Botoneras inline (InlineKeyboardMarkup) por estado.

Convención de callback_data (prefijos para routing limpio, máx 64 bytes):
    nav:<accion>                  navegación general (menú, refresh, listas)
    ord:<accion>:<order_id>       acciones sobre una orden
    pv:<accion>:<order_id>[:x]    flujo de postventa / contacto
    msg:<accion>:<order_id>       respuesta a mensajes del comprador
    cfg:<accion>                  configuración

Los order_id de MLC tienen ~16 dígitos: cabe de sobra en 64 bytes.
"""
from telegram import InlineKeyboardButton as Btn, InlineKeyboardMarkup as Markup

import config

ML_ORDER_URL = "https://www.mercadolibre.cl/ventas/{order_id}/detalle"


# ── ESTADO 1 — Nueva venta ────────────────────────────────────
def kb_new_sale(order_id: str) -> Markup:
    return Markup([
        [Btn("💬 Contactar comprador", callback_data=f"pv:contact:{order_id}"),
         Btn("📋 Ver detalle", callback_data=f"ord:detail:{order_id}")],
        [Btn("✅ Marcar en preparación", callback_data=f"pv:prep:{order_id}"),
         Btn("🔗 Ver en ML", url=ML_ORDER_URL.format(order_id=order_id))],
    ])


# ── ESTADO 2 — Opciones de contacto ───────────────────────────
def kb_contact_options(order_id: str, options: list, conv_open: bool) -> Markup:
    """
    `options` es la lista normalizada de ml_client.get_caps_available.
    Si una opción tiene cap_available == 0 se muestra deshabilitada.
    Si la conversación NO está bloqueada, se ofrece respuesta directa.
    """
    by_id = {o["id"]: o for o in options}

    def opt_btn(option_id: str, label: str, target: str) -> Btn:
        o = by_id.get(option_id)
        if o is not None and o.get("cap_available", 0) == 0:
            return Btn(f"⛔ {label} (sin cap)", callback_data="pv:no_cap")
        return Btn(label, callback_data=target)

    rows = [
        [opt_btn("REQUEST_VARIANTS", "📦 Pedir variante", f"pv:tmpl:{order_id}:REQUEST_VARIANTS"),
         opt_btn("REQUEST_BILLING_INFO", "🧾 Datos de factura", f"pv:tmpl:{order_id}:REQUEST_BILLING_INFO")],
        [opt_btn("SEND_INVOICE_LINK", "🔗 Enviar link factura", f"pv:invoice:{order_id}"),
         opt_btn("OTHER", "✏️ Mensaje libre", f"pv:free:{order_id}")],
    ]
    if conv_open:
        rows.append([Btn("✏️ Respuesta directa", callback_data=f"pv:direct:{order_id}")])
    rows.append([Btn("← Volver", callback_data=f"ord:detail:{order_id}")])
    return Markup(rows)


# ── ESTADO 3A — Confirmar plantilla ───────────────────────────
def kb_template_confirm(order_id: str, option_id: str) -> Markup:
    return Markup([
        [Btn("✅ Confirmar envío", callback_data=f"pv:tmplsend:{order_id}:{option_id}"),
         Btn("❌ Cancelar", callback_data=f"pv:contact:{order_id}")],
    ])


# ── ESTADO 3B — Mensaje libre (mensajes rápidos) ──────────────
def kb_free_text(order_id: str) -> Markup:
    keys = list(config.QUICK_REPLIES.keys())
    rows = []
    for i in range(0, len(keys), 2):
        row = [
            Btn(config.QUICK_REPLY_LABELS[k], callback_data=f"pv:qr:{order_id}:{k}")
            for k in keys[i:i + 2]
        ]
        rows.append(row)
    rows.append([Btn("⌨️ Escribir mensaje propio", callback_data=f"pv:custom:{order_id}")])
    rows.append([Btn("← Volver", callback_data=f"pv:contact:{order_id}")])
    return Markup(rows)


# ── ESTADO 4 — Preview ────────────────────────────────────────
def kb_preview(order_id: str, too_long: bool) -> Markup:
    if too_long:
        return Markup([
            [Btn("✏️ Editar texto", callback_data=f"pv:edit:{order_id}")],
            [Btn("❌ Cancelar", callback_data=f"pv:contact:{order_id}")],
        ])
    return Markup([
        [Btn("✅ Enviar ahora", callback_data=f"pv:send:{order_id}"),
         Btn("✏️ Editar texto", callback_data=f"pv:edit:{order_id}")],
        [Btn("❌ Cancelar", callback_data=f"pv:contact:{order_id}")],
    ])


# ── ESTADO 5 — Éxito ──────────────────────────────────────────
def kb_success(order_id: str) -> Markup:
    return Markup([
        [Btn("📋 Ver orden completa", callback_data=f"ord:detail:{order_id}"),
         Btn("🏠 Menú principal", callback_data="nav:menu")],
    ])


# ── ESTADO 6 — Error ──────────────────────────────────────────
def kb_error(order_id: str) -> Markup:
    return Markup([
        [Btn("🔄 Reintentar", callback_data=f"pv:retry:{order_id}"),
         Btn("← Volver al inicio", callback_data=f"pv:contact:{order_id}")],
    ])


# ── ESTADO 7 — Mensaje recibido del comprador ─────────────────
def kb_buyer_message(order_id: str) -> Markup:
    return Markup([
        [Btn("✏️ Responder", callback_data=f"msg:reply:{order_id}"),
         Btn("📋 Ver historial", callback_data=f"msg:history:{order_id}")],
        [Btn("✅ No requiere respuesta", callback_data=f"msg:noreply:{order_id}"),
         Btn("🏠 Menú principal", callback_data="nav:menu")],
    ])


# ── ESTADO 8 — Detalle de orden ───────────────────────────────
def kb_order_detail(order_id: str) -> Markup:
    return Markup([
        [Btn("💬 Contactar comprador", callback_data=f"pv:contact:{order_id}"),
         Btn("🔗 Ver en ML", url=ML_ORDER_URL.format(order_id=order_id))],
        [Btn("🔄 Actualizar", callback_data=f"ord:refresh:{order_id}"),
         Btn("← Volver", callback_data="nav:menu")],
    ])


# ── ESTADO 9 — Menú principal ─────────────────────────────────
def kb_main_menu() -> Markup:
    return Markup([
        [Btn("📦 Ventas activas", callback_data="nav:orders"),
         Btn("💬 Mensajes pendientes", callback_data="nav:pending")],
        [Btn("📊 Resumen del día", callback_data="nav:summary"),
         Btn("🔄 Actualizar", callback_data="nav:refresh")],
        [Btn("⚙️ Configuración", callback_data="cfg:open")],
    ])


# ── Listas (ventas activas / pendientes) ──────────────────────
def kb_orders_list(orders: list) -> Markup:
    """orders: [{order_id, buyer_name, product}]. Un botón por orden."""
    rows = [[Btn(f"#{o['order_id']} · {o['buyer_name'][:18]}",
                 callback_data=f"ord:detail:{o['order_id']}")]
            for o in orders[:20]]
    rows.append([Btn("🏠 Menú principal", callback_data="nav:menu")])
    return Markup(rows)


def kb_back_menu() -> Markup:
    return Markup([[Btn("🏠 Menú principal", callback_data="nav:menu")]])


# ── Token expirado ────────────────────────────────────────────
def kb_token_expired() -> Markup:
    return Markup([[Btn("🔄 El token expiró — renuévalo en ML", callback_data="cfg:token")]])
