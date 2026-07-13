import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { onRequest } from "../functions/api/[[path]].js";

test("guest password accepts exactly four digits, including a simple PIN", async () => {
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
  const env = {
    DB: d1Adapter(sqlite),
    SITE_PASSWORD: "admin-password-2026"
  };
  try {
    for (const invalid of ["123", "12345", "12a4", "１２３４"]) {
      const response = await saveGuestPassword(env, invalid);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /숫자 4자리/);
    }

    const accepted = await saveGuestPassword(env, "1234");
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { enabled: true });
    assert.match(sqlite.prepare(
      "SELECT value FROM app_settings WHERE key = 'auth.guestPasswordHash'"
    ).get().value, /^pbkdf2-sha256\$100000\$/);
  } finally {
    sqlite.close();
  }
});

test("guest password field opens a numeric keypad and is capped at four digits", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="guestPasswordInput"[^>]*inputmode="numeric"/);
  assert.match(html, /id="guestPasswordInput"[^>]*pattern="\[0-9\]\{4\}"/);
  assert.match(html, /id="guestPasswordInput"[^>]*minlength="4"[^>]*maxlength="4"/);
});

function saveGuestPassword(env, password) {
  const request = new Request("http://localhost/api/auth/guest-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password })
  });
  return onRequest({
    request,
    env,
    params: { path: ["auth", "guest-password"] },
    data: { viewerRole: "admin" }
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
          return statement.get(...bound) || null;
        },
        async run() {
          const result = statement.run(...bound);
          return { meta: { changes: Number(result.changes || 0) } };
        }
      };
    }
  };
}
