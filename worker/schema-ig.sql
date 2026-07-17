-- Cola de publicaciones a Instagram (spec 2026-07-13-mlpu-instagram-design.md)
CREATE TABLE IF NOT EXISTS ig_queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ml_item_id   TEXT NOT NULL UNIQUE,
  titulo       TEXT NOT NULL,
  precio       INTEGER NOT NULL,
  permalink_ml TEXT,
  estado       TEXT NOT NULL DEFAULT 'pendiente', -- pendiente|publicando|publicado|error|cancelado
  intentos     INTEGER NOT NULL DEFAULT 0,
  ultimo_error TEXT,
  ig_media_id  TEXT, -- se guarda APENAS sale el feed (idempotencia: un reintento no lo repite)
  ig_story_id  TEXT,
  prioridad    INTEGER NOT NULL DEFAULT 0, -- interacciones del feed (requeueStories); el publisher saca primero la más alta
  creado_en    TEXT NOT NULL DEFAULT (datetime('now')),
  publicado_en TEXT,
  claimed_en   TEXT -- cuándo una corrida reclamó la fila ('publicando'); >15 min → se recupera
);
-- Migraciones sobre bases existentes:
--   ALTER TABLE ig_queue ADD COLUMN claimed_en TEXT;              (aplicada en remote 2026-07-16)
--   ALTER TABLE ig_queue ADD COLUMN prioridad INTEGER NOT NULL DEFAULT 0;  (aplicada en remote 2026-07-17)

-- Config clave/valor (JSON en valor): ventanas, ventanas_manual, meta_token, ultima_corrida
CREATE TABLE IF NOT EXISTS ig_config (
  clave          TEXT PRIMARY KEY,
  valor          TEXT NOT NULL,
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
