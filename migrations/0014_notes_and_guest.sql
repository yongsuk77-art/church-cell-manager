CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('personal', 'visitation', 'admin')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done')),
  member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  group_id TEXT REFERENCES managed_groups(id) ON DELETE SET NULL,
  remind_at TEXT NOT NULL DEFAULT '',
  reminder_state TEXT NOT NULL DEFAULT 'none' CHECK (reminder_state IN ('none', 'scheduled', 'dismissed')),
  dismissed_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (reminder_state = 'none' AND remind_at = '' AND dismissed_at = '')
    OR (reminder_state = 'scheduled' AND remind_at <> '' AND dismissed_at = '')
    OR (reminder_state = 'dismissed' AND remind_at <> '' AND dismissed_at <> '')
  )
);

CREATE INDEX IF NOT EXISTS idx_notes_status_category_updated
  ON notes(status, category, pinned DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_notes_member_id
  ON notes(member_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_notes_group_id
  ON notes(group_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_notes_scheduled_reminders
  ON notes(remind_at)
  WHERE reminder_state = 'scheduled' AND status = 'active';
