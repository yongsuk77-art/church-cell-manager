PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS relay_sites (
  site_id TEXT PRIMARY KEY,
  site_origin TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS relay_site_keys (
  site_id TEXT NOT NULL REFERENCES relay_sites(site_id) ON DELETE CASCADE,
  key_id TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('current', 'previous', 'revoked')),
  verify_until TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  previous_at TEXT NOT NULL DEFAULT '',
  revoked_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (site_id, key_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_site_keys_one_current
  ON relay_site_keys(site_id)
  WHERE status = 'current';

CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_site_keys_one_previous
  ON relay_site_keys(site_id)
  WHERE status = 'previous';

CREATE INDEX IF NOT EXISTS idx_relay_site_keys_verify
  ON relay_site_keys(site_id, status, verify_until);

CREATE TABLE IF NOT EXISTS relay_replay_nonces (
  site_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  request_timestamp INTEGER NOT NULL CHECK (request_timestamp > 0),
  seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (site_id, key_id, nonce_hash),
  FOREIGN KEY (site_id, key_id)
    REFERENCES relay_site_keys(site_id, key_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_relay_replay_nonces_expiry
  ON relay_replay_nonces(expires_at);

CREATE TABLE IF NOT EXISTS relay_targets (
  target_handle TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES relay_sites(site_id) ON DELETE RESTRICT,
  site_device_id TEXT NOT NULL,
  target_kind TEXT NOT NULL
    CHECK (target_kind IN ('fid', 'registration_token')),
  target_ciphertext TEXT NOT NULL,
  target_fingerprint TEXT NOT NULL,
  device_generation INTEGER NOT NULL CHECK (device_generation >= 0),
  target_revision INTEGER NOT NULL CHECK (target_revision >= 1),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'unregistered', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_registered_at TEXT NOT NULL,
  unregistered_at TEXT NOT NULL DEFAULT '',
  revoked_at TEXT NOT NULL DEFAULT '',
  UNIQUE (site_id, site_device_id),
  UNIQUE (site_id, target_handle)
);

-- One active Firebase destination may belong to only one site/device binding.
-- This is the server-side safety boundary until the Android client supports a
-- relay challenge proving possession of the target during pairing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_targets_active_fingerprint
  ON relay_targets(target_fingerprint)
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_targets_one_active_per_site
  ON relay_targets(site_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_relay_targets_site_status
  ON relay_targets(site_id, status, updated_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_relay_targets_site_cap
BEFORE INSERT ON relay_targets
WHEN (
  SELECT COUNT(*) FROM relay_targets WHERE site_id = NEW.site_id
) >= 100
BEGIN
  SELECT RAISE(ABORT, 'RELAY_TARGET_SITE_CAP');
END;

CREATE TABLE IF NOT EXISTS relay_deliveries (
  site_id TEXT NOT NULL REFERENCES relay_sites(site_id) ON DELETE RESTRICT,
  notification_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  target_handle TEXT NOT NULL,
  device_generation INTEGER NOT NULL CHECK (device_generation >= 0),
  target_revision INTEGER NOT NULL CHECK (target_revision >= 1),
  type TEXT NOT NULL
    CHECK (type IN ('memo_reminder', 'visit_alarm', 'connection_test')),
  reminder_id TEXT NOT NULL DEFAULT '',
  scheduled_at TEXT NOT NULL,
  route TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('processing', 'accepted', 'unregistered', 'retry', 'blocked', 'dead')),
  outcome TEXT NOT NULL DEFAULT ''
    CHECK (outcome IN ('', 'accepted', 'unregistered', 'retry', 'blocked', 'dead')),
  http_status INTEGER NOT NULL DEFAULT 0 CHECK (http_status >= 0),
  error_code TEXT NOT NULL DEFAULT '',
  retry_after_ms INTEGER NOT NULL DEFAULT 0 CHECK (retry_after_ms >= 0),
  message_name TEXT NOT NULL DEFAULT '',
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_token TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT NOT NULL DEFAULT '',
  next_attempt_at TEXT NOT NULL DEFAULT '',
  accepted_at TEXT NOT NULL DEFAULT '',
  completed_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (site_id, notification_id, device_generation, target_revision),
  FOREIGN KEY (site_id, target_handle)
    REFERENCES relay_targets(site_id, target_handle) ON DELETE RESTRICT,
  CHECK (
    (type IN ('memo_reminder', 'visit_alarm') AND reminder_id <> '')
    OR (type = 'connection_test' AND reminder_id = '')
  )
);

CREATE INDEX IF NOT EXISTS idx_relay_deliveries_recovery
  ON relay_deliveries(state, next_attempt_at, lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_relay_deliveries_target
  ON relay_deliveries(site_id, target_handle, created_at DESC);

-- A hard database-level ceiling complements the configurable lower limit in
-- the Worker and remains effective under concurrent inserts.
CREATE TRIGGER IF NOT EXISTS trg_relay_deliveries_site_cap
BEFORE INSERT ON relay_deliveries
WHEN (
  SELECT COUNT(*) FROM relay_deliveries WHERE site_id = NEW.site_id
) >= 10000
BEGIN
  SELECT RAISE(ABORT, 'RELAY_DELIVERY_SITE_CAP');
END;

CREATE TABLE IF NOT EXISTS relay_site_rate_limits (
  site_id TEXT NOT NULL REFERENCES relay_sites(site_id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('delivery', 'target')),
  window_minute INTEGER NOT NULL CHECK (window_minute >= 0),
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (site_id, scope)
);

CREATE TABLE IF NOT EXISTS relay_admin_audit (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL
    CHECK (action IN ('site.create', 'site.key.rotate', 'site.revoke')),
  site_id TEXT NOT NULL,
  key_id TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL CHECK (result IN ('success', 'failure')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_relay_admin_audit_site_time
  ON relay_admin_audit(site_id, created_at DESC);
