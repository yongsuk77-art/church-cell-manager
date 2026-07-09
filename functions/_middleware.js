const SESSION_COOKIE = "__Host-seosanch_cell_session";
const LEGACY_SESSION_COOKIE = "seosanch_cell_session";
const SESSION_TTL_SECONDS = 60 * 60 * 4;
const PASSWORD_HASH_KEY = "auth.passwordHash";
const PASSWORD_ALGORITHM = "pbkdf2-sha256";
const MAX_PBKDF2_ITERATIONS = 100000;
const LOGIN_FAILURE_PREFIX = "auth.loginFailure.";
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_LOCK_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 5;
const PUBLIC_AUTH_ASSETS = new Set([
  "/share-card.png",
  "/favicon.svg",
  "/favicon.png",
  "/apple-touch-icon.png"
]);
const PUBLIC_API_PATHS = new Set([
  "/api/webhook/call-note"
]);
const SITE_URL = "https://seosanch-cell.pages.dev/";
const META_TITLE = "남아메리카 공동체 관리";
const META_SITE_NAME = "남아메리카 공동체";
const META_DESCRIPTION = "셀별 성도 관리와 심방 기록을 위한 공동체관리 페이지";
const META_IMAGE = SITE_URL + "share-card.png?v=3";
const LOGIN_NOT_CONFIGURED = "로그인 설정이 아직 반영되지 않았습니다. 잠시 후 다시 시도해주세요.";
const INVALID_PASSWORD = "비밀번호가 맞지 않습니다.";
const LOGIN_LOCKED = "비밀번호 입력 실패가 많아 잠시 잠겼습니다. 15분 후 다시 시도해주세요.";
const COUNTRY_BLOCK_MESSAGE = "이 공동체관리 페이지는 대한민국에서만 접속할 수 있습니다.";

const SECURITY_HEADERS = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "X-Robots-Tag": "noindex, nofollow, noarchive"
};

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  if (!isLocalRequest(request, url) && !isKoreaRequest(request)) {
    return withSecurityHeaders(countryBlockResponse(url), { noStore: true });
  }

  let response;
  let noStore = url.pathname.startsWith("/api/") || url.pathname.startsWith("/__auth/");

  if (request.method === "OPTIONS") {
    response = await next();
    return withSecurityHeaders(response, { noStore });
  }

  if (PUBLIC_AUTH_ASSETS.has(url.pathname)) {
    response = await next();
    return withSecurityHeaders(response, { noStore: false });
  }

  if (PUBLIC_API_PATHS.has(url.pathname)) {
    response = await next();
    return withSecurityHeaders(response, { noStore: true });
  }

  const authConfigured = await isAuthConfigured(env);
  if (!authConfigured) {
    response = url.pathname.startsWith("/api/")
      ? json({ error: "Login is not configured" }, 503)
      : loginPage(LOGIN_NOT_CONFIGURED, 503);
    return withSecurityHeaders(response, { noStore: true });
  }

  if (url.pathname === "/__auth/login") {
    response = request.method === "POST" ? await login(request, env) : loginPage();
    return withSecurityHeaders(response, { noStore: true });
  }

  if (url.pathname === "/__auth/logout") {
    response = redirect("/", clearSessionCookies());
    return withSecurityHeaders(response, { noStore: true });
  }

  if (await hasValidSession(request, env)) {
    response = await next();
    return withSecurityHeaders(response, { noStore });
  }

  response = url.pathname.startsWith("/api/")
    ? json({ error: "Login required" }, 401)
    : loginPage();
  return withSecurityHeaders(response, { noStore: true });
}

function isLocalRequest(request, url) {
  const hostname = url.hostname.toLowerCase();
  const host = (request.headers.get("Host") || "").toLowerCase();
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || host.startsWith("localhost:")
    || host.startsWith("127.0.0.1:");
}

function isKoreaRequest(request) {
  const country = String(request.cf?.country || request.headers.get("CF-IPCountry") || "").toUpperCase();
  return country === "KR";
}

function countryBlockResponse(url) {
  if (url.pathname.startsWith("/api/")) {
    return json({ error: "Country not allowed", message: COUNTRY_BLOCK_MESSAGE }, 403);
  }
  return new Response(
    `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>접속 제한</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f7f4ed; color: #221f1a; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      main { width: min(440px, calc(100vw - 32px)); padding: 32px; border: 1px solid #dacdb8; border-radius: 8px; background: #fffdf8; box-shadow: 0 20px 60px rgba(64, 52, 34, 0.12); }
      p { margin: 0; color: #6d6255; font-weight: 700; line-height: 1.6; }
      h1 { margin: 0 0 12px; font-size: 28px; }
    </style>
  </head>
  <body><main><h1>접속이 제한되었습니다</h1><p>${COUNTRY_BLOCK_MESSAGE}</p></main></body>
</html>`,
    { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

async function isAuthConfigured(env) {
  const storedHash = await getStoredPasswordHash(env);
  const hasPassword = Boolean(storedHash || env.SITE_PASSWORD);
  const hasSessionSecret = Boolean(env.SESSION_SECRET || env.SITE_PASSWORD);
  return hasPassword && hasSessionSecret;
}

async function login(request, env) {
  const lock = await getLoginLock(request, env);
  if (lock.locked) return loginPage(LOGIN_LOCKED, 429);

  const form = await request.formData();
  const password = String(form.get("password") || "");
  if (!(await verifySitePassword(password, env))) {
    const failure = await recordLoginFailure(request, env);
    return loginPage(failure.locked ? LOGIN_LOCKED : INVALID_PASSWORD, failure.locked ? 429 : 401);
  }

  await clearLoginFailure(request, env);

  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${expiresAt}`;
  const signature = await sign(payload, env);
  const headers = clearSessionCookies();
  headers.append("Set-Cookie", [
    `${SESSION_COOKIE}=${payload}.${signature}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`
  ].join("; "));

  return redirect("/", headers);
}

async function verifySitePassword(password, env) {
  const storedHash = await getStoredPasswordHash(env);
  if (storedHash) return verifyPasswordHash(password, storedHash);
  return Boolean(env.SITE_PASSWORD) && await timingSafeStringEqual(password, env.SITE_PASSWORD);
}

async function getStoredPasswordHash(env) {
  if (!env.DB) return "";
  try {
    const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?")
      .bind(PASSWORD_HASH_KEY)
      .first();
    return typeof row?.value === "string" ? row.value : "";
  } catch {
    return "";
  }
}

async function getLoginLock(request, env) {
  const key = await loginFailureKey(request, env);
  if (!key) return { locked: false };
  try {
    const record = await readLoginFailureRecord(env, key);
    return { locked: Number(record.lockedUntil || 0) > Date.now() };
  } catch {
    return { locked: false };
  }
}

async function recordLoginFailure(request, env) {
  const key = await loginFailureKey(request, env);
  if (!key) return { locked: false };
  try {
    await ensureAppSettingsTable(env);
    const now = Date.now();
    const previous = await readLoginFailureRecord(env, key);
    const inWindow = Number(previous.firstFailedAt || 0) + LOGIN_FAILURE_WINDOW_MS > now;
    const count = inWindow ? Number(previous.count || 0) + 1 : 1;
    const locked = count >= LOGIN_FAILURE_LIMIT;
    const record = {
      count,
      firstFailedAt: inWindow ? Number(previous.firstFailedAt || now) : now,
      lockedUntil: locked ? now + LOGIN_FAILURE_LOCK_MS : Number(previous.lockedUntil || 0)
    };
    const updatedAt = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(key, JSON.stringify(record), updatedAt).run();
    return { locked };
  } catch {
    return { locked: false };
  }
}

async function clearLoginFailure(request, env) {
  const key = await loginFailureKey(request, env);
  if (!key) return;
  try {
    await env.DB.prepare("DELETE FROM app_settings WHERE key = ?").bind(key).run();
  } catch {
    // Best-effort only.
  }
}

async function loginFailureKey(request, env) {
  if (!env.DB || !(env.SESSION_SECRET || env.SITE_PASSWORD)) return "";
  const ip = clientIp(request);
  if (!ip) return "";
  const digest = await sign(`login-failure:${ip}`, env);
  return `${LOGIN_FAILURE_PREFIX}${digest.slice(0, 48)}`;
}

function clientIp(request) {
  const forwarded = request.headers.get("CF-Connecting-IP")
    || request.headers.get("X-Forwarded-For")?.split(",")[0]
    || "";
  return forwarded.trim();
}

async function readLoginFailureRecord(env, key) {
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?")
    .bind(key)
    .first();
  if (typeof row?.value !== "string") return {};
  try {
    return JSON.parse(row.value) || {};
  } catch {
    return {};
  }
}

async function ensureAppSettingsTable(env) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)"
  ).run();
}

async function verifyPasswordHash(password, storedHash) {
  const [algorithm, iterationsText, saltText, expectedText] = String(storedHash || "").split("$");
  const iterations = Number(iterationsText);
  if (algorithm !== PASSWORD_ALGORITHM || !Number.isFinite(iterations) || !saltText || !expectedText) {
    return false;
  }
  if (iterations > MAX_PBKDF2_ITERATIONS) return false;

  try {
    const salt = base64UrlToBytes(saltText);
    const expected = base64UrlToBytes(expectedText);
    const actual = new Uint8Array(await derivePasswordBits(password, salt, iterations));
    return timingSafeBytesEqual(actual, expected);
  } catch {
    return false;
  }
}

async function derivePasswordBits(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256
  );
}

async function hasValidSession(request, env) {
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const value = cookies[SESSION_COOKIE];
  if (!value) return false;

  const [expiresAt, signature] = value.split(".");
  if (!expiresAt || !signature) return false;
  if (Number(expiresAt) <= Math.floor(Date.now() / 1000)) return false;

  const expected = await sign(expiresAt, env);
  return timingSafeEqual(signature, expected);
}

async function sign(payload, env) {
  const secret = env.SESSION_SECRET || env.SITE_PASSWORD;
  if (!secret) throw new Error("Session secret is not configured");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64Url(signature);
}

function loginPage(error = "", status = 200) {
  const errorMarkup = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  return new Response(
    `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>공동체관리 로그인</title>
    ${metaTags()}
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #f7f4ed;
        color: #221f1a;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        width: min(420px, calc(100vw - 32px));
        padding: 34px;
        border: 1px solid #dacdb8;
        border-radius: 8px;
        background: #fffdf8;
        box-shadow: 0 20px 60px rgba(64, 52, 34, 0.12);
      }
      .eyebrow {
        margin: 0 0 8px;
        color: #b43a2a;
        font-size: 14px;
        font-weight: 700;
      }
      h1 {
        margin: 0 0 26px;
        font-size: 34px;
        line-height: 1.1;
      }
      label {
        display: grid;
        gap: 8px;
        color: #6d6255;
        font-size: 14px;
        font-weight: 700;
      }
      input {
        box-sizing: border-box;
        width: 100%;
        height: 48px;
        border: 1px solid #d8c9b4;
        border-radius: 8px;
        padding: 0 14px;
        font: inherit;
        color: #221f1a;
        background: #fff;
      }
      button {
        width: 100%;
        height: 50px;
        margin-top: 18px;
        border: 0;
        border-radius: 8px;
        background: #23746b;
        color: #fff;
        font-size: 17px;
        font-weight: 800;
        cursor: pointer;
      }
      .error {
        margin: 0 0 14px;
        color: #b42318;
        font-weight: 700;
      }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">남아메리카 공동체</p>
      <h1>공동체관리</h1>
      ${errorMarkup}
      <form method="post" action="/__auth/login">
        <label>
          관리자 비밀번호
          <input name="password" type="password" autocomplete="current-password" autofocus required>
        </label>
        <button type="submit">로그인</button>
      </form>
    </main>
  </body>
</html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

function metaTags() {
  return `<meta name="description" content="${META_DESCRIPTION}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="${META_SITE_NAME}">
    <meta property="og:title" content="${META_TITLE}">
    <meta property="og:description" content="${META_DESCRIPTION}">
    <meta property="og:url" content="${SITE_URL}">
    <meta property="og:image" content="${META_IMAGE}">
    <meta property="og:image:secure_url" content="${META_IMAGE}">
    <meta property="og:image:alt" content="${META_TITLE}">
    <meta property="og:locale" content="ko_KR">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${META_TITLE}">
    <meta name="twitter:description" content="${META_DESCRIPTION}">
    <meta name="twitter:image" content="${META_IMAGE}">
    <link rel="icon" href="/favicon.svg?v=2" type="image/svg+xml">
    <link rel="icon" href="/favicon.png?v=2" type="image/png">
    <link rel="apple-touch-icon" href="/apple-touch-icon.png?v=2">`;
}

function redirect(location, headers = {}) {
  const responseHeaders = headers instanceof Headers ? new Headers(headers) : new Headers(headers);
  responseHeaders.set("Location", location);
  return new Response(null, { status: 302, headers: responseHeaders });
}

function clearSessionCookies() {
  const headers = new Headers();
  headers.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  headers.append("Set-Cookie", `${LEGACY_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  return headers;
}

function parseCookies(header) {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index === -1 ? [part, ""] : [part.slice(0, index), part.slice(index + 1)];
      })
  );
}

function withSecurityHeaders(response, options = {}) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  if (options.noStore) headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function base64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const base64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let index = 0; index < a.length; index += 1) {
    result |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return result === 0;
}

async function timingSafeStringEqual(actual, expected) {
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(String(actual || ""))),
    crypto.subtle.digest("SHA-256", encoder.encode(String(expected || "")))
  ]);
  return timingSafeBytesEqual(new Uint8Array(actualHash), new Uint8Array(expectedHash));
}

function timingSafeBytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let index = 0; index < a.length; index += 1) {
    result |= a[index] ^ b[index];
  }
  return result === 0;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}