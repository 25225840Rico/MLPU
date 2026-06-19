"""
main.py — Punto de entrada del bot de postventa ML.

- Configura logging con rotación diaria a logs/bot.log.
- Registra command handlers, el router de callbacks y el captador de texto.
- Programa los jobs de polling (ventas nuevas + respuestas del comprador).
- Corre en modo webhook (si WEBHOOK_URL está definido) o polling.
- Persiste el estado con PicklePersistence para sobrevivir reinicios.
"""
import logging
import os
from logging.handlers import TimedRotatingFileHandler

from telegram import Update
from telegram.ext import (
    Application, ApplicationBuilder, CallbackQueryHandler, CommandHandler,
    MessageHandler, PicklePersistence, filters,
)

import config
import handlers as h
import ml_client as ml


def setup_logging():
    os.makedirs(config.LOG_DIR, exist_ok=True)
    handler = TimedRotatingFileHandler(config.LOG_FILE, when="midnight",
                                       backupCount=14, encoding="utf-8")
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    handler.setFormatter(fmt)
    console = logging.StreamHandler()
    console.setFormatter(fmt)
    root = logging.getLogger()
    root.setLevel(getattr(logging, config.LOG_LEVEL.upper(), logging.INFO))
    root.addHandler(handler)
    root.addHandler(console)
    logging.getLogger("httpx").setLevel(logging.WARNING)


async def _post_init(app: Application):
    """Carga datos iniciales: nombre del vendedor para el menú."""
    res = await ml.get_seller_info(config.ML_SELLER_ID)
    if res.get("ok"):
        data = res["data"] or {}
        app.bot_data["seller_name"] = data.get("first_name") or data.get("nickname") or "vendedor"
    logging.getLogger("main").info("Bot inicializado. Seller: %s",
                                   app.bot_data.get("seller_name"))


def build_app() -> Application:
    persistence = PicklePersistence(filepath=config.PERSISTENCE_FILE)
    app = (ApplicationBuilder()
           .token(config.TELEGRAM_BOT_TOKEN)
           .persistence(persistence)
           .post_init(_post_init)
           .build())

    # Comandos
    app.add_handler(CommandHandler("start", h.cmd_start))
    app.add_handler(CommandHandler("menu", h.cmd_menu))

    # Router de callbacks (toda la botonera)
    app.add_handler(CallbackQueryHandler(h.on_callback))

    # Captura de texto libre (solo cuando el bot lo pidió con ForceReply)
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, h.on_text))

    # Errores globales
    app.add_error_handler(h.on_error)

    # Jobs de polling
    jq = app.job_queue
    jq.run_repeating(h.poll_orders_job, interval=config.POLL_INTERVAL_SECONDS,
                     first=5, name="poll_orders")
    jq.run_repeating(h.poll_messages_job, interval=config.POLL_INTERVAL_SECONDS,
                     first=15, name="poll_messages")
    return app


def main():
    setup_logging()
    config.validate()
    app = build_app()
    log = logging.getLogger("main")

    if config.WEBHOOK_URL:
        log.info("Arrancando en modo WEBHOOK: %s", config.WEBHOOK_URL)
        app.run_webhook(
            listen=config.WEBHOOK_LISTEN,
            port=config.WEBHOOK_PORT,
            url_path=config.TELEGRAM_BOT_TOKEN,
            webhook_url=f"{config.WEBHOOK_URL}/{config.TELEGRAM_BOT_TOKEN}",
            secret_token=config.WEBHOOK_SECRET or None,
            allowed_updates=Update.ALL_TYPES,
        )
    else:
        log.info("Arrancando en modo POLLING (sin WEBHOOK_URL).")
        app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
