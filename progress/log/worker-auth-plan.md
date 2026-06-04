# Plan: Centralizar token ML en Cloudflare Worker (KV)

Fecha: 2026-06-04
Objetivo: mover access_token + refresh_token de localStorage por-celular a Workers KV, gestionado por el Worker. Dos usuarios comparten una cuenta ML sin pisarse el token.

## Estado actual (scout)

### worker/index.js (59 lineas) — proxy puro stateless
- `/ml/*` -> `api.mercadolibre.com/*`, reenvia el header Authorization del cliente.
- Sin KV, sin env, sin secrets.

### worker/wrangler.toml — solo name/main/compatibility_date

### src/App.jsx — auth en cliente
- Constantes: ML (l.6), TOKEN_TTL=21600 (l.9)
- localStorage keys: ml_token, ml_refresh_token, ml_client_secret, ml_app_id, token_obtained_at, proxy_url
- mlBase(path) l.363-366
- refreshAccessToken l.387-420
- exchangeCode l.423-458
- setInterval 60s auto-refresh l.461-469
- publish usa `Bearer ${token}` l.779 (upload) y l.811 (items)
- publishBatch usa `Bearer ${token}` l.911
- ONBOARDING UI l.1016-1090

## Diseno

### Principio
El Worker es la unica fuente de verdad del token ML. Inyecta `Authorization: Bearer <token>` en TODAS las rutas proxeadas leyendo de KV. El front deja de mandar el token. Si KV no esta configurado -> error 500 claro.

### KV
- Binding: `ML_TOKENS` (un solo namespace).
- Clave unica: `ml_session` (objeto JSON):
  ```json
  { "access_token": "...", "refresh_token": "...", "obtained_at": 1733280000000, "expires_in": 21600 }
  ```
- Secrets via env: `ML_CLIENT_ID`, `ML_CLIENT_SECRET` (wrangler secret put / vars).

## Cambios Worker (builder A)

Reescribir worker/index.js manteniendo el proxy, agregando:

1. **Helpers KV**: `getSession(env)`, `putSession(env, obj)`.
2. **`refreshIfNeeded(env)`**: si `obtained_at + expires_in*1000 - now < 300s`, hace POST a ML `/oauth/token` grant_type=refresh_token con ML_CLIENT_ID/SECRET, guarda nueva sesion en KV. Devuelve access_token vigente. Lock simple: re-lee KV justo antes de decidir (best-effort; KV es eventually consistent pero suficiente para 2 usuarios).
3. **`POST /ml/auth/init`**: body `{ code, redirect_uri }`. Exchange grant_type=authorization_code con secrets del env. Guarda sesion en KV. Responde `{ ok:true, expires_in }`. NO devuelve el token al cliente.
4. **`GET /ml/auth/status`**: lee KV. Responde `{ active:bool, secs_left:int, expires_at:int }`. Sin exponer tokens.
5. **Proxy existente `/ml/*`**: antes de reenviar, si la ruta NO es /ml/auth/* ni /ml/oauth/*, llama refreshIfNeeded, e **inyecta** `Authorization: Bearer <token>` (sobrescribe lo que mande el cliente). En 401 de ML: forzar refresh una vez y reintentar.
6. **Guard KV ausente**: si `env.ML_TOKENS` es undefined -> 500 `{ error: "KV ML_TOKENS no configurado" }`. Si faltan secrets en auth/init -> 500 claro.
7. CORS igual que hoy.

### wrangler.toml — agregar
```
[[kv_namespaces]]
binding = "ML_TOKENS"
id = "<PENDIENTE: crear con wrangler kv namespace create ML_TOKENS>"
```
(ML_CLIENT_ID/SECRET van como secrets, no en toml.)

## Cambios App.jsx (builder B)

1. **Eliminar gestion local de token**:
   - Quitar estados/efectos: token countdown puede quedar pero alimentado por /ml/auth/status, no por LS.
   - Quitar setInterval auto-refresh local (l.461-469) -> el Worker renueva. Opcional: poll a /ml/auth/status cada 60s para mostrar estado.
   - refreshAccessToken local: eliminar (l.387-420). El boton "renovar" puede llamar status o quitarse.
2. **exchangeCode -> initAuth**: en vez de POST /oauth/token directo, llamar `POST mlBase('/auth/init')` con `{ code, redirect_uri: 'https://httpbin.org/get' }`. Ya no guarda tokens en LS. Solo refleja exito.
3. **Estado de sesion**: nuevo `authStatus` desde `GET mlBase('/auth/status')` al montar y tras init. Mostrar activo/expira en ONBOARDING en lugar de tokenDraft.
4. **publish / publishBatch**: QUITAR el header `Authorization: Bearer ${token}` (l.779, 811, 911). El Worker lo inyecta. Dejar Content-Type donde aplique. NO romper el resto del payload.
5. **localStorage**: dejar de leer/escribir ml_token, ml_refresh_token, ml_client_secret, token_obtained_at. Mantener proxy_url, ml_app_id (app id sigue util para construir URL de autorizacion del Paso 1), anthropic_key.
6. **Client Secret**: ya NO se pide en el front (vive como secret del Worker). Quitar input de Client Secret del ONBOARDING o dejarlo informativo. Supuesto: quitarlo; el Worker tiene el secret.
7. **NO tocar**: Anthropic key, logica de fotos/atributos/precios, drafts/historial.

## Riesgos / supuestos
- Supuesto: una sola cuenta ML compartida -> una sola clave KV. Confirmado por el objetivo.
- Supuesto: redirect_uri httpbin se mantiene (no cambia el flujo de autorizacion manual del Paso 1).
- KV eventually consistent: con 2 usuarios el riesgo de pisada es bajo; refreshIfNeeded re-lee antes de escribir.
- El header Authorization inyectado por el Worker rompe cualquier llamada GET publica que no necesite token, pero ML ignora Authorization valido en endpoints publicos -> aceptable.

## IMPLEMENTADO (2026-06-04)
- worker/index.js reescrito: endpoints /ml/auth/init, /ml/auth/status, proxy con token inyectado desde KV, refresh proactivo (<5min) + reintento en 401, guards KV/secrets. `node --check` OK.
- worker/wrangler.toml: agregado binding KV ML_TOKENS (id placeholder) + comentario de secrets.
- src/App.jsx: eliminada gestion local de token (estados ml_token/ml_refresh_token/ml_client_secret/token_obtained_at, refreshAccessToken, exchangeCode, interval auto-refresh local, TOKEN_TTL). Nuevos: authStatus, fetchAuthStatus (poll 60s), initAuth. publish/publishBatch y fetch de categorias/comisiones ya NO mandan Authorization. ONBOARDING usa sessionActive; quitado input Client Secret. `vite build` OK.

## Config pendiente para el usuario (Cloudflare)
1. `wrangler kv namespace create ML_TOKENS` -> pegar id en wrangler.toml
2. `wrangler secret put ML_CLIENT_ID`
3. `wrangler secret put ML_CLIENT_SECRET`
4. `wrangler deploy`
5. Re-autorizar una vez (Paso 1 + Paso 2) para sembrar KV.
