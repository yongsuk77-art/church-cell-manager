PRAGMA foreign_keys = ON;

-- A site creates a short-lived, one-use enrollment request that the central
-- Relay administrator can approve. The bearer token itself is never stored.
CREATE TABLE IF NOT EXISTS relay_enrollment_requests (
  request_id TEXT PRIMARY KEY,
  token_hmac TEXT NOT NULL UNIQUE,
  site_id TEXT NOT NULL,
  site_origin TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'invalidated')),
  expires_at TEXT NOT NULL,
  relay_base_url TEXT NOT NULL DEFAULT '',
  key_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT '',
  invalidated_at TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_enrollment_one_pending
  ON relay_enrollment_requests(status)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_relay_enrollment_expiry
  ON relay_enrollment_requests(status, expires_at);

-- Relay credentials are encrypted with a purpose-separated key derived from
-- NOTIFICATION_SECRET. Only one credential set belongs to this site.
CREATE TABLE IF NOT EXISTS relay_client_credentials (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  site_id TEXT NOT NULL,
  site_origin TEXT NOT NULL,
  relay_base_url TEXT NOT NULL,
  key_id TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT NOT NULL DEFAULT ''
);
