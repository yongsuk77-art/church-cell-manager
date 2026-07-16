CREATE TABLE IF NOT EXISTS note_categories (
  id TEXT PRIMARY KEY
    CHECK (
      id IN ('personal', 'visitation', 'admin')
      OR (
        id = lower(id)
        AND length(id) = 36
        AND substr(id, 9, 1) = '-'
        AND substr(id, 14, 1) = '-'
        AND substr(id, 19, 1) = '-'
        AND substr(id, 24, 1) = '-'
        AND length(replace(id, '-', '')) = 32
        AND lower(replace(id, '-', '')) NOT GLOB '*[^0-9a-f]*'
        AND substr(id, 15, 1) GLOB '[1-8]'
        AND substr(id, 20, 1) GLOB '[89ab]'
      )
    ),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  normalized_name TEXT NOT NULL COLLATE NOCASE UNIQUE
    CHECK (length(trim(normalized_name)) BETWEEN 1 AND 160),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (is_system = 1 AND id IN ('personal', 'visitation', 'admin'))
    OR (is_system = 0 AND id NOT IN ('personal', 'visitation', 'admin'))
  )
);

INSERT OR IGNORE INTO note_categories
  (id, name, normalized_name, is_system, created_at, updated_at)
VALUES
  ('personal', '개인', '개인', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('visitation', '심방', '심방', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('admin', '행정', '행정', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

ALTER TABLE notes ADD COLUMN category_id TEXT NOT NULL DEFAULT '';

UPDATE notes
SET category_id = CASE
  WHEN category IN ('personal', 'visitation', 'admin') THEN category
  ELSE 'personal'
END
WHERE category_id = '';

CREATE INDEX IF NOT EXISTS idx_notes_category_id
  ON notes(category_id, updated_at DESC);

CREATE TRIGGER IF NOT EXISTS notes_category_id_before_insert
BEFORE INSERT ON notes
WHEN NOT EXISTS (SELECT 1 FROM note_categories WHERE id = NEW.category_id)
BEGIN
  SELECT RAISE(ABORT, 'NOTE_CATEGORY_INVALID');
END;

CREATE TRIGGER IF NOT EXISTS notes_category_id_before_update
BEFORE UPDATE OF category_id ON notes
WHEN NOT EXISTS (SELECT 1 FROM note_categories WHERE id = NEW.category_id)
BEGIN
  SELECT RAISE(ABORT, 'NOTE_CATEGORY_INVALID');
END;

CREATE TRIGGER IF NOT EXISTS note_categories_in_use_before_delete
BEFORE DELETE ON note_categories
WHEN EXISTS (SELECT 1 FROM notes WHERE category_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'NOTE_CATEGORY_IN_USE');
END;

CREATE TRIGGER IF NOT EXISTS note_categories_system_before_delete
BEFORE DELETE ON note_categories
WHEN OLD.is_system = 1
BEGIN
  SELECT RAISE(ABORT, 'NOTE_CATEGORY_SYSTEM_PROTECTED');
END;
