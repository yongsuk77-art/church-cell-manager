CREATE TABLE IF NOT EXISTS passkey_challenge_uses (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  used_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_passkey_challenge_uses_expires_at
  ON passkey_challenge_uses(expires_at);
