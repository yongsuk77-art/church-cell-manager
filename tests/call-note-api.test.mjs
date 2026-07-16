import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { handleCallNoteNotificationApi } from "../lib/call-note-notification-api.js";
import { pairCodeHmac } from "../lib/notification-crypto.js";

const SECRET = "unit-test-notification-secret-32-bytes-minimum";
const TEST_SITE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEST_SITE_ORIGIN = "https://church-cell-manager.pages.dev";

test("distributed wrong guesses cannot invalidate a pair code and each actor is rate limited", async () => {
  const fixture = await createFixture("123456");
  try {
    for (const ip of ["203.0.113.10", "203.0.113.11"]) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await pair(fixture.env, "999999", ip);
        assert.equal(response.status, 401);
      }
    }

    const locked = await pair(fixture.env, "999999", "203.0.113.10");
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get("Retry-After")) > 0);

    const valid = await pair(fixture.env, "123456", "203.0.113.12");
    assert.equal(valid.status, 201);
    const body = await valid.json();
    assert.equal(body.status, "pending");
    assert.equal(body.siteId, TEST_SITE_ID);
    assert.equal(body.siteOrigin, TEST_SITE_ORIGIN);
    assert.match(body.deviceCredential, /^dvc_v1_[A-Za-z0-9_-]{43}$/);
  } finally {
    fixture.sqlite.close();
  }
});

test("a registration version is idempotent only for the complete normalized event", async () => {
  const fixture = await createFixture("234567");
  try {
    const paired = await pair(fixture.env, "234567", "203.0.113.20");
    assert.equal(paired.status, 201);
    const device = await paired.json();
    const occurredAt = new Date(Date.now() - 1_000).toISOString();
    const registration = {
      fid: "firebase-installation-id-for-unit-test",
      deviceName: "Pixel Unit Test",
      appVersion: "6.3.0 (43)",
      notificationPermission: "granted",
      notificationsEnabled: true,
      registrationVersion: 2,
      occurredAt
    };

    const first = await register(fixture.env, device, registration);
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.siteId, TEST_SITE_ID);
    assert.equal(firstBody.siteOrigin, TEST_SITE_ORIGIN);
    const identicalRetry = await register(fixture.env, device, registration);
    assert.equal(identicalRetry.status, 200);

    const variants = [
      { ...registration, fid: "different-firebase-installation-id" },
      {
        ...registration,
        fid: undefined,
        target: { kind: "registration_token", value: "different-registration-token" }
      },
      { ...registration, occurredAt: new Date(Date.parse(occurredAt) - 1_000).toISOString() },
      { ...registration, deviceName: "Different Device" },
      { ...registration, appVersion: "6.3.1 (44)" },
      { ...registration, notificationPermission: "denied" },
      { ...registration, notificationsEnabled: false }
    ];
    for (const variant of variants) {
      const conflict = await register(fixture.env, device, variant);
      assert.equal(conflict.status, 409);
      assert.equal((await conflict.json()).code, "REGISTRATION_VERSION_CONFLICT");
    }

    const stale = await register(fixture.env, device, {
      ...registration,
      registrationVersion: 1
    });
    assert.equal(stale.status, 200);
    assert.equal((await stale.json()).staleIgnored, true);
  } finally {
    fixture.sqlite.close();
  }
});

test("relay registration stores only the opaque handle and local disconnect survives relay downtime", async () => {
  const originalFetch = globalThis.fetch;
  const fixture = await createFixture("345678", { pushTransport: "relay" });
  let relayAvailable = true;
  globalThis.fetch = async (url, init) => {
    if (!relayAvailable) throw new TypeError("relay unavailable");
    assert.match(String(url), /\/v1\/targets\//);
    assert.equal(init.method, "PUT");
    const body = JSON.parse(String(init.body || "{}"));
    return new Response(JSON.stringify({
      targetHandle: "rth_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      status: "active",
      deviceGeneration: body.deviceGeneration,
      targetRevision: body.targetRevision
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const paired = await pair(fixture.env, "345678", "203.0.113.30");
    assert.equal(paired.status, 201);
    const device = await paired.json();
    const registration = await register(fixture.env, device, {
      fid: "firebase-installation-id-for-relay-test",
      deviceName: "Pixel Relay Test",
      appVersion: "6.4.0 (44)",
      notificationPermission: "granted",
      notificationsEnabled: true,
      registrationVersion: 1,
      occurredAt: new Date(Date.now() - 1_000).toISOString()
    });
    assert.equal(registration.status, 200);
    const active = fixture.sqlite.prepare(
      `SELECT status, relay_target_handle AS relayTargetHandle,
        relay_target_state AS relayTargetState
       FROM call_note_devices WHERE id = ?`
    ).get(device.deviceId);
    assert.equal(active.status, "active");
    assert.equal(active.relayTargetHandle, "rth_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    assert.equal(active.relayTargetState, "active");

    fixture.sqlite.prepare(
      "UPDATE call_note_devices SET target_revision = target_revision + 1 WHERE id = ?"
    ).run(device.deviceId);
    fixture.sqlite.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
    ).run("notification.dispatcherStatus", JSON.stringify({
      status: "ready",
      lastRunAt: new Date().toISOString(),
      senderEnabled: true,
      pushTransport: "relay",
      relayConfigured: true,
      fcmConfigured: true
    }), new Date().toISOString());
    const status = await callApi(
      fixture.env,
      ["integrations", "call-note", "admin", "status"],
      { method: "GET", viewerRole: "admin" }
    );
    assert.equal(status.status, 200);
    assert.equal((await status.json()).devices[0].relayTargetReady, false);
    const blockedTest = await callApi(
      fixture.env,
      ["integrations", "call-note", "admin", "devices", device.deviceId, "test"],
      { method: "POST", viewerRole: "admin" }
    );
    assert.equal(blockedTest.status, 409);
    assert.equal((await blockedTest.json()).code, "RELAY_TARGET_NOT_SYNCED");

    relayAvailable = false;
    const disconnected = await callApi(
      fixture.env,
      ["integrations", "call-note", "devices", device.deviceId],
      { method: "DELETE", auth: device.deviceCredential }
    );
    assert.equal(disconnected.status, 200);
    assert.equal((await disconnected.json()).relayCleanupPending, true);
    const revoked = fixture.sqlite.prepare(
      "SELECT status, relay_target_state AS relayTargetState FROM call_note_devices WHERE id = ?"
    ).get(device.deviceId);
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.relayTargetState, "revoked");
  } finally {
    globalThis.fetch = originalFetch;
    fixture.sqlite.close();
  }
});

test("relay upstream authentication errors stay retryable to the Android registration worker", async () => {
  const originalFetch = globalThis.fetch;
  const fixture = await createFixture("456789", { pushTransport: "relay" });
  let relayRecovered = false;
  globalThis.fetch = async (_url, init) => {
    if (!relayRecovered) {
      return new Response(JSON.stringify({ code: "RELAY_AUTH_INVALID" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }
    const body = JSON.parse(String(init.body || "{}"));
    return new Response(JSON.stringify({
      targetHandle: "rth_v1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      status: "active",
      deviceGeneration: body.deviceGeneration,
      targetRevision: body.targetRevision
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const paired = await pair(fixture.env, "456789", "203.0.113.31");
    const device = await paired.json();
    const event = {
      fid: "firebase-installation-id-for-upstream-test",
      deviceName: "Pixel Upstream Test",
      appVersion: "6.4.0 (44)",
      notificationPermission: "granted",
      notificationsEnabled: true,
      registrationVersion: 1,
      occurredAt: new Date(Date.now() - 1_000).toISOString()
    };
    const failed = await register(fixture.env, device, event);
    assert.equal(failed.status, 502);
    assert.equal((await failed.json()).code, "RELAY_AUTH_INVALID");
    assert.ok(Number(failed.headers.get("Retry-After")) >= 1);
    assert.equal(fixture.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action='notification.device.register'"
    ).get().count, 1);
    assert.equal(fixture.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action='notification.device.relay_sync'"
    ).get().count, 0);

    relayRecovered = true;
    const retried = await register(fixture.env, device, event);
    assert.equal(retried.status, 200);
    assert.equal((await retried.json()).status, "active");
    assert.equal(fixture.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action='notification.device.relay_sync'"
    ).get().count, 1);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.sqlite.close();
  }
});

async function createFixture(pairCode, { pushTransport = "direct" } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE call_note_pair_codes (
      id TEXT PRIMARY KEY,
      code_hmac TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT NOT NULL DEFAULT '',
      invalidated_at TEXT NOT NULL DEFAULT '',
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE call_note_pair_attempts (
      actor_hmac TEXT PRIMARY KEY,
      failures INTEGER NOT NULL,
      window_started_at TEXT NOT NULL,
      locked_until TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
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
      relay_target_handle TEXT NOT NULL DEFAULT '',
      relay_target_generation INTEGER NOT NULL DEFAULT 0,
      relay_target_revision INTEGER NOT NULL DEFAULT 0,
      relay_target_state TEXT NOT NULL DEFAULT 'none',
      relay_synced_at TEXT NOT NULL DEFAULT '',
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
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX call_note_devices_one_active
      ON call_note_devices(status) WHERE status = 'active';
    CREATE UNIQUE INDEX call_note_devices_one_pending
      ON call_note_devices(status) WHERE status = 'pending';
    CREATE TABLE call_note_push_deliveries (
      notification_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'connection_test',
      device_id TEXT,
      device_generation INTEGER NOT NULL DEFAULT 0,
      scheduled_at TEXT NOT NULL DEFAULT '',
      send_state TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      accepted_at TEXT NOT NULL DEFAULT '',
      received_at TEXT NOT NULL DEFAULT '',
      displayed_at TEXT NOT NULL DEFAULT '',
      opened_at TEXT NOT NULL DEFAULT '',
      next_attempt_at TEXT NOT NULL DEFAULT '',
      lease_token TEXT NOT NULL DEFAULT '',
      lease_expires_at TEXT NOT NULL DEFAULT '',
      last_error_code TEXT NOT NULL DEFAULT '',
      failed_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
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
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO app_settings (key, value, updated_at) VALUES
      ('notification.siteId', '${TEST_SITE_ID}', CURRENT_TIMESTAMP),
      ('notification.siteOrigin', '${TEST_SITE_ORIGIN}', CURRENT_TIMESTAMP);
  `);
  const now = new Date();
  sqlite.prepare(
    `INSERT INTO call_note_pair_codes
      (id, code_hmac, expires_at, used_at, invalidated_at, failed_attempts, created_at)
     VALUES (?, ?, ?, '', '', 0, ?)`
  ).run(
    crypto.randomUUID(),
    await pairCodeHmac(SECRET, pairCode),
    new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
    now.toISOString()
  );
  return {
    sqlite,
    env: {
      DB: d1Adapter(sqlite),
      NOTIFICATION_SECRET: SECRET,
      PASSKEY_ORIGIN: TEST_SITE_ORIGIN,
      SITE_ORIGIN: TEST_SITE_ORIGIN,
      PUSH_TRANSPORT: pushTransport,
      ...(pushTransport === "relay" ? {
        RELAY_BASE_URL: "https://relay.example.com",
        RELAY_KEY_ID: "rkey_v1_AAAAAAAAAAAAAAAAAAAAAA",
        RELAY_HMAC_SECRET: "relay-api-test-hmac-secret-that-is-long-enough"
      } : {})
    }
  };
}

function pair(env, pairCode, ip) {
  return callApi(env, ["integrations", "call-note", "devices", "pair"], {
    method: "POST",
    ip,
    body: {
      pairCode,
      fid: "firebase-installation-id-for-pairing",
      deviceName: "Pixel Unit Test",
      appVersion: "6.3.0 (43)",
      platform: "android",
      notificationPermission: "granted",
      notificationsEnabled: true
    }
  });
}

function register(env, device, body) {
  return callApi(env, ["integrations", "call-note", "devices", device.deviceId, "registration"], {
    method: "PUT",
    auth: device.deviceCredential,
    body
  });
}

function callApi(env, path, { method, body, ip = "203.0.113.1", auth = "", viewerRole = "" }) {
  const headers = {
    "Content-Type": "application/json",
    "CF-Connecting-IP": ip
  };
  if (auth) headers.Authorization = `Bearer ${auth}`;
  const request = new Request(`https://church-cell-manager.pages.dev/api/${path.join("/")}`, {
    method,
    headers,
    body: JSON.stringify(body)
  });
  return handleCallNoteNotificationApi({ request, env, path, viewerRole });
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
