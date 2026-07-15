import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { onRequest as middleware } from "../functions/_middleware.js";

const SESSION_SECRET = "session-security-test-secret-at-least-32-bytes";
const PASSWORD_HASH_KEY = "auth.passwordHash";
const GUEST_PASSWORD_HASH_KEY = "auth.guestPasswordHash";

test("only exact mobile memo bearer routes bypass the web login and country gate", async () => {
  const memoToken = `mmo_v1_${"A".repeat(100)}.${"B".repeat(43)}`;
  const mobileHeaders = { Authorization: `Bearer ${memoToken}`, "CF-IPCountry": "US" };

  for (const [path, method] of [
    ["/api/notes", "GET"],
    ["/api/notes/11111111-1111-4111-8111-111111111111", "PATCH"],
    ["/api/mobile/notes/sync?cursor=0", "GET"],
    ["/api/mobile/members?query=test", "GET"],
    ["/api/photos/notes%2Fmemo%2Fphoto.png", "GET"],
    ["/photos/seed-member.jpg", "GET"]
  ]) {
    const result = await dispatch({}, new Request(`https://example.test${path}`, {
      method,
      headers: mobileHeaders
    }));
    assert.equal(result.reachedNext, true, `${method} ${path}`);
  }

  const broadMemberApi = await dispatch({}, new Request("https://example.test/api/members", {
    headers: mobileHeaders
  }));
  assert.equal(broadMemberApi.reachedNext, false);
  assert.equal(broadMemberApi.response.status, 403);

  const deviceCredentialOnNotes = await dispatch({}, new Request("https://example.test/api/notes", {
    headers: {
      Authorization: `Bearer dvc_v1_${"C".repeat(43)}`,
      "CF-IPCountry": "US"
    }
  }));
  assert.equal(deviceCredentialOnNotes.reachedNext, false);
  assert.equal(deviceCredentialOnNotes.response.status, 403);
});

test("login page offers an explicit 30-day automatic-login choice", async () => {
  const fixture = await createFixture({ adminPassword: "login-page-password-2026" });
  try {
    const page = await dispatch(fixture.env, request("/__auth/login"));
    assert.equal(page.response.status, 200);
    const html = await page.response.text();
    assert.match(html, /id="rememberLogin"[^>]+name="remember"[^>]+value="1"/);
    assert.match(html, /자동 로그인/);
    assert.match(html, /30일 동안 유지/);
    assert.match(html, /공용 기기에서는 사용하지 마세요/);

    const failed = await login(fixture.env, "wrong-password", { remember: true });
    assert.equal(failed.status, 401);
    assert.match(await failed.text(), /id="rememberLogin"[^>]+checked/);
  } finally {
    fixture.sqlite.close();
  }
});

test("v5 sessions keep their mode and stable random session id across refresh", async () => {
  const fixture = await createFixture({ adminPassword: "old-admin-password-2026" });
  try {
    const loggedIn = await login(fixture.env, "old-admin-password-2026");
    assert.equal(loggedIn.status, 302);
    assert.match(loggedIn.headers.get("Set-Cookie") || "", /Max-Age=3600/);
    const firstCookie = sessionCookieFrom(loggedIn);
    const firstParts = firstCookie.split(".");
    assert.equal(firstParts.length, 7);
    assert.equal(firstParts[0], "v5");
    assert.equal(firstParts[1], "admin");
    assert.equal(firstParts[2], "standard");
    assert.match(firstParts[3], /^[A-Za-z0-9_-]{32}$/);
    assert.match(firstParts[4], /^[A-Za-z0-9_-]{43}$/);
    assert.match(firstParts[6], /^[A-Za-z0-9_-]{43}$/);

    const refreshed = await dispatch(fixture.env, request("/__auth/refresh", {
      method: "POST",
      cookie: firstCookie
    }));
    assert.equal(refreshed.response.status, 200);
    assert.equal(refreshed.response.headers.get("X-Seosanch-Session-Persistent"), "0");
    const refreshedParts = sessionCookieFrom(refreshed.response).split(".");
    assert.equal(refreshedParts[3], firstParts[3]);
    assert.equal(refreshedParts[4], firstParts[4]);

    const forgedMode = [...firstParts];
    forgedMode[2] = "remember";
    const forged = await dispatch(fixture.env, request("/api/bootstrap", {
      cookie: forgedMode.join(".")
    }));
    assert.equal(forged.response.status, 401);
    assert.equal(forged.reachedNext, false);

    const legacyV4Cookie = await createLegacyV4AdminCookie(fixture.sqlite);
    const legacyV4 = await dispatch(fixture.env, request("/api/bootstrap", {
      cookie: legacyV4Cookie
    }));
    assert.equal(legacyV4.response.status, 200);
    assert.equal(legacyV4.response.headers.get("X-Seosanch-Session-Persistent"), "0");
    assert.equal(legacyV4.reachedNext, true);

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

test("automatic login creates and refreshes a signed 30-day session", async () => {
  const fixture = await createFixture({ adminPassword: "remember-me-password-2026" });
  try {
    const loggedIn = await login(fixture.env, "remember-me-password-2026", { remember: true });
    assert.equal(loggedIn.status, 302);
    assert.match(loggedIn.headers.get("Set-Cookie") || "", /Max-Age=2592000/);

    const firstCookie = sessionCookieFrom(loggedIn);
    const firstParts = firstCookie.split(".");
    assert.equal(firstParts[2], "remember");
    const remainingSeconds = Number(firstParts[5]) - Math.floor(Date.now() / 1000);
    assert.ok(remainingSeconds >= 2591998 && remainingSeconds <= 2592000);

    const bootstrap = await dispatch(fixture.env, request("/api/bootstrap", {
      cookie: firstCookie
    }));
    assert.equal(bootstrap.response.status, 200);
    assert.equal(bootstrap.response.headers.get("X-Seosanch-Session-Persistent"), "1");

    const refreshed = await dispatch(fixture.env, request("/__auth/refresh", {
      method: "POST",
      cookie: firstCookie
    }));
    assert.equal(refreshed.response.status, 200);
    assert.equal(refreshed.response.headers.get("X-Seosanch-Session-Persistent"), "1");
    assert.deepEqual(await refreshed.response.json(), {
      ok: true,
      persistent: true,
      expiresInSeconds: 2592000
    });
    const refreshedParts = sessionCookieFrom(refreshed.response).split(".");
    assert.equal(refreshedParts[2], "remember");
    assert.equal(refreshedParts[3], firstParts[3]);
    assert.equal(refreshedParts[4], firstParts[4]);
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

async function login(env, password, { remember = false } = {}) {
  return (await dispatch(env, new Request("http://localhost/__auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      password,
      ...(remember ? { remember: "1" } : {})
    })
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

async function createLegacyV4AdminCookie(sqlite) {
  const storedHash = sqlite.prepare(
    "SELECT value FROM app_settings WHERE key = ?"
  ).get(PASSWORD_HASH_KEY).value;
  const revision = (await hmac(`admin-session:stored:${storedHash}`)).slice(0, 32);
  const sessionId = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const payload = `v4.admin.${revision}.${sessionId}.${expiresAt}`;
  return `${payload}.${await hmac(payload)}`;
}

async function hmac(value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return base64Url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}
