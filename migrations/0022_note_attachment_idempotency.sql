ALTER TABLE note_attachments
  ADD COLUMN client_attachment_id TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_note_attachments_note_client_id
  ON note_attachments(note_id, client_attachment_id)
  WHERE client_attachment_id <> '';
