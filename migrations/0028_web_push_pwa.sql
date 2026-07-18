ALTER TABLE call_note_devices
  ADD COLUMN transport TEXT NOT NULL DEFAULT 'fcm'
    CHECK (transport IN ('fcm', 'webpush'));

CREATE INDEX IF NOT EXISTS idx_call_note_devices_transport_status
  ON call_note_devices(transport, status, updated_at DESC);
