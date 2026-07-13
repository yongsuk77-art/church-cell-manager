import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { onRequest } from "../functions/api/[[path]].js";
import {
  authenticatePasskey,
  createPasskeyAuthenticationOptions,
  createPasskeyPasswordResetOptions,
  verifyPasskeyPasswordReset
} from "../lib/webauthn.js";

const ORIGIN = "http://localhost";
const PASSKEY_SECRET = "passkey-password-reset-test-secret-32-bytes-minimum";
const SESSION_REVISION = "A".repeat(32);
const SESSION_ID = "B".repeat(43);
const SESSION_COOKIE = `__Host-seosanch_cell_session=${sessionValue()}`;

test("password-reset challenges are session-bound and cannot be exchanged with login challenges", async () => {
  const fixture = await createPasskeyFixture();
  try {
    const request = passkeyRequest("/api/auth/passkey/password-reset-options");
    const login = await createPasskeyAuthenticationOptions(request, fixture.env);
    const reset = await createPasskeyPasswordResetOptions(request, fixture.env);
    const loginPayload = decodeChallengePayload(login.challengeToken);
    const resetPayload = decodeChallengePayload(reset.challengeToken);

    assert.equal(loginPayload.purpose, "login");
    assert.equal(loginPayload.sessionBinding, undefined);
    assert.equal(resetPayload.purpose, "password-reset");
    assert.match(resetPayload.sessionBinding, /^[A-Za-z0-9_-]+$/);

    const dummyCredential = assertionEnvelope(fixture.credentialId, fixture.userHandle);
    await assert.rejects(
      authenticatePasskey(request, fixture.env, {
        challengeToken: reset.challengeToken,
        credential: dummyCredential
      }),
      (error) => error?.code === "CHALLENGE_INVALID"
    );
    await assert.rejects(
      verifyPasskeyPasswordReset(request, fixture.env, {
        challengeToken: login.challengeToken,
        credential: dummyCredential
      }),
      (error) => error?.code === "CHALLENGE_INVALID"
    );
    await assert.rejects(
      verifyPasskeyPasswordReset(
        passkeyRequest("/api/auth/passkey/reset-password", sessionValue({ sessionId: "D".repeat(43) })),
        fixture.env,
        { challengeToken: reset.challengeToken, credential: dummyCredential }
      ),
      (error) => error?.code === "CHALLENGE_INVALID"
    );

    const refreshedSessionResult = await verifyPasskeyPasswordReset(
      passkeyRequest("/api/auth/passkey/reset-password", sessionValue({
        expiresAt: Math.floor(Date.now() / 1000) + 7200,
        signature: "E".repeat(43)
      })),
      fixture.env,
      {
        challengeToken: reset.challengeToken,
        credential: await signedAssertion(reset.options.challenge, fixture, 1)
      }
    );
    assert.equal(refreshedSessionResult.credentialId, fixture.credentialId);

    for (const legacySession of [
      "raw-session-cookie",
      `v3.admin.${Math.floor(Date.now() / 1000) + 3600}.${"F".repeat(43)}`,
      sessionValue().replace("v4.admin.", "v4.guest.")
    ]) {
      await assert.rejects(
        createPasskeyPasswordResetOptions(
          passkeyRequest("/api/auth/passkey/password-reset-options", legacySession),
          fixture.env
        ),
        (error) => error?.code === "SESSION_REQUIRED"
      );
    }
  } finally {
    fixture.sqlite.close();
  }
});

test("admin can reset the password only after a fresh passkey assertion and a challenge is consumed once", async () => {
  const fixture = await createPasskeyFixture();
  try {
    const guestResponse = await apiRequest(
      fixture.env,
      ["auth", "passkey", "password-reset-options"],
      undefined,
      "guest"
    );
    assert.equal(guestResponse.status, 403);

    const optionsResponse = await apiRequest(
      fixture.env,
      ["auth", "passkey", "password-reset-options"]
    );
    assert.equal(optionsResponse.status, 200);
    const ceremony = await optionsResponse.json();
    const credential = await signedAssertion(
      ceremony.options.challenge,
      fixture,
      1
    );

    const resetResponse = await apiRequest(
      fixture.env,
      ["auth", "passkey", "reset-password"],
      {
        challengeToken: ceremony.challengeToken,
        credential,
        newPassword: "new-admin-password-2026"
      }
    );
    assert.equal(resetResponse.status, 200);
    assert.deepEqual(await resetResponse.json(), { ok: true });

    const passwordSetting = fixture.sqlite.prepare(
      "SELECT value FROM app_settings WHERE key = 'auth.passwordHash'"
    ).get();
    assert.match(passwordSetting.value, /^pbkdf2-sha256\$100000\$/);
    const auditRow = fixture.sqlite.prepare(
      "SELECT actor, action, after_json AS afterJson FROM audit_logs WHERE action = 'auth.password.reset_with_passkey'"
    ).get();
    assert.equal(auditRow.actor, "admin");
    assert.equal(auditRow.action, "auth.password.reset_with_passkey");
    assert.equal(JSON.parse(auditRow.afterJson).method, "passkey");

    const replayResponse = await apiRequest(
      fixture.env,
      ["auth", "passkey", "reset-password"],
      {
        challengeToken: ceremony.challengeToken,
        credential: await signedAssertion(ceremony.options.challenge, fixture, 2),
        newPassword: "another-admin-password-2026"
      }
    );
    assert.equal(replayResponse.status, 409);
    assert.equal((await replayResponse.json()).code, "CHALLENGE_REPLAYED");
  } finally {
    fixture.sqlite.close();
  }
});

test("passkey reset enforces the streamed request limit and password byte limit", async () => {
  const fixture = await createPasskeyFixture();
  try {
    const nonStringResponse = await apiRequest(
      fixture.env,
      ["auth", "passkey", "reset-password"],
      {
        challengeToken: "unused",
        credential: assertionEnvelope(fixture.credentialId, fixture.userHandle),
        newPassword: { value: "not-a-string" }
      }
    );
    assert.equal(nonStringResponse.status, 400);
    assert.match((await nonStringResponse.json()).error, /형식/);

    const oracleResponse = await apiRequest(
      fixture.env,
      ["auth", "passkey", "reset-password"],
      {
        challengeToken: "not-a-valid-challenge",
        credential: assertionEnvelope(fixture.credentialId, fixture.userHandle),
        newPassword: "current-admin-password-2026"
      }
    );
    assert.equal(oracleResponse.status, 400);
    assert.equal((await oracleResponse.json()).code, "CHALLENGE_INVALID");

    const oversizedPassword = "가".repeat(43);
    assert.ok(new TextEncoder().encode(oversizedPassword).byteLength > 128);
    const passwordResponse = await apiRequest(
      fixture.env,
      ["auth", "passkey", "reset-password"],
      {
        challengeToken: "unused",
        credential: assertionEnvelope(fixture.credentialId, fixture.userHandle),
        newPassword: oversizedPassword
      }
    );
    assert.equal(passwordResponse.status, 400);
    assert.match((await passwordResponse.json()).error, /128바이트/);

    const oversizedJson = JSON.stringify({ padding: "x".repeat(192 * 1024) });
    const bytes = new TextEncoder().encode(oversizedJson);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 96 * 1024));
        controller.enqueue(bytes.subarray(96 * 1024));
        controller.close();
      }
    });
    const request = new Request(`${ORIGIN}/api/auth/passkey/reset-password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        Cookie: SESSION_COOKIE
      },
      body: stream,
      duplex: "half"
    });
    const response = await onRequest({
      request,
      env: fixture.env,
      params: { path: ["auth", "passkey", "reset-password"] },
      data: { viewerRole: "admin" }
    });
    assert.equal(response.status, 413);
  } finally {
    fixture.sqlite.close();
  }
});

test("password and success audit are committed atomically", async () => {
  const fixture = await createPasskeyFixture();
  try {
    fixture.sqlite.exec(`
      CREATE TRIGGER reject_password_reset_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'auth.password.reset_with_passkey'
      BEGIN
        SELECT RAISE(ABORT, 'audit unavailable');
      END;
    `);
    const optionsResponse = await apiRequest(
      fixture.env,
      ["auth", "passkey", "password-reset-options"]
    );
    const ceremony = await optionsResponse.json();
    const response = await apiRequest(
      fixture.env,
      ["auth", "passkey", "reset-password"],
      {
        challengeToken: ceremony.challengeToken,
        credential: await signedAssertion(ceremony.options.challenge, fixture, 1),
        newPassword: "new-admin-password-2026"
      }
    );
    assert.equal(response.status, 500);
    assert.equal(fixture.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM app_settings WHERE key = 'auth.passwordHash'"
    ).get().count, 0);
    assert.equal(fixture.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'auth.password.reset_with_passkey'"
    ).get().count, 0);
  } finally {
    fixture.sqlite.close();
  }
});

async function createPasskeyFixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
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

  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const credentialId = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  const userHandle = base64Url(new TextEncoder().encode("admin-user-handle"));
  const now = new Date().toISOString();
  const credential = {
    id: credentialId,
    publicKey: base64Url(coseEs256PublicKey(publicJwk)),
    algorithm: -7,
    counter: 0,
    transports: ["internal"],
    userHandle,
    deviceType: "singleDevice",
    backedUp: false,
    rpId: "localhost",
    origin: ORIGIN,
    createdAt: now,
    lastUsedAt: ""
  };
  sqlite.prepare(
    "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)"
  ).run("auth.passkeys", JSON.stringify({ version: 1, credentials: [credential] }), now);

  return {
    sqlite,
    env: {
      DB: d1Adapter(sqlite),
      PASSKEY_CHALLENGE_SECRET: PASSKEY_SECRET,
      SITE_PASSWORD: "current-admin-password-2026"
    },
    credentialId,
    userHandle,
    privateKey: keyPair.privateKey
  };
}

function apiRequest(env, path, body, viewerRole = "admin") {
  const request = new Request(`${ORIGIN}/api/${path.join("/")}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      Cookie: SESSION_COOKIE
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return onRequest({ request, env, params: { path }, data: { viewerRole } });
}

function passkeyRequest(path, session = sessionValue()) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      Cookie: `__Host-seosanch_cell_session=${session}`
    }
  });
}

function sessionValue({
  revision = SESSION_REVISION,
  sessionId = SESSION_ID,
  expiresAt = Math.floor(Date.now() / 1000) + 3600,
  signature = "C".repeat(43)
} = {}) {
  return `v4.admin.${revision}.${sessionId}.${expiresAt}.${signature}`;
}

async function signedAssertion(challenge, fixture, counter) {
  const clientData = new TextEncoder().encode(JSON.stringify({
    type: "webauthn.get",
    challenge,
    origin: ORIGIN,
    crossOrigin: false
  }));
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode("localhost"))
  );
  const authenticatorData = new Uint8Array(37);
  authenticatorData.set(rpIdHash, 0);
  authenticatorData[32] = 0x05;
  new DataView(authenticatorData.buffer).setUint32(33, counter, false);
  const clientDataHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientData));
  const signedBytes = concatBytes(authenticatorData, clientDataHash);
  const rawSignature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    fixture.privateKey,
    signedBytes
  ));

  return {
    id: fixture.credentialId,
    rawId: fixture.credentialId,
    type: "public-key",
    authenticatorAttachment: "platform",
    clientExtensionResults: {},
    response: {
      clientDataJSON: base64Url(clientData),
      authenticatorData: base64Url(authenticatorData),
      signature: base64Url(ecdsaSignatureToDer(rawSignature)),
      userHandle: fixture.userHandle
    }
  };
}

function assertionEnvelope(credentialId, userHandle) {
  return {
    id: credentialId,
    rawId: credentialId,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: "YQ",
      authenticatorData: "YQ",
      signature: "YQ",
      userHandle
    }
  };
}

function decodeChallengePayload(token) {
  const encoded = String(token).split(".")[1];
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded)));
}

function coseEs256PublicKey(jwk) {
  const x = base64UrlToBytes(jwk.x);
  const y = base64UrlToBytes(jwk.y);
  return Uint8Array.from([
    0xa5,
    0x01, 0x02,
    0x03, 0x26,
    0x20, 0x01,
    0x21, 0x58, 0x20, ...x,
    0x22, 0x58, 0x20, ...y
  ]);
}

function ecdsaSignatureToDer(signature) {
  if (signature.length !== 64) return signature;
  const r = positiveDerInteger(signature.subarray(0, 32));
  const s = positiveDerInteger(signature.subarray(32));
  return Uint8Array.from([0x30, r.length + s.length + 4, 0x02, r.length, ...r, 0x02, s.length, ...s]);
}

function positiveDerInteger(value) {
  let offset = 0;
  while (offset < value.length - 1 && value[offset] === 0) offset += 1;
  const trimmed = value.subarray(offset);
  return trimmed[0] & 0x80 ? Uint8Array.from([0, ...trimmed]) : trimmed;
}

function concatBytes(...values) {
  const bytes = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0));
  let offset = 0;
  for (const value of values) {
    bytes.set(value, offset);
    offset += value.byteLength;
  }
  return bytes;
}

function base64Url(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const base64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
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
