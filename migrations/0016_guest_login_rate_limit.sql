CREATE TABLE IF NOT EXISTS auth_login_limits (
  scope TEXT PRIMARY KEY,
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  window_started_at INTEGER NOT NULL DEFAULT 0 CHECK (window_started_at >= 0),
  locked_until INTEGER NOT NULL DEFAULT 0 CHECK (locked_until >= 0),
  updated_at TEXT NOT NULL
);
