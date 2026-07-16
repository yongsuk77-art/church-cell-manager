ALTER TABLE notes
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1
  CHECK (revision >= 1);

ALTER TABLE notes
  ADD COLUMN deleted_at TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_notes_deleted_updated
  ON notes(deleted_at, pinned DESC, updated_at DESC, id);

DROP INDEX IF EXISTS idx_notes_scheduled_reminders;

CREATE INDEX IF NOT EXISTS idx_notes_scheduled_reminders
  ON notes(remind_at)
  WHERE deleted_at = ''
    AND reminder_state = 'scheduled'
    AND status = 'active';

CREATE TABLE IF NOT EXISTS note_sync_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  change_type TEXT NOT NULL CHECK (change_type IN ('upsert', 'delete')),
  changed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_note_sync_changes_note_sequence
  ON note_sync_changes(note_id, sequence DESC);

INSERT INTO note_sync_changes (note_id, revision, change_type, changed_at)
SELECT id, revision, 'upsert', updated_at
FROM notes
ORDER BY updated_at, id;

CREATE TRIGGER IF NOT EXISTS notes_sync_after_insert
AFTER INSERT ON notes
BEGIN
  INSERT INTO note_sync_changes (note_id, revision, change_type, changed_at)
  VALUES (
    NEW.id,
    NEW.revision,
    CASE WHEN NEW.deleted_at = '' THEN 'upsert' ELSE 'delete' END
    ,
    NEW.updated_at
  );
END;

CREATE TRIGGER IF NOT EXISTS notes_sync_after_live_hard_delete
AFTER DELETE ON notes
WHEN OLD.deleted_at = ''
BEGIN
  INSERT INTO note_sync_changes (note_id, revision, change_type, changed_at)
  VALUES (OLD.id, OLD.revision + 1, 'delete', OLD.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS notes_sync_after_revision_update
AFTER UPDATE OF revision ON notes
WHEN NEW.revision <> OLD.revision
BEGIN
  INSERT INTO note_sync_changes (note_id, revision, change_type, changed_at)
  VALUES (
    NEW.id,
    NEW.revision,
    CASE WHEN NEW.deleted_at = '' THEN 'upsert' ELSE 'delete' END
    ,
    NEW.updated_at
  );
END;
