import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationSql = readFileSync(
  new URL("../migrations/0017_visit_alarm_notifications.sql", import.meta.url),
  "utf8"
);

test("0017 preserves delivery state and backfills legacy alarms without replaying past ones", () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE members (id TEXT PRIMARY KEY);
    INSERT INTO members (id) VALUES ('member-1');
    CREATE TABLE visit_notes (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      visit_date TEXT NOT NULL,
      visit_type TEXT DEFAULT '심방',
      summary TEXT NOT NULL,
      prayer TEXT DEFAULT '',
      action TEXT DEFAULT '',
      source TEXT DEFAULT 'manual',
      raw_payload TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE call_note_devices (id TEXT PRIMARY KEY);
    CREATE TABLE call_note_push_deliveries (
      notification_id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('memo_reminder', 'connection_test')),
      reminder_id TEXT NOT NULL DEFAULT '',
      note_id TEXT NOT NULL DEFAULT '',
      device_id TEXT REFERENCES call_note_devices(id) ON DELETE SET NULL,
      device_generation INTEGER NOT NULL DEFAULT 0,
      scheduled_at TEXT NOT NULL,
      send_state TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      lease_token TEXT NOT NULL DEFAULT '',
      lease_expires_at TEXT NOT NULL DEFAULT '',
      target_revision_used INTEGER NOT NULL DEFAULT 0,
      fcm_message_name TEXT NOT NULL DEFAULT '',
      last_http_status INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT NOT NULL DEFAULT '',
      accepted_at TEXT NOT NULL DEFAULT '',
      received_at TEXT NOT NULL DEFAULT '',
      received_client_at TEXT NOT NULL DEFAULT '',
      displayed_at TEXT NOT NULL DEFAULT '',
      displayed_client_at TEXT NOT NULL DEFAULT '',
      opened_at TEXT NOT NULL DEFAULT '',
      opened_client_at TEXT NOT NULL DEFAULT '',
      failed_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT INTO visit_notes
      (id, member_id, visit_date, visit_type, summary, action, source, created_at)
    VALUES
      ('future-local', 'member-1', '2099-01-01', '알람', 'future local',
       'visit-meta:{"alarmAt":"2099-01-01T09:00"}', 'manual', '2098-12-01T00:00:00.000Z'),
      ('future-offset', 'member-1', '2099-01-01', '알람', 'future offset',
       'visit-meta:{"alarmAt":"2099-01-01T09:00:00+09:00"}', 'manual', '2098-12-01T00:00:00.000Z'),
      ('past', 'member-1', '2000-01-01', '알람', 'past',
       'visit-meta:{"alarmAt":"2000-01-01T09:00"}', 'manual', '1999-12-01T00:00:00.000Z'),
      ('trashed', 'member-1', '2099-01-01', '알람', 'trashed',
       'visit-meta:{"alarmAt":"2099-01-01T09:00","trashedAt":"2098-12-31T00:00:00.000Z"}',
       'manual', '2098-12-01T00:00:00.000Z'),
      ('imported', 'member-1', '2099-01-01', '알람', 'imported',
       'visit-meta:{"alarmAt":"2099-01-01T09:00"}', 'call-note-app', '2098-12-01T00:00:00.000Z'),
      ('malformed', 'member-1', '2099-01-01', '알람', 'malformed',
       'visit-meta:not-json', 'manual', '2098-12-01T00:00:00.000Z');

    INSERT INTO call_note_push_deliveries (
      notification_id, dedupe_key, kind, reminder_id, note_id, scheduled_at,
      send_state, attempt_count, next_attempt_at, received_at, displayed_at,
      opened_at, created_at, updated_at
    ) VALUES (
      'notification-1', 'memo:reminder-1', 'memo_reminder', 'reminder-1', 'note-1',
      '2099-01-01T00:00:00.000Z', 'accepted', 2, '2099-01-01T00:00:00.000Z',
      '2099-01-01T00:00:01.000Z', '2099-01-01T00:00:02.000Z',
      '2099-01-01T00:00:03.000Z', '2098-12-01T00:00:00.000Z',
      '2099-01-01T00:00:03.000Z'
    );
  `);

  sqlite.exec(migrationSql);

  const rows = sqlite.prepare(`
    SELECT id, alarm_at AS alarmAt, alarm_state AS alarmState, alarm_id AS alarmId,
      dismissed_at AS dismissedAt, updated_at AS updatedAt
    FROM visit_notes ORDER BY id
  `).all();
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  for (const id of ["future-local", "future-offset"]) {
    assert.equal(byId[id].alarmAt, "2099-01-01T00:00:00.000Z");
    assert.equal(byId[id].alarmState, "scheduled");
    assert.match(byId[id].alarmId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(byId[id].dismissedAt, "");
    assert.equal(byId[id].updatedAt, "2098-12-01T00:00:00.000Z");
  }
  for (const id of ["past", "trashed"]) {
    assert.ok(byId[id].alarmAt);
    assert.equal(byId[id].alarmState, "dismissed");
    assert.match(byId[id].alarmId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(byId[id].dismissedAt);
  }
  for (const id of ["imported", "malformed"]) {
    assert.equal(byId[id].alarmAt, "");
    assert.equal(byId[id].alarmState, "none");
    assert.equal(byId[id].alarmId, "");
  }

  const delivery = sqlite.prepare(`
    SELECT kind, visit_id AS visitId, send_state AS sendState, attempt_count AS attemptCount,
      received_at AS receivedAt, displayed_at AS displayedAt, opened_at AS openedAt
    FROM call_note_push_deliveries WHERE notification_id = 'notification-1'
  `).get();
  assert.deepEqual({ ...delivery }, {
    kind: "memo_reminder",
    visitId: "",
    sendState: "accepted",
    attemptCount: 2,
    receivedAt: "2099-01-01T00:00:01.000Z",
    displayedAt: "2099-01-01T00:00:02.000Z",
    openedAt: "2099-01-01T00:00:03.000Z"
  });
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  sqlite.close();
});
