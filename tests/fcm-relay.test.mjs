import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  RELAY_AUTH_HEADERS,
  createRelayAuthHeaders,
  verifyRelayAuthSignature
} from "../lib/relay-auth.js";
import { handleRelayRequest, sendFcmDelivery } from "../workers/fcm-relay/index.js";

const relayMigration1 = readFileSync(
  new URL("../relay-migrations/0001_relay_schema.sql", import.meta.url),
  "utf8"
);
const relayMigration2 = readFileSync(
  new URL("../relay-migrations/0002_relay_admission_and_target_tombstone.sql", import.meta.url),
  "utf8"
);
const migration = `${relayMigration1}\n${relayMigration2}`;
const MASTER_SECRET = "relay-master-secret-for-tests-that-is-more-than-32-bytes";
const ADMIN_TOKEN = "relay-admin-token-for-tests-that-is-more-than-32-bytes";
const SITE_A = "11111111-1111-4111-8111-111111111111";
const SITE_B = "22222222-2222-4222-8222-222222222222";
const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DEVICE_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DEVICE_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TARGET_HANDLE_PATTERN = /^rth_v1_[A-Za-z0-9_-]{32}$/;

test("HMAC V1 signs exact raw bytes and rejects tampering and stale timestamps", async () => {
  const secret = "site-hmac-secret-for-tests-that-is-more-than-32-bytes";
  const timestamp = 2_000_000_000;
  const nonce = "AAAAAAAAAAAAAAAAAAAAAA";
  const rawBody = JSON.stringify({ exact: "bytes" });
  const headers = await createRelayAuthHeaders({
    method: "post",
    path: "/v1/deliveries",
    rawBody,
    siteId: SITE_A,
    keyId: "rkey_v1_AAAAAAAAAAAAAAAAAAAAAA",
    secret,
    timestamp,
    nonce
  });
  assert.deepEqual(Object.keys(headers).sort(), Object.values(RELAY_AUTH_HEADERS).sort());

  const request = new Request("https://relay.example/v1/deliveries", {
    method: "POST",
    headers,
    body: rawBody
  });
  const verified = await verifyRelayAuthSignature({ request, rawBody, secret, now: timestamp });
  assert.equal(verified.siteId, SITE_A);
  assert.equal(verified.timestamp, timestamp);
  assert.equal(verified.nonce, nonce);
  assert.match(verified.nonceHash, /^[A-Za-z0-9_-]{43}$/);

  await assert.rejects(
    verifyRelayAuthSignature({ request, rawBody: `${rawBody} `, secret, now: timestamp }),
    (error) => error.code === "RELAY_SIGNATURE_INVALID"
  );
  await assert.rejects(
    verifyRelayAuthSignature({ request, rawBody, secret, now: timestamp + 301 }),
    (error) => error.code === "RELAY_TIMESTAMP_OUT_OF_WINDOW"
  );
});

test("admin registration encrypts keys, rotates with overlap, and rejects noncanonical origins", async (t) => {
  const harness = createHarness(t);
  const invalid = await adminCall(harness.env, "/admin/v1/sites", {
    siteId: SITE_A,
    siteOrigin: "https://site-a.example:8443"
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { code: "SITE_ORIGIN_INVALID" });
  const emptyQuery = await adminCall(harness.env, "/admin/v1/sites", {
    siteId: SITE_A,
    siteOrigin: "https://site-a.example?"
  });
  assert.equal(emptyQuery.status, 400);
  assert.deepEqual(await emptyQuery.json(), { code: "SITE_ORIGIN_INVALID" });

  const site = await registerSite(harness.env, SITE_A, "https://SITE-A.example");
  assert.equal(site.code, "SITE_CREATED");
  assert.equal(site.siteOrigin, "https://site-a.example");
  assert.match(site.keyId, /^rkey_v1_[A-Za-z0-9_-]{22}$/);
  assert.match(site.secret, /^[A-Za-z0-9_-]{43}$/);
  const stored = harness.sqlite.prepare(
    "SELECT secret_ciphertext AS ciphertext FROM relay_site_keys WHERE site_id = ?"
  ).get(SITE_A);
  assert.equal(stored.ciphertext.includes(site.secret), false);

  const rotatedResponse = await adminCall(
    harness.env,
    `/admin/v1/sites/${SITE_A}/keys/rotate`,
    {}
  );
  assert.equal(rotatedResponse.status, 200);
  const rotated = await rotatedResponse.json();
  assert.equal(rotated.code, "SITE_KEY_ROTATED");
  assert.notEqual(rotated.keyId, site.keyId);
  assert.notEqual(rotated.secret, site.secret);
  const auditRows = harness.sqlite.prepare(
    `SELECT action, site_id AS siteId, key_id AS keyId, result
     FROM relay_admin_audit WHERE site_id = ? ORDER BY created_at, action`
  ).all(SITE_A);
  assert.equal(auditRows.length, 2);
  assert.equal(auditRows[0].action, "site.create");
  assert.equal(auditRows[0].siteId, SITE_A);
  assert.equal(auditRows[0].result, "success");
  assert.equal(auditRows[1].action, "site.key.rotate");
  assert.equal(auditRows[1].keyId, rotated.keyId);
  assert.equal(JSON.stringify(auditRows).includes(site.secret), false);
  assert.equal(JSON.stringify(auditRows).includes(rotated.secret), false);

  // The previous key remains verify-only during the documented 24-hour grace.
  const targetResponse = await signedCall(harness.env, site, "PUT", `/v1/targets/${DEVICE_A}`, {
    targetKind: "fid",
    targetValue: "firebase-installation-id-A",
    deviceGeneration: 1,
    targetRevision: 1
  });
  assert.equal(targetResponse.status, 200);
});

test("relay migration 0002 preserves v1 data and backfills the site target tombstone", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(relayMigration1);
    const nowIso = "2026-07-14T00:00:00.000Z";
    sqlite.prepare(
      `INSERT INTO relay_sites (site_id, site_origin, status, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?)`
    ).run(SITE_A, "https://site-a.example", nowIso, nowIso);
    sqlite.prepare(
      `INSERT INTO relay_targets
        (target_handle, site_id, site_device_id, target_kind, target_ciphertext,
         target_fingerprint, device_generation, target_revision, status,
         created_at, updated_at, last_registered_at)
       VALUES (?, ?, ?, 'fid', 'encrypted', 'fingerprint', 7, 4, 'active', ?, ?, ?)`
    ).run(
      "rth_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      SITE_A,
      DEVICE_B,
      nowIso,
      nowIso,
      nowIso
    );

    sqlite.exec(relayMigration2);

    assert.deepEqual({ ...sqlite.prepare(
      `SELECT max_device_generation AS generation,
        max_generation_device_id AS deviceId, max_target_revision AS revision
       FROM relay_sites WHERE site_id = ?`
    ).get(SITE_A) }, { generation: 7, deviceId: DEVICE_B, revision: 4 });
    assert.ok(sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'relay_site_admission_limits'"
    ).get());
    assert.ok(sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_relay_replay_nonces_site_cap'"
    ).get());
  } finally {
    sqlite.close();
  }
});

test("target upsert uses opaque handles, blocks replay/cross-site use, and makes stale DELETE safe", async (t) => {
  const harness = createHarness(t);
  const siteA = await registerSite(harness.env, SITE_A, "https://site-a.example");
  const siteB = await registerSite(harness.env, SITE_B, "https://site-b.example");
  const targetBody = {
    targetKind: "fid",
    targetValue: "shared-firebase-installation-id",
    deviceGeneration: 1,
    targetRevision: 1
  };

  const firstSigned = await buildSignedRequest(siteA, "PUT", `/v1/targets/${DEVICE_A}`, targetBody, {
    nonce: "AQEBAQEBAQEBAQEBAQEBAQ"
  });
  const first = await handleRelayRequest(firstSigned.request, harness.env);
  assert.equal(first.status, 200);
  const firstPayload = await first.json();
  assert.deepEqual(Object.keys(firstPayload).sort(), [
    "deviceGeneration", "status", "targetHandle", "targetRevision"
  ]);
  assert.match(firstPayload.targetHandle, TARGET_HANDLE_PATTERN);

  const replay = await handleRelayRequest(
    new Request(firstSigned.request.url, firstSigned.init),
    harness.env
  );
  assert.equal(replay.status, 409);
  assert.deepEqual(await replay.json(), { code: "RELAY_REPLAY_DETECTED" });

  const repeated = await signedCall(harness.env, siteA, "PUT", `/v1/targets/${DEVICE_A}`, targetBody);
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).targetHandle, firstPayload.targetHandle);

  // Re-pairing the same phone under a new local device UUID gets a new handle.
  // This prevents a delayed DELETE for the old binding from revoking the new one.
  const transferred = await signedCall(harness.env, siteA, "PUT", `/v1/targets/${DEVICE_B}`, {
    ...targetBody,
    deviceGeneration: 2
  });
  assert.equal(transferred.status, 200);
  const transferredPayload = await transferred.json();
  assert.match(transferredPayload.targetHandle, TARGET_HANDLE_PATTERN);
  assert.notEqual(transferredPayload.targetHandle, firstPayload.targetHandle);
  const rows = harness.sqlite.prepare(
    `SELECT site_device_id AS siteDeviceId, target_handle AS targetHandle, status
     FROM relay_targets WHERE site_id = ? ORDER BY site_device_id`
  ).all(SITE_A);
  assert.deepEqual(rows.map((row) => [row.siteDeviceId, row.status]), [
    [DEVICE_A, "revoked"],
    [DEVICE_B, "active"]
  ]);

  const staleDelete = await signedCall(
    harness.env,
    siteA,
    "DELETE",
    `/v1/targets/${firstPayload.targetHandle}`,
    null
  );
  assert.equal(staleDelete.status, 204);
  assert.equal(harness.sqlite.prepare(
    "SELECT status FROM relay_targets WHERE target_handle = ?"
  ).get(transferredPayload.targetHandle).status, "active");

  const staleOldDevice = await signedCall(
    harness.env,
    siteA,
    "PUT",
    `/v1/targets/${DEVICE_A}`,
    targetBody
  );
  assert.equal(staleOldDevice.status, 409);
  assert.deepEqual(await staleOldDevice.json(), { code: "TARGET_VERSION_STALE" });
  assert.equal(harness.sqlite.prepare(
    "SELECT status FROM relay_targets WHERE target_handle = ?"
  ).get(transferredPayload.targetHandle).status, "active");

  const crossSite = await signedCall(harness.env, siteB, "PUT", `/v1/targets/${DEVICE_A}`, targetBody);
  assert.equal(crossSite.status, 409);
  assert.deepEqual(await crossSite.json(), { code: "TARGET_ALREADY_ACTIVE" });

  const deleted = await signedCall(
    harness.env,
    siteA,
    "DELETE",
    `/v1/targets/${transferredPayload.targetHandle}`,
    null
  );
  assert.equal(deleted.status, 204);
});

test("an atomic site tombstone blocks a delayed lower generation after concurrent target pruning", async (t) => {
  const harness = createHarness(t, {
    RELAY_REQUEST_RATE_LIMIT_PER_MINUTE: "10",
    RELAY_TARGET_RATE_LIMIT_PER_MINUTE: "10"
  });
  const site = await registerSite(harness.env, SITE_A, "https://site-a.example");
  const originalBatch = harness.env.DB.batch;
  let concurrentGenerationCommitted = false;
  harness.env.DB.batch = async (statements) => {
    if (!concurrentGenerationCommitted) {
      concurrentGenerationCommitted = true;
      // Simulate device B generation 2 completing registration, disconnecting,
      // and having its old target row pruned after this request's reads but
      // before its target batch commits. Only the durable tombstone remains.
      harness.sqlite.prepare(
        `UPDATE relay_sites
         SET max_device_generation = 2, max_generation_device_id = ?,
           max_target_revision = 1, updated_at = ?
         WHERE site_id = ?`
      ).run(DEVICE_B, new Date().toISOString(), SITE_A);
    }
    return originalBatch(statements);
  };

  const delayed = await signedCall(harness.env, site, "PUT", `/v1/targets/${DEVICE_A}`, {
    targetKind: "fid",
    targetValue: "firebase-installation-id-A",
    deviceGeneration: 1,
    targetRevision: 1
  });
  assert.equal(concurrentGenerationCommitted, true);
  assert.equal(delayed.status, 409);
  assert.deepEqual(await delayed.json(), { code: "TARGET_VERSION_STALE" });
  assert.equal(harness.sqlite.prepare(
    "SELECT COUNT(*) AS count FROM relay_targets WHERE site_id = ?"
  ).get(SITE_A).count, 0);
  assert.deepEqual({ ...harness.sqlite.prepare(
    `SELECT max_device_generation AS generation,
      max_generation_device_id AS deviceId, max_target_revision AS revision
     FROM relay_sites WHERE site_id = ?`
  ).get(SITE_A) }, { generation: 2, deviceId: DEVICE_B, revision: 1 });
});

test("target registration works while sending is disabled and delivery uses a normalized blocked result", async (t) => {
  const harness = createHarness(t, { RELAY_SEND_ENABLED: "false" });
  const site = await registerSite(harness.env, SITE_A, "https://site-a.example");
  const target = await registerTarget(harness.env, site, DEVICE_A);
  assert.match(target.targetHandle, TARGET_HANDLE_PATTERN);

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("must not send");
  };
  try {
    const response = await signedCall(
      harness.env,
      site,
      "POST",
      "/v1/deliveries",
      deliveryBody(target.targetHandle)
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      outcome: "blocked",
      httpStatus: 503,
      errorCode: "RELAY_SEND_DISABLED",
      retryAfterMs: 0,
      messageName: ""
    });
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("target row cap and retention bound repeated re-pairing", async (t) => {
  const harness = createHarness(t, {
    RELAY_TARGET_MAX_ROWS_PER_SITE: "2",
    RELAY_TARGET_RETENTION_DAYS: "7",
    RELAY_TARGET_RATE_LIMIT_PER_MINUTE: "10"
  });
  const site = await registerSite(harness.env, SITE_A, "https://site-a.example");
  const firstTarget = await registerTarget(harness.env, site, DEVICE_A);
  const second = await signedCall(harness.env, site, "PUT", `/v1/targets/${DEVICE_B}`, {
    targetKind: "fid",
    targetValue: "firebase-installation-id-B",
    deviceGeneration: 2,
    targetRevision: 1
  });
  assert.equal(second.status, 200);
  harness.sqlite.prepare(
    `INSERT INTO relay_deliveries
      (site_id, notification_id, payload_hash, target_handle, device_generation,
       target_revision, type, reminder_id, scheduled_at, route, state, outcome,
       http_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 1, 'connection_test', '', ?, ?, 'accepted',
       'accepted', 200, ?, ?)`
  ).run(
    SITE_A,
    "99999999-9999-4999-8999-999999999999",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    firstTarget.targetHandle,
    "2020-01-01T00:00:00.000Z",
    "reminders/99999999-9999-4999-8999-999999999999",
    "2020-01-01T00:00:00.000Z",
    "2026-07-14T12:00:00.000Z"
  );
  const capped = await signedCall(harness.env, site, "PUT", `/v1/targets/${DEVICE_C}`, {
    targetKind: "fid",
    targetValue: "firebase-installation-id-C",
    deviceGeneration: 3,
    targetRevision: 1
  });
  assert.equal(capped.status, 507);
  assert.deepEqual(await capped.json(), { code: "TARGET_STORAGE_LIMIT" });

  harness.sqlite.prepare(
    "UPDATE relay_targets SET updated_at = '2020-01-01T00:00:00.000Z' WHERE site_device_id = ?"
  ).run(DEVICE_A);
  harness.sqlite.prepare(
    "UPDATE relay_deliveries SET updated_at = '2020-01-01T00:00:00.000Z' WHERE target_handle = ?"
  ).run(firstTarget.targetHandle);
  const afterRetention = await signedCall(harness.env, site, "PUT", `/v1/targets/${DEVICE_C}`, {
    targetKind: "fid",
    targetValue: "firebase-installation-id-C",
    deviceGeneration: 3,
    targetRevision: 1
  });
  assert.equal(afterRetention.status, 200);
  assert.equal(
    harness.sqlite.prepare("SELECT COUNT(*) AS count FROM relay_targets WHERE site_id = ?").get(SITE_A).count,
    2
  );
});

test("delivery sends exact seven-key data, is version-scoped idempotent, and rejects PII", async (t) => {
  const serviceAccount = await createServiceAccount();
  const harness = createHarness(t, {
    RELAY_SEND_ENABLED: "true",
    FCM_TARGET_PROJECT_ID: "callsum-target-project",
    FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount)
  });
  const site = await registerSite(harness.env, SITE_A, "https://site-a.example");
  const target = await registerTarget(harness.env, site, DEVICE_A);
  const originalFetch = globalThis.fetch;
  const fcmBodies = [];
  globalThis.fetch = async (url, init) => {
    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "oauth-token", expires_in: 3600 });
    }
    assert.equal(url, "https://fcm.googleapis.com/v1/projects/callsum-target-project/messages:send");
    fcmBodies.push(JSON.parse(init.body));
    return Response.json({
      name: `projects/callsum-target-project/messages/message-${fcmBodies.length}`
    });
  };
  try {
    const bodyV1 = deliveryBody(target.targetHandle);
    const accepted = await signedCall(harness.env, site, "POST", "/v1/deliveries", bodyV1);
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).outcome, "accepted");
    assert.equal(fcmBodies.length, 1);
    assert.equal(fcmBodies[0].message.fid, "firebase-installation-id-A");
    assert.equal(fcmBodies[0].message.notification, undefined);
    assert.deepEqual(Object.keys(fcmBodies[0].message.data).sort(), [
      "notificationId",
      "reminderId",
      "route",
      "scheduledAt",
      "schemaVersion",
      "siteId",
      "type"
    ]);
    assert.equal(fcmBodies[0].message.data.deviceGeneration, undefined);
    assert.equal(fcmBodies[0].message.data.targetRevision, undefined);

    const duplicate = await signedCall(harness.env, site, "POST", "/v1/deliveries", bodyV1);
    assert.equal((await duplicate.json()).outcome, "accepted");
    assert.equal(fcmBodies.length, 1);

    const conflictBody = { ...bodyV1, scheduledAt: "2026-07-14T13:00:00.000Z" };
    const conflict = await signedCall(harness.env, site, "POST", "/v1/deliveries", conflictBody);
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { code: "IDEMPOTENCY_CONFLICT" });

    const pii = { ...deliveryBody(target.targetHandle, "44444444-4444-4444-8444-444444444444"), memberName: "private" };
    const piiResponse = await signedCall(harness.env, site, "POST", "/v1/deliveries", pii);
    assert.equal(piiResponse.status, 400);
    assert.deepEqual(await piiResponse.json(), { code: "DELIVERY_SCHEMA_INVALID" });

    const rotatedTargetResponse = await signedCall(
      harness.env,
      site,
      "PUT",
      `/v1/targets/${DEVICE_A}`,
      {
        targetKind: "fid",
        targetValue: "firebase-installation-id-A",
        deviceGeneration: 1,
        targetRevision: 2
      }
    );
    const rotatedTarget = await rotatedTargetResponse.json();
    assert.equal(rotatedTarget.targetHandle, target.targetHandle);
    const bodyV2 = { ...bodyV1, targetRevision: 2 };
    const acceptedV2 = await signedCall(harness.env, site, "POST", "/v1/deliveries", bodyV2);
    assert.equal((await acceptedV2.json()).outcome, "accepted");
    assert.equal(fcmBodies.length, 2, "a new target version has its own idempotency attempt");

    const wrongVersion = deliveryBody(
      target.targetHandle,
      "55555555-5555-4555-8555-555555555555",
      { targetRevision: 99 }
    );
    const mismatch = await signedCall(harness.env, site, "POST", "/v1/deliveries", wrongVersion);
    assert.deepEqual(await mismatch.json(), {
      outcome: "unregistered",
      httpStatus: 409,
      errorCode: "TARGET_VERSION_MISMATCH",
      retryAfterMs: 0,
      messageName: ""
    });
    assert.equal(fcmBodies.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("delivery row cap is hard-bounded and retention makes room for new notifications", async (t) => {
  const serviceAccount = await createServiceAccount();
  const harness = createHarness(t, {
    RELAY_SEND_ENABLED: "true",
    RELAY_DELIVERY_MAX_ROWS_PER_SITE: "1",
    RELAY_DELIVERY_RETENTION_DAYS: "7",
    FCM_TARGET_PROJECT_ID: "callsum-target-project",
    FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount)
  });
  const site = await registerSite(harness.env, SITE_A, "https://site-a.example");
  const target = await registerTarget(harness.env, site, DEVICE_A);
  const originalFetch = globalThis.fetch;
  let fcmCalls = 0;
  globalThis.fetch = async (url) => {
    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "oauth-token", expires_in: 3600 });
    }
    fcmCalls += 1;
    return Response.json({ name: `projects/callsum-target-project/messages/${fcmCalls}` });
  };
  try {
    const first = await signedCall(
      harness.env,
      site,
      "POST",
      "/v1/deliveries",
      deliveryBody(target.targetHandle)
    );
    assert.equal((await first.json()).outcome, "accepted");
    const secondBody = deliveryBody(
      target.targetHandle,
      "88888888-8888-4888-8888-888888888888"
    );
    const capped = await signedCall(harness.env, site, "POST", "/v1/deliveries", secondBody);
    assert.deepEqual(await capped.json(), {
      outcome: "blocked",
      httpStatus: 507,
      errorCode: "DELIVERY_STORAGE_LIMIT",
      retryAfterMs: 0,
      messageName: ""
    });
    assert.equal(fcmCalls, 1);

    harness.sqlite.prepare(
      "UPDATE relay_deliveries SET updated_at = '2020-01-01T00:00:00.000Z' WHERE site_id = ?"
    ).run(SITE_A);
    const afterRetention = await signedCall(
      harness.env,
      site,
      "POST",
      "/v1/deliveries",
      secondBody
    );
    assert.equal((await afterRetention.json()).outcome, "accepted");
    assert.equal(fcmCalls, 2);
    assert.equal(
      harness.sqlite.prepare("SELECT COUNT(*) AS count FROM relay_deliveries WHERE site_id = ?").get(SITE_A).count,
      1
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OAuth and FCM share one bounded upstream deadline", async () => {
  const account = await createServiceAccount();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "oauth-token", expires_in: 3600 });
    }
    return new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  };
  try {
    const startedAt = Date.now();
    const result = await sendFcmDelivery(
      {
        serviceAccount: {
          clientEmail: account.client_email,
          privateKey: account.private_key
        },
        targetProjectId: "callsum-target-project",
        upstreamTimeoutMs: 30
      },
      "fid",
      "firebase-installation-id-A",
      SITE_A,
      deliveryBody("rth_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
    );
    assert.equal(result.outcome, "retry");
    assert.equal(result.errorCode, "FCM_TIMEOUT");
    assert.ok(Date.now() - startedAt < 500);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("delivery and target rate limits plus streaming body bounds are enforced", async (t) => {
  const harness = createHarness(t, {
    RELAY_SEND_ENABLED: "false",
    RELAY_SITE_RATE_LIMIT_PER_MINUTE: "1",
    RELAY_TARGET_RATE_LIMIT_PER_MINUTE: "2"
  });
  const site = await registerSite(harness.env, SITE_A, "https://site-a.example");
  const target = await registerTarget(harness.env, site, DEVICE_A);
  const targetBody = {
    targetKind: "fid",
    targetValue: "firebase-installation-id-A",
    deviceGeneration: 1,
    targetRevision: 1
  };
  assert.equal((await signedCall(
    harness.env,
    site,
    "PUT",
    `/v1/targets/${DEVICE_A}`,
    targetBody
  )).status, 200);
  const targetLimited = await signedCall(
    harness.env,
    site,
    "PUT",
    `/v1/targets/${DEVICE_A}`,
    targetBody
  );
  assert.equal(targetLimited.status, 429);
  assert.deepEqual(await targetLimited.json(), { code: "SITE_RATE_LIMITED" });
  const first = await signedCall(
    harness.env,
    site,
    "POST",
    "/v1/deliveries",
    deliveryBody(target.targetHandle)
  );
  assert.equal(first.status, 200);
  const limited = await signedCall(
    harness.env,
    site,
    "POST",
    "/v1/deliveries",
    deliveryBody(target.targetHandle, "66666666-6666-4666-8666-666666666666")
  );
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { code: "SITE_RATE_LIMITED" });
  assert.ok(Number(limited.headers.get("Retry-After")) >= 1);

  const huge = "x".repeat(16 * 1024 + 1);
  const hugeHeaders = await createRelayAuthHeaders({
    method: "POST",
    path: "/v1/deliveries",
    rawBody: huge,
    siteId: site.siteId,
    keyId: site.keyId,
    secret: site.secret
  });
  const tooLarge = await handleRelayRequest(new Request("https://relay.example/v1/deliveries", {
    method: "POST",
    headers: { ...hugeHeaders, "Content-Type": "application/json" },
    body: huge
  }), harness.env);
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(await tooLarge.json(), { code: "REQUEST_TOO_LARGE" });
});

test("site-wide admission limits PUT, DELETE, and delivery before consuming a nonce", async (t) => {
  const harness = createHarness(t, {
    RELAY_SEND_ENABLED: "false",
    RELAY_REQUEST_RATE_LIMIT_PER_MINUTE: "3",
    RELAY_SITE_RATE_LIMIT_PER_MINUTE: "10",
    RELAY_TARGET_RATE_LIMIT_PER_MINUTE: "10"
  });
  const site = await registerSite(harness.env, SITE_A, "https://site-a.example");
  const target = await registerTarget(harness.env, site, DEVICE_A);

  const missingDelete = await signedCall(
    harness.env,
    site,
    "DELETE",
    "/v1/targets/rth_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    null
  );
  assert.equal(missingDelete.status, 204);

  const delivery = await signedCall(
    harness.env,
    site,
    "POST",
    "/v1/deliveries",
    deliveryBody(target.targetHandle)
  );
  assert.equal(delivery.status, 200);

  const limited = await signedCall(
    harness.env,
    site,
    "DELETE",
    `/v1/targets/${target.targetHandle}`,
    null
  );
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { code: "SITE_RATE_LIMITED" });
  assert.ok(Number(limited.headers.get("Retry-After")) >= 1);

  assert.equal(harness.sqlite.prepare(
    "SELECT COUNT(*) AS count FROM relay_replay_nonces WHERE site_id = ?"
  ).get(SITE_A).count, 3);
  assert.equal(harness.sqlite.prepare(
    "SELECT status FROM relay_targets WHERE target_handle = ?"
  ).get(target.targetHandle).status, "active");

  const invalidSigned = await buildSignedRequest(
    site,
    "DELETE",
    `/v1/targets/${target.targetHandle}`,
    null
  );
  const invalidHeaders = new Headers(invalidSigned.init.headers);
  invalidHeaders.set(RELAY_AUTH_HEADERS.signature, `v1=${"A".repeat(43)}`);
  const invalid = await handleRelayRequest(new Request(invalidSigned.request.url, {
    ...invalidSigned.init,
    headers: invalidHeaders
  }), harness.env);
  assert.equal(invalid.status, 401);
  assert.deepEqual(await invalid.json(), { code: "RELAY_SIGNATURE_INVALID" });
  assert.equal(harness.sqlite.prepare(
    "SELECT request_count AS count FROM relay_site_admission_limits WHERE site_id = ?"
  ).get(SITE_A).count, 3);
});

test("the replay nonce table has a hard per-site ceiling", async (t) => {
  const harness = createHarness(t, {
    RELAY_REQUEST_RATE_LIMIT_PER_MINUTE: "90"
  });
  const site = await registerSite(harness.env, SITE_A, "https://site-a.example");
  harness.sqlite.prepare(
    `WITH RECURSIVE sequence(value) AS (
       SELECT 1
       UNION ALL
       SELECT value + 1 FROM sequence WHERE value < 1000
     )
     INSERT INTO relay_replay_nonces
       (site_id, key_id, nonce_hash, request_timestamp, seen_at, expires_at)
     SELECT ?, ?, printf('seed-%04d', value), 2000000000,
       '2026-07-14T00:00:00.000Z', '2999-01-01T00:00:00.000Z'
     FROM sequence`
  ).run(site.siteId, site.keyId);
  assert.equal(harness.sqlite.prepare(
    "SELECT COUNT(*) AS count FROM relay_replay_nonces WHERE site_id = ?"
  ).get(SITE_A).count, 1000);

  const capped = await signedCall(
    harness.env,
    site,
    "DELETE",
    "/v1/targets/rth_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    null
  );
  assert.equal(capped.status, 429);
  assert.deepEqual(await capped.json(), { code: "SITE_RATE_LIMITED" });
  assert.ok(Number(capped.headers.get("Retry-After")) >= 1);
  assert.equal(harness.sqlite.prepare(
    "SELECT COUNT(*) AS count FROM relay_replay_nonces WHERE site_id = ?"
  ).get(SITE_A).count, 1000);
});

function createHarness(t, overrides = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);
  t.after(() => sqlite.close());
  return {
    sqlite,
    env: {
      DB: d1Adapter(sqlite),
      RELAY_MASTER_SECRET: MASTER_SECRET,
      RELAY_ADMIN_TOKEN: ADMIN_TOKEN,
      RELAY_SEND_ENABLED: "false",
      ...overrides
    }
  };
}

async function registerSite(env, siteId, siteOrigin) {
  const response = await adminCall(env, "/admin/v1/sites", { siteId, siteOrigin });
  assert.equal(response.status, 201);
  return response.json();
}

async function adminCall(env, path, body, token = ADMIN_TOKEN) {
  const rawBody = JSON.stringify(body);
  return handleRelayRequest(new Request(`https://relay.example${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: rawBody
  }), env);
}

async function registerTarget(env, site, deviceId) {
  const response = await signedCall(env, site, "PUT", `/v1/targets/${deviceId}`, {
    targetKind: "fid",
    targetValue: "firebase-installation-id-A",
    deviceGeneration: 1,
    targetRevision: 1
  });
  assert.equal(response.status, 200);
  return response.json();
}

function deliveryBody(targetHandle, notificationId = "33333333-3333-4333-8333-333333333333", patch = {}) {
  return {
    schemaVersion: "2",
    targetHandle,
    deviceGeneration: 1,
    targetRevision: 1,
    notificationId,
    type: "memo_reminder",
    reminderId: "77777777-7777-4777-8777-777777777777",
    scheduledAt: "2026-07-14T12:00:00.000Z",
    route: `reminders/${notificationId}`,
    ...patch
  };
}

async function signedCall(env, site, method, path, body, options = {}) {
  const signed = await buildSignedRequest(site, method, path, body, options);
  return handleRelayRequest(signed.request, env);
}

async function buildSignedRequest(site, method, path, body, options = {}) {
  const rawBody = body === null ? "" : JSON.stringify(body);
  const authHeaders = await createRelayAuthHeaders({
    method,
    path,
    rawBody,
    siteId: site.siteId,
    keyId: site.keyId,
    secret: site.secret,
    timestamp: options.timestamp,
    nonce: options.nonce
  });
  const headers = {
    ...authHeaders,
    ...(body === null ? {} : { "Content-Type": "application/json; charset=utf-8" })
  };
  const init = { method, headers, ...(body === null ? {} : { body: rawBody }) };
  return {
    request: new Request(`https://relay.example${path}`, init),
    init
  };
}

async function createServiceAccount() {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["sign", "verify"]
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const base64 = Buffer.from(pkcs8).toString("base64");
  return {
    project_id: "credential-project-not-the-target",
    client_email: "relay-test@credential-project.iam.gserviceaccount.com",
    private_key: `-----BEGIN PRIVATE KEY-----\n${base64.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`
  };
}

function d1Adapter(sqlite) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let bound = [];
      const prepared = {
        bind(...values) {
          bound = values;
          return prepared;
        },
        async first() {
          return statement.get(...bound);
        },
        async all() {
          return { results: statement.all(...bound) };
        },
        async run() {
          const result = statement.run(...bound);
          return { success: true, meta: { changes: Number(result.changes || 0) } };
        }
      };
      return prepared;
    },
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
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
