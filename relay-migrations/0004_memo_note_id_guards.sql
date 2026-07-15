-- Apply this guard migration only after the relay Worker that writes note_id
-- has been deployed. Keeping it separate lets 0003 safely precede that deploy.
CREATE TRIGGER IF NOT EXISTS trg_relay_deliveries_note_id_insert
BEFORE INSERT ON relay_deliveries
WHEN (
  (NEW.type = 'memo_reminder' AND NEW.note_id = '')
  OR (NEW.type <> 'memo_reminder' AND NEW.note_id <> '')
)
BEGIN
  SELECT RAISE(ABORT, 'RELAY_DELIVERY_NOTE_ID_INVALID');
END;

CREATE TRIGGER IF NOT EXISTS trg_relay_deliveries_note_id_update
BEFORE UPDATE OF type, note_id ON relay_deliveries
WHEN (
  (NEW.type = 'memo_reminder' AND NEW.note_id = '')
  OR (NEW.type <> 'memo_reminder' AND NEW.note_id <> '')
)
BEGIN
  SELECT RAISE(ABORT, 'RELAY_DELIVERY_NOTE_ID_INVALID');
END;
