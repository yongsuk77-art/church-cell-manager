INSERT OR IGNORE INTO app_settings (key, value, updated_at)
VALUES (
  'notification.siteId',
  lower(hex(randomblob(4))) || '-' ||
    lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', 1 + (random() & 3), 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6))),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

INSERT OR IGNORE INTO app_settings (key, value, updated_at)
VALUES (
  'notification.siteOrigin',
  'https://church-cell-manager.pages.dev',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

ALTER TABLE call_note_devices
  ADD COLUMN relay_target_handle TEXT NOT NULL DEFAULT '';

ALTER TABLE call_note_devices
  ADD COLUMN relay_target_generation INTEGER NOT NULL DEFAULT 0
    CHECK (relay_target_generation >= 0);

ALTER TABLE call_note_devices
  ADD COLUMN relay_target_revision INTEGER NOT NULL DEFAULT 0
    CHECK (relay_target_revision >= 0);

ALTER TABLE call_note_devices
  ADD COLUMN relay_target_state TEXT NOT NULL DEFAULT 'none'
    CHECK (relay_target_state IN ('none', 'active', 'unregistered', 'revoked'));

ALTER TABLE call_note_devices
  ADD COLUMN relay_synced_at TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_note_devices_relay_target_handle
  ON call_note_devices(relay_target_handle)
  WHERE relay_target_handle <> '';

CREATE INDEX IF NOT EXISTS idx_call_note_devices_relay_target_state
  ON call_note_devices(relay_target_state, relay_synced_at);
