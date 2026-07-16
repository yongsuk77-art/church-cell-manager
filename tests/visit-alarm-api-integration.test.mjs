import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { onRequest } from "../functions/api/[[path]].js";

test("visit alarm API reschedules atomically and cancels the previous delivery", async () => {
  const sqlite = createDatabase();
  const env = { DB: d1Adapter(sqlite) };
  const createdResponse = await apiRequest(env, ["visit-notes"], "POST", {
    id: "visit-1",
    memberId: "member-1",
    visitDate: "2026-07-14",
    visitType: "알람",
    summary: "Call again",
    action: "visit-meta:{\"alarmAt\":\"2026-07-14T10:30:00+09:00\"}",
    alarmAt: "2026-07-14T10:30:00+09:00",
    alarmState: "scheduled",
    source: "manual"
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.alarmAt, "2026-07-14T01:30:00.000Z");
  assert.equal(created.alarmState, "scheduled");
  assert.ok(created.updatedAt);

  sqlite.prepare(`
    INSERT INTO call_note_push_deliveries
      (notification_id, reminder_id, visit_id, kind, send_state, lease_token, lease_expires_at,
       last_error_code, failed_at, updated_at)
    VALUES ('notification-old', ?, 'visit-1', 'visit_alarm', 'waiting_target', '', '', '', '', '')
  `).run(created.alarmId);

  const updatedResponse = await apiRequest(env, ["visit-notes", "visit-1"], "PATCH", {
    expectedUpdatedAt: created.updatedAt,
    alarmAt: "2026-07-14T11:30:00+09:00",
    alarmState: "scheduled",
    action: "visit-meta:{\"alarmAt\":\"2026-07-14T11:30:00+09:00\"}"
  });
  assert.equal(updatedResponse.status, 200);
  const updated = await updatedResponse.json();
  assert.notEqual(updated.alarmId, created.alarmId);
  assert.equal(updated.alarmAt, "2026-07-14T02:30:00.000Z");
  const oldDelivery = sqlite.prepare(
    "SELECT send_state AS sendState, last_error_code AS errorCode FROM call_note_push_deliveries WHERE notification_id='notification-old'"
  ).get();
  assert.equal(oldDelivery.sendState, "cancelled");
  assert.equal(oldDelivery.errorCode, "VISIT_ALARM_CHANGED");

  const staleResponse = await apiRequest(env, ["visit-notes", "visit-1"], "PATCH", {
    expectedUpdatedAt: created.updatedAt,
    summary: "Stale overwrite"
  });
  assert.equal(staleResponse.status, 409);
  sqlite.close();
});

test("dismissing and deleting a visit alarm cancel nonterminal delivery rows", async () => {
  const sqlite = createDatabase();
  const env = { DB: d1Adapter(sqlite) };
  const createdResponse = await apiRequest(env, ["visit-notes"], "POST", {
    id: "visit-2",
    memberId: "member-1",
    visitType: "알람",
    summary: "Reminder",
    alarmAt: "2026-07-14T10:30:00+09:00",
    action: "visit-meta:{\"alarmAt\":\"2026-07-14T10:30:00+09:00\"}",
    source: "manual"
  });
  const created = await createdResponse.json();
  sqlite.prepare(`
    INSERT INTO call_note_push_deliveries
      (notification_id, reminder_id, visit_id, kind, send_state, lease_token, lease_expires_at,
       last_error_code, failed_at, updated_at)
    VALUES ('notification-dismiss', ?, 'visit-2', 'visit_alarm', 'pending', '', '', '', '', '')
  `).run(created.alarmId);

  const dismissedResponse = await apiRequest(env, ["visit-notes", "visit-2"], "PATCH", {
    expectedUpdatedAt: created.updatedAt,
    alarmState: "dismissed"
  });
  assert.equal(dismissedResponse.status, 200);
  const dismissed = await dismissedResponse.json();
  assert.equal(dismissed.alarmState, "dismissed");
  assert.equal(sqlite.prepare(
    "SELECT send_state AS state FROM call_note_push_deliveries WHERE notification_id='notification-dismiss'"
  ).get().state, "cancelled");

  sqlite.prepare(`
    INSERT INTO call_note_push_deliveries
      (notification_id, reminder_id, visit_id, kind, send_state, lease_token, lease_expires_at,
       last_error_code, failed_at, updated_at)
    VALUES ('notification-delete', ?, 'visit-2', 'visit_alarm', 'retry_wait', '', '', '', '', '')
  `).run(dismissed.alarmId);
  const staleDeleteResponse = await apiRequest(env, ["visit-notes", "visit-2"], "DELETE", {
    expectedUpdatedAt: created.updatedAt
  });
  assert.equal(staleDeleteResponse.status, 409);
  assert.equal(sqlite.prepare(
    "SELECT send_state AS state FROM call_note_push_deliveries WHERE notification_id='notification-delete'"
  ).get().state, "retry_wait");

  const deletedResponse = await apiRequest(env, ["visit-notes", "visit-2"], "DELETE", {
    expectedUpdatedAt: dismissed.updatedAt
  });
  assert.equal(deletedResponse.status, 200);
  assert.equal(sqlite.prepare(
    "SELECT send_state AS state FROM call_note_push_deliveries WHERE notification_id='notification-delete'"
  ).get().state, "cancelled");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM visit_notes WHERE id='visit-2'").get().count, 0);
  sqlite.close();
});

async function apiRequest(env, path, method, body) {
  const request = new Request(`https://example.test/api/${path.join("/")}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return onRequest({ request, env, params: { path }, data: { viewerRole: "admin" } });
}

function createDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE visit_notes (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      visit_date TEXT NOT NULL,
      visit_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      prayer TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual',
      raw_payload TEXT NOT NULL DEFAULT '',
      alarm_at TEXT NOT NULL DEFAULT '',
      alarm_state TEXT NOT NULL DEFAULT 'none',
      alarm_id TEXT NOT NULL DEFAULT '',
      dismissed_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE call_note_push_deliveries (
      notification_id TEXT PRIMARY KEY,
      reminder_id TEXT NOT NULL,
      visit_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      send_state TEXT NOT NULL,
      lease_token TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      last_error_code TEXT NOT NULL,
      failed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY,
      actor TEXT DEFAULT '',
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      before_json TEXT DEFAULT '',
      after_json TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return sqlite;
}

function d1Adapter(sqlite) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      const bound = [];
      return {
        bind(...values) {
          bound.splice(0, bound.length, ...values);
          return this;
        },
        async first() {
          return statement.get(...bound) || null;
        },
        async all() {
          return { results: statement.all(...bound) };
        },
        async run() {
          const result = statement.run(...bound);
          return { meta: { changes: Number(result.changes || 0) } };
        }
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  };
}
