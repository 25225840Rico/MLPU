-- Cola de publicaciones a Instagram (spec 2026-07-13-mlpu-instagram-design.md)
CREATE TABLE IF NOT EXISTS ig_queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ml_item_id   TEXT NOT NULL UNIQUE,
  titulo       TEXT NOT NULL,
  precio       INTEGER NOT NULL,
  permalink_ml TEXT,
  estado       TEXT NOT NULL DEFAULT 'pendiente', -- pendiente|publicado|error|cancelado
  intentos     INTEGER NOT NULL DEFAULT 0,
  ultimo_error TEXT,
  ig_media_id  TEXT,
  ig_story_id  TEXT,
  creado_en    TEXT NOT NULL DEFAULT (datetime('now')),
  publicado_en TEXT
);

-- Config clave/valor (JSON en valor): ventanas, ventanas_manual, meta_token, ultima_corrida
CREATE TABLE IF NOT EXISTS ig_config (
  clave          TEXT PRIMARY KEY,
  valor          TEXT NOT NULL,
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
