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
  claimed_en   TEXT, -- cuándo una corrida reclamó la fila ('publicando'); pasados RECOVERY_MIN (10 min) se recupera
  -- Fuente del ítem: 'ml' (por defecto, inventario de MercadoLibre) o 'drive'
  -- (inventario propio con fotos en Google Drive). Para 'drive': image_url =
  -- URL pública del proxy (/img/drive/<id>) y caption = texto ya armado; el
  -- publisher NO consulta ML para esas filas.
  fuente       TEXT NOT NULL DEFAULT 'ml',
  image_url    TEXT, -- solo fuente 'drive': foto pública (proxy del Worker)
  caption      TEXT  -- solo fuente 'drive': caption del feed ya armado
);
-- Migraciones sobre bases existentes:
--   ALTER TABLE ig_queue ADD COLUMN claimed_en TEXT;              (aplicada en remote 2026-07-16)
--   ALTER TABLE ig_queue ADD COLUMN prioridad INTEGER NOT NULL DEFAULT 0;  (aplicada en remote 2026-07-17)
--   ALTER TABLE ig_queue ADD COLUMN fuente/image_url/caption;     (ver migrate-drive.sql, 2026-07-20)

-- Índices (2026-07-26). Sin ellos cada operación del publisher recorre la tabla
-- entera, y la cola ya pasa de 400 filas:
--  · claimNext corre una vez POR PUBLICACIÓN (hasta 5 por tick, cada minuto) y
--    busca 'pendiente' [+ fuente] ordenando por prioridad DESC, id;
--  · el panel de /ig y los conteos del rush filtran por estado y por fuente;
--  · avisarCupoLleno y las historias vivas filtran por publicado_en.
-- Son índices parciales/compuestos: ocupan poco porque la mayoría de las filas
-- terminan en 'publicado' y quedan fuera del primero.
CREATE INDEX IF NOT EXISTS ix_ig_queue_claim
  ON ig_queue (fuente, prioridad DESC, id) WHERE estado='pendiente';
CREATE INDEX IF NOT EXISTS ix_ig_queue_estado    ON ig_queue (estado);
CREATE INDEX IF NOT EXISTS ix_ig_queue_publicado ON ig_queue (publicado_en);

-- Config clave/valor (JSON en valor): ventanas, ventanas_manual, meta_token, ultima_corrida
CREATE TABLE IF NOT EXISTS ig_config (
  clave          TEXT PRIMARY KEY,
  valor          TEXT NOT NULL,
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
