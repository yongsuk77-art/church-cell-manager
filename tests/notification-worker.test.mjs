import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  computeRetryDelayMs,
  createOauthAccessToken,
  materializeDueReminders,
  materializeDueVisitAlarms,
  sendFcmMessage,
  validateDeliverySource
} from "../workers/call-note-push/index.js";

test("service-account OAuth JWT uses the Firebase messaging scope and RS256", async () => {
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const privateKey = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(privateKey).toString("base64").match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
  const originalFetch = globalThis.fetch;
  let assertion = "";
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(init.body);
    assertion = form.get("assertion") || "";
    return Response.json({ access_token: "unit-test-access-token", expires_in: 3600 });
  };
  try {
    const token = await createOauthAccessToken({
      project_id: "callsum-test-project",
      client_email: "push-test@callsum-test-project.iam.gserviceaccount.com",
      private_key: pem
    });
    assert.equal(token, "unit-test-access-token");
    const [header, claims, signature] = assertion.split(".");
    assert.equal(JSON.parse(Buffer.from(header, "base64url")).alg, "RS256");
    const payload = JSON.parse(Buffer.from(claims, "base64url"));
    assert.equal(payload.scope, "https://www.googleapis.com/auth/firebase.messaging");
    assert.equal(payload.aud, "https://oauth2.googleapis.com/token");
    assert.ok(payload.exp - payload.iat <= 3600);
    assert.equal(await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      keyPair.publicKey,
      Buffer.from(signature, "base64url"),
      new TextEncoder().encode(`${header}.${claims}`)
    ), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("FCM request is data-only, uses FID, and contains no memo content", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://fcm.googleapis.com/v1/projects/callsum-test-project/messages:send");
    assert.equal(init.headers.Authorization, "Bearer access-token");
    requestBody = JSON.parse(init.body);
    return Response.json({ name: "projects/callsum-test-project/messages/test-message" });
  };
  try {
    const result = await sendFcmMessage(
      "callsum-test-project",
      "access-token",
      "fid",
      "firebase-installation-id",
      {
        kind: "memo_reminder",
        notificationId: "11111111-1111-4111-8111-111111111111",
        reminderId: "22222222-2222-4222-8222-222222222222",
        scheduledAt: "2026-07-13T12:00:00.000Z"
      }
    );
    assert.equal(result.kind, "accepted");
    assert.equal(requestBody.message.fid, "firebase-installation-id");
    assert.equal(requestBody.message.token, undefined);
    assert.equal(requestBody.message.notification, undefined);
    assert.deepEqual(Object.keys(requestBody.message.data).sort(), [
      "notificationId", "reminderId", "route", "scheduledAt", "schemaVersion", "type"
    ]);
    assert.equal(JSON.stringify(requestBody).includes("title"), false);
    assert.equal(JSON.stringify(requestBody).includes("body"), false);
    assert.equal(requestBody.message.android.priority, "HIGH");
    assert.equal(requestBody.message.android.ttl, "604800s");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("visit-alarm FCM payload has the exact data-only shape and exposes no visit details", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return Response.json({ name: "projects/callsum-test-project/messages/visit-alarm" });
  };
  try {
    const alarmId = "33333333-3333-4333-8333-333333333333";
    const result = await sendFcmMessage(
      "callsum-test-project",
      "access-token",
      "registration_token",
      "registration-token",
      {
        kind: "visit_alarm",
        notificationId: "11111111-1111-4111-8111-111111111111",
        reminderId: alarmId,
        scheduledAt: "2026-07-13T12:00:00.000Z",
        visitId: "private-visit-database-id",
        memberName: "민감한 성도 이름",
        content: "민감한 심방 내용"
      }
    );
    assert.equal(result.kind, "accepted");
    assert.equal(requestBody.message.token, "registration-token");
    assert.equal(requestBody.message.fid, undefined);
    assert.equal(requestBody.message.notification, undefined);
    assert.deepEqual(Object.keys(requestBody.message.data).sort(), [
      "notificationId", "reminderId", "route", "scheduledAt", "schemaVersion", "type"
    ]);
    assert.equal(requestBody.message.data.type, "visit_alarm");
    assert.equal(requestBody.message.data.reminderId, alarmId);
    const serialized = JSON.stringify(requestBody);
    assert.equal(serialized.includes("private-visit-database-id"), false);
    assert.equal(serialized.includes("민감한 성도 이름"), false);
    assert.equal(serialized.includes("민감한 심방 내용"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("FCM transient responses retry and never precede Retry-After or the one-minute floor", async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    new Response("", { status: 408 }),
    new Response("", { status: 429, headers: { "Retry-After": "120" } }),
    new Response("", { status: 500 })
  ];
  globalThis.fetch = async () => responses.shift();
  try {
    const delivery = {
      kind: "connection_test",
      notificationId: "11111111-1111-4111-8111-111111111111",
      reminderId: "",
      scheduledAt: "2026-07-13T12:00:00.000Z"
    };
    const timeout = await sendFcmMessage("callsum-test-project", "token", "fid", "fid-value", delivery);
    const throttled = await sendFcmMessage("callsum-test-project", "token", "fid", "fid-value", delivery);
    const unavailable = await sendFcmMessage("callsum-test-project", "token", "fid", "fid-value", delivery);
    assert.equal(timeout.kind, "retry");
    assert.equal(throttled.kind, "retry");
    assert.equal(throttled.retryAfterMs, 120_000);
    assert.equal(unavailable.kind, "retry");
    assert.equal(computeRetryDelayMs(1, 0, 0), 60_000);
    assert.equal(computeRetryDelayMs(1, 120_000, 0), 120_000);
    assert.ok(computeRetryDelayMs(2, 0, 1) >= 120_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("materialization skips existing ledgers so reminders beyond the first 100 are not starved", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      reminder_state TEXT NOT NULL,
      reminder_id TEXT NOT NULL,
      remind_at TEXT NOT NULL
    );
    CREATE TABLE call_note_push_deliveries (
      notification_id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      reminder_id TEXT NOT NULL,
      note_id TEXT NOT NULL,
      device_id TEXT,
      device_generation INTEGER NOT NULL,
      scheduled_at TEXT NOT NULL,
      send_state TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      next_attempt_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const dueAt = "2026-07-13T11:59:00.000Z";
  const insertNote = sqlite.prepare(
    "INSERT INTO notes (id, status, reminder_state, reminder_id, remind_at) VALUES (?, 'active', 'scheduled', ?, ?)"
  );
  const insertDelivery = sqlite.prepare(`
    INSERT INTO call_note_push_deliveries
      (notification_id, dedupe_key, kind, reminder_id, note_id, device_id, device_generation,
       scheduled_at, send_state, attempt_count, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, 'memo_reminder', ?, ?, NULL, 0, ?, 'accepted', 1, ?, ?, ?)
  `);
  for (let index = 0; index < 150; index += 1) {
    const noteId = `note-${String(index).padStart(3, "0")}`;
    const reminderId = `reminder-${String(index).padStart(3, "0")}`;
    insertNote.run(noteId, reminderId, dueAt);
    if (index < 100) {
      insertDelivery.run(
        `notification-${String(index).padStart(3, "0")}`,
        `memo:${reminderId}`,
        reminderId,
        noteId,
        dueAt,
        dueAt,
        dueAt,
        dueAt
      );
    }
  }

  const db = d1Adapter(sqlite);
  const materialized = await materializeDueReminders({ DB: db }, new Date("2026-07-13T12:00:00.000Z"));
  assert.equal(materialized, 50);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM call_note_push_deliveries").get().count, 150);
  sqlite.close();
});

test("FCM treats a retired Firebase Installation ID as an unregistered target", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    error: {
      code: 404,
      status: "NOT_FOUND",
      details: [{ errorCode: "INSTALLATION_ID_NOT_REGISTERED" }]
    }
  }, { status: 404 });
  try {
    const result = await sendFcmMessage(
      "callsum-test-project",
      "access-token",
      "fid",
      "retired-firebase-installation-id",
      {
        kind: "connection_test",
        notificationId: "11111111-1111-4111-8111-111111111111",
        reminderId: "",
        scheduledAt: "2026-07-13T12:00:00.000Z"
      }
    );
    assert.deepEqual(result, {
      kind: "unregistered",
      httpStatus: 404,
      errorCode: "FCM_UNREGISTERED"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("visit alarms materialize once with a visit-scoped dedupe key", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE visit_notes (
      id TEXT PRIMARY KEY,
      alarm_state TEXT NOT NULL,
      alarm_id TEXT NOT NULL,
      alarm_at TEXT NOT NULL
    );
    CREATE TABLE call_note_push_deliveries (
      notification_id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      reminder_id TEXT NOT NULL,
      note_id TEXT NOT NULL,
      visit_id TEXT NOT NULL,
      device_id TEXT,
      device_generation INTEGER NOT NULL,
      scheduled_at TEXT NOT NULL,
      send_state TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      next_attempt_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO visit_notes (id, alarm_state, alarm_id, alarm_at)
    VALUES ('visit-1', 'scheduled', 'alarm-1', '2026-07-13T11:59:00.000Z');
  `);

  const env = { DB: d1Adapter(sqlite) };
  const now = new Date("2026-07-13T12:00:00.000Z");
  assert.equal(await materializeDueVisitAlarms(env, now), 1);
  assert.equal(await materializeDueVisitAlarms(env, now), 0);
  const delivery = sqlite.prepare(`
    SELECT dedupe_key AS dedupeKey, kind, reminder_id AS reminderId,
      note_id AS noteId, visit_id AS visitId, scheduled_at AS scheduledAt
    FROM call_note_push_deliveries
  `).get();
  assert.equal(delivery.dedupeKey, "visit:alarm-1");
  assert.equal(delivery.kind, "visit_alarm");
  assert.equal(delivery.reminderId, "alarm-1");
  assert.equal(delivery.noteId, "");
  assert.equal(delivery.visitId, "visit-1");
  assert.equal(delivery.scheduledAt, "2026-07-13T11:59:00.000Z");
  sqlite.close();
});

test("delivery source validation is explicit for memo, visit alarm, connection test, and unknown kinds", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      reminder_state TEXT NOT NULL,
      reminder_id TEXT NOT NULL,
      remind_at TEXT NOT NULL
    );
    CREATE TABLE visit_notes (
      id TEXT PRIMARY KEY,
      alarm_state TEXT NOT NULL,
      alarm_id TEXT NOT NULL,
      alarm_at TEXT NOT NULL
    );
    INSERT INTO notes (id, status, reminder_state, reminder_id, remind_at)
    VALUES ('note-1', 'active', 'scheduled', 'memo-reminder-1', '2026-07-13T12:00:00.000Z');
    INSERT INTO visit_notes (id, alarm_state, alarm_id, alarm_at)
    VALUES ('visit-1', 'scheduled', 'visit-alarm-1', '2026-07-13T12:00:00.000Z');
  `);
  const env = { DB: d1Adapter(sqlite) };
  assert.equal(await validateDeliverySource(env, {
    kind: "memo_reminder",
    noteId: "note-1",
    reminderId: "memo-reminder-1",
    scheduledAt: "2026-07-13T12:00:00.000Z"
  }), true);
  assert.equal(await validateDeliverySource(env, {
    kind: "visit_alarm",
    visitId: "visit-1",
    reminderId: "visit-alarm-1",
    scheduledAt: "2026-07-13T12:00:00.000Z"
  }), true);
  assert.equal(await validateDeliverySource(env, {
    kind: "visit_alarm",
    visitId: "visit-1",
    reminderId: "visit-alarm-1",
    scheduledAt: "2026-07-13T12:01:00.000Z"
  }), false);
  assert.equal(await validateDeliverySource(env, { kind: "connection_test" }), true);
  assert.equal(await validateDeliverySource(env, { kind: "future_unknown_kind" }), false);
  sqlite.close();
});

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
        async all() {
          return { results: statement.all(...bound) };
        },
        async first() {
          return statement.get(...bound) || null;
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
