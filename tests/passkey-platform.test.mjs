import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  AUTH_PASSKEYS_KEY,
  createPasskeyLoginOptions,
  createPasskeyRegistrationOptions
} from "../functions/_webauthn.js";

const ORIGIN = "https://church-cell-manager.pages.dev";
const SESSION_SECRET = "platform-passkey-test-session-secret-32-bytes";

test("registration requires the device platform authenticator and user verification", async () => {
  const fixture = createFixture();
  try {
    const options = await createPasskeyRegistrationOptions(fixture.env, new Request(`${ORIGIN}/api/auth/passkey/register-options`));
    assert.equal(options.publicKey.authenticatorSelection.authenticatorAttachment, "platform");
    assert.equal(options.publicKey.authenticatorSelection.userVerification, "required");
    assert.equal(options.publicKey.authenticatorSelection.residentKey, "preferred");
    assert.equal(options.publicKey.attestation, "none");
    assert.deepEqual(options.publicKey.pubKeyCredParams, [{ type: "public-key", alg: -7 }]);

    const payload = challengePayload(options.token);
    assert.equal(payload.kind, "passkey-register");
    assert.equal(payload.origin, ORIGIN);
    assert.equal(payload.rpId, "church-cell-manager.pages.dev");
    assert.equal(payload.expiresAt - payload.issuedAt, 300);
  } finally {
    fixture.sqlite.close();
  }
});

test("login options keep user verification required for an internal credential", async () => {
  const fixture = createFixture();
  try {
    const stored = {
      version: 1,
      credentials: [{
        id: "registered-platform-credential",
        publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
        signCount: 0,
        transports: ["internal"],
        label: "platform",
        createdAt: "2026-07-17T00:00:00.000Z",
        updatedAt: "2026-07-17T00:00:00.000Z"
      }]
    };
    fixture.sqlite.prepare(
      "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)"
    ).run(AUTH_PASSKEYS_KEY, JSON.stringify(stored), "2026-07-17T00:00:00.000Z");

    const options = await createPasskeyLoginOptions(fixture.env, new Request(`${ORIGIN}/__auth/passkey/options`));
    assert.equal(options.enabled, true);
    assert.equal(options.publicKey.userVerification, "required");
    assert.equal(options.publicKey.rpId, "church-cell-manager.pages.dev");
    assert.deepEqual(options.publicKey.allowCredentials, [{
      type: "public-key",
      id: "registered-platform-credential",
      transports: ["internal"]
    }]);
  } finally {
    fixture.sqlite.close();
  }
});

test("web UI checks for a user-verifying platform authenticator before registration and login", () => {
  const appScript = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const authScript = readFileSync(new URL("../public/auth.js", import.meta.url), "utf8");
  const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

  assert.match(appScript, /isUserVerifyingPlatformAuthenticatorAvailable/);
  assert.match(authScript, /isUserVerifyingPlatformAuthenticatorAvailable/);
  assert.match(indexHtml, /<h3>지문·얼굴 로그인<\/h3>/);
  assert.match(indexHtml, />지문·얼굴 등록<\/button>/);
});

function challengePayload(token) {
  const [encoded, signature] = String(token).split(".");
  assert.ok(encoded);
  assert.match(signature, /^[A-Za-z0-9_-]{43}$/);
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}

function createFixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return {
    sqlite,
    env: {
      DB: d1Adapter(sqlite),
      SESSION_SECRET
    }
  };
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
