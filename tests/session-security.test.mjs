import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { onRequest as middleware } from "../functions/_middleware.js";

const SESSION_SECRET = "session-security-test-secret-at-least-32-bytes";
const PASSWORD_HASH_KEY = "auth.passwordHash";
const GUEST_PASSWORD_HASH_KEY = "auth.guestPasswordHash";

test("v4 sessions keep a stable random session id across refresh and reject legacy cookies", async () => {
  const fixture = await createFixture({ adminPassword: "old-admin-password-2026" });
  try {
    const loggedIn = await login(fixture.env, "old-admin-password-2026");
    assert.equal(loggedIn.status, 302);
    const firstCookie = sessionCookieFrom(loggedIn);
    const firstParts = firstCookie.split(".");
    assert.equal(firstParts.length, 6);
    assert.equal(firstParts[0], "v4");
    assert.equal(firstParts[1], "admin");
    assert.match(firstParts[2], /^[A-Za-z0-9_-]{32}$/);
    assert.match(firstParts[3], /^[A-Za-z0-9_-]{43}$/);
    assert.match(firstParts[5], /^[A-Za-z0-9_-]{43}$/);

    const refreshed = await dispatch(fixture.env, request("/__auth/refresh", {
      method: "POST",
      cookie: firstCookie
    }));
    assert.equal(refreshed.response.status, 200);
    const refreshedParts = sessionCookieFrom(refreshed.response).split(".");
    assert.equal(refreshedParts[2], firstParts[2]);
    assert.equal(refreshedParts[3], firstParts[3]);

    for (const legacyCookie of [
      `v3.admin.admin.${Math.floor(Date.now() / 1000) + 3600}.${"A".repeat(43)}`,
      `v2.admin.${Math.floor(Date.now() / 1000) + 3600}.${"B".repeat(43)}`,
      `${Math.floor(Date.now() / 1000) + 3600}.${"C".repeat(43)}`
    ]) {
      const denied = await dispatch(fixture.env, request("/api/bootstrap", {
        cookie: legacyCookie
      }));
      assert.equal(denied.response.status, 401);
      assert.equal(denied.reachedNext, false);
    }
  } finally {
    fixture.sqlite.close();
  }
});

test("changing the admin password invalidates every old admin session but not guest sessions", async () => {
  const fixture = await createFixture({
    adminPassword: "old-admin-password-2026",
    guestPassword: "g7!x2"
  });
  try {
    const adminCookie = sessionCookieFrom(await login(fixture.env, "old-admin-password-2026"));
    const guestCookie = sessionCookieFrom(await login(fixture.env, "g7!x2"));
    await setPasswordHash(fixture.sqlite, PASSWORD_HASH_KEY, "new-admin-password-2026");

    const oldAdmin = await dispatch(fixture.env, request("/api/bootstrap", {
      cookie: adminCookie
    }));
    assert.equal(oldAdmin.response.status, 401);
    assert.equal(oldAdmin.reachedNext, false);

    const guest = await dispatch(fixture.env, request("/api/bootstrap", {
      cookie: guestCookie
    }));
    assert.equal(guest.response.status, 200);
    assert.equal(guest.reachedNext, true);
    assert.equal((await guest.response.json()).role, "guest");
  } finally {
    fixture.sqlite.close();
  }
});

test("password storage failures never fall back to the environment password", async () => {
  const env = {
    DB: {
      prepare() {
        return {
          bind() { return this; },
          async first() { throw new Error("D1 unavailable"); }
        };
      }
    },
    SITE_PASSWORD: "environment-fallback-must-not-work",
    SESSION_SECRET
  };
  const response = await login(env, "environment-fallback-must-not-work");
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Set-Cookie"), null);
});

test("a password reset racing after verification cannot mint a session for the old password", async () => {
  const sqlite = new DatabaseSync(":memory:");
  createSchema(sqlite);
  await setPasswordHash(sqlite, PASSWORD_HASH_KEY, "old-admin-password-2026");
  const newHash = await passwordHash("new-admin-password-2026");
  const env = {
    DB: d1Adapter(sqlite, {
      afterPasswordRead(readCount) {
        if (readCount === 2) {
          sqlite.prepare("UPDATE app_settings SET value = ?, updated_at = ? WHERE key = ?")
            .run(newHash, new Date().toISOString(), PASSWORD_HASH_KEY);
        }
      }
    }),
    SITE_PASSWORD: "environment-fallback-must-not-work",
    SESSION_SECRET
  };
  try {
    const response = await login(env, "old-admin-password-2026");
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("Set-Cookie"), null);
  } finally {
    sqlite.close();
  }
});

async function createFixture({ adminPassword, guestPassword = "" }) {
  const sqlite = new DatabaseSync(":memory:");
  createSchema(sqlite);
  await setPasswordHash(sqlite, PASSWORD_HASH_KEY, adminPassword);
  if (guestPassword) await setPasswordHash(sqlite, GUEST_PASSWORD_HASH_KEY, guestPassword);
  return {
    sqlite,
    env: {
      DB: d1Adapter(sqlite),
      SITE_PASSWORD: "environment-fallback-must-not-work",
      SESSION_SECRET
    }
  };
}

function createSchema(sqlite) {
  sqlite.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

async function setPasswordHash(sqlite, key, password) {
  const value = await passwordHash(password);
  sqlite.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, new Date().toISOString());
}

async function passwordHash(password) {
  const iterations = 100000;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256
  ));
  return `pbkdf2-sha256$${iterations}$${base64Url(salt)}$${base64Url(bits)}`;
}

async function login(env, password) {
  return (await dispatch(env, new Request("http://localhost/__auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password })
  }))).response;
}

function request(path, { method = "GET", cookie = "" } = {}) {
  const headers = cookie
    ? { Cookie: `__Host-seosanch_cell_session=${cookie}` }
    : undefined;
  return new Request(`http://localhost${path}`, { method, headers });
}

async function dispatch(env, requestValue) {
  const data = {};
  let reachedNext = false;
  const response = await middleware({
    request: requestValue,
    env,
    data,
    next: async () => {
      reachedNext = true;
      return new Response(JSON.stringify({ role: data.viewerRole || "" }), {
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  return { response, reachedNext };
}

function sessionCookieFrom(response) {
  const value = response.headers.get("Set-Cookie") || "";
  const match = value.match(/__Host-seosanch_cell_session=([^;,\s]+)/);
  assert.ok(match, `session cookie missing from ${value}`);
  return match[1];
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
    }
  };
}

function base64Url(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
