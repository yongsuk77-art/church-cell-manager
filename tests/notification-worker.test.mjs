import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { encryptDeviceTarget } from "../lib/notification-crypto.js";
import {
  computeRetryDelayMs,
  createOauthAccessToken,
  materializeDueReminders,
  materializeDueVisitAlarms,
  normalizeRelayOutcome,
  purgeExpiredDeletedNotes,
  runNotificationDispatcher,
  sendFcmMessage,
  synchronizeActiveRelayTarget,
  validateDeliverySource
} from "../workers/call-note-push/index.js";

const TEST_SITE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("malformed relay outcomes remain retryable and cannot poison D1 bindings", () => {
  assert.deepEqual(normalizeRelayOutcome({
    outcome: "accepted",
    httpStatus: "200",
    errorCode: "",
    retryAfterMs: 0,
    messageName: "projects/test/messages/1"
  }), {
    kind: "retry",
    httpStatus: 502,
    errorCode: "RELAY_RESPONSE_INVALID",
    retryAfterMs: 60_000,
    messageName: ""
  });
  assert.equal(normalizeRelayOutcome({
    outcome: "accepted",
    httpStatus: 200,
    errorCode: "SHOULD_BE_EMPTY",
    retryAfterMs: 0,
    messageName: ""
  }).kind, "retry");
  assert.deepEqual(normalizeRelayOutcome({
    outcome: "accepted",
    httpStatus: 200,
    errorCode: "",
    retryAfterMs: 0,
    messageName: "projects/test/messages/1"
  }), {
    kind: "accepted",
    httpStatus: 200,
    errorCode: "",
    retryAfterMs: 0,
    messageName: "projects/test/messages/1"
  });
});

test("disabled relay dispatcher still persists its tenant and transport readiness", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE call_note_devices (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      relay_target_handle TEXT NOT NULL DEFAULT '',
      relay_target_state TEXT NOT NULL DEFAULT 'none',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT NOT NULL DEFAULT '',
      purge_started_at TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO app_settings (key, value, updated_at) VALUES
      ('notification.siteId', '${TEST_SITE_ID}', '2026-07-14T00:00:00.000Z'),
      ('notification.siteOrigin', 'https://seosanch-cell.pages.dev', '2026-07-14T00:00:00.000Z');
  `);
  try {
    const result = await runNotificationDispatcher({
      DB: d1Adapter(sqlite),
      PUSH_SEND_ENABLED: "false",
      PUSH_TRANSPORT: "relay",
      RELAY_BASE_URL: "https://relay.example.com",
      RELAY_KEY_ID: "rkey_v1_AAAAAAAAAAAAAAAAAAAAAA",
      RELAY_HMAC_SECRET: "relay-worker-test-hmac-secret-that-is-long-enough"
    }, new Date("2026-07-14T00:01:00.000Z"));
    assert.equal(result.status, "disabled");
    const stored = JSON.parse(sqlite.prepare(
      "SELECT value FROM app_settings WHERE key='notification.dispatcherStatus'"
    ).get().value);
    assert.equal(stored.pushTransport, "relay");
    assert.equal(stored.siteId, TEST_SITE_ID);
    assert.equal(stored.siteOrigin, "https://seosanch-cell.pages.dev");
    assert.equal(stored.siteIdentityConfigured, true);
    assert.equal(stored.relayConfigured, true);
    assert.equal(stored.senderEnabled, false);
  } finally {
    sqlite.close();
  }
});

test("scheduled dispatcher repairs an active device that registration could not sync to the relay", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const notificationSecret = "unit-test-notification-secret-32-bytes-minimum";
  const deviceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const targetKind = "fid";
  const targetValue = "firebase-installation-id-for-recovery-test";
  const targetCiphertext = await encryptDeviceTarget(
    notificationSecret,
    deviceId,
    targetKind,
    targetValue
  );
  sqlite.exec(`
    CREATE TABLE call_note_devices (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      generation INTEGER NOT NULL,
      target_kind TEXT NOT NULL,
      target_ciphertext TEXT NOT NULL,
      target_revision INTEGER NOT NULL,
      relay_target_handle TEXT NOT NULL DEFAULT '',
      relay_target_generation INTEGER NOT NULL DEFAULT 0,
      relay_target_revision INTEGER NOT NULL DEFAULT 0,
      relay_target_state TEXT NOT NULL DEFAULT 'none',
      relay_synced_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE call_note_push_deliveries (
      notification_id TEXT PRIMARY KEY,
      send_state TEXT NOT NULL,
      next_attempt_at TEXT NOT NULL DEFAULT '',
      last_error_code TEXT NOT NULL DEFAULT '',
      accepted_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO call_note_push_deliveries
      (notification_id, send_state, last_error_code, updated_at)
    VALUES ('11111111-1111-4111-8111-111111111111', 'waiting_target',
      'RELAY_TARGET_NOT_SYNCED', '2026-07-14T00:00:00.000Z');
  `);
  sqlite.prepare(`
    INSERT INTO call_note_devices
      (id, status, generation, target_kind, target_ciphertext, target_revision, updated_at)
    VALUES (?, 'active', 4, ?, ?, 2, '2026-07-14T00:00:00.000Z')
  `).run(deviceId, targetKind, targetCiphertext);

  const originalFetch = globalThis.fetch;
  let relayRequests = 0;
  globalThis.fetch = async (url, init) => {
    relayRequests += 1;
    assert.equal(url, `https://relay.example.com/v1/targets/${deviceId}`);
    assert.equal(init.method, "PUT");
    const body = JSON.parse(init.body);
    assert.equal(body.targetKind, targetKind);
    assert.equal(body.targetValue, targetValue);
    assert.equal(body.deviceGeneration, 4);
    assert.equal(body.targetRevision, 2);
    return Response.json({
      targetHandle: "rth_v1_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      status: "active",
      deviceGeneration: 4,
      targetRevision: 2
    });
  };
  const env = {
    DB: d1Adapter(sqlite),
    RELAY_BASE_URL: "https://relay.example.com",
    RELAY_KEY_ID: "rkey_v1_AAAAAAAAAAAAAAAAAAAAAA",
    RELAY_HMAC_SECRET: "relay-worker-test-hmac-secret-that-is-long-enough"
  };
  try {
    const first = await synchronizeActiveRelayTarget(
      env,
      { siteId: TEST_SITE_ID, siteOrigin: "https://seosanch-cell.pages.dev" },
      notificationSecret
    );
    assert.equal(first.status, "ready");
    assert.equal(first.changed, true);
    const stored = sqlite.prepare(`
      SELECT relay_target_handle AS relayTargetHandle,
        relay_target_generation AS relayTargetGeneration,
        relay_target_revision AS relayTargetRevision,
        relay_target_state AS relayTargetState,
        relay_synced_at AS relaySyncedAt
      FROM call_note_devices WHERE id = ?
    `).get(deviceId);
    assert.equal(stored.relayTargetHandle, "rth_v1_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC");
    assert.equal(stored.relayTargetGeneration, 4);
    assert.equal(stored.relayTargetRevision, 2);
    assert.equal(stored.relayTargetState, "active");
    assert.ok(stored.relaySyncedAt);
    assert.equal(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action='notification.device.relay_sync'"
    ).get().count, 1);
    const released = sqlite.prepare(`
      SELECT send_state AS sendState, next_attempt_at AS nextAttemptAt,
        last_error_code AS lastErrorCode
      FROM call_note_push_deliveries
    `).get();
    assert.equal(released.sendState, "retry_wait");
    assert.ok(released.nextAttemptAt);
    assert.equal(released.lastErrorCode, "");

    const second = await synchronizeActiveRelayTarget(
      env,
      { siteId: TEST_SITE_ID, siteOrigin: "https://seosanch-cell.pages.dev" },
      notificationSecret
    );
    assert.deepEqual(second, { status: "ready", changed: false });
    assert.equal(relayRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

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
        noteId: "33333333-3333-4333-8333-333333333333",
        scheduledAt: "2026-07-13T12:00:00.000Z"
      },
      TEST_SITE_ID
    );
    assert.equal(result.kind, "accepted");
    assert.equal(requestBody.message.fid, "firebase-installation-id");
    assert.equal(requestBody.message.token, undefined);
    assert.equal(requestBody.message.notification, undefined);
    assert.deepEqual(Object.keys(requestBody.message.data).sort(), [
      "noteId", "notificationId", "reminderId", "route", "scheduledAt", "schemaVersion", "siteId", "type"
    ]);
    assert.equal(requestBody.message.data.schemaVersion, "2");
    assert.equal(requestBody.message.data.siteId, TEST_SITE_ID);
    assert.equal(requestBody.message.data.noteId, "33333333-3333-4333-8333-333333333333");
    assert.equal(JSON.stringify(requestBody).includes("title"), false);
    assert.equal(JSON.stringify(requestBody).includes("body"), false);
    assert.equal(requestBody.message.android.priority, "HIGH");
    assert.equal(requestBody.message.android.ttl, "604800s");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("memo FCM rejects a missing note id before making an outbound request", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("must not send");
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
      },
      TEST_SITE_ID
    );
    assert.deepEqual(result, {
      kind: "blocked",
      httpStatus: 0,
      errorCode: "NOTE_ID_INVALID"
    });
    assert.equal(fetchCalls, 0);
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
      },
      TEST_SITE_ID
    );
    assert.equal(result.kind, "accepted");
    assert.equal(requestBody.message.token, "registration-token");
    assert.equal(requestBody.message.fid, undefined);
    assert.equal(requestBody.message.notification, undefined);
    assert.deepEqual(Object.keys(requestBody.message.data).sort(), [
      "noteId", "notificationId", "reminderId", "route", "scheduledAt", "schemaVersion", "siteId", "type"
    ]);
    assert.equal(requestBody.message.data.type, "visit_alarm");
    assert.equal(requestBody.message.data.reminderId, alarmId);
    assert.equal(requestBody.message.data.noteId, "");
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
    const timeout = await sendFcmMessage("callsum-test-project", "token", "fid", "fid-value", delivery, TEST_SITE_ID);
    const throttled = await sendFcmMessage("callsum-test-project", "token", "fid", "fid-value", delivery, TEST_SITE_ID);
    const unavailable = await sendFcmMessage("callsum-test-project", "token", "fid", "fid-value", delivery, TEST_SITE_ID);
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
      remind_at TEXT NOT NULL,
      deleted_at TEXT NOT NULL DEFAULT ''
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
  insertNote.run("deleted-note", "deleted-reminder", dueAt);
  sqlite.prepare("UPDATE notes SET deleted_at = ? WHERE id = 'deleted-note'")
    .run("2026-07-13T11:59:30.000Z");

  const db = d1Adapter(sqlite);
  const materialized = await materializeDueReminders({ DB: db }, new Date("2026-07-13T12:00:00.000Z"));
  assert.equal(materialized, 50);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM call_note_push_deliveries").get().count, 150);
  assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM call_note_push_deliveries WHERE note_id = 'deleted-note'"
  ).get().count, 0);
  sqlite.close();
});

test("lookahead materializes a future reminder without making it due early", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      reminder_state TEXT NOT NULL,
      reminder_id TEXT NOT NULL,
      remind_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT NOT NULL DEFAULT '',
      purge_started_at TEXT NOT NULL DEFAULT ''
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
    INSERT INTO notes (id, status, reminder_state, reminder_id, remind_at)
    VALUES ('note-future', 'active', 'scheduled', 'reminder-future',
      '2026-07-15T11:27:00.000Z');
  `);
  try {
    const env = { DB: d1Adapter(sqlite) };
    const now = new Date("2026-07-15T11:26:00.000Z");
    assert.equal(await materializeDueReminders(env, now), 0);
    assert.equal(
      await materializeDueReminders(
        env,
        now,
        new Date("2026-07-15T11:27:05.000Z")
      ),
      1
    );
    const delivery = sqlite.prepare(`
      SELECT scheduled_at AS scheduledAt, next_attempt_at AS nextAttemptAt,
        created_at AS createdAt
      FROM call_note_push_deliveries
    `).get();
    assert.equal(delivery.scheduledAt, "2026-07-15T11:27:00.000Z");
    assert.equal(delivery.nextAttemptAt, delivery.scheduledAt);
    assert.equal(delivery.createdAt, "2026-07-15T11:26:00.000Z");
  } finally {
    sqlite.close();
  }
});

test("scheduled timing drains distinct reminder times throughout the lookahead window", async () => {
  const sqlite = createTimedDispatcherDatabase();
  sqlite.prepare(`
    INSERT INTO notes (id, status, reminder_state, reminder_id, remind_at)
    VALUES (?, 'active', 'scheduled', ?, ?)
  `).run(
    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    "ffffffff-ffff-4fff-8fff-ffffffffffff",
    "2026-07-15T11:27:20.000Z"
  );
  sqlite.prepare(`
    INSERT INTO notes (id, status, reminder_state, reminder_id, remind_at)
    VALUES (?, 'active', 'scheduled', ?, ?)
  `).run(
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "2026-07-15T11:27:50.000Z"
  );
  const start = new Date("2026-07-15T11:26:56.000Z");
  let currentTime = start.getTime();
  const waits = [];
  let relayCalls = 0;
  const relayScheduledAt = [];
  const env = {
    DB: d1Adapter(sqlite),
    PUSH_SEND_ENABLED: "true",
    PUSH_TRANSPORT: "relay",
    RELAY_BASE_URL: "https://relay.example.com",
    RELAY_KEY_ID: "rkey_v1_AAAAAAAAAAAAAAAAAAAAAA",
    RELAY_HMAC_SECRET: "relay-worker-test-hmac-secret-that-is-long-enough",
    RELAY: {
      async fetch(_url, init) {
        relayCalls += 1;
        const body = JSON.parse(init.body);
        relayScheduledAt.push(body.scheduledAt);
        return Response.json({
          outcome: "accepted",
          httpStatus: 200,
          errorCode: "",
          retryAfterMs: 0,
          messageName: "projects/test/messages/imminent"
        });
      }
    }
  };

  try {
    const result = await runNotificationDispatcher(env, start, {
      lookaheadMs: 65_000,
      clock: () => new Date(currentTime),
      wait: async (delayMs) => {
        waits.push(delayMs);
        currentTime += delayMs;
      }
    });

    assert.deepEqual(waits, [4_000, 20_000, 30_000]);
    assert.deepEqual(relayScheduledAt, [
      "2026-07-15T11:27:00.000Z",
      "2026-07-15T11:27:20.000Z",
      "2026-07-15T11:27:50.000Z"
    ]);
    assert.equal(result.materialized, 3);
    assert.equal(result.processed, 3);
    assert.equal(result.accepted, 3);
    assert.equal(relayCalls, 3);
    const deliveries = sqlite.prepare(`
      SELECT scheduled_at AS scheduledAt, send_state AS sendState,
        attempt_count AS attemptCount
      FROM call_note_push_deliveries
      ORDER BY scheduled_at
    `).all();
    assert.deepEqual(deliveries.map((delivery) => delivery.scheduledAt), relayScheduledAt);
    assert.ok(deliveries.every((delivery) => delivery.sendState === "accepted"));
    assert.ok(deliveries.every((delivery) => delivery.attemptCount === 1));
  } finally {
    sqlite.close();
  }
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
      },
      TEST_SITE_ID
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
      remind_at TEXT NOT NULL,
      deleted_at TEXT NOT NULL DEFAULT ''
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
  sqlite.prepare("UPDATE notes SET deleted_at = ? WHERE id = 'note-1'")
    .run("2026-07-13T12:00:30.000Z");
  assert.equal(await validateDeliverySource(env, {
    kind: "memo_reminder",
    noteId: "note-1",
    reminderId: "memo-reminder-1",
    scheduledAt: "2026-07-13T12:00:00.000Z"
  }), false);
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

test("trash purge hard-deletes only expired notes after every R2 delete succeeds", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT NOT NULL DEFAULT '',
      purge_started_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE note_attachments (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      object_key TEXT NOT NULL UNIQUE
    );
    INSERT INTO notes (id, revision, deleted_at, purge_started_at) VALUES
      ('expired-photo', 3, '2026-06-15T11:59:00.000Z', ''),
      ('expired-plain', 2, '2026-06-14T12:00:00.000Z', '2026-07-15T11:30:00.000Z'),
      ('failed-photo', 4, '2026-06-01T00:00:00.000Z', ''),
      ('recent-photo', 2, '2026-06-15T12:00:01.000Z', '');
    INSERT INTO note_attachments (id, note_id, object_key) VALUES
      ('attachment-expired', 'expired-photo', 'notes/expired.webp'),
      ('attachment-failed', 'failed-photo', 'notes/failed.webp'),
      ('attachment-recent', 'recent-photo', 'notes/recent.webp');
  `);
  const objects = new Set(["notes/expired.webp", "notes/failed.webp", "notes/recent.webp"]);
  let failingKey = "notes/failed.webp";
  const photos = {
    async delete(keys) {
      const values = Array.isArray(keys) ? keys : [keys];
      if (values.includes(failingKey)) throw new Error("simulated R2 outage");
      for (const key of values) objects.delete(key);
    }
  };

  try {
    const now = new Date("2026-07-15T12:00:00.000Z");
    const first = await purgeExpiredDeletedNotes({ DB: d1Adapter(sqlite), PHOTOS: photos }, now);
    assert.deepEqual(first, { scanned: 3, purged: 2, failed: 1 });
    assert.deepEqual(
      sqlite.prepare("SELECT id FROM notes ORDER BY id").all().map((row) => row.id),
      ["failed-photo", "recent-photo"]
    );
    assert.equal(
      sqlite.prepare("SELECT purge_started_at AS claim FROM notes WHERE id = 'failed-photo'").get().claim,
      ""
    );
    assert.equal(objects.has("notes/expired.webp"), false);
    assert.equal(objects.has("notes/failed.webp"), true);
    assert.equal(objects.has("notes/recent.webp"), true);

    failingKey = "";
    const second = await purgeExpiredDeletedNotes({ DB: d1Adapter(sqlite), PHOTOS: photos }, now);
    assert.deepEqual(second, { scanned: 1, purged: 1, failed: 0 });
    assert.deepEqual(
      sqlite.prepare("SELECT id FROM notes ORDER BY id").all().map((row) => row.id),
      ["recent-photo"]
    );
    assert.equal(objects.has("notes/failed.webp"), false);
    assert.equal(objects.has("notes/recent.webp"), true);
  } finally {
    sqlite.close();
  }
});

function createTimedDispatcherDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO app_settings (key, value, updated_at) VALUES
      ('notification.siteId', '${TEST_SITE_ID}', '2026-07-15T11:00:00.000Z'),
      ('notification.siteOrigin', 'https://seosanch-cell.pages.dev',
        '2026-07-15T11:00:00.000Z');

    CREATE TABLE call_note_devices (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      generation INTEGER NOT NULL,
      target_kind TEXT NOT NULL,
      target_ciphertext TEXT NOT NULL,
      target_fingerprint TEXT NOT NULL,
      target_revision INTEGER NOT NULL,
      pending_expires_at TEXT NOT NULL DEFAULT '',
      revoked_at TEXT NOT NULL DEFAULT '',
      revoke_reason TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      relay_target_handle TEXT NOT NULL DEFAULT '',
      relay_target_generation INTEGER NOT NULL DEFAULT 0,
      relay_target_revision INTEGER NOT NULL DEFAULT 0,
      relay_target_state TEXT NOT NULL DEFAULT 'none',
      relay_synced_at TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO call_note_devices (
      id, status, generation, target_kind, target_ciphertext, target_fingerprint,
      target_revision, updated_at, relay_target_handle, relay_target_generation,
      relay_target_revision, relay_target_state, relay_synced_at
    ) VALUES (
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'active', 5, 'fid', 'unused',
      'unused', 3, '2026-07-15T11:00:00.000Z',
      'rth_v1_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', 5, 3, 'active',
      '2026-07-15T11:00:00.000Z'
    );

    CREATE TABLE call_note_pair_codes (
      id TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL,
      used_at TEXT NOT NULL,
      invalidated_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE call_note_pair_attempts (
      actor_hmac TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      reminder_state TEXT NOT NULL,
      reminder_id TEXT NOT NULL,
      remind_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT NOT NULL DEFAULT '',
      purge_started_at TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO notes (id, status, reminder_state, reminder_id, remind_at)
    VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'active', 'scheduled',
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '2026-07-15T11:27:00.000Z');
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
      reminder_id TEXT NOT NULL DEFAULT '',
      note_id TEXT NOT NULL DEFAULT '',
      visit_id TEXT NOT NULL DEFAULT '',
      device_id TEXT,
      device_generation INTEGER NOT NULL DEFAULT 0,
      scheduled_at TEXT NOT NULL,
      send_state TEXT NOT NULL,
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
