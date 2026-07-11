PRAGMA foreign_keys = ON;

ALTER TABLE sunday_attendance_records
  ADD COLUMN attendance_status TEXT NOT NULL DEFAULT 'absent';

UPDATE sunday_attendance_records
SET attendance_status = CASE WHEN present = 1 THEN 'present' ELSE 'absent' END;

CREATE INDEX IF NOT EXISTS idx_sunday_attendance_records_status
  ON sunday_attendance_records(attendance_status);

CREATE TABLE IF NOT EXISTS care_tasks (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  due_date TEXT NOT NULL,
  assignee TEXT DEFAULT '',
  note TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'cancelled')),
  source_type TEXT DEFAULT 'manual',
  source_id TEXT DEFAULT '',
  completed_at TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_care_tasks_member
  ON care_tasks(member_id, status, due_date);

CREATE INDEX IF NOT EXISTS idx_care_tasks_due
  ON care_tasks(status, due_date);

CREATE TABLE IF NOT EXISTS prayer_topics (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'praying'
    CHECK (status IN ('praying', 'answered', 'closed')),
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('normal', 'urgent')),
  answered_note TEXT DEFAULT '',
  source TEXT DEFAULT 'manual',
  started_at TEXT NOT NULL,
  answered_at TEXT DEFAULT '',
  closed_at TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_prayer_topics_member
  ON prayer_topics(member_id, status, started_at);

CREATE INDEX IF NOT EXISTS idx_prayer_topics_attention
  ON prayer_topics(status, priority, updated_at);

INSERT OR IGNORE INTO prayer_topics (
  id, member_id, content, status, priority, answered_note, source,
  started_at, answered_at, closed_at, created_at, updated_at
)
SELECT
  'profile-prayer-' || id,
  id,
  prayer_requests,
  'praying',
  'normal',
  '',
  'profile',
  COALESCE(NULLIF(updated_at, ''), CURRENT_TIMESTAMP),
  '',
  '',
  COALESCE(NULLIF(updated_at, ''), CURRENT_TIMESTAMP),
  COALESCE(NULLIF(updated_at, ''), CURRENT_TIMESTAMP)
FROM members
WHERE TRIM(COALESCE(prayer_requests, '')) <> '';
