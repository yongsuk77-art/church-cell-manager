CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('pastor', 'cell_leader', 'viewer')),
  password_hash TEXT NOT NULL,
  can_view_sensitive INTEGER NOT NULL DEFAULT 0 CHECK (can_view_sensitive IN (0, 1)),
  can_edit INTEGER NOT NULL DEFAULT 1 CHECK (can_edit IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_login_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_app_users_status_role
  ON app_users(status, role, display_name);

CREATE TABLE IF NOT EXISTS app_user_cells (
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  cell_id TEXT NOT NULL REFERENCES cells(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, cell_id)
);

CREATE INDEX IF NOT EXISTS idx_app_user_cells_cell
  ON app_user_cells(cell_id, user_id);

ALTER TABLE auth_auto_login_tokens
  ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner';

ALTER TABLE call_note_devices
  ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner';

DROP INDEX IF EXISTS idx_call_note_devices_one_active;
DROP INDEX IF EXISTS idx_call_note_devices_one_pending;

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_note_devices_user_active
  ON call_note_devices(user_id)
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_note_devices_user_pending
  ON call_note_devices(user_id)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS pastoral_assignments (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL DEFAULT 'manual'
    CHECK (source_kind IN ('manual', 'birthday', 'new_family', 'attendance', 'care_gap', 'task', 'prayer')),
  source_key TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  assignee_user_id TEXT NOT NULL DEFAULT 'owner',
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'contacted', 'visit_planned', 'completed', 'cancelled')),
  due_date TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  completed_at TEXT NOT NULL DEFAULT '',
  created_by_user_id TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pastoral_assignments_source
  ON pastoral_assignments(source_kind, source_key)
  WHERE source_key <> '' AND status <> 'cancelled';

CREATE INDEX IF NOT EXISTS idx_pastoral_assignments_assignee
  ON pastoral_assignments(assignee_user_id, status, due_date);

CREATE INDEX IF NOT EXISTS idx_pastoral_assignments_member
  ON pastoral_assignments(member_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS newcomer_invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  max_submissions INTEGER NOT NULL DEFAULT 20 CHECK (max_submissions BETWEEN 1 AND 500),
  submission_count INTEGER NOT NULL DEFAULT 0 CHECK (submission_count >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by_user_id TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_newcomer_invites_active
  ON newcomer_invites(active, expires_at DESC);

CREATE TABLE IF NOT EXISTS newcomer_submissions (
  id TEXT PRIMARY KEY,
  invite_id TEXT NOT NULL REFERENCES newcomer_invites(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  birth TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  family_details TEXT NOT NULL DEFAULT '',
  consent_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  duplicate_member_ids TEXT NOT NULL DEFAULT '[]',
  desired_cell_id TEXT NOT NULL DEFAULT '',
  approved_member_id TEXT NOT NULL DEFAULT '',
  reviewer_user_id TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_newcomer_submissions_status
  ON newcomer_submissions(status, created_at DESC);

CREATE TABLE IF NOT EXISTS families (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by_user_id TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_families_name
  ON families(name);

CREATE TABLE IF NOT EXISTS family_members (
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL DEFAULT '',
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (family_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_family_members_member
  ON family_members(member_id, family_id);

CREATE TABLE call_note_push_deliveries_next (
  notification_id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('memo_reminder', 'visit_alarm', 'connection_test', 'today_pastoral', 'pastoral_assignment')),
  reminder_id TEXT NOT NULL DEFAULT '',
  note_id TEXT NOT NULL DEFAULT '',
  visit_id TEXT NOT NULL DEFAULT '',
  target_user_id TEXT NOT NULL DEFAULT 'owner',
  device_id TEXT REFERENCES call_note_devices(id) ON DELETE SET NULL,
  device_generation INTEGER NOT NULL DEFAULT 0 CHECK (device_generation >= 0),
  scheduled_at TEXT NOT NULL,
  send_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (send_state IN ('pending', 'sending', 'retry_wait', 'accepted', 'waiting_target', 'blocked_config', 'dead', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL,
  lease_token TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT NOT NULL DEFAULT '',
  target_revision_used INTEGER NOT NULL DEFAULT 0 CHECK (target_revision_used >= 0),
  fcm_message_name TEXT NOT NULL DEFAULT '',
  last_http_status INTEGER NOT NULL DEFAULT 0 CHECK (last_http_status >= 0),
  last_error_code TEXT NOT NULL DEFAULT '',
  accepted_at TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL DEFAULT '',
  received_client_at TEXT NOT NULL DEFAULT '',
  displayed_at TEXT NOT NULL DEFAULT '',
  displayed_client_at TEXT NOT NULL DEFAULT '',
  opened_at TEXT NOT NULL DEFAULT '',
  opened_client_at TEXT NOT NULL DEFAULT '',
  failed_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (kind = 'memo_reminder' AND reminder_id <> '' AND note_id <> '' AND visit_id = '')
    OR (kind = 'visit_alarm' AND reminder_id <> '' AND note_id = '' AND visit_id <> '')
    OR (kind = 'connection_test' AND reminder_id = '' AND note_id = '' AND visit_id = '')
    OR (kind = 'today_pastoral' AND reminder_id <> '' AND note_id = '' AND visit_id = '')
    OR (kind = 'pastoral_assignment' AND reminder_id <> '' AND note_id = '' AND visit_id = '')
  )
);

INSERT INTO call_note_push_deliveries_next (
  notification_id, dedupe_key, kind, reminder_id, note_id, visit_id,
  target_user_id, device_id, device_generation, scheduled_at, send_state,
  attempt_count, next_attempt_at, lease_token, lease_expires_at,
  target_revision_used, fcm_message_name, last_http_status, last_error_code,
  accepted_at, received_at, received_client_at, displayed_at,
  displayed_client_at, opened_at, opened_client_at, failed_at, created_at,
  updated_at
)
SELECT
  notification_id, dedupe_key, kind, reminder_id, note_id, visit_id,
  'owner', device_id, device_generation, scheduled_at, send_state,
  attempt_count, next_attempt_at, lease_token, lease_expires_at,
  target_revision_used, fcm_message_name, last_http_status, last_error_code,
  accepted_at, received_at, received_client_at, displayed_at,
  displayed_client_at, opened_at, opened_client_at, failed_at, created_at,
  updated_at
FROM call_note_push_deliveries;

DROP TABLE call_note_push_deliveries;

ALTER TABLE call_note_push_deliveries_next RENAME TO call_note_push_deliveries;

CREATE INDEX IF NOT EXISTS idx_call_note_push_due
  ON call_note_push_deliveries(send_state, next_attempt_at, lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_call_note_push_recent
  ON call_note_push_deliveries(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_call_note_push_device
  ON call_note_push_deliveries(device_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_call_note_push_target_user
  ON call_note_push_deliveries(target_user_id, send_state, next_attempt_at);
