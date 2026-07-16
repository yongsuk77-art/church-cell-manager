CREATE TABLE IF NOT EXISTS auth_auto_login_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  previous_token_hash TEXT NOT NULL DEFAULT '',
  previous_valid_until INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_auto_login_tokens_expires_at
  ON auth_auto_login_tokens(expires_at);
