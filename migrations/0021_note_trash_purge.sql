ALTER TABLE notes
  ADD COLUMN purge_started_at TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_notes_trash_purge
  ON notes(deleted_at, purge_started_at, id)
  WHERE deleted_at <> '';
