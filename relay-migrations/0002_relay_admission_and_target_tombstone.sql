PRAGMA foreign_keys = ON;

-- Keep the highest site-wide device generation even after old target rows are
-- revoked or pruned. The matching device/revision fields make same-generation
-- updates monotonic without preventing a new device generation from starting
-- at target revision 1.
ALTER TABLE relay_sites ADD COLUMN max_device_generation INTEGER NOT NULL DEFAULT 0
  CHECK (max_device_generation >= 0);
ALTER TABLE relay_sites ADD COLUMN max_generation_device_id TEXT NOT NULL DEFAULT '';
ALTER TABLE relay_sites ADD COLUMN max_target_revision INTEGER NOT NULL DEFAULT 0
  CHECK (max_target_revision >= 0);

UPDATE relay_sites
SET max_device_generation = COALESCE((
      SELECT target.device_generation
      FROM relay_targets AS target
      WHERE target.site_id = relay_sites.site_id
      ORDER BY target.device_generation DESC, target.target_revision DESC, target.updated_at DESC
      LIMIT 1
    ), 0),
    max_generation_device_id = COALESCE((
      SELECT target.site_device_id
      FROM relay_targets AS target
      WHERE target.site_id = relay_sites.site_id
      ORDER BY target.device_generation DESC, target.target_revision DESC, target.updated_at DESC
      LIMIT 1
    ), ''),
    max_target_revision = COALESCE((
      SELECT target.target_revision
      FROM relay_targets AS target
      WHERE target.site_id = relay_sites.site_id
      ORDER BY target.device_generation DESC, target.target_revision DESC, target.updated_at DESC
      LIMIT 1
    ), 0);

-- This bounded, fixed-window admission counter is deliberately separate from
-- the existing delivery/target limits. It runs after HMAC verification but
-- before replay-nonce persistence and covers every clone endpoint.
CREATE TABLE IF NOT EXISTS relay_site_admission_limits (
  site_id TEXT PRIMARY KEY REFERENCES relay_sites(site_id) ON DELETE CASCADE,
  window_minute INTEGER NOT NULL CHECK (window_minute >= 0),
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  updated_at TEXT NOT NULL
);

-- Admission is capped at 90 accepted requests per fixed minute and nonces live
-- for ten minutes. Even at a minute boundary no site can legitimately retain
-- more than 990 rows, so 1,000 is a hard database safety ceiling.
CREATE TRIGGER IF NOT EXISTS trg_relay_replay_nonces_site_cap
BEFORE INSERT ON relay_replay_nonces
WHEN (
  SELECT COUNT(*) FROM relay_replay_nonces WHERE site_id = NEW.site_id
) >= 1000
BEGIN
  SELECT RAISE(ABORT, 'RELAY_NONCE_SITE_CAP');
END;
