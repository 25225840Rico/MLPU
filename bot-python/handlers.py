"""
handlers.py — Routing de callbacks, captura de texto libre y jobs de polling.

Diseño:
- Toda acción del flujo normal se ejecuta por botón → on_callback() despacha por
  prefijo y edita el mismo mensaje (editMessageText).
- answer_callback_query() se llama SIEMPRE primero.
- El texto libre solo se acepta cuando el bot lo pidió explícitamente
  (context.user_data["await"]); lo captura on_text() vía ForceReply.
- Estado de composición en context.user_data["compose"].
- Push: poll_orders_job (ventas nuevas) y poll_messages_job (respuestas del
  comprador) corren en el JobQueue.
"""
import logging
from datetime import datetime, timezone
from functools import wraps

from telegram import ForceReply, Update
from telegram.constants import ParseMode
from telegram.ext import ContextTypes

import config
import formatters as fmt
import keyboards as kb
import ml_client as ml

log = logging.getLogger("handlers")

HTML = ParseMode.HTML


# ── Autorización ──────────────────────────────────────────────
def authorized(func):
    @wraps(func)
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE):
        chat = update.effective_chat
        if chat is None or chat.id != config.AUTHORIZED_CHAT_ID:
            if update.callback_query:
                await update.callback_query.answer("Bot privado. Acceso no autorizado.", show_alert=True)
            elif update.message:
                await update.message.reply_text("Bot privado. Acceso no autorizado.")
            log.warning("Acceso no autorizado de chat_id=%s", getattr(chat, "id", "?"))
            return
        return await func(update, context)
    return wrapper


# ── Normalización de órdenes ──────────────────────────────────
def _buyer_name(buyer: dict) -> str:
    full = " ".join(x for x in [buyer.get("first_name"), buyer.get("last_name")] if x).strip()
    return full or buyer.get("nickname") or "Comprador"


def _shipping_type(shipment: dict | None) -> str:
    if not shipment:
        return "Mercado Envíos"
    return shipment.get("logistic_type") or shipment.get("shipping_mode") or "Mercado Envíos"


def normalize_order(order: dict, shipment: dict | None = None) -> dict:
    item = (order.get("order_items") or [{}])[0]
    buyer = order.get("buyer") or {}
    return {
        "order_id": str(order.get("id")),
        "product": (item.get("item") or {}).get("title") or "Producto",
        "quantity": item.get("quantity") or 1,
        "amount": order.get("total_amount"),
        "buyer_name": _buyer_name(buyer),
        "buyer_id": buyer.get("id"),
        "pack_id": str(order.get("pack_id") or order.get("id")),
        "seller_id": str((order.get("seller") or {}).get("id") or config.ML_SELLER_ID),
        "status": order.get("status") or "unknown",
        "shipment_id": (order.get("shipping") or {}).get("id"),
        "shipping_type": _shipping_type(shipment),
        "shipment_status": (shipment or {}).get("status"),
        "tracking": (shipment or {}).get("tracking_number"),
    }


async def fetch_order(context, order_id: str, *, with_shipment: bool = True,
                      with_conv: bool = False) -> dict | None:
    """Trae y normaliza una orden (con envío y, opcional, estado de conversación)."""
    res = await ml.get_order(order_id)
    if not res["ok"]:
        return None
    order = res["data"]
    shipment = None
    if with_shipment and (order.get("shipping") or {}).get("id"):
        sr = await ml.get_shipment(str(order["shipping"]["id"]))
        if sr["ok"]:
            shipment = sr["data"]
    o = normalize_order(order, shipment)
    if with_conv:
        o["conversation"] = await _conversation_label(o["pack_id"], o["seller_id"])
    # Cache liviano para refresh/preview.
    context.bot_data.setdefault("orders", {})[o["order_id"]] = o
    return o


def cached_order(context, order_id: str) -> dict:
    return context.bot_data.get("orders", {}).get(order_id, {"order_id": order_id, "buyer_name": "Comprador"})


async def _conversation_label(pack_id: str, seller_id: str) -> str:
    res = await ml.get_pack_messages(pack_id, seller_id, limit=1)
    status = ((res.get("data") or {}).get("conversation_status") or {}).get("status")
    if status == "blocked":
        return "🔒 Bloqueada (inicia con plantilla)"
    if status == "active":
        return "🟢 Abierta"
    return "—"


# ── Comandos ──────────────────────────────────────────────────
@authorized
async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await _show_main_menu(update, context, edit=False)


@authorized
async def cmd_menu(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await _show_main_menu(update, context, edit=False)


async def _day_stats(context) -> tuple[int, float, int]:
    """(ventas_hoy, monto_hoy, pendientes_sin_responder)."""
    res = await ml.get_active_orders(config.ML_SELLER_ID, limit=30)
    results = (res.get("data") or {}).get("results") or []
    today = datetime.now().date()
    ventas, monto = 0, 0.0
    for o in results:
        created = o.get("date_created", "")
        try:
            d = datetime.fromisoformat(created.replace("Z", "+00:00")).date()
        except ValueError:
            d = None
        if d == today and o.get("status") in ("paid", "confirmed"):
            ventas += 1
            monto += float(o.get("total_amount") or 0)
    pendientes = len(context.bot_data.get("pending_msgs", {}))
    return ventas, monto, pendientes


async def _show_main_menu(update: Update, context, edit: bool):
    ventas, monto, pend = await _day_stats(context)
    seller = context.bot_data.get("seller_name") or "vendedor"
    text = fmt.fmt_main_menu(seller, ventas, monto, pend)
    markup = kb.kb_main_menu()
    if edit and update.callback_query:
        await update.callback_query.edit_message_text(text, parse_mode=HTML, reply_markup=markup)
    else:
        await context.bot.send_message(config.AUTHORIZED_CHAT_ID, text, parse_mode=HTML, reply_markup=markup)


# ── Router de callbacks ───────────────────────────────────────
@authorized
async def on_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()  # SIEMPRE primero
    data = query.data or ""
    parts = data.split(":")
    prefix = parts[0]

    try:
        if prefix == "nav":
            await _nav(update, context, parts)
        elif prefix == "ord":
            await _ord(update, context, parts)
        elif prefix == "pv":
            await _pv(update, context, parts)
        elif prefix == "msg":
            await _msg(update, context, parts)
        elif prefix == "cfg":
            await _cfg(update, context, parts)
        else:
            await query.answer("Acción desconocida.", show_alert=True)
    except Exception:  # noqa: BLE001 — nunca crashear en un callback
        log.exception("Error en callback %s", data)
        await context.bot.send_message(
            config.AUTHORIZED_CHAT_ID,
            "⚠️ Ocurrió un error procesando esa acción. Revisa logs/bot.log.")


async def _nav(update, context, parts):
    action = parts[1]
    query = update.callback_query
    if action == "menu" or action == "refresh":
        await _show_main_menu(update, context, edit=True)
    elif action == "orders":
        res = await ml.get_active_orders(config.ML_SELLER_ID, limit=20)
        results = (res.get("data") or {}).get("results") or []
        orders = [{"order_id": str(o.get("id")),
                   "buyer_name": _buyer_name(o.get("buyer") or {}),
                   "product": ""}
                  for o in results if o.get("status") in ("paid", "confirmed")]
        if not orders:
            await query.edit_message_text("📦 No hay ventas activas.", reply_markup=kb.kb_back_menu())
            return
        await query.edit_message_text("📦 <b>Ventas activas</b>\nElige una orden:",
                                      parse_mode=HTML, reply_markup=kb.kb_orders_list(orders))
    elif action == "pending":
        pend = context.bot_data.get("pending_msgs", {})
        if not pend:
            await query.edit_message_text("💬 No hay mensajes pendientes.", reply_markup=kb.kb_back_menu())
            return
        orders = [{"order_id": oid, "buyer_name": v.get("buyer_name", "Comprador"), "product": ""}
                  for oid, v in pend.items()]
        await query.edit_message_text("💬 <b>Mensajes pendientes</b>\nElige una orden:",
                                      parse_mode=HTML, reply_markup=kb.kb_orders_list(orders))
    elif action == "summary":
        ventas, monto, pend = await _day_stats(context)
        txt = (f"📊 <b>Resumen del día</b>\n{fmt.SEP}\n"
               f"🛒 Ventas: {ventas}\n💰 Monto: ${fmt.money(monto)} CLP\n"
               f"💬 Pendientes: {pend}")
        await query.edit_message_text(txt, parse_mode=HTML, reply_markup=kb.kb_back_menu())


async def _ord(update, context, parts):
    action, order_id = parts[1], parts[2]
    query = update.callback_query
    if action in ("detail", "refresh"):
        o = await fetch_order(context, order_id, with_conv=True)
        if not o:
            await query.edit_message_text("⚠️ No pude obtener la orden.", reply_markup=kb.kb_back_menu())
            return
        await query.edit_message_text(fmt.fmt_order_detail(o), parse_mode=HTML,
                                      reply_markup=kb.kb_order_detail(order_id))


async def _pv(update, context, parts):
    action, order_id = parts[1], parts[2]
    query = update.callback_query

    if action == "no_cap":
        await query.answer("Sin cap disponible: espera que el comprador responda primero.", show_alert=True)
        return

    # Estado 2 — opciones de contacto (consulta action guide + estado de conv).
    if action == "contact":
        o = await fetch_order(context, order_id)
        if not o:
            await query.edit_message_text("⚠️ No pude obtener la orden.", reply_markup=kb.kb_back_menu())
            return
        options = await ml.get_caps_available(o["pack_id"])
        conv_res = await ml.get_pack_messages(o["pack_id"], o["seller_id"], limit=1)
        conv_status = ((conv_res.get("data") or {}).get("conversation_status") or {}).get("status")
        await query.edit_message_text(
            fmt.fmt_contact_options(o), parse_mode=HTML,
            reply_markup=kb.kb_contact_options(order_id, options, conv_open=(conv_status == "active")))
        return

    # Estado 3A — plantilla (preview de confirmación).
    if action == "tmpl":
        option_id = parts[3]
        o = cached_order(context, order_id)
        context.user_data["compose"] = {"order_id": order_id, "pack_id": o.get("pack_id"),
                                        "option_id": option_id, "mode": "template"}
        await query.edit_message_text(fmt.fmt_template_confirm(o, option_id), parse_mode=HTML,
                                      reply_markup=kb.kb_template_confirm(order_id, option_id))
        return

    if action == "tmplsend":
        option_id = parts[3]
        o = await fetch_order(context, order_id)
        options = await ml.get_caps_available(o["pack_id"]) if o else []
        template_id = next((x.get("template_id") for x in options if x["id"] == option_id), None)
        res = await ml.send_action_guide_message(o["pack_id"], option_id, template_id=template_id)
        await _finish_send(update, context, o, res)
        return

    # Estado 3B — mensaje libre: mostrar quick replies.
    if action == "free":
        o = cached_order(context, order_id)
        await query.edit_message_text(fmt.fmt_free_text_intro(o), parse_mode=HTML,
                                      reply_markup=kb.kb_free_text(order_id))
        return

    # Quick reply elegido → preview.
    if action == "qr":
        key = parts[3]
        text = config.QUICK_REPLIES.get(key, "")
        await _enter_preview(update, context, order_id, text, mode="action_guide", option_id="OTHER")
        return

    # Marcar en preparación → preloaded "confirmando" como mensaje de inicio.
    if action == "prep":
        text = config.QUICK_REPLIES["confirmando"]
        await _enter_preview(update, context, order_id, text, mode="action_guide", option_id="OTHER")
        return

    # Link de factura (texto libre con opción SEND_INVOICE_LINK).
    if action == "invoice":
        await _ask_free_text(update, context, order_id, mode="action_guide",
                             option_id="SEND_INVOICE_LINK",
                             prompt="🔗 Escribe el texto con el link de la factura (máx 350):")
        return

    # Escribir mensaje propio / editar.
    if action in ("custom", "edit"):
        compose = context.user_data.get("compose", {})
        mode = compose.get("mode", "action_guide")
        option_id = compose.get("option_id", "OTHER")
        await _ask_free_text(update, context, order_id, mode=mode, option_id=option_id,
                             prompt="✏️ Escribe tu mensaje (máx 350 caracteres):")
        return

    # Respuesta directa (conversación abierta).
    if action == "direct":
        await _ask_free_text(update, context, order_id, mode="direct", option_id=None,
                             prompt="✏️ Escribe tu respuesta (máx 350 caracteres):")
        return

    # Enviar el texto en preview.
    if action == "send":
        await _do_send(update, context, order_id)
        return

    # Reintentar el último envío.
    if action == "retry":
        await _do_send(update, context, order_id)
        return


async def _msg(update, context, parts):
    action, order_id = parts[1], parts[2]
    query = update.callback_query
    if action == "reply":
        await _ask_free_text(update, context, order_id, mode="direct", option_id=None,
                             prompt="✏️ Escribe tu respuesta (máx 350 caracteres):")
    elif action == "history":
        o = await fetch_order(context, order_id)
        res = await ml.get_pack_messages(o["pack_id"], o["seller_id"], limit=10) if o else {"data": {}}
        msgs = (res.get("data") or {}).get("messages") or []
        lines = []
        for m in msgs[-10:]:
            who = "Tú" if str((m.get("from") or {}).get("user_id")) == str(o["seller_id"]) else "Cliente"
            lines.append(f"<b>{who}:</b> {fmt.esc((m.get('text') or '')[:120])}")
        body = "\n".join(lines) or "Sin mensajes."
        await query.edit_message_text(f"📋 <b>Historial</b>\n{fmt.SEP}\n{body}",
                                      parse_mode=HTML, reply_markup=kb.kb_back_menu())
    elif action == "noreply":
        context.bot_data.get("pending_msgs", {}).pop(order_id, None)
        await query.edit_message_text("✅ Marcado como resuelto.", reply_markup=kb.kb_back_menu())


async def _cfg(update, context, parts):
    action = parts[1]
    query = update.callback_query
    if action == "token":
        await query.edit_message_text(
            "🔑 El token de MercadoLibre expiró.\nRenuévalo en tu Worker / panel ML y reinicia el bot.",
            reply_markup=kb.kb_back_menu())
    else:
        ml_mode = "Worker proxy" if config.ML_USE_PROXY else "API directa"
        await query.edit_message_text(
            f"⚙️ <b>Configuración</b>\n{fmt.SEP}\n"
            f"Seller: <code>{fmt.esc(config.ML_SELLER_ID)}</code>\n"
            f"Site: {fmt.esc(config.ML_SITE_ID)}\n"
            f"Conexión ML: {ml_mode}\n"
            f"Polling: cada {config.POLL_INTERVAL_SECONDS}s",
            parse_mode=HTML, reply_markup=kb.kb_back_menu())


# ── Composición / preview / envío ─────────────────────────────
async def _enter_preview(update, context, order_id, text, *, mode, option_id):
    o = cached_order(context, order_id)
    context.user_data["compose"] = {
        "order_id": order_id, "pack_id": o.get("pack_id"), "seller_id": o.get("seller_id"),
        "buyer_name": o.get("buyer_name"), "text": text, "mode": mode, "option_id": option_id,
    }
    too_long = len(text) > config.MAX_MESSAGE_LENGTH
    await update.callback_query.edit_message_text(
        fmt.fmt_preview(o, text), parse_mode=HTML, reply_markup=kb.kb_preview(order_id, too_long))


async def _ask_free_text(update, context, order_id, *, mode, option_id, prompt):
    """Activa la captura de texto libre con ForceReply (único punto con texto)."""
    o = cached_order(context, order_id)
    context.user_data["await"] = {
        "order_id": order_id, "pack_id": o.get("pack_id"), "seller_id": o.get("seller_id"),
        "buyer_name": o.get("buyer_name"), "mode": mode, "option_id": option_id,
    }
    await context.bot.send_message(config.AUTHORIZED_CHAT_ID, prompt,
                                   reply_markup=ForceReply(input_field_placeholder="máx 350 caracteres"))


@authorized
async def on_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Captura texto libre SOLO cuando el bot lo pidió (user_data['await'])."""
    pending = context.user_data.get("await")
    if not pending:
        return  # fuera de flujo: el bot es 100% botonera, ignoramos texto suelto
    context.user_data.pop("await", None)
    text = (update.message.text or "").strip()

    if len(text) > config.MAX_MESSAGE_LENGTH:
        await update.message.reply_text(
            f"⚠️ El mensaje tiene {len(text)} caracteres (máx {config.MAX_MESSAGE_LENGTH}). "
            "Vuelve a tocar el botón y recórtalo.")
        return

    o = cached_order(context, pending["order_id"])
    context.user_data["compose"] = {
        "order_id": pending["order_id"], "pack_id": pending["pack_id"],
        "seller_id": pending["seller_id"], "buyer_name": pending["buyer_name"],
        "text": text, "mode": pending["mode"], "option_id": pending["option_id"],
    }
    too_long = len(text) > config.MAX_MESSAGE_LENGTH
    await update.message.reply_text(fmt.fmt_preview(o, text), parse_mode=HTML,
                                    reply_markup=kb.kb_preview(pending["order_id"], too_long))


async def _do_send(update, context, order_id):
    compose = context.user_data.get("compose")
    o = cached_order(context, order_id)
    if not compose or compose.get("order_id") != order_id:
        await update.callback_query.edit_message_text(
            "⚠️ No hay un mensaje en preparación. Vuelve a empezar.", reply_markup=kb.kb_back_menu())
        return

    text = compose.get("text", "")
    if len(text) > config.MAX_MESSAGE_LENGTH:
        await update.callback_query.answer("El texto excede 350 caracteres.", show_alert=True)
        return

    mode = compose["mode"]
    pack_id, seller_id = compose["pack_id"], compose["seller_id"]
    if mode == "direct":
        res = await ml.send_direct_message(pack_id, seller_id, text)
    elif mode == "action_guide":
        res = await ml.send_action_guide_message(pack_id, compose.get("option_id", "OTHER"), text=text)
    else:
        res = {"ok": False, "error_code": "http_error", "status": 0}
    await _finish_send(update, context, o, res)


async def _finish_send(update, context, o, res):
    query = update.callback_query
    if res.get("ok"):
        context.bot_data.get("pending_msgs", {}).pop(o.get("order_id"), None)
        await query.edit_message_text(fmt.fmt_success(o), parse_mode=HTML,
                                      reply_markup=kb.kb_success(o.get("order_id")))
    else:
        await query.edit_message_text(fmt.fmt_error(o, res), parse_mode=HTML,
                                      reply_markup=kb.kb_error(o.get("order_id")))


# ── Jobs de polling (push) ────────────────────────────────────
async def poll_orders_job(context: ContextTypes.DEFAULT_TYPE):
    """Detecta ventas nuevas pagadas y empuja la card ESTADO 1."""
    res = await ml.get_active_orders(config.ML_SELLER_ID, limit=20)
    if res.get("error_code") == "token_expired":
        await context.bot.send_message(config.AUTHORIZED_CHAT_ID,
                                       "🔑 El token de MercadoLibre expiró.",
                                       reply_markup=kb.kb_token_expired())
        return
    results = (res.get("data") or {}).get("results") or []
    seen = context.bot_data.setdefault("seen_orders", set())
    seeded = context.bot_data.get("orders_seeded", False)

    for o in results:
        oid = str(o.get("id"))
        if oid in seen:
            continue
        seen.add(oid)
        if not seeded:
            continue  # primera corrida: sembrar sin notificar el histórico
        if o.get("status") != "paid":
            continue
        full = await fetch_order(context, oid)
        if not full:
            continue
        _track_pack(context, full)
        await context.bot.send_message(config.AUTHORIZED_CHAT_ID, fmt.fmt_new_sale(full),
                                       parse_mode=HTML, reply_markup=kb.kb_new_sale(oid))

    if not seeded:
        context.bot_data["orders_seeded"] = True
        log.info("Sembradas %d órdenes existentes (sin notificar).", len(seen))


def _track_pack(context, o: dict):
    packs = context.bot_data.setdefault("packs", {})
    packs[o["pack_id"]] = {
        "order_id": o["order_id"], "seller_id": o["seller_id"],
        "buyer_name": o["buyer_name"],
        "last_seen": packs.get(o["pack_id"], {}).get("last_seen"),
    }


async def poll_messages_job(context: ContextTypes.DEFAULT_TYPE):
    """Detecta respuestas nuevas del comprador y empuja la card ESTADO 7."""
    packs = context.bot_data.get("packs", {})
    for pack_id, info in list(packs.items()):
        res = await ml.get_pack_messages(pack_id, info["seller_id"], limit=10)
        if not res.get("ok"):
            continue
        msgs = (res.get("data") or {}).get("messages") or []
        last_seen = info.get("last_seen")
        newest = last_seen
        for m in msgs:
            from_id = str((m.get("from") or {}).get("user_id"))
            date = (m.get("message_date") or {}).get("created") or m.get("date_created")
            if from_id == str(info["seller_id"]):
                continue  # mensaje propio
            if last_seen and date and date <= last_seen:
                continue
            # Mensaje nuevo del comprador.
            o = await fetch_order(context, info["order_id"])
            if o:
                context.bot_data.setdefault("pending_msgs", {})[o["order_id"]] = {
                    "buyer_name": o["buyer_name"], "pack_id": pack_id}
                await context.bot.send_message(
                    config.AUTHORIZED_CHAT_ID, fmt.fmt_buyer_message(o, m.get("text") or ""),
                    parse_mode=HTML, reply_markup=kb.kb_buyer_message(o["order_id"]))
            if date and (not newest or date > newest):
                newest = date
        if newest != last_seen:
            info["last_seen"] = newest


# ── Manejo global de errores ──────────────────────────────────
async def on_error(update: object, context: ContextTypes.DEFAULT_TYPE):
    log.exception("Excepción no controlada", exc_info=context.error)
    try:
        await context.bot.send_message(
            config.AUTHORIZED_CHAT_ID,
            "⚠️ Error interno del bot. Revisa logs/bot.log para el detalle.")
    except Exception:  # noqa: BLE001
        pass
