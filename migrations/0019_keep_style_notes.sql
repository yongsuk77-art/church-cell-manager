ALTER TABLE notes
  ADD COLUMN color TEXT NOT NULL DEFAULT 'default'
  CHECK (color IN ('default', 'coral', 'peach', 'yellow', 'sage', 'mint', 'blue', 'lavender', 'pink', 'gray'));

CREATE TABLE IF NOT EXISTS note_attachments (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_note_attachments_note_created
  ON note_attachments(note_id, created_at);
