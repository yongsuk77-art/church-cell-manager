import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { onRequest } from "../functions/_middleware.js";

const ORIGIN = "https://church-cell-manager.pages.dev";
const PASSWORD = "unit-test-password";
const SESSION_SECRET = "auto-login-unit-test-session-secret-32-bytes";
const AUTO_COOKIE = "__Host-seosanch_cell_auto_login";
const SESSION_COOKIE = "__Host-seosanch_cell_session";

test("remembered password login stores only a keyed token hash and rotates on resume", async () => {
  const fixture = createFixture();
  try {
    const login = await passwordLogin(fixture, true);
    assert.equal(login.status, 302);
    const firstCookies = cookiesFromResponse(login);
    assert.ok(firstCookies[SESSION_COOKIE]);
    assert.match(firstCookies[AUTO_COOKIE], /^alt_v1_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);

    const firstToken = parseAutoCookie(firstCookies[AUTO_COOKIE]);
    const stored = fixture.sqlite.prepare(
      "SELECT id, token_hash AS tokenHash, previous_token_hash AS previousHash FROM auth_auto_login_tokens"
    ).get();
    assert.equal(stored.id, firstToken.id);
    assert.notEqual(stored.tokenHash, firstToken.secret);
    assert.equal(stored.previousHash, "");

    const data = {};
    const resumed = await middlewareRequest(fixture, "/api/bootstrap", {
      cookie: `${AUTO_COOKIE}=${firstCookies[AUTO_COOKIE]}`,
      data,
      next: async () => Response.json({ ok: true })
    });
    assert.equal(resumed.status, 200);
    assert.equal(data.viewerRole, "admin");
    const rotatedCookies = cookiesFromResponse(resumed);
    assert.ok(rotatedCookies[SESSION_COOKIE]);
    assert.ok(rotatedCookies[AUTO_COOKIE]);
    assert.notEqual(rotatedCookies[AUTO_COOKIE], firstCookies[AUTO_COOKIE]);

    const rotated = fixture.sqlite.prepare(
      "SELECT token_hash AS tokenHash, previous_token_hash AS previousHash, previous_valid_until AS graceUntil FROM auth_auto_login_tokens"
    ).get();
    assert.equal(rotated.previousHash, stored.tokenHash);
    assert.notEqual(rotated.tokenHash, stored.tokenHash);
    assert.ok(rotated.graceUntil > Math.floor(Date.now() / 1000));

    const graceResponse = await middlewareRequest(fixture, "/api/bootstrap", {
      cookie: `${AUTO_COOKIE}=${firstCookies[AUTO_COOKIE]}`,
      next: async () => Response.json({ ok: true })
    });
    assert.equal(graceResponse.status, 200);
  } finally {
    fixture.sqlite.close();
  }
});

test("invalid automatic-login tokens are rejected and cleared", async () => {
  const fixture = createFixture();
  try {
    const login = await passwordLogin(fixture, true);
    const value = cookiesFromResponse(login)[AUTO_COOKIE];
    const token = parseAutoCookie(value);
    const invalid = `alt_v1_${token.id}.${"A".repeat(43)}`;
    const response = await middlewareRequest(fixture, "/api/bootstrap", {
      cookie: `${AUTO_COOKIE}=${invalid}`,
      next: async () => Response.json({ leaked: true })
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "Login required");
    assert.ok(setCookies(response).some((cookie) => cookie.startsWith(`${AUTO_COOKIE}=;`)));

    const malformed = await middlewareRequest(fixture, "/api/bootstrap", {
      cookie: `${AUTO_COOKIE}=not-a-valid-token`,
      next: async () => Response.json({ leaked: true })
    });
    assert.equal(malformed.status, 401);
    assert.ok(setCookies(malformed).some((cookie) => cookie.startsWith(`${AUTO_COOKIE}=;`)));
  } finally {
    fixture.sqlite.close();
  }
});

test("settings can inspect and revoke this device without ending the four-hour session", async () => {
  const fixture = createFixture();
  try {
    const login = await passwordLogin(fixture, true);
    const cookies = cookiesFromResponse(login);
    const cookieHeader = `${SESSION_COOKIE}=${cookies[SESSION_COOKIE]}; ${AUTO_COOKIE}=${cookies[AUTO_COOKIE]}`;

    const status = await middlewareRequest(fixture, "/__auth/auto-login/status", { cookie: cookieHeader });
    assert.equal(status.status, 200);
    const statusBody = await status.json();
    assert.equal(statusBody.enabled, true);
    assert.ok(Date.parse(statusBody.expiresAt) > Date.now());

    const revoked = await middlewareRequest(fixture, "/__auth/auto-login/revoke", {
      method: "POST",
      cookie: cookieHeader
    });
    assert.equal(revoked.status, 200);
    assert.equal((await revoked.json()).enabled, false);
    assert.equal(fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM auth_auto_login_tokens").get().count, 0);
    assert.ok(setCookies(revoked).some((cookie) => cookie.startsWith(`${AUTO_COOKIE}=;`)));

    const sessionStillWorks = await middlewareRequest(fixture, "/api/bootstrap", {
      cookie: `${SESSION_COOKIE}=${cookies[SESSION_COOKIE]}`,
      next: async () => Response.json({ ok: true })
    });
    assert.equal(sessionStillWorks.status, 200);
  } finally {
    fixture.sqlite.close();
  }
});

test("logout and an unchecked password login revoke the remembered device", async () => {
  const fixture = createFixture();
  try {
    const firstLogin = await passwordLogin(fixture, true);
    const firstCookies = cookiesFromResponse(firstLogin);
    const cookieHeader = `${SESSION_COOKIE}=${firstCookies[SESSION_COOKIE]}; ${AUTO_COOKIE}=${firstCookies[AUTO_COOKIE]}`;
    const logout = await middlewareRequest(fixture, "/__auth/logout", { cookie: cookieHeader });
    assert.equal(logout.status, 302);
    assert.equal(fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM auth_auto_login_tokens").get().count, 0);
    assert.ok(setCookies(logout).some((cookie) => cookie.startsWith(`${AUTO_COOKIE}=;`)));

    const secondLogin = await passwordLogin(fixture, true);
    const secondCookies = cookiesFromResponse(secondLogin);
    assert.equal(fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM auth_auto_login_tokens").get().count, 1);
    await passwordLogin(fixture, false, `${AUTO_COOKIE}=${secondCookies[AUTO_COOKIE]}`);
    assert.equal(fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM auth_auto_login_tokens").get().count, 0);
  } finally {
    fixture.sqlite.close();
  }
});

test("revoking from an automatically resumed request leaves the clear cookie last", async () => {
  const fixture = createFixture();
  try {
    const login = await passwordLogin(fixture, true);
    const autoCookie = cookiesFromResponse(login)[AUTO_COOKIE];
    const response = await middlewareRequest(fixture, "/__auth/auto-login/revoke", {
      method: "POST",
      cookie: `${AUTO_COOKIE}=${autoCookie}`
    });
    assert.equal(response.status, 200);
    const automaticCookies = setCookies(response).filter((cookie) => cookie.startsWith(`${AUTO_COOKIE}=`));
    assert.ok(automaticCookies.length >= 2);
    assert.match(automaticCookies.at(-1), new RegExp(`^${AUTO_COOKIE}=;`));
    assert.equal(fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM auth_auto_login_tokens").get().count, 0);
  } finally {
    fixture.sqlite.close();
  }
});

test("login pages expose automatic login and fingerprint or face login without inline auth script", async () => {
  const fixture = createFixture();
  try {
    const response = await middlewareRequest(fixture, "/__auth/login");
    const html = await response.text();
    assert.match(html, /name="remember"/);
    assert.match(html, /자동 로그인 \(30일\)/);
    assert.match(html, /지문·얼굴로 로그인/);
    assert.match(html, /<script src="\/auth\.js\?v=fingerprint-login-1" defer><\/script>/);
    assert.doesNotMatch(html, /<script(?! src=)/);

    const authScript = readFileSync(new URL("../public/auth.js", import.meta.url), "utf8");
    assert.match(authScript, /remember: Boolean\(remember\?\.checked\)/);
  } finally {
    fixture.sqlite.close();
  }
});

function createFixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  sqlite.exec(readFileSync(new URL("../migrations/0026_auto_login_tokens.sql", import.meta.url), "utf8"));
  return {
    sqlite,
    env: {
      DB: d1Adapter(sqlite),
      SITE_PASSWORD: PASSWORD,
      SESSION_SECRET
    }
  };
}

async function passwordLogin(fixture, remember, cookie = "") {
  const body = new URLSearchParams({ password: PASSWORD });
  if (remember) body.set("remember", "1");
  return middlewareRequest(fixture, "/__auth/login", {
    method: "POST",
    cookie,
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" }
  });
}

function middlewareRequest(fixture, path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("CF-IPCountry", "KR");
  headers.set("CF-Connecting-IP", "203.0.113.10");
  if (options.cookie) headers.set("Cookie", options.cookie);
  const request = new Request(`${ORIGIN}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body
  });
  return onRequest({
    request,
    env: fixture.env,
    data: options.data || {},
    next: options.next || (async () => new Response("not found", { status: 404 }))
  });
}

function setCookies(response) {
  if (typeof response.headers.getSetCookie === "function") return response.headers.getSetCookie();
  const value = response.headers.get("Set-Cookie");
  return value ? [value] : [];
}

function cookiesFromResponse(response) {
  const cookies = {};
  for (const header of setCookies(response)) {
    const pair = header.split(";", 1)[0];
    const separator = pair.indexOf("=");
    cookies[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return cookies;
}

function parseAutoCookie(value) {
  const match = String(value).match(/^alt_v1_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/);
  assert.ok(match);
  return { id: match[1], secret: match[2] };
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
