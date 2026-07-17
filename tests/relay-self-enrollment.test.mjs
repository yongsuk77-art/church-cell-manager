import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { handleCallNoteNotificationApi } from "../lib/call-note-notification-api.js";
import { parseRelayEnrollmentCode } from "../lib/relay-enrollment-code.js";
import { verifyRelayAuthSignature } from "../lib/relay-auth.js";

const SITE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_SITE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SITE_ORIGIN = "https://pastor-site.example";
const RELAY_ORIGIN = "https://relay.example";
const NOTIFICATION_SECRET = "notification-secret-for-site-enrollment-tests";
const RELAY_KEY_ID = "rkey_v1_BBBBBBBBBBBBBBBBBBBBBB";
const RELAY_SECRET = "relay-site-secret-for-enrollment-tests-long";
const LEGACY_KEY_ID = "rkey_v1_AAAAAAAAAAAAAAAAAAAAAA";
const LEGACY_SECRET = "legacy-relay-secret-that-must-not-be-used";
const migration = readFileSync(
  new URL("../migrations/0027_relay_self_enrollment.sql", import.meta.url),
  "utf8"
);

test("0027 adds Relay enrollment storage without changing existing data", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec("CREATE TABLE preserved (value TEXT NOT NULL); INSERT INTO preserved VALUES ('keep');");
    sqlite.exec(migration);
    assert.equal(sqlite.prepare("SELECT value FROM preserved").get().value, "keep");
    const tables = new Set(sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all().map((row) => row.name));
    assert.equal(tables.has("relay_enrollment_requests"), true);
    assert.equal(tables.has("relay_client_credentials"), true);
  } finally {
    sqlite.close();
  }
});

test("site enrollment is token-safe, origin-bound, encrypted, idempotent, and gates FCM pairing", async (t) => {
  const harness = createHarness(t);
  let relayMode = "valid";
  let verificationCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    verificationCalls += 1;
    const request = new Request(url, init);
    assert.equal(request.url, `${RELAY_ORIGIN}/v1/site-verifications`);
    const rawBody = await request.clone().text();
    const verified = await verifyRelayAuthSignature({
      request,
      rawBody,
      secret: RELAY_SECRET
    });
    assert.equal(verified.siteId, SITE_ID);
    assert.equal(verified.keyId, RELAY_KEY_ID);
    if (relayMode === "revoked") {
      return jsonResponse({ code: "SITE_NOT_ACTIVE" }, 401);
    }
    return jsonResponse({
      code: "RELAY_CREDENTIALS_VALID",
      siteId: SITE_ID,
      keyId: RELAY_KEY_ID
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const unauthorized = await siteCall(
    harness.env,
    ["integrations", "call-note", "admin", "relay-enrollments"],
    { method: "POST" }
  );
  assert.equal(unauthorized.status, 403);

  const before = await adminStatus(harness.env);
  assert.equal(before.relayEnrollment.state, "not_registered");
  const blocked = await createPairCode(harness.env);
  assert.equal(blocked.status, 503);

  const created = await createEnrollment(harness.env);
  const parsed = parseRelayEnrollmentCode(created.requestCode);
  assert.equal(parsed.siteId, SITE_ID);
  assert.equal(parsed.siteOrigin, SITE_ORIGIN);
  assert.equal(Date.parse(parsed.expiresAt) - Date.parse(parsed.issuedAt), 10 * 60 * 1000);
  assert.ok(created.requestCode.length > 100);
  assert.doesNotMatch(created.requestCode, /^\d{6}$/);
  const storedRequest = harness.sqlite.prepare(
    `SELECT token_hmac AS tokenHmac, site_id AS siteId, site_origin AS siteOrigin
     FROM relay_enrollment_requests WHERE request_id = ?`
  ).get(parsed.requestId);
  assert.notEqual(storedRequest.tokenHmac, parsed.token);
  assert.equal(storedRequest.siteId, SITE_ID);
  assert.equal(storedRequest.siteOrigin, SITE_ORIGIN);

  const tamperedToken = `${parsed.token.slice(0, -1)}${parsed.token.endsWith("A") ? "B" : "A"}`;
  const tampered = await callbackCall(harness.env, parsed.requestId, "inspect", {
    token: tamperedToken
  });
  assert.equal(tampered.status, 401);
  const wrongOrigin = await callbackCall(harness.env, parsed.requestId, "inspect", {
    token: parsed.token
  }, "https://other-site.example");
  assert.equal(wrongOrigin.status, 403);
  harness.sqlite.prepare(
    "UPDATE relay_enrollment_requests SET site_id = ? WHERE request_id = ?"
  ).run(OTHER_SITE_ID, parsed.requestId);
  const wrongSite = await callbackCall(harness.env, parsed.requestId, "inspect", {
    token: parsed.token
  });
  assert.equal(wrongSite.status, 401);
  harness.sqlite.prepare(
    "UPDATE relay_enrollment_requests SET site_id = ? WHERE request_id = ?"
  ).run(SITE_ID, parsed.requestId);

  const inspected = await callbackCall(harness.env, parsed.requestId, "inspect", {
    token: parsed.token
  });
  assert.equal(inspected.status, 200);
  assert.equal((await inspected.json()).status, "pending");

  const wrongRelay = await callbackCall(harness.env, parsed.requestId, "complete", {
    token: parsed.token,
    relayBaseUrl: "https://wrong-relay.example",
    keyId: RELAY_KEY_ID,
    secret: RELAY_SECRET
  });
  assert.equal(wrongRelay.status, 400);
  assert.equal(verificationCalls, 0);

  const completionBody = {
    token: parsed.token,
    relayBaseUrl: RELAY_ORIGIN,
    keyId: RELAY_KEY_ID,
    secret: RELAY_SECRET
  };
  const completed = await callbackCall(
    harness.env,
    parsed.requestId,
    "complete",
    completionBody
  );
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).alreadyCompleted, false);
  assert.equal(verificationCalls, 1);

  const storedCredential = harness.sqlite.prepare(
    `SELECT key_id AS keyId, secret_ciphertext AS ciphertext, status
     FROM relay_client_credentials WHERE singleton = 1`
  ).get();
  assert.equal(storedCredential.keyId, RELAY_KEY_ID);
  assert.equal(storedCredential.status, "active");
  assert.match(storedCredential.ciphertext, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(storedCredential.ciphertext.includes(RELAY_SECRET), false);
  const auditJson = harness.sqlite.prepare(
    "SELECT GROUP_CONCAT(after_json, '') AS value FROM audit_logs WHERE entity_type='relay_enrollment'"
  ).get().value;
  assert.equal(auditJson.includes(parsed.token), false);
  assert.equal(auditJson.includes(RELAY_SECRET), false);

  const connected = await adminStatus(harness.env);
  assert.equal(connected.relayEnrollment.state, "connected");
  assert.equal(connected.relayEnrollment.source, "self_enrollment");
  assert.equal(connected.relayClientConfigured, true);
  const pair = await createPairCode(harness.env);
  assert.equal(pair.status, 201);
  assert.match((await pair.json()).pairCode, /^\d{6}$/);

  harness.sqlite.prepare(
    "UPDATE relay_enrollment_requests SET expires_at='2000-01-01T00:00:00.000Z' WHERE request_id = ?"
  ).run(parsed.requestId);
  const retry = await callbackCall(harness.env, parsed.requestId, "complete", completionBody);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).alreadyCompleted, true);
  assert.equal(verificationCalls, 3);
  assert.equal(harness.sqlite.prepare(
    "SELECT COUNT(*) AS count FROM relay_client_credentials"
  ).get().count, 1);

  const conflicting = await callbackCall(harness.env, parsed.requestId, "complete", {
    ...completionBody,
    secret: `${RELAY_SECRET}-different`
  });
  assert.equal(conflicting.status, 409);

  relayMode = "revoked";
  const revoked = await adminStatus(harness.env);
  assert.equal(revoked.relayEnrollment.state, "not_registered");
  assert.equal(revoked.relayClientConfigured, false);
  const revokedRow = harness.sqlite.prepare(
    "SELECT status, secret_ciphertext AS ciphertext FROM relay_client_credentials WHERE singleton = 1"
  ).get();
  assert.equal(revokedRow.status, "revoked");
  assert.equal(revokedRow.ciphertext, "");
  assert.equal((await createPairCode(harness.env)).status, 503);
});

test("expired requests are one-use, legacy keys remain compatible, and corrupt D1 credentials fail closed", async (t) => {
  const expiredHarness = createHarness(t);
  const expiredRequest = await createEnrollment(expiredHarness.env);
  const parsed = parseRelayEnrollmentCode(expiredRequest.requestCode);
  expiredHarness.sqlite.prepare(
    "UPDATE relay_enrollment_requests SET expires_at='2000-01-01T00:00:00.000Z' WHERE request_id = ?"
  ).run(parsed.requestId);
  const expired = await callbackCall(expiredHarness.env, parsed.requestId, "inspect", {
    token: parsed.token
  });
  assert.equal(expired.status, 410);
  assert.equal(expiredHarness.sqlite.prepare(
    "SELECT status FROM relay_enrollment_requests WHERE request_id = ?"
  ).get(parsed.requestId).status, "invalidated");

  const legacyHarness = createHarness(t, {
    RELAY_KEY_ID: LEGACY_KEY_ID,
    RELAY_HMAC_SECRET: LEGACY_SECRET
  });
  const legacyStatus = await adminStatus(legacyHarness.env);
  assert.equal(legacyStatus.relayEnrollment.state, "connected");
  assert.equal(legacyStatus.relayEnrollment.source, "legacy_environment");
  assert.equal((await createPairCode(legacyHarness.env)).status, 201);

  const corruptHarness = createHarness(t, {
    RELAY_KEY_ID: LEGACY_KEY_ID,
    RELAY_HMAC_SECRET: LEGACY_SECRET
  });
  corruptHarness.sqlite.prepare(
    `INSERT INTO relay_client_credentials
      (singleton, site_id, site_origin, relay_base_url, key_id, secret_ciphertext,
       status, installed_at, updated_at, revoked_at)
     VALUES (1, ?, ?, ?, ?, 'v1.invalid.invalid', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '')`
  ).run(SITE_ID, SITE_ORIGIN, RELAY_ORIGIN, RELAY_KEY_ID);
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("must not use legacy fallback");
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const corruptPair = await createPairCode(corruptHarness.env);
  assert.equal(corruptPair.status, 503);
  assert.equal((await corruptPair.json()).code, "RELAY_CREDENTIAL_DECRYPT_FAILED");
  assert.equal(fetchCalled, false);
});

function createHarness(t, extraEnv = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
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
    CREATE TABLE call_note_push_deliveries (
      notification_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'connection_test',
      reminder_id TEXT NOT NULL DEFAULT '',
      note_id TEXT NOT NULL DEFAULT '',
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
    INSERT INTO app_settings (key, value, updated_at) VALUES
      ('notification.siteId', '${SITE_ID}', CURRENT_TIMESTAMP),
      ('notification.siteOrigin', '${SITE_ORIGIN}', CURRENT_TIMESTAMP),
      ('notification.dispatcherStatus', '{"status":"ready","lastRunAt":"${new Date().toISOString()}","lastSuccessAt":"${new Date().toISOString()}","senderEnabled":true,"pushTransport":"relay","relayConfigured":false,"fcmConfigured":false,"notificationSecretConfigured":true}', CURRENT_TIMESTAMP);
  `);
  sqlite.exec(migration);
  t.after(() => sqlite.close());
  return {
    sqlite,
    env: {
      DB: d1Adapter(sqlite),
      NOTIFICATION_SECRET,
      SITE_ORIGIN,
      PASSKEY_ORIGIN: SITE_ORIGIN,
      PUSH_TRANSPORT: "relay",
      RELAY_BASE_URL: RELAY_ORIGIN,
      ...extraEnv
    }
  };
}

async function createEnrollment(env) {
  const response = await siteCall(
    env,
    ["integrations", "call-note", "admin", "relay-enrollments"],
    { method: "POST", viewerRole: "admin" }
  );
  assert.equal(response.status, 201);
  return response.json();
}

async function adminStatus(env) {
  const response = await siteCall(
    env,
    ["integrations", "call-note", "admin", "status"],
    { method: "GET", viewerRole: "admin" }
  );
  assert.equal(response.status, 200);
  return response.json();
}

function createPairCode(env) {
  return siteCall(
    env,
    ["integrations", "call-note", "admin", "pair-codes"],
    { method: "POST", viewerRole: "admin" }
  );
}

function callbackCall(env, requestId, operation, body, origin = SITE_ORIGIN) {
  return siteCall(
    env,
    ["integrations", "call-note", "relay-enrollments", requestId, operation],
    { method: "POST", body, origin }
  );
}

function siteCall(env, path, { method, body, viewerRole = "", origin = SITE_ORIGIN }) {
  const request = new Request(`${origin}/api/${path.join("/")}`, {
    method,
    headers: { "Content-Type": "application/json", "CF-IPCountry": "KR" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return handleCallNoteNotificationApi({ request, env, path, viewerRole });
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
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
