DROP TRIGGER IF EXISTS note_categories_system_before_delete;

DROP TRIGGER IF EXISTS notes_category_id_before_insert;
DROP TRIGGER IF EXISTS notes_category_id_before_update;

CREATE TRIGGER notes_category_id_before_insert
BEFORE INSERT ON notes
WHEN NEW.category_id <> ''
  AND NOT EXISTS (SELECT 1 FROM note_categories WHERE id = NEW.category_id)
BEGIN
  SELECT RAISE(ABORT, 'NOTE_CATEGORY_INVALID');
END;

CREATE TRIGGER notes_category_id_before_update
BEFORE UPDATE OF category_id ON notes
WHEN NEW.category_id <> ''
  AND NOT EXISTS (SELECT 1 FROM note_categories WHERE id = NEW.category_id)
BEGIN
  SELECT RAISE(ABORT, 'NOTE_CATEGORY_INVALID');
END;
