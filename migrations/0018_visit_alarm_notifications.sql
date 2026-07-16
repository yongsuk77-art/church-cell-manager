ALTER TABLE visit_notes ADD COLUMN alarm_at TEXT NOT NULL DEFAULT '';
ALTER TABLE visit_notes ADD COLUMN alarm_state TEXT NOT NULL DEFAULT 'none'
  CHECK (alarm_state IN ('none', 'scheduled', 'dismissed'));
ALTER TABLE visit_notes ADD COLUMN alarm_id TEXT NOT NULL DEFAULT '';
ALTER TABLE visit_notes ADD COLUMN dismissed_at TEXT NOT NULL DEFAULT '';
ALTER TABLE visit_notes ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

UPDATE visit_notes
SET updated_at = created_at
WHERE updated_at = '';

-- Legacy web alarms lived only in action JSON. Move them into canonical UTC
-- columns; past or trashed alarms become dismissed so they are never replayed.
WITH legacy_alarm_meta AS (
  SELECT
    id,
    CASE
      WHEN action LIKE 'visit-meta:%'
        AND json_valid(substr(action, length('visit-meta:') + 1))
      THEN COALESCE(
        CAST(json_extract(substr(action, length('visit-meta:') + 1), '$.alarmAt') AS TEXT),
        ''
      )
      ELSE ''
    END AS raw_alarm_at,
    CASE
      WHEN action LIKE 'visit-meta:%'
        AND json_valid(substr(action, length('visit-meta:') + 1))
      THEN COALESCE(
        CAST(json_extract(substr(action, length('visit-meta:') + 1), '$.trashedAt') AS TEXT),
        ''
      )
      ELSE ''
    END AS trashed_at
  FROM visit_notes
  WHERE visit_type = '알람' AND COALESCE(source, 'manual') = 'manual'
),
legacy_alarm_utc AS (
  SELECT
    id,
    trashed_at,
    CASE
      WHEN raw_alarm_at GLOB '????-??-??T??:??' AND length(raw_alarm_at) = 16
      THEN strftime('%Y-%m-%dT%H:%M:%fZ', raw_alarm_at, '-9 hours')
      ELSE strftime('%Y-%m-%dT%H:%M:%fZ', raw_alarm_at)
    END AS alarm_at_utc
  FROM legacy_alarm_meta
)
UPDATE visit_notes
SET
  alarm_at = (
    SELECT alarm_at_utc FROM legacy_alarm_utc WHERE legacy_alarm_utc.id = visit_notes.id
  ),
  alarm_state = CASE
    WHEN (
      SELECT trashed_at FROM legacy_alarm_utc WHERE legacy_alarm_utc.id = visit_notes.id
    ) <> '' THEN 'dismissed'
    WHEN julianday((
      SELECT alarm_at_utc FROM legacy_alarm_utc WHERE legacy_alarm_utc.id = visit_notes.id
    )) > julianday('now') THEN 'scheduled'
    ELSE 'dismissed'
  END,
  alarm_id = lower(hex(randomblob(4))) || '-' ||
    lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', 1 + (random() & 3), 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6))),
  dismissed_at = CASE
    WHEN (
      SELECT trashed_at FROM legacy_alarm_utc WHERE legacy_alarm_utc.id = visit_notes.id
    ) = '' AND julianday((
      SELECT alarm_at_utc FROM legacy_alarm_utc WHERE legacy_alarm_utc.id = visit_notes.id
    )) > julianday('now') THEN ''
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  END
WHERE id IN (
  SELECT id
  FROM legacy_alarm_utc
  WHERE alarm_at_utc IS NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_visit_notes_alarm_id_unique
  ON visit_notes(alarm_id)
  WHERE alarm_id <> '';

CREATE INDEX IF NOT EXISTS idx_visit_notes_scheduled_alarms
  ON visit_notes(alarm_at)
  WHERE alarm_state = 'scheduled';

CREATE TABLE call_note_push_deliveries_new (
  notification_id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('memo_reminder', 'visit_alarm', 'connection_test')),
  reminder_id TEXT NOT NULL DEFAULT '',
  note_id TEXT NOT NULL DEFAULT '',
  visit_id TEXT NOT NULL DEFAULT '',
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
  )
);

INSERT INTO call_note_push_deliveries_new (
  notification_id,
  dedupe_key,
  kind,
  reminder_id,
  note_id,
  visit_id,
  device_id,
  device_generation,
  scheduled_at,
  send_state,
  attempt_count,
  next_attempt_at,
  lease_token,
  lease_expires_at,
  target_revision_used,
  fcm_message_name,
  last_http_status,
  last_error_code,
  accepted_at,
  received_at,
  received_client_at,
  displayed_at,
  displayed_client_at,
  opened_at,
  opened_client_at,
  failed_at,
  created_at,
  updated_at
)
SELECT
  notification_id,
  dedupe_key,
  kind,
  reminder_id,
  note_id,
  '',
  device_id,
  device_generation,
  scheduled_at,
  send_state,
  attempt_count,
  next_attempt_at,
  lease_token,
  lease_expires_at,
  target_revision_used,
  fcm_message_name,
  last_http_status,
  last_error_code,
  accepted_at,
  received_at,
  received_client_at,
  displayed_at,
  displayed_client_at,
  opened_at,
  opened_client_at,
  failed_at,
  created_at,
  updated_at
FROM call_note_push_deliveries;

DROP TABLE call_note_push_deliveries;

ALTER TABLE call_note_push_deliveries_new RENAME TO call_note_push_deliveries;

CREATE INDEX IF NOT EXISTS idx_call_note_push_due
  ON call_note_push_deliveries(send_state, next_attempt_at, lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_call_note_push_recent
  ON call_note_push_deliveries(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_call_note_push_device
  ON call_note_push_deliveries(device_id, created_at DESC);
