"""
ml_client.py — Cliente async de la API de MercadoLibre (httpx).

Encapsula los endpoints de postventa: action guide (motivos para iniciar
conversación con cuentas NEWBIE), mensajería directa, órdenes y datos del
vendedor. Maneja reintentos (timeout / 5xx / 409) y normaliza la respuesta a:

    {"ok": bool, "status": int, "data": <json|None>, "error_code": str|None,
     "error": str|None}

`error_code` es una clave estable para mapear a texto en español (ver
formatters.map_error).
"""
import asyncio
import logging

import httpx

import config

log = logging.getLogger("ml_client")

_RETRY_STATUS = {409, 500, 502, 503, 504}


def _headers() -> dict:
    h = {"Accept": "application/json"}
    # Cuando se usa el Worker proxy, el Authorization lo inyecta el proxy.
    if not config.ML_USE_PROXY and config.ML_ACCESS_TOKEN:
        h["Authorization"] = f"Bearer {config.ML_ACCESS_TOKEN}"
    return h


def _classify(status: int, data) -> tuple[str | None, str | None]:
    """Devuelve (error_code, mensaje) a partir del status y el cuerpo de ML."""
    if 200 <= status < 300:
        return None, None
    msg = ""
    if isinstance(data, dict):
        msg = str(data.get("message") or data.get("error") or "")
    low = msg.lower()
    if status == 401:
        return "token_expired", msg or "Token expirado"
    if status == 403:
        if "limit" in low or "cap" in low:
            return "limit_exceeded", msg
        return "forbidden", msg
    if status == 400:
        return "bad_request", msg
    if status == 409:
        return "conflict", msg
    if status >= 500:
        return "server_error", msg or f"HTTP {status}"
    return "http_error", msg or f"HTTP {status}"


async def _request(method: str, path: str, *, params: dict | None = None,
                   json_body: dict | None = None) -> dict:
    """Request genérica con reintentos. `path` es relativo a ML_BASE_URL."""
    url = f"{config.ML_BASE_URL}{path}"
    last_exc = None
    for attempt in range(config.ML_MAX_RETRIES + 1):
        try:
            async with httpx.AsyncClient(timeout=config.ML_TIMEOUT) as client:
                resp = await client.request(
                    method, url, params=params, json=json_body, headers=_headers()
                )
            try:
                data = resp.json()
            except Exception:
                data = None

            if resp.status_code in _RETRY_STATUS and attempt < config.ML_MAX_RETRIES:
                await asyncio.sleep(1.5 * (attempt + 1))
                continue

            code, err = _classify(resp.status_code, data)
            return {
                "ok": resp.is_success,
                "status": resp.status_code,
                "data": data,
                "error_code": code,
                "error": err,
            }
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            last_exc = exc
            log.warning("Reintento %s por error de red en %s: %s", attempt, path, exc)
            if attempt < config.ML_MAX_RETRIES:
                await asyncio.sleep(1.5 * (attempt + 1))
                continue

    log.error("Falló request a %s tras reintentos: %s", path, last_exc)
    return {"ok": False, "status": 0, "data": None,
            "error_code": "timeout", "error": str(last_exc) if last_exc else "Sin respuesta"}


# ── Action Guide (iniciar conversación postventa) ─────────────
async def get_action_guide(pack_id: str) -> dict:
    """GET de las opciones del action guide para un pack."""
    return await _request(
        "GET", f"/messages/action_guide/packs/{pack_id}",
        params={"tag": config.ML_TAG},
    )


async def get_caps_available(pack_id: str) -> list:
    """
    Devuelve la lista de opciones con su cap disponible, en forma simplificada:
    [{"id": "OTHER", "type": "FREE_TEXT", "char_limit": 350, "cap_available": 1,
      "enabled": True, "template_id": "..."}].
    Lista vacía si el pack no expone opciones (conversación ya abierta/bloqueada).
    """
    res = await get_action_guide(pack_id)
    options = (res.get("data") or {}).get("options") or []
    out = []
    for opt in options:
        templates = opt.get("templates") or []
        out.append({
            "id": opt.get("id"),
            "type": opt.get("type"),
            "char_limit": opt.get("char_limit"),
            "cap_available": opt.get("cap_available", 0),
            "enabled": opt.get("enabled", False) and opt.get("actionable", False),
            "template_id": templates[0].get("id") if templates else None,
        })
    return out


async def send_action_guide_message(pack_id: str, option_id: str,
                                     text: str | None = None,
                                     template_id: str | None = None) -> dict:
    """
    POST de una opción del action guide. Para texto libre (OTHER /
    SEND_INVOICE_LINK) pasar `text`; para plantillas pasar `template_id`.
    """
    body: dict = {"option_id": option_id}
    if text is not None:
        body["text"] = text
    if template_id is not None:
        body["template_id"] = template_id
    return await _request(
        "POST", f"/messages/action_guide/packs/{pack_id}/option",
        params={"tag": config.ML_TAG}, json_body=body,
    )


# ── Mensajería directa (conversación ya abierta) ──────────────
async def send_direct_message(pack_id: str, seller_id: str, text: str) -> dict:
    """POST a /messages clásico. Solo funciona si la conversación está abierta."""
    body = {"from": {"user_id": seller_id}, "text": text}
    return await _request(
        "POST", f"/messages/packs/{pack_id}/sellers/{seller_id}",
        params={"tag": config.ML_TAG}, json_body=body,
    )


async def get_pack_messages(pack_id: str, seller_id: str, limit: int = 20) -> dict:
    """GET de la conversación de un pack (mensajes + conversation_status)."""
    return await _request(
        "GET", f"/messages/packs/{pack_id}/sellers/{seller_id}",
        params={"tag": config.ML_TAG, "mark_as_read": "false", "limit": limit},
    )


# ── Órdenes / vendedor ────────────────────────────────────────
async def get_order(order_id: str) -> dict:
    return await _request("GET", f"/orders/{order_id}")


async def get_shipment(shipment_id: str) -> dict:
    return await _request("GET", f"/shipments/{shipment_id}")


async def get_active_orders(seller_id: str, limit: int = 20) -> dict:
    return await _request(
        "GET", "/orders/search",
        params={"seller": seller_id, "sort": "date_desc", "limit": limit},
    )


async def get_seller_info(seller_id: str) -> dict:
    return await _request("GET", f"/users/{seller_id}")
