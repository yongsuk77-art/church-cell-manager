import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import test from "node:test";
import webpush from "web-push";
import { decryptDeviceTarget } from "../lib/notification-crypto.js";
import { handleWebPushNotificationApi } from "../lib/web-push-notification-api.js";
import { sendWebPushNotification } from "../workers/call-note-push/index.js";

const NOTIFICATION_SECRET = "web-push-test-notification-secret-at-least-32-bytes";
const VAPID_PUBLIC_KEY = base64Url(Uint8Array.from([4, ...new Uint8Array(64).fill(7)]));
const SUBSCRIPTION = {
  endpoint: "https://fcm.googleapis.com/fcm/send/unit-test-subscription",
  expirationTime: null,
  keys: {
    p256dh: base64Url(Uint8Array.from([4, ...new Uint8Array(64).fill(9)])),
    auth: base64Url(new Uint8Array(16).fill(11))
  }
};

test("0028 adds an indexed Web Push transport without changing existing devices", () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE call_note_devices (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO call_note_devices (id, status, updated_at)
    VALUES ('legacy-device', 'active', '2026-07-18T00:00:00.000Z');
  `);
  try {
    sqlite.exec(readFileSync(new URL("../migrations/0028_web_push_pwa.sql", import.meta.url), "utf8"));
    const row = sqlite.prepare("SELECT transport FROM call_note_devices WHERE id = 'legacy-device'").get();
    assert.equal(row.transport, "fcm");
    assert.ok(sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_call_note_devices_transport_status'"
    ).get());
  } finally {
    sqlite.close();
  }
});

test("admin Web Push registration encrypts the subscription, replaces the old device, queues a test, and revokes only itself", async () => {
  const sqlite = createWebPushDatabase();
  const env = {
    DB: d1Adapter(sqlite),
    NOTIFICATION_SECRET,
    VAPID_PUBLIC_KEY
  };
  try {
    const register = await callApi(env, "POST", ["notifications", "web-push", "subscription"], {
      subscription: SUBSCRIPTION,
      platform: "android",
      deviceName: "Android 테스트 기기"
    });
    assert.equal(register.status, 201);
    const registerBody = await register.json();
    assert.equal(registerBody.active, true);
    assert.equal(registerBody.device.deviceName, "Android 테스트 기기");
    assert.equal(registerBody.publicKey, VAPID_PUBLIC_KEY);
    assert.equal(JSON.stringify(registerBody).includes(SUBSCRIPTION.endpoint), false);

    const active = sqlite.prepare(`
      SELECT id, status, generation, target_kind AS targetKind,
        target_ciphertext AS targetCiphertext, target_fingerprint AS targetFingerprint,
        credential_hmac AS credentialHmac, transport
      FROM call_note_devices WHERE status = 'active'
    `).get();
    assert.equal(active.transport, "webpush");
    assert.equal(active.targetKind, "registration_token");
    assert.ok(active.credentialHmac.length > 40);
    assert.ok(active.targetFingerprint.length > 40);
    assert.equal(active.targetCiphertext.includes(SUBSCRIPTION.endpoint), false);
    assert.deepEqual(
      JSON.parse(await decryptDeviceTarget(
        NOTIFICATION_SECRET,
        active.id,
        active.targetKind,
        active.targetCiphertext
      )),
      SUBSCRIPTION
    );
    assert.equal(sqlite.prepare("SELECT status FROM call_note_devices WHERE id='legacy-fcm-device'").get().status, "revoked");

    sqlite.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)`
    ).run("notification.dispatcherStatus", JSON.stringify({
      lastRunAt: new Date().toISOString(),
      pushTransport: "webpush",
      webPushConfigured: true,
      senderEnabled: true
    }), new Date().toISOString());

    const testResponse = await callApi(env, "POST", ["notifications", "web-push", "test"]);
    assert.equal(testResponse.status, 202);
    const testBody = await testResponse.json();
    const queued = sqlite.prepare(
      "SELECT kind, device_id AS deviceId, send_state AS sendState FROM call_note_push_deliveries WHERE notification_id = ?"
    ).get(testBody.notificationId);
    assert.equal(queued.kind, "connection_test");
    assert.equal(queued.deviceId, active.id);
    assert.equal(queued.sendState, "pending");

    const revoke = await callApi(env, "DELETE", ["notifications", "web-push", "subscription"], {
      subscription: SUBSCRIPTION
    });
    assert.equal(revoke.status, 200);
    const revokeBody = await revoke.json();
    assert.equal(revokeBody.removed, true);
    assert.equal(revokeBody.active, false);
    const revoked = sqlite.prepare(
      "SELECT status, target_ciphertext AS targetCiphertext, target_fingerprint AS targetFingerprint FROM call_note_devices WHERE id = ?"
    ).get(active.id);
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.targetCiphertext, "");
    assert.equal(revoked.targetFingerprint, "");
  } finally {
    sqlite.close();
  }
});

test("Web Push delivery contains only generic routing data and classifies an expired subscription", async () => {
  const originalSend = webpush.sendNotification;
  let sentPayload = null;
  let sentOptions = null;
  webpush.sendNotification = async (subscription, payload, options) => {
    assert.deepEqual(subscription, SUBSCRIPTION);
    sentPayload = JSON.parse(payload);
    sentOptions = options;
    return { statusCode: 201 };
  };
  const delivery = {
    kind: "visit_alarm",
    notificationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    reminderId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    noteId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    visitId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    memberName: "민감한 이름",
    summary: "민감한 심방 내용"
  };
  try {
    const accepted = await sendWebPushNotification({
      subject: "https://church-cell-manager.pages.dev",
      publicKey: VAPID_PUBLIC_KEY,
      privateKey: base64Url(new Uint8Array(32).fill(13))
    }, JSON.stringify(SUBSCRIPTION), delivery);
    assert.equal(accepted.kind, "accepted");
    assert.deepEqual(Object.keys(sentPayload).sort(), ["data", "kind", "schemaVersion", "tag"]);
    assert.equal(sentPayload.kind, "visit_alarm");
    assert.deepEqual(sentPayload.data, {
      notificationId: delivery.notificationId,
      url: "/index.html"
    });
    assert.equal(JSON.stringify(sentPayload).includes(delivery.memberName), false);
    assert.equal(JSON.stringify(sentPayload).includes(delivery.summary), false);
    assert.equal(JSON.stringify(sentPayload).includes(delivery.reminderId), false);
    assert.equal(sentOptions.urgency, "high");
    assert.equal(sentOptions.TTL, 604800);

    webpush.sendNotification = async () => {
      const error = new Error("gone");
      error.statusCode = 410;
      throw error;
    };
    const gone = await sendWebPushNotification({
      subject: "https://church-cell-manager.pages.dev",
      publicKey: VAPID_PUBLIC_KEY,
      privateKey: base64Url(new Uint8Array(32).fill(13))
    }, JSON.stringify(SUBSCRIPTION), delivery);
    assert.deepEqual(gone, {
      kind: "unregistered",
      httpStatus: 410,
      errorCode: "WEB_PUSH_SUBSCRIPTION_GONE"
    });
  } finally {
    webpush.sendNotification = originalSend;
  }
});

test("the PWA exposes install and per-device notification controls while retired Relay controls stay hidden", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const manifest = JSON.parse(readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
  const serviceWorker = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  const middleware = readFileSync(new URL("../functions/_middleware.js", import.meta.url), "utf8");
  assert.match(html, /id="pwaInstallBtn"/);
  assert.match(html, /id="webPushRegisterBtn"/);
  assert.match(html, /id="webPushTestBtn"/);
  assert.match(html, /id="webPushUnregisterBtn"/);
  assert.match(html, /relayEnrollmentSettingsTitle" hidden aria-hidden="true"/);
  assert.match(html, /mobileNotificationSettingsTitle" hidden aria-hidden="true"/);
  assert.match(html, /<section class="call-note-settings" hidden aria-hidden="true">[\s\S]*?앱 → 웹 메모 수신\(Webhook\)/);
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/?source=pwa");
  assert.match(serviceWorker, /self\.addEventListener\("push"/);
  assert.doesNotMatch(serviceWorker, /memberName|summary|phone|address|prayer/i);
  assert.doesNotMatch(serviceWorker, /addEventListener\("fetch"/);
  assert.match(middleware, /"\/sw\.js"/);
  assert.match(middleware, /"\/manifest\.webmanifest"/);
});

async function callApi(env, method, path, body) {
  return handleWebPushNotificationApi({
    request: new Request(`https://church-cell-manager.pages.dev/api/${path.join("/")}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    }),
    env,
    path,
    viewerRole: "admin"
  });
}

function createWebPushDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY,
      actor TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      before_json TEXT NOT NULL DEFAULT '',
      after_json TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE call_note_devices (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0,
      credential_hmac TEXT NOT NULL UNIQUE,
      target_kind TEXT NOT NULL,
      target_ciphertext TEXT NOT NULL,
      target_fingerprint TEXT NOT NULL,
      target_revision INTEGER NOT NULL DEFAULT 1,
      registration_version INTEGER NOT NULL DEFAULT 0,
      registration_client_at TEXT NOT NULL DEFAULT '',
      crypto_version INTEGER NOT NULL DEFAULT 1,
      device_name TEXT NOT NULL DEFAULT '',
      app_version TEXT NOT NULL DEFAULT '',
      notification_permission TEXT NOT NULL DEFAULT 'unknown',
      notifications_enabled INTEGER NOT NULL DEFAULT 0,
      pair_code_id TEXT NOT NULL UNIQUE,
      paired_at TEXT NOT NULL,
      pending_expires_at TEXT NOT NULL DEFAULT '',
      activated_at TEXT NOT NULL DEFAULT '',
      last_registered_at TEXT NOT NULL DEFAULT '',
      last_seen_at TEXT NOT NULL DEFAULT '',
      revoked_at TEXT NOT NULL DEFAULT '',
      revoke_reason TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      relay_target_handle TEXT NOT NULL DEFAULT '',
      relay_target_generation INTEGER NOT NULL DEFAULT 0,
      relay_target_revision INTEGER NOT NULL DEFAULT 0,
      relay_target_state TEXT NOT NULL DEFAULT 'none',
      relay_synced_at TEXT NOT NULL DEFAULT '',
      transport TEXT NOT NULL DEFAULT 'fcm'
    );
    CREATE UNIQUE INDEX idx_call_note_devices_one_active
      ON call_note_devices(status) WHERE status = 'active';
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
    INSERT INTO call_note_devices (
      id, status, generation, credential_hmac, target_kind, target_ciphertext,
      target_fingerprint, pair_code_id, paired_at, activated_at, updated_at
    ) VALUES (
      'legacy-fcm-device', 'active', 1, 'legacy-credential', 'registration_token',
      'legacy-ciphertext', 'legacy-fingerprint', 'legacy-pair',
      '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z'
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

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}
