import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationSql = readFileSync(
  new URL("../migrations/0029_today_pastoral_push.sql", import.meta.url),
  "utf8"
);

test("0029 preserves delivery history and adds a constrained today pastoral kind", () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE call_note_devices (id TEXT PRIMARY KEY);
    INSERT INTO call_note_devices (id) VALUES ('device-1');
    CREATE TABLE call_note_push_deliveries (
      notification_id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('memo_reminder', 'visit_alarm', 'connection_test')),
      reminder_id TEXT NOT NULL DEFAULT '',
      note_id TEXT NOT NULL DEFAULT '',
      visit_id TEXT NOT NULL DEFAULT '',
      device_id TEXT REFERENCES call_note_devices(id) ON DELETE SET NULL,
      device_generation INTEGER NOT NULL DEFAULT 0 CHECK (device_generation >= 0),
      scheduled_at TEXT NOT NULL,
      send_state TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at TEXT NOT NULL,
      lease_token TEXT NOT NULL DEFAULT '',
      lease_expires_at TEXT NOT NULL DEFAULT '',
      target_revision_used INTEGER NOT NULL DEFAULT 0 CHECK (target_revision_used >= 0),
      fcm_message_name TEXT NOT NULL DEFAULT '',
      last_http_status INTEGER NOT NULL DEFAULT 0 CHECK (last_http_status >= 0),
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
    INSERT INTO call_note_push_deliveries (
      notification_id, dedupe_key, kind, reminder_id, note_id, device_id,
      device_generation, scheduled_at, send_state, next_attempt_at, created_at, updated_at
    ) VALUES (
      'notification-existing', 'memo:existing', 'memo_reminder', 'reminder-existing',
      'note-existing', 'device-1', 3, '2026-07-17T00:00:00.000Z', 'accepted',
      '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z',
      '2026-07-17T00:00:01.000Z'
    );
  `);
  try {
    sqlite.exec(migrationSql);
    const preserved = sqlite.prepare(`
      SELECT notification_id AS notificationId, kind, reminder_id AS reminderId,
        note_id AS noteId, device_id AS deviceId, device_generation AS deviceGeneration,
        send_state AS sendState, updated_at AS updatedAt
      FROM call_note_push_deliveries WHERE notification_id = 'notification-existing'
    `).get();
    assert.deepEqual({ ...preserved }, {
      notificationId: "notification-existing",
      kind: "memo_reminder",
      reminderId: "reminder-existing",
      noteId: "note-existing",
      deviceId: "device-1",
      deviceGeneration: 3,
      sendState: "accepted",
      updatedAt: "2026-07-17T00:00:01.000Z"
    });

    sqlite.prepare(`
      INSERT INTO call_note_push_deliveries (
        notification_id, dedupe_key, kind, reminder_id, scheduled_at,
        next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, 'today_pastoral', ?, ?, ?, ?, ?)
    `).run(
      "notification-today",
      "today-pastoral:2026-07-18",
      "2026-07-18",
      "2026-07-17T23:00:00.000Z",
      "2026-07-17T23:00:00.000Z",
      "2026-07-17T22:59:30.000Z",
      "2026-07-17T22:59:30.000Z"
    );
    assert.equal(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM call_note_push_deliveries WHERE kind='today_pastoral'"
    ).get().count, 1);
    assert.throws(() => sqlite.prepare(`
      INSERT INTO call_note_push_deliveries (
        notification_id, dedupe_key, kind, reminder_id, scheduled_at,
        next_attempt_at, created_at, updated_at
      ) VALUES ('invalid-today', 'today-pastoral:invalid', 'today_pastoral', '',
        '2026-07-17T23:00:00.000Z', '2026-07-17T23:00:00.000Z',
        '2026-07-17T23:00:00.000Z', '2026-07-17T23:00:00.000Z')
    `).run(), /CHECK constraint failed/);
  } finally {
    sqlite.close();
  }
});
