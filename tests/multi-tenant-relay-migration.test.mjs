import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationSql = readFileSync(
  new URL("../migrations/0019_notification_site_identity.sql", import.meta.url),
  "utf8"
);
const SITE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("0019 preserves existing community and notification data and adds safe relay defaults", () => {
  const sqlite = createPreMigrationDatabase();
  try {
    const before = snapshotExistingData(sqlite);
    sqlite.exec(migrationSql);

    assert.deepEqual(snapshotExistingData(sqlite), before);
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);

    const relay = sqlite.prepare(`
      SELECT relay_target_handle AS handle,
        relay_target_generation AS generation,
        relay_target_revision AS revision,
        relay_target_state AS state,
        relay_synced_at AS syncedAt
      FROM call_note_devices WHERE id = 'device-active'
    `).get();
    assert.deepEqual({ ...relay }, {
      handle: "",
      generation: 0,
      revision: 0,
      state: "none",
      syncedAt: ""
    });

    const settings = Object.fromEntries(sqlite.prepare(`
      SELECT key, value FROM app_settings
      WHERE key IN ('notification.siteId', 'notification.siteOrigin')
    `).all().map((row) => [row.key, row.value]));
    assert.match(settings["notification.siteId"], SITE_ID_PATTERN);
    assert.notEqual(settings["notification.siteId"], "00000000-0000-0000-0000-000000000000");
    assert.equal(settings["notification.siteOrigin"], "https://church-cell-manager.pages.dev");

    const indexes = new Set(sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='call_note_devices'"
    ).all().map((row) => row.name));
    assert.equal(indexes.has("idx_call_note_devices_relay_target_handle"), true);
    assert.equal(indexes.has("idx_call_note_devices_relay_target_state"), true);

    sqlite.prepare(`
      UPDATE call_note_devices
      SET relay_target_handle='target-handle-1', relay_target_state='active'
      WHERE id='device-active'
    `).run();
    assert.throws(() => sqlite.prepare(`
      UPDATE call_note_devices
      SET relay_target_handle='target-handle-1'
      WHERE id='device-revoked'
    `).run(), /unique/i);
    assert.throws(() => sqlite.prepare(`
      UPDATE call_note_devices SET relay_target_state='invalid'
      WHERE id='device-revoked'
    `).run(), /constraint/i);
  } finally {
    sqlite.close();
  }
});

test("0019 creates a different canonical site id for each fresh database", () => {
  const first = createPreMigrationDatabase();
  const second = createPreMigrationDatabase();
  try {
    first.exec(migrationSql);
    second.exec(migrationSql);
    const firstId = siteId(first);
    const secondId = siteId(second);
    assert.match(firstId, SITE_ID_PATTERN);
    assert.match(secondId, SITE_ID_PATTERN);
    assert.notEqual(firstId, secondId);
  } finally {
    first.close();
    second.close();
  }
});

test("0019 does not replace a previously fixed site identity", () => {
  const sqlite = createPreMigrationDatabase();
  const existingId = "123e4567-e89b-42d3-a456-426614174000";
  try {
    const insert = sqlite.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)");
    insert.run("notification.siteId", existingId, "2026-07-14T00:00:00.000Z");
    insert.run("notification.siteOrigin", "https://existing.example", "2026-07-14T00:00:00.000Z");
    sqlite.exec(migrationSql);
    assert.equal(siteId(sqlite), existingId);
    assert.equal(sqlite.prepare(
      "SELECT value FROM app_settings WHERE key='notification.siteOrigin'"
    ).get().value, "https://existing.example");
  } finally {
    sqlite.close();
  }
});

function createPreMigrationDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      memo TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      reminder_id TEXT NOT NULL,
      reminder_state TEXT NOT NULL,
      member_id TEXT REFERENCES members(id) ON DELETE SET NULL
    );

    CREATE TABLE visit_notes (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      summary TEXT NOT NULL,
      alarm_id TEXT NOT NULL,
      alarm_state TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE call_note_pair_codes (
      id TEXT PRIMARY KEY
    );

    CREATE TABLE call_note_devices (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      generation INTEGER NOT NULL,
      credential_hmac TEXT NOT NULL UNIQUE,
      target_kind TEXT NOT NULL,
      target_ciphertext TEXT NOT NULL,
      target_fingerprint TEXT NOT NULL,
      target_revision INTEGER NOT NULL,
      registration_version INTEGER NOT NULL,
      pair_code_id TEXT NOT NULL UNIQUE REFERENCES call_note_pair_codes(id),
      revoked_at TEXT NOT NULL DEFAULT '',
      revoke_reason TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE call_note_push_deliveries (
      notification_id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      reminder_id TEXT NOT NULL,
      note_id TEXT NOT NULL,
      visit_id TEXT NOT NULL,
      device_id TEXT REFERENCES call_note_devices(id) ON DELETE SET NULL,
      device_generation INTEGER NOT NULL,
      send_state TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      last_error_code TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      displayed_at TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT INTO members (id, name, memo)
      VALUES ('member-1', 'Member One', 'preserve member memo');
    INSERT INTO notes
      (id, title, body, status, reminder_id, reminder_state, member_id)
      VALUES ('note-1', 'Preserve note', 'private note body', 'active', 'reminder-1', 'scheduled', 'member-1');
    INSERT INTO visit_notes
      (id, member_id, summary, alarm_id, alarm_state, updated_at)
      VALUES ('visit-1', 'member-1', 'preserve visit', 'alarm-1', 'scheduled', '2026-07-14T00:00:00.000Z');
    INSERT INTO call_note_pair_codes (id) VALUES ('pair-active'), ('pair-revoked');
    INSERT INTO call_note_devices
      (id, status, generation, credential_hmac, target_kind, target_ciphertext,
       target_fingerprint, target_revision, registration_version, pair_code_id,
       revoked_at, revoke_reason, updated_at)
      VALUES
      ('device-active', 'active', 3, 'credential-active', 'fid', 'encrypted-active',
       'fingerprint-active', 4, 7, 'pair-active', '', '', '2026-07-14T00:00:00.000Z'),
      ('device-revoked', 'revoked', 2, 'credential-revoked', 'registration_token', 'encrypted-revoked',
       'fingerprint-revoked', 5, 8, 'pair-revoked', '2026-07-13T00:00:00.000Z',
       'device_disconnect', '2026-07-13T00:00:00.000Z');
    INSERT INTO call_note_push_deliveries
      (notification_id, dedupe_key, kind, reminder_id, note_id, visit_id, device_id,
       device_generation, send_state, attempt_count, last_error_code, accepted_at,
       received_at, displayed_at, opened_at, updated_at)
      VALUES
      ('notification-1', 'memo:reminder-1', 'memo_reminder', 'reminder-1', 'note-1', '',
       'device-active', 3, 'accepted', 2, '', '2026-07-14T00:00:01.000Z',
       '2026-07-14T00:00:02.000Z', '2026-07-14T00:00:03.000Z',
       '2026-07-14T00:00:04.000Z', '2026-07-14T00:00:04.000Z');
  `);
  return sqlite;
}

function snapshotExistingData(sqlite) {
  return {
    members: sqlite.prepare("SELECT * FROM members ORDER BY id").all(),
    notes: sqlite.prepare("SELECT * FROM notes ORDER BY id").all(),
    visits: sqlite.prepare("SELECT * FROM visit_notes ORDER BY id").all(),
    devices: sqlite.prepare(`
      SELECT id, status, generation, credential_hmac, target_kind, target_ciphertext,
        target_fingerprint, target_revision, registration_version, pair_code_id,
        revoked_at, revoke_reason, updated_at
      FROM call_note_devices ORDER BY id
    `).all(),
    deliveries: sqlite.prepare("SELECT * FROM call_note_push_deliveries ORDER BY notification_id").all()
  };
}

function siteId(sqlite) {
  return sqlite.prepare(
    "SELECT value FROM app_settings WHERE key='notification.siteId'"
  ).get().value;
}
