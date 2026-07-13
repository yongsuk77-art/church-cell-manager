import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { onRequest } from "../functions/api/[[path]].js";

const PASSWORD_HASH_KEY = "auth.passwordHash";

for (const source of ["stored", "environment"]) {
  test(`ordinary password change cannot overwrite a concurrent passkey reset from ${source} credentials`, async () => {
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
    const currentPassword = source === "stored"
      ? "stored-admin-password-2026"
      : "environment-admin-password-2026";
    if (source === "stored") {
      sqlite.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)")
        .run(PASSWORD_HASH_KEY, await passwordHash(currentPassword), new Date().toISOString());
    }
    const resetHash = await passwordHash("passkey-reset-won-2026");
    const env = {
      DB: d1Adapter(sqlite, {
        afterPasswordRead(readCount) {
          if (readCount !== 1) return;
          sqlite.prepare(
            `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
          ).run(PASSWORD_HASH_KEY, resetHash, new Date().toISOString());
        }
      }),
      SITE_PASSWORD: "environment-admin-password-2026"
    };
    try {
      const response = await changePassword(env, currentPassword, "stale-request-password-2026");
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, "PASSWORD_CHANGED_REAUTH_REQUIRED");
      assert.equal(sqlite.prepare(
        "SELECT value FROM app_settings WHERE key = ?"
      ).get(PASSWORD_HASH_KEY).value, resetHash);
      assert.equal(sqlite.prepare(
        "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'auth.password.update'"
      ).get().count, 0);
    } finally {
      sqlite.close();
    }
  });
}

function changePassword(env, currentPassword, newPassword) {
  const request = new Request("http://localhost/api/auth/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword })
  });
  return onRequest({
    request,
    env,
    params: { path: ["auth", "change-password"] },
    data: { viewerRole: "admin" }
  });
}

async function passwordHash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 },
    key,
    256
  ));
  return `pbkdf2-sha256$100000$${base64Url(salt)}$${base64Url(bits)}`;
}

function d1Adapter(sqlite, hooks = {}) {
  let passwordReadCount = 0;
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
          const row = statement.get(...bound) || null;
          if (/SELECT value FROM app_settings WHERE key = \?/i.test(sql)
            && bound[0] === PASSWORD_HASH_KEY) {
            passwordReadCount += 1;
            hooks.afterPasswordRead?.(passwordReadCount, row);
          }
          return row;
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

function base64Url(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
