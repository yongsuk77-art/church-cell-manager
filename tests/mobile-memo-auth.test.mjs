import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { handleCallNoteNotificationApi } from "../lib/call-note-notification-api.js";
import {
  authenticateMobileMemoRequest,
  createMobileMemoAccessToken,
  isMobileMemoTokenShape,
  MOBILE_MEMO_SCOPES,
  MOBILE_MEMO_TOKEN_PREFIX,
  MOBILE_MEMO_TOKEN_TTL_SECONDS,
  verifyMobileMemoAccessToken
} from "../lib/mobile-memo-auth.js";
import { createDeviceCredential, deviceCredentialHmac } from "../lib/notification-crypto.js";

const SECRET = "mobile-memo-auth-test-secret-at-least-32-bytes";
const OTHER_SECRET = "different-mobile-memo-test-secret-at-least-32-bytes";
const SITE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SITE_ORIGIN = "https://church-cell-manager.pages.dev";
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const GENERATION = 7;
const NOW = Date.parse("2026-07-15T04:00:00.000Z");

test("mobile memo tokens are fixed-scope, signed, and expire after exactly 15 minutes", async () => {
  const env = { NOTIFICATION_SECRET: SECRET };
  const session = await createMobileMemoAccessToken({
    env,
    siteId: SITE_ID,
    deviceId: DEVICE_ID,
    generation: GENERATION,
    now: NOW
  });

  assert.equal(session.accessToken.startsWith(MOBILE_MEMO_TOKEN_PREFIX), true);
  assert.equal(isMobileMemoTokenShape(session.accessToken), true);
  assert.equal(session.expiresInSeconds, MOBILE_MEMO_TOKEN_TTL_SECONDS);
  assert.equal(session.expiresAt, "2026-07-15T04:15:00.000Z");
  assert.deepEqual(session.scopes, MOBILE_MEMO_SCOPES);

  const claims = await verifyMobileMemoAccessToken(session.accessToken, env, {
    now: NOW + (MOBILE_MEMO_TOKEN_TTL_SECONDS - 1) * 1000
  });
  assert.deepEqual(claims, {
    v: 1,
    aud: "church-cell-manager-mobile-memo",
    siteId: SITE_ID,
    deviceId: DEVICE_ID,
    generation: GENERATION,
    scopes: [...MOBILE_MEMO_SCOPES],
    iat: NOW / 1000,
    exp: NOW / 1000 + MOBILE_MEMO_TOKEN_TTL_SECONDS
  });

  const changed = session.accessToken.endsWith("A") ? "B" : "A";
  const tampered = `${session.accessToken.slice(0, -1)}${changed}`;
  await assert.rejects(
    () => verifyMobileMemoAccessToken(tampered, env, { now: NOW }),
    (error) => error.status === 401 && error.code === "MOBILE_MEMO_TOKEN_INVALID"
  );
  await assert.rejects(
    () => verifyMobileMemoAccessToken(session.accessToken, { NOTIFICATION_SECRET: OTHER_SECRET }, { now: NOW }),
    (error) => error.status === 401 && error.code === "MOBILE_MEMO_TOKEN_INVALID"
  );
  await assert.rejects(
    () => verifyMobileMemoAccessToken(session.accessToken, env, {
      now: NOW + MOBILE_MEMO_TOKEN_TTL_SECONDS * 1000
    }),
    (error) => error.status === 401 && error.code === "MOBILE_MEMO_TOKEN_EXPIRED"
  );
});

test("mobile memo request authentication checks live site, device status, and generation", async () => {
  const fixture = createAuthFixture();
  try {
    const session = await createMobileMemoAccessToken({
      env: fixture.env,
      siteId: SITE_ID,
      deviceId: DEVICE_ID,
      generation: GENERATION
    });
    const request = memoRequest(session.accessToken);
    assert.deepEqual(
      await authenticateMobileMemoRequest(request, fixture.env, "notes:write"),
      {
        kind: "mobile",
        deviceId: DEVICE_ID,
        generation: GENERATION,
        siteId: SITE_ID,
        scopes: [...MOBILE_MEMO_SCOPES]
      }
    );

    fixture.sqlite.prepare("UPDATE call_note_devices SET generation = generation + 1 WHERE id = ?")
      .run(DEVICE_ID);
    await assert.rejects(
      () => authenticateMobileMemoRequest(request, fixture.env, "notes:read"),
      (error) => error.status === 401 && error.code === "MOBILE_MEMO_DEVICE_INACTIVE"
    );

    fixture.sqlite.prepare("UPDATE call_note_devices SET generation = ?, status = 'revoked' WHERE id = ?")
      .run(GENERATION, DEVICE_ID);
    await assert.rejects(
      () => authenticateMobileMemoRequest(request, fixture.env, "notes:read"),
      (error) => error.status === 401 && error.code === "MOBILE_MEMO_DEVICE_INACTIVE"
    );

    fixture.sqlite.prepare("UPDATE call_note_devices SET status = 'unregistered' WHERE id = ?")
      .run(DEVICE_ID);
    assert.equal(
      (await authenticateMobileMemoRequest(request, fixture.env, "members:read")).deviceId,
      DEVICE_ID
    );

    fixture.sqlite.prepare(
      "UPDATE app_settings SET value = ? WHERE key = 'notification.siteId'"
    ).run("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    await assert.rejects(
      () => authenticateMobileMemoRequest(request, fixture.env, "notes:read"),
      (error) => error.status === 401 && error.code === "MOBILE_MEMO_TOKEN_INVALID"
    );
  } finally {
    fixture.sqlite.close();
  }
});

test("an active device credential exchanges for a memo session and updates last seen", async () => {
  const fixture = await createExchangeFixture();
  try {
    const before = fixture.sqlite.prepare(
      "SELECT last_seen_at AS lastSeenAt FROM call_note_devices WHERE id = ?"
    ).get(DEVICE_ID).lastSeenAt;
    const response = await exchangeMemoSession(fixture.env, fixture.credential);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const body = await response.json();
    assert.equal(body.schemaVersion, "1");
    assert.equal(body.tokenType, "Bearer");
    assert.equal(body.deviceId, DEVICE_ID);
    assert.equal(body.generation, GENERATION);
    assert.equal(body.siteId, SITE_ID);
    assert.equal(body.siteOrigin, SITE_ORIGIN);
    assert.equal(body.expiresInSeconds, MOBILE_MEMO_TOKEN_TTL_SECONDS);
    assert.deepEqual(body.scopes, MOBILE_MEMO_SCOPES);
    assert.equal(isMobileMemoTokenShape(body.accessToken), true);
    assert.equal(new Date(body.serverTime).toISOString(), body.serverTime);
    const remainingMs = new Date(body.expiresAt).getTime() - new Date(body.serverTime).getTime();
    assert.ok(remainingMs > 899_000 && remainingMs <= 900_000);

    const principal = await authenticateMobileMemoRequest(
      memoRequest(body.accessToken),
      fixture.env,
      "notes:read"
    );
    assert.equal(principal.deviceId, DEVICE_ID);
    const after = fixture.sqlite.prepare(
      "SELECT last_seen_at AS lastSeenAt FROM call_note_devices WHERE id = ?"
    ).get(DEVICE_ID).lastSeenAt;
    assert.notEqual(after, before);
    assert.equal(after, body.serverTime);

    const wrongCredential = await exchangeMemoSession(
      fixture.env,
      "dvc_v1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
    );
    assert.equal(wrongCredential.status, 401);
    assert.equal((await wrongCredential.json()).code, "DEVICE_AUTH_INVALID");

    fixture.sqlite.prepare(
      "UPDATE call_note_devices SET status = 'pending', generation = 0, pending_expires_at = ? WHERE id = ?"
    ).run(new Date(Date.now() + 60_000).toISOString(), DEVICE_ID);
    const pending = await exchangeMemoSession(fixture.env, fixture.credential);
    assert.equal(pending.status, 409);
    assert.equal((await pending.json()).code, "DEVICE_REGISTRATION_REQUIRED");
  } finally {
    fixture.sqlite.close();
  }
});

function memoRequest(token) {
  return new Request(`${SITE_ORIGIN}/api/notes`, {
    headers: { Authorization: `Bearer ${token}` }
  });
}

function createAuthFixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE call_note_devices (id TEXT PRIMARY KEY, status TEXT NOT NULL, generation INTEGER NOT NULL);
    INSERT INTO app_settings (key, value, updated_at)
      VALUES ('notification.siteId', '${SITE_ID}', CURRENT_TIMESTAMP);
    INSERT INTO call_note_devices (id, status, generation)
      VALUES ('${DEVICE_ID}', 'active', ${GENERATION});
  `);
  return {
    sqlite,
    env: { DB: d1Adapter(sqlite), NOTIFICATION_SECRET: SECRET }
  };
}

async function createExchangeFixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO app_settings (key, value, updated_at) VALUES
      ('notification.siteId', '${SITE_ID}', CURRENT_TIMESTAMP),
      ('notification.siteOrigin', '${SITE_ORIGIN}', CURRENT_TIMESTAMP);
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
  `);
  const credential = createDeviceCredential();
  const credentialHmac = await deviceCredentialHmac(SECRET, DEVICE_ID, credential);
  const oldSeenAt = "2026-07-14T00:00:00.000Z";
  sqlite.prepare(
    `INSERT INTO call_note_devices
      (id, status, generation, credential_hmac, target_kind, target_ciphertext,
       target_fingerprint, target_revision, relay_target_handle, relay_target_generation,
       relay_target_revision, relay_target_state, relay_synced_at, registration_version,
       registration_client_at, device_name, app_version, notification_permission,
       notifications_enabled, pair_code_id, paired_at, pending_expires_at, activated_at,
       last_registered_at, last_seen_at, revoked_at, updated_at)
     VALUES (?, 'active', ?, ?, 'fid', 'encrypted', 'fingerprint', 1, '', 0, 0,
       'none', '', 1, ?, 'Pixel Test', '7.0.0', 'granted', 1, 'pair-code-1', ?, '', ?, ?, ?, '', ?)`
  ).run(
    DEVICE_ID,
    GENERATION,
    credentialHmac,
    oldSeenAt,
    oldSeenAt,
    oldSeenAt,
    oldSeenAt,
    oldSeenAt,
    oldSeenAt
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

function exchangeMemoSession(env, credential) {
  const path = ["integrations", "call-note", "devices", DEVICE_ID, "memo-session"];
  const request = new Request(`${SITE_ORIGIN}/api/${path.join("/")}`, {
    method: "POST",
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
