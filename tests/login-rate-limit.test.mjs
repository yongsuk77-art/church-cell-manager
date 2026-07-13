import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  clearGuestLoginFailures,
  getGuestLoginLock,
  recordGuestLoginFailure
} from "../lib/login-rate-limit.js";

test("guest login failures are counted globally and lock only after the configured limit", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const env = { DB: d1Adapter(sqlite) };
  const now = Date.parse("2026-07-13T12:00:00Z");

  for (let attempt = 1; attempt < 20; attempt += 1) {
    const result = await recordGuestLoginFailure(env, now + attempt);
    assert.equal(result.locked, false);
  }
  const locked = await recordGuestLoginFailure(env, now + 20);
  assert.equal(locked.locked, true);
  assert.equal((await getGuestLoginLock(env, now + 21)).locked, true);

  await clearGuestLoginFailures(env);
  assert.equal((await getGuestLoginLock(env, now + 22)).locked, false);
  sqlite.close();
});

test("guest failure window starts over after fifteen minutes", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const env = { DB: d1Adapter(sqlite) };
  const now = Date.parse("2026-07-13T12:00:00Z");
  await recordGuestLoginFailure(env, now);
  await recordGuestLoginFailure(env, now + 15 * 60 * 1000 + 1);
  const row = sqlite.prepare(
    "SELECT failure_count AS failureCount, window_started_at AS windowStartedAt FROM auth_login_limits"
  ).get();
  assert.equal(row.failureCount, 1);
  assert.equal(row.windowStartedAt, now + 15 * 60 * 1000 + 1);
  sqlite.close();
});

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
        async run() {
          const result = statement.run(...bound);
          return { meta: { changes: Number(result.changes || 0) } };
        }
      };
    }
  };
}
