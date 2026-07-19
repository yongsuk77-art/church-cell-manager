PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS churches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  join_enabled INTEGER NOT NULL DEFAULT 1 CHECK (join_enabled IN (0, 1)),
  created_by_user_id TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO churches (
  id, name, status, join_enabled, created_by_user_id, created_at, updated_at
) VALUES (
  'church-seosan', '서산교회', 'active', 1, 'owner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);

ALTER TABLE cells
  ADD COLUMN church_id TEXT NOT NULL DEFAULT 'church-seosan';

ALTER TABLE cells
  ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_cells_church_sort
  ON cells(church_id, sort_order, name);

ALTER TABLE app_users
  ADD COLUMN last_church_id TEXT NOT NULL DEFAULT 'church-seosan';

CREATE TABLE IF NOT EXISTS church_memberships (
  church_id TEXT NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('pastor', 'cell_leader', 'viewer')),
  can_view_sensitive INTEGER NOT NULL DEFAULT 0 CHECK (can_view_sensitive IN (0, 1)),
  can_edit INTEGER NOT NULL DEFAULT 0 CHECK (can_edit IN (0, 1)),
  can_manage_members INTEGER NOT NULL DEFAULT 0 CHECK (can_manage_members IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
  requested_at TEXT NOT NULL,
  approved_at TEXT NOT NULL DEFAULT '',
  approved_by_user_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (church_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_church_memberships_user_status
  ON church_memberships(user_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_church_memberships_church_status
  ON church_memberships(church_id, status, role, updated_at DESC);

INSERT OR IGNORE INTO church_memberships (
  church_id, user_id, role, can_view_sensitive, can_edit, can_manage_members,
  status, requested_at, approved_at, approved_by_user_id, created_at, updated_at
)
SELECT
  'church-seosan', id, role, can_view_sensitive, can_edit, 0,
  CASE status WHEN 'active' THEN 'active' ELSE 'disabled' END,
  created_at,
  CASE status WHEN 'active' THEN created_at ELSE '' END,
  CASE status WHEN 'active' THEN 'owner' ELSE '' END,
  created_at, updated_at
FROM app_users;

CREATE TABLE IF NOT EXISTS church_membership_cells (
  church_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  cell_id TEXT NOT NULL REFERENCES cells(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (church_id, user_id, cell_id),
  FOREIGN KEY (church_id, user_id)
    REFERENCES church_memberships(church_id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_church_membership_cells_cell
  ON church_membership_cells(church_id, cell_id, user_id);

INSERT OR IGNORE INTO church_membership_cells (church_id, user_id, cell_id, created_at)
SELECT 'church-seosan', user_id, cell_id, created_at
FROM app_user_cells;

-- The legacy pastor role had implicit access to every cell. Preserve that access
-- as explicit grants so all non-owner accounts use the same cell-scope rule.
INSERT OR IGNORE INTO church_membership_cells (church_id, user_id, cell_id, created_at)
SELECT 'church-seosan', user.id, cell.id, CURRENT_TIMESTAMP
FROM app_users user
CROSS JOIN cells cell
WHERE user.role = 'pastor' AND user.status = 'active';

CREATE TABLE IF NOT EXISTS church_settings (
  church_id TEXT NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (church_id, key)
);

INSERT OR IGNORE INTO church_settings (church_id, key, value, updated_at)
SELECT 'church-seosan', key, value, updated_at
FROM app_settings
WHERE key = 'app.communityTitle';

INSERT OR IGNORE INTO church_settings (church_id, key, value, updated_at)
VALUES ('church-seosan', 'app.communityTitle', '청년공동체 목양웹', CURRENT_TIMESTAMP);

ALTER TABLE auth_auto_login_tokens
  ADD COLUMN church_id TEXT NOT NULL DEFAULT 'church-seosan';

ALTER TABLE call_note_devices
  ADD COLUMN church_id TEXT NOT NULL DEFAULT 'church-seosan';

DROP INDEX IF EXISTS idx_call_note_devices_user_active;
DROP INDEX IF EXISTS idx_call_note_devices_user_pending;

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_note_devices_user_church_active
  ON call_note_devices(user_id, church_id)
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_note_devices_user_church_pending
  ON call_note_devices(user_id, church_id)
  WHERE status = 'pending';

ALTER TABLE call_note_push_deliveries
  ADD COLUMN church_id TEXT NOT NULL DEFAULT 'church-seosan';

CREATE INDEX IF NOT EXISTS idx_call_note_push_church_due
  ON call_note_push_deliveries(church_id, send_state, next_attempt_at);

ALTER TABLE notes
  ADD COLUMN church_id TEXT NOT NULL DEFAULT 'church-seosan';

CREATE INDEX IF NOT EXISTS idx_notes_church_updated
  ON notes(church_id, deleted_at, pinned DESC, updated_at DESC);

DROP TRIGGER IF EXISTS notes_category_id_before_insert;
DROP TRIGGER IF EXISTS notes_category_id_before_update;
DROP TRIGGER IF EXISTS note_categories_in_use_before_delete;
DROP TRIGGER IF EXISTS note_categories_system_before_delete;

CREATE TABLE note_categories_next (
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
  church_id TEXT NOT NULL DEFAULT 'church-seosan'
    REFERENCES churches(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  normalized_name TEXT NOT NULL COLLATE NOCASE
    CHECK (length(trim(normalized_name)) BETWEEN 1 AND 160),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (church_id, normalized_name)
);

INSERT INTO note_categories_next (
  id, church_id, name, normalized_name, is_system, created_at, updated_at
)
SELECT id, 'church-seosan', name, normalized_name, is_system, created_at, updated_at
FROM note_categories;

DROP TABLE note_categories;
ALTER TABLE note_categories_next RENAME TO note_categories;

CREATE INDEX IF NOT EXISTS idx_note_categories_church_sort
  ON note_categories(church_id, is_system DESC, name COLLATE NOCASE, id);

CREATE TRIGGER notes_category_id_before_insert
BEFORE INSERT ON notes
WHEN NEW.category_id <> ''
  AND NOT EXISTS (
    SELECT 1 FROM note_categories
    WHERE id = NEW.category_id AND church_id = NEW.church_id
  )
BEGIN
  SELECT RAISE(ABORT, 'NOTE_CATEGORY_INVALID');
END;

CREATE TRIGGER notes_category_id_before_update
BEFORE UPDATE OF category_id, church_id ON notes
WHEN NEW.category_id <> ''
  AND NOT EXISTS (
    SELECT 1 FROM note_categories
    WHERE id = NEW.category_id AND church_id = NEW.church_id
  )
BEGIN
  SELECT RAISE(ABORT, 'NOTE_CATEGORY_INVALID');
END;

CREATE TRIGGER note_categories_in_use_before_delete
BEFORE DELETE ON note_categories
WHEN EXISTS (
  SELECT 1 FROM notes
  WHERE category_id = OLD.id AND church_id = OLD.church_id
)
BEGIN
  SELECT RAISE(ABORT, 'NOTE_CATEGORY_IN_USE');
END;

ALTER TABLE note_sync_changes
  ADD COLUMN church_id TEXT NOT NULL DEFAULT 'church-seosan';

CREATE INDEX IF NOT EXISTS idx_note_sync_changes_church_sequence
  ON note_sync_changes(church_id, sequence);

DROP TRIGGER IF EXISTS notes_sync_after_insert;
DROP TRIGGER IF EXISTS notes_sync_after_live_hard_delete;
DROP TRIGGER IF EXISTS notes_sync_after_revision_update;

CREATE TRIGGER notes_sync_after_insert
AFTER INSERT ON notes
BEGIN
  INSERT INTO note_sync_changes (note_id, revision, change_type, changed_at, church_id)
  VALUES (
    NEW.id, NEW.revision,
    CASE WHEN NEW.deleted_at = '' THEN 'upsert' ELSE 'delete' END,
    NEW.updated_at, NEW.church_id
  );
END;

CREATE TRIGGER notes_sync_after_live_hard_delete
AFTER DELETE ON notes
WHEN OLD.deleted_at = ''
BEGIN
  INSERT INTO note_sync_changes (note_id, revision, change_type, changed_at, church_id)
  VALUES (OLD.id, OLD.revision + 1, 'delete', OLD.updated_at, OLD.church_id);
END;

CREATE TRIGGER notes_sync_after_revision_update
AFTER UPDATE OF revision ON notes
WHEN NEW.revision <> OLD.revision
BEGIN
  INSERT INTO note_sync_changes (note_id, revision, change_type, changed_at, church_id)
  VALUES (
    NEW.id, NEW.revision,
    CASE WHEN NEW.deleted_at = '' THEN 'upsert' ELSE 'delete' END,
    NEW.updated_at, NEW.church_id
  );
END;

ALTER TABLE managed_groups
  ADD COLUMN church_id TEXT NOT NULL DEFAULT 'church-seosan';

DROP INDEX IF EXISTS idx_managed_groups_name_unique_nocase;

CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_groups_church_name_unique
  ON managed_groups(church_id, name COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_managed_groups_church_sort
  ON managed_groups(church_id, sort_order, name);

ALTER TABLE newcomer_invites
  ADD COLUMN church_id TEXT NOT NULL DEFAULT 'church-seosan';

CREATE INDEX IF NOT EXISTS idx_newcomer_invites_church_active
  ON newcomer_invites(church_id, active, expires_at DESC);

ALTER TABLE families
  ADD COLUMN church_id TEXT NOT NULL DEFAULT 'church-seosan';

CREATE INDEX IF NOT EXISTS idx_families_church_name
  ON families(church_id, name);

ALTER TABLE pastoral_assignments
  ADD COLUMN church_id TEXT NOT NULL DEFAULT 'church-seosan';

DROP INDEX IF EXISTS idx_pastoral_assignments_source;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pastoral_assignments_church_source
  ON pastoral_assignments(church_id, source_kind, source_key)
  WHERE source_key <> '' AND status <> 'cancelled';

CREATE INDEX IF NOT EXISTS idx_pastoral_assignments_church_due
  ON pastoral_assignments(church_id, status, due_date);

ALTER TABLE call_note_imports
  ADD COLUMN church_id TEXT NOT NULL DEFAULT 'church-seosan';

ALTER TABLE audit_logs
  ADD COLUMN church_id TEXT NOT NULL DEFAULT 'church-seosan';

CREATE INDEX IF NOT EXISTS idx_audit_logs_church_created
  ON audit_logs(church_id, created_at DESC);

CREATE TABLE sunday_attendance_sessions_next (
  id TEXT PRIMARY KEY,
  church_id TEXT NOT NULL DEFAULT 'church-seosan',
  attendance_date TEXT NOT NULL,
  label TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (church_id, attendance_date)
);

CREATE TABLE sunday_attendance_records_next (
  session_id TEXT NOT NULL REFERENCES sunday_attendance_sessions_next(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  member_name TEXT NOT NULL,
  member_title TEXT DEFAULT '',
  member_role TEXT DEFAULT '',
  member_long_absent INTEGER NOT NULL DEFAULT 0,
  cell_id TEXT NOT NULL,
  cell_name TEXT NOT NULL,
  cell_sort_order INTEGER DEFAULT 0,
  photo_key TEXT DEFAULT '',
  present INTEGER NOT NULL DEFAULT 0,
  attendance_status TEXT NOT NULL DEFAULT 'absent',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (session_id, member_id)
);

INSERT INTO sunday_attendance_sessions_next (
  id, church_id, attendance_date, label, created_at, updated_at
)
SELECT id, 'church-seosan', attendance_date, label, created_at, updated_at
FROM sunday_attendance_sessions;

INSERT INTO sunday_attendance_records_next (
  session_id, member_id, member_name, member_title, member_role,
  member_long_absent, cell_id, cell_name, cell_sort_order, photo_key,
  present, attendance_status, created_at, updated_at
)
SELECT
  session_id, member_id, member_name, member_title, member_role,
  member_long_absent, cell_id, cell_name, cell_sort_order, photo_key,
  present, attendance_status, created_at, updated_at
FROM sunday_attendance_records;

DROP TABLE sunday_attendance_records;
DROP TABLE sunday_attendance_sessions;

ALTER TABLE sunday_attendance_sessions_next RENAME TO sunday_attendance_sessions;
ALTER TABLE sunday_attendance_records_next RENAME TO sunday_attendance_records;

CREATE INDEX IF NOT EXISTS idx_sunday_attendance_sessions_date
  ON sunday_attendance_sessions(church_id, attendance_date DESC);

CREATE INDEX IF NOT EXISTS idx_sunday_attendance_records_session
  ON sunday_attendance_records(session_id);

CREATE INDEX IF NOT EXISTS idx_sunday_attendance_records_member
  ON sunday_attendance_records(member_id);

CREATE INDEX IF NOT EXISTS idx_sunday_attendance_records_status
  ON sunday_attendance_records(attendance_status);
