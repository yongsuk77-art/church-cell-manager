import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { onRequest } from "../functions/_middleware.js";
import { handleCallNoteNotificationApi } from "../lib/call-note-notification-api.js";
import { createDeviceCredential, deviceCredentialHmac } from "../lib/notification-crypto.js";

const SECRET = "notification-detail-unit-test-secret-32-bytes";
const SITE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SITE_ORIGIN = "https://seosanch-cell.pages.dev";
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_GENERATION = 7;
const RESPONSE_FIELDS = [
  "schemaVersion", "siteId", "siteOrigin", "notificationId", "type",
  "reminderId", "scheduledAt", "route", "title", "body", "serverTime"
].sort();

test("an authenticated device receives the exact memo reminder detail contract", async () => {
  const fixture = await createFixture();
  try {
    const notificationId = "22222222-2222-4222-8222-222222222222";
    const reminderId = "33333333-3333-4333-8333-333333333333";
    const scheduledAt = "2026-07-15T03:02:00.000Z";
    fixture.sqlite.prepare("INSERT INTO notes (id, title, body) VALUES (?, ?, ?)")
      .run("note-1", "테스트 알림용", "테스트 알림\n두 번째 줄");
    insertDelivery(fixture.sqlite, {
      notificationId,
      kind: "memo_reminder",
      reminderId,
      noteId: "note-1",
      scheduledAt
    });

    const response = await getDetail(fixture.env, notificationId, fixture.credential);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), RESPONSE_FIELDS);
    assert.deepEqual({
      ...body,
      serverTime: "<server-time>"
    }, {
      schemaVersion: "2",
      siteId: SITE_ID,
      siteOrigin: SITE_ORIGIN,
      notificationId,
      type: "memo_reminder",
      reminderId,
      scheduledAt,
      route: `reminders/${notificationId}`,
      title: "테스트 알림용",
      body: "테스트 알림\n두 번째 줄",
      serverTime: "<server-time>"
    });
    assert.equal(new Date(body.serverTime).toISOString(), body.serverTime);
  } finally {
    fixture.sqlite.close();
  }
});

test("notification detail rejects a wrong credential, another generation, and deleted content", async () => {
  const fixture = await createFixture();
  try {
    const notificationId = "44444444-4444-4444-8444-444444444444";
    fixture.sqlite.prepare("INSERT INTO notes (id, title, body) VALUES (?, ?, ?)")
      .run("note-2", "보호된 메모", "기기 소유자만 볼 수 있음");
    insertDelivery(fixture.sqlite, {
      notificationId,
      kind: "memo_reminder",
      reminderId: "55555555-5555-4555-8555-555555555555",
      noteId: "note-2",
      scheduledAt: "2026-07-15T04:00:00.000Z"
    });

    const wrongCredential = await getDetail(
      fixture.env,
      notificationId,
      "dvc_v1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
    );
    assert.equal(wrongCredential.status, 401);
    assert.equal((await wrongCredential.json()).code, "DEVICE_AUTH_INVALID");

    fixture.sqlite.prepare(
      "UPDATE call_note_push_deliveries SET device_generation = ? WHERE notification_id = ?"
    ).run(DEVICE_GENERATION - 1, notificationId);
    const wrongGeneration = await getDetail(fixture.env, notificationId, fixture.credential);
    assert.equal(wrongGeneration.status, 404);
    assert.equal((await wrongGeneration.json()).code, "NOTIFICATION_NOT_FOUND");

    fixture.sqlite.prepare(
      "UPDATE call_note_push_deliveries SET device_generation = ? WHERE notification_id = ?"
    ).run(DEVICE_GENERATION, notificationId);
    fixture.sqlite.prepare("DELETE FROM notes WHERE id = ?").run("note-2");
    const deleted = await getDetail(fixture.env, notificationId, fixture.credential);
    assert.equal(deleted.status, 410);
    assert.equal((await deleted.json()).code, "NOTIFICATION_CONTENT_UNAVAILABLE");
  } finally {
    fixture.sqlite.close();
  }
});

test("visit alarms and connection tests return useful app content", async () => {
  const fixture = await createFixture();
  try {
    const visitNotificationId = "66666666-6666-4666-8666-666666666666";
    fixture.sqlite.prepare("INSERT INTO members (id, name) VALUES (?, ?)")
      .run("member-1", "최춘화 권사");
    fixture.sqlite.prepare(
      "INSERT INTO visit_notes (id, member_id, summary, prayer, action) VALUES (?, ?, ?, ?, ?)"
    ).run(
      "visit-1",
      "member-1",
      "입원 후 회복 중",
      "빠른 회복",
      'visit-meta:{"alarmAt":"2026-07-15T05:00:00.000Z","note":"금요일 다시 전화"}'
    );
    insertDelivery(fixture.sqlite, {
      notificationId: visitNotificationId,
      kind: "visit_alarm",
      reminderId: "77777777-7777-4777-8777-777777777777",
      visitId: "visit-1",
      scheduledAt: "2026-07-15T05:00:00.000Z"
    });

    const visitResponse = await getDetail(fixture.env, visitNotificationId, fixture.credential);
    assert.equal(visitResponse.status, 200);
    const visitBody = await visitResponse.json();
    assert.equal(visitBody.type, "visit_alarm");
    assert.equal(visitBody.title, "최춘화 권사 심방 알람");
    assert.equal(visitBody.body, "입원 후 회복 중\n기도제목: 빠른 회복\n후속조치: 금요일 다시 전화");

    const testNotificationId = "88888888-8888-4888-8888-888888888888";
    insertDelivery(fixture.sqlite, {
      notificationId: testNotificationId,
      kind: "connection_test",
      scheduledAt: "2026-07-15T06:00:00.000Z"
    });
    const testResponse = await getDetail(fixture.env, testNotificationId, fixture.credential);
    assert.equal(testResponse.status, 200);
    const testBody = await testResponse.json();
    assert.equal(testBody.type, "connection_test");
    assert.equal(testBody.reminderId, "");
    assert.equal(testBody.title, "공동체관리 알림 테스트");
    assert.equal(testBody.body, "웹과 심방콜노트 앱의 알림 연결이 정상입니다.");
  } finally {
    fixture.sqlite.close();
  }
});

test("the session middleware forwards credential-authenticated notification GET requests", async () => {
  const notificationId = "99999999-9999-4999-8999-999999999999";
  let forwardedAuthorization = "";
  const request = new Request(
    `${SITE_ORIGIN}/api/integrations/call-note/notifications/${notificationId}`,
    {
      method: "GET",
      headers: {
        Authorization: "Bearer device-credential",
        "CF-IPCountry": "US"
      }
    }
  );
  const response = await onRequest({
    request,
    env: {},
    data: {},
    next: async (forwardedRequest) => {
      forwardedAuthorization = forwardedRequest.headers.get("Authorization") || "";
      return new Response(null, { status: 204 });
    }
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(forwardedAuthorization, "Bearer device-credential");
});

async function createFixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE call_note_devices (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      generation INTEGER NOT NULL,
      credential_hmac TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_ciphertext TEXT NOT NULL,
      target_fingerprint TEXT NOT NULL,
      target_revision INTEGER NOT NULL,
      relay_target_handle TEXT NOT NULL,
      relay_target_generation INTEGER NOT NULL,
      relay_target_revision INTEGER NOT NULL,
      relay_target_state TEXT NOT NULL,
      relay_synced_at TEXT NOT NULL,
      registration_version INTEGER NOT NULL,
      registration_client_at TEXT NOT NULL,
      device_name TEXT NOT NULL,
      app_version TEXT NOT NULL,
      notification_permission TEXT NOT NULL,
      notifications_enabled INTEGER NOT NULL,
      pair_code_id TEXT NOT NULL,
      paired_at TEXT NOT NULL,
      pending_expires_at TEXT NOT NULL,
      activated_at TEXT NOT NULL,
      last_registered_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE members (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE visit_notes (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      prayer TEXT NOT NULL,
      action TEXT NOT NULL
    );
    CREATE TABLE call_note_push_deliveries (
      notification_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      reminder_id TEXT NOT NULL,
      note_id TEXT NOT NULL,
      visit_id TEXT NOT NULL,
      device_id TEXT,
      device_generation INTEGER NOT NULL,
      scheduled_at TEXT NOT NULL
    );
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO app_settings (key, value, updated_at) VALUES
      ('notification.siteId', '${SITE_ID}', CURRENT_TIMESTAMP),
      ('notification.siteOrigin', '${SITE_ORIGIN}', CURRENT_TIMESTAMP);
  `);
  const credential = createDeviceCredential();
  const credentialHmac = await deviceCredentialHmac(SECRET, DEVICE_ID, credential);
  const nowIso = new Date().toISOString();
  sqlite.prepare(
    `INSERT INTO call_note_devices
      (id, status, generation, credential_hmac, target_kind, target_ciphertext,
       target_fingerprint, target_revision, relay_target_handle, relay_target_generation,
       relay_target_revision, relay_target_state, relay_synced_at, registration_version,
       registration_client_at, device_name, app_version, notification_permission,
       notifications_enabled, pair_code_id, paired_at, pending_expires_at, activated_at,
       last_registered_at, last_seen_at, revoked_at, updated_at)
     VALUES (?, 'active', ?, ?, 'fid', 'encrypted-target', 'target-fingerprint', 1,
       '', 0, 0, 'none', '', 1, ?, 'Pixel Test', '6.5.0', 'granted', 1,
       'pair-code-1', ?, '', ?, ?, ?, '', ?)`
  ).run(
    DEVICE_ID,
    DEVICE_GENERATION,
    credentialHmac,
    nowIso,
    nowIso,
    nowIso,
    nowIso,
    nowIso,
    nowIso
  );
  return {
    sqlite,
    credential,
    env: {
      DB: d1Adapter(sqlite),
      NOTIFICATION_SECRET: SECRET,
      SITE_ORIGIN,
      PASSKEY_ORIGIN: SITE_ORIGIN
    }
  };
}

function insertDelivery(sqlite, {
  notificationId,
  kind,
  reminderId = "",
  noteId = "",
  visitId = "",
  scheduledAt
}) {
  sqlite.prepare(
    `INSERT INTO call_note_push_deliveries
      (notification_id, kind, reminder_id, note_id, visit_id, device_id,
       device_generation, scheduled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    notificationId,
    kind,
    reminderId,
    noteId,
    visitId,
    DEVICE_ID,
    DEVICE_GENERATION,
    scheduledAt
  );
}

function getDetail(env, notificationId, credential) {
  const path = ["integrations", "call-note", "notifications", notificationId];
  const request = new Request(`${SITE_ORIGIN}/api/${path.join("/")}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${credential}` }
  });
  return handleCallNoteNotificationApi({ request, env, path, viewerRole: "" });
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
          return statement.get(...bound);
        },
        async all() {
          return { results: statement.all(...bound) };
        },
        async run() {
          const result = statement.run(...bound);
          return { meta: { changes: Number(result.changes || 0) } };
        }
      };
    }
  };
}
