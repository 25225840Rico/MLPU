-- Migración 2026-07-20: soporte de inventario propio en Google Drive (fuente 'drive').
-- Añade a ig_queue las columnas para publicar fotos de Drive sin pasar por ML.
-- Aplicar UNA vez en remoto:
--   npx wrangler d1 execute mlpu-db --remote --file=worker/migrate-drive.sql
-- (Si alguna columna ya existe, SQLite dará "duplicate column"; ignorar esa línea.)
ALTER TABLE ig_queue ADD COLUMN fuente    TEXT NOT NULL DEFAULT 'ml';
ALTER TABLE ig_queue ADD COLUMN image_url TEXT;
ALTER TABLE ig_queue ADD COLUMN caption   TEXT;
