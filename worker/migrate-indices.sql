-- Índices de rendimiento de la cola de Instagram (2026-07-26).
-- Aplicar a la base REMOTA con:
--   npx wrangler d1 execute mlpu-db --remote --file=migrate-indices.sql   (desde worker/)
-- Es idempotente (IF NOT EXISTS) y no toca datos: solo agrega índices.
--
-- Por qué: claimNext corre una vez por publicación (hasta 5 por tick del cron,
-- cada minuto) y hoy recorre las ~470 filas de ig_queue para encontrar la
-- siguiente 'pendiente'. Lo mismo el panel de /ig y los conteos del rush.

CREATE INDEX IF NOT EXISTS ix_ig_queue_claim
  ON ig_queue (fuente, prioridad DESC, id) WHERE estado='pendiente';
CREATE INDEX IF NOT EXISTS ix_ig_queue_estado    ON ig_queue (estado);
CREATE INDEX IF NOT EXISTS ix_ig_queue_publicado ON ig_queue (publicado_en);
