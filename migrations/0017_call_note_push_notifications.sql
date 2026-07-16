ALTER TABLE notes ADD COLUMN reminder_id TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_reminder_id_unique
  ON notes(reminder_id)
  WHERE reminder_id <> '';

CREATE TABLE IF NOT EXISTS call_note_pair_codes (
  id TEXT PRIMARY KEY,
  code_hmac TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT NOT NULL DEFAULT '',
  invalidated_at TEXT NOT NULL DEFAULT '',
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0 AND failed_attempts <= 10),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_call_note_pair_codes_active
  ON call_note_pair_codes(expires_at DESC)
  WHERE used_at = '' AND invalidated_at = '';

CREATE TABLE IF NOT EXISTS call_note_pair_attempts (
  actor_hmac TEXT PRIMARY KEY,
  failures INTEGER NOT NULL CHECK (failures >= 0),
  window_started_at TEXT NOT NULL,
  locked_until TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_call_note_pair_attempts_updated
  ON call_note_pair_attempts(updated_at);

CREATE TABLE IF NOT EXISTS call_note_devices (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'unregistered', 'revoked')),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  credential_hmac TEXT NOT NULL UNIQUE,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('fid', 'registration_token')),
  target_ciphertext TEXT NOT NULL,
  target_fingerprint TEXT NOT NULL,
  target_revision INTEGER NOT NULL DEFAULT 1 CHECK (target_revision >= 1),
  registration_version INTEGER NOT NULL DEFAULT 0 CHECK (registration_version >= 0),
  registration_client_at TEXT NOT NULL DEFAULT '',
  crypto_version INTEGER NOT NULL DEFAULT 1 CHECK (crypto_version = 1),
  device_name TEXT NOT NULL DEFAULT '',
  app_version TEXT NOT NULL DEFAULT '',
  notification_permission TEXT NOT NULL DEFAULT 'unknown'
    CHECK (notification_permission IN ('unknown', 'granted', 'denied')),
  notifications_enabled INTEGER NOT NULL DEFAULT 0 CHECK (notifications_enabled IN (0, 1)),
  pair_code_id TEXT NOT NULL UNIQUE,
  paired_at TEXT NOT NULL,
  pending_expires_at TEXT NOT NULL DEFAULT '',
  activated_at TEXT NOT NULL DEFAULT '',
  last_registered_at TEXT NOT NULL DEFAULT '',
  last_seen_at TEXT NOT NULL DEFAULT '',
  revoked_at TEXT NOT NULL DEFAULT '',
  revoke_reason TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'pending' AND pending_expires_at <> '' AND activated_at = '' AND revoked_at = '')
    OR (status IN ('active', 'unregistered') AND pending_expires_at = '' AND activated_at <> '' AND revoked_at = '')
    OR (status = 'revoked' AND pending_expires_at = '' AND revoked_at <> '')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_note_devices_one_active
  ON call_note_devices(status)
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_note_devices_one_pending
  ON call_note_devices(status)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_call_note_devices_status_updated
  ON call_note_devices(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS call_note_push_deliveries (
  notification_id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('memo_reminder', 'connection_test')),
  reminder_id TEXT NOT NULL DEFAULT '',
  note_id TEXT NOT NULL DEFAULT '',
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
  CHECK ((kind = 'memo_reminder' AND reminder_id <> '' AND note_id <> '')
    OR (kind = 'connection_test' AND reminder_id = '' AND note_id = ''))
);

CREATE INDEX IF NOT EXISTS idx_call_note_push_due
  ON call_note_push_deliveries(send_state, next_attempt_at, lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_call_note_push_recent
  ON call_note_push_deliveries(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_call_note_push_device
  ON call_note_push_deliveries(device_id, created_at DESC);
