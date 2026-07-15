import {
  authenticatePasskey,
  createPasskeyAuthenticationOptions,
  hasUsablePasskeys,
  PasskeyError
} from "../lib/webauthn.js";
import {
  clearGuestLoginFailures,
  getGuestLoginLock,
  recordGuestLoginFailure
} from "../lib/login-rate-limit.js";

const SESSION_COOKIE = "__Host-seosanch_cell_session";
const LEGACY_SESSION_COOKIE = "seosanch_cell_session";
const SESSION_TTL_SECONDS = 60 * 60;
const REMEMBER_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_VERSION = "v5";
const LEGACY_SESSION_VERSION = "v4";
const STANDARD_SESSION_MODE = "standard";
const REMEMBER_SESSION_MODE = "remember";
const SESSION_PERSISTENCE_HEADER = "X-Seosanch-Session-Persistent";
const MAX_PASSKEY_REQUEST_BYTES = 192 * 1024;
const SESSION_REVISION_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_ROLE_HEADER = "X-Seosanch-Role";
const ADMIN_ROLE = "admin";
const GUEST_ROLE = "guest";
const PASSWORD_HASH_KEY = "auth.passwordHash";
const GUEST_PASSWORD_HASH_KEY = "auth.guestPasswordHash";
const PASSWORD_ALGORITHM = "pbkdf2-sha256";
const MAX_PBKDF2_ITERATIONS = 100000;
const LOGIN_FAILURE_PREFIX = "auth.loginFailure.";
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_LOCK_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 5;
const PUBLIC_AUTH_ASSETS = new Set([
  "/auth.js",
  "/share-card.png",
  "/favicon.png",
  "/apple-touch-icon.png",
  "/site.webmanifest"
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
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-create=(self), publickey-credentials-get=(self)",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "X-Robots-Tag": "noindex, nofollow, noarchive"
};

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  delete context.data.viewerRole;
  const mobileMemoRequest = isMobileMemoApiRequest(request, url);
  const credentialDeviceRequest = isCredentialDeviceApiRequest(request, url) || mobileMemoRequest;

  if (!isLocalRequest(request, url) && !isKoreaRequest(request) && !credentialDeviceRequest) {
    return withSecurityHeaders(countryBlockResponse(url), { noStore: true });
  }

  let response;
  let noStore = url.pathname.startsWith("/api/") || url.pathname.startsWith("/__auth/");

  if (request.method === "OPTIONS") {
    response = await next(requestWithoutSessionRoleHeader(request));
    return withSecurityHeaders(response, { noStore });
  }

  if (PUBLIC_AUTH_ASSETS.has(url.pathname)) {
    response = await next(requestWithoutSessionRoleHeader(request));
    return withSecurityHeaders(response, { noStore: false });
  }

  if (PUBLIC_API_PATHS.has(url.pathname) || isPublicCallNoteDeviceApiRequest(request, url) || mobileMemoRequest) {
    response = await next(requestWithoutSessionRoleHeader(request));
    return withSecurityHeaders(response, { noStore: true });
  }

  const authConfigured = await isAuthConfigured(env);
  if (!authConfigured) {
    response = url.pathname.startsWith("/api/")
      ? json({ error: "Login is not configured" }, 503)
      : loginPage(LOGIN_NOT_CONFIGURED, 503);
    return withSecurityHeaders(response, { noStore: true });
  }

  if (url.pathname === "/__auth/passkey/options") {
    response = request.method === "GET"
      ? await passkeyAuthenticationOptions(request, env)
      : json({ error: "Method not allowed" }, 405);
    return withSecurityHeaders(response, { noStore: true });
  }

  if (url.pathname === "/__auth/passkey/login") {
    response = request.method === "POST"
      ? await passkeyLogin(request, env)
      : json({ error: "Method not allowed" }, 405);
    return withSecurityHeaders(response, { noStore: true });
  }

  if (url.pathname === "/__auth/login") {
    const passkeyAvailable = await hasUsablePasskeys(request, env);
    response = request.method === "POST"
      ? await login(request, env, passkeyAvailable)
      : loginPage("", 200, passkeyAvailable);
    return withSecurityHeaders(response, { noStore: true });
  }

  if (url.pathname === "/__auth/refresh") {
    const session = request.method === "POST"
      ? await getValidSession(request, env)
      : null;
    if (request.method !== "POST") {
      response = json({ error: "Method not allowed" }, 405);
    } else if (!session) {
      response = json({ error: "Login required" }, 401);
    } else {
      const headers = await sessionCookieHeaders(
        env,
        session.role,
        {
          existingRevision: session.revision,
          existingSessionId: session.sessionId,
          persistent: session.persistent
        }
      );
      response = headers
        ? json({
          ok: true,
          persistent: session.persistent,
          expiresInSeconds: sessionTtlSeconds(session.persistent)
        }, 200, headers)
        : json({ error: "Login required" }, 401);
    }
    return withSecurityHeaders(response, {
      noStore: true,
      ...(session ? { sessionPersistent: session.persistent } : {})
    });
  }

  if (url.pathname === "/__auth/logout") {
    response = redirect("/", clearSessionCookies());
    return withSecurityHeaders(response, { noStore: true });
  }

  const session = await getValidSession(request, env);
  if (session) {
    context.data.viewerRole = session.role;
    response = await next(requestWithoutSessionRoleHeader(request));
    return withSecurityHeaders(response, {
      noStore,
      sessionPersistent: session.persistent
    });
  }

  response = url.pathname.startsWith("/api/")
    ? json({ error: "Login required" }, 401)
    : loginPage("", 200, await hasUsablePasskeys(request, env));
  return withSecurityHeaders(response, { noStore: true });
}

function isPublicCallNoteDeviceApiRequest(request, url) {
  if (request.method === "POST" && url.pathname === "/api/integrations/call-note/devices/pair") return true;
  return isCredentialDeviceApiRequest(request, url);
}

function isCredentialDeviceApiRequest(request, url) {
  const uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
  if (request.method === "POST"
    && new RegExp(`^/api/integrations/call-note/devices/${uuid}/memo-session$`).test(url.pathname)) return true;
  if (request.method === "PUT"
    && new RegExp(`^/api/integrations/call-note/devices/${uuid}/registration$`).test(url.pathname)) return true;
  if (request.method === "DELETE"
    && new RegExp(`^/api/integrations/call-note/devices/${uuid}$`).test(url.pathname)) return true;
  if (request.method === "GET"
    && new RegExp(`^/api/integrations/call-note/notifications/${uuid}$`).test(url.pathname)) return true;
  return request.method === "POST"
    && new RegExp(`^/api/integrations/call-note/notifications/${uuid}/ack$`).test(url.pathname);
}

function isMobileMemoApiRequest(request, url) {
  const authorization = String(request.headers.get("Authorization") || "").trim();
  if (!/^Bearer[\t ]+mmo_v1_[A-Za-z0-9_-]{1,1600}\.[A-Za-z0-9_-]{43}$/i.test(authorization)) return false;
  const uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
  if (request.method === "GET" && url.pathname === "/api/mobile/notes/sync") return true;
  if (request.method === "GET" && url.pathname === "/api/mobile/members") return true;
  if (request.method === "GET" && url.pathname.startsWith("/api/photos/")) return true;
  if (request.method === "GET" && /^\/photos\/seed-[A-Za-z0-9_-]+\.jpg$/.test(url.pathname)) return true;
  if ((request.method === "GET" || request.method === "POST") && url.pathname === "/api/notes") return true;
  if ((request.method === "GET" || request.method === "PATCH" || request.method === "DELETE")
    && new RegExp(`^/api/notes/${uuid}$`).test(url.pathname)) return true;
  if (request.method === "POST"
    && new RegExp(`^/api/notes/${uuid}/attachments$`).test(url.pathname)) return true;
  return request.method === "DELETE"
    && new RegExp(`^/api/notes/${uuid}/attachments/${uuid}$`).test(url.pathname);
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
  const credential = await getAdminPasswordCredential(env);
  const hasPassword = credential.status === "ready";
  const hasSessionSecret = Boolean(env.SESSION_SECRET || env.SITE_PASSWORD);
  return hasPassword && hasSessionSecret;
}

async function login(request, env, passkeyAvailable = false) {
  const lock = await getLoginLock(request, env);
  if (lock.locked) return loginPage(LOGIN_LOCKED, 429, passkeyAvailable);

  const form = await request.formData();
  const password = String(form.get("password") || "");
  const persistent = form.get("remember") === "1";
  const verifiedAdminRevision = await verifySitePasswordRevision(password, env);
  if (verifiedAdminRevision) {
    const headers = await sessionCookieHeaders(env, ADMIN_ROLE, {
      existingRevision: verifiedAdminRevision,
      persistent
    });
    if (headers) {
      await clearLoginFailure(request, env);
      return redirect("/", headers);
    }
    return loginPage(INVALID_PASSWORD, 401, passkeyAvailable, persistent);
  }

  const guestHash = await getStoredPasswordHash(env, GUEST_PASSWORD_HASH_KEY);
  if (guestHash) {
    const guestLock = await getGuestLoginLock(env);
    if (guestLock.locked) {
      await recordLoginFailure(request, env);
      return loginPage(LOGIN_LOCKED, 429, passkeyAvailable);
    }
    if (await verifyPasswordHash(password, guestHash)) {
      await Promise.all([
        clearLoginFailure(request, env),
        clearGuestLoginFailures(env)
      ]);
      const revision = await guestSessionRevisionForHash(guestHash, env);
      const headers = await sessionCookieHeaders(env, GUEST_ROLE, {
        existingRevision: revision,
        persistent
      });
      return headers
        ? redirect("/", headers)
        : loginPage(INVALID_PASSWORD, 401, passkeyAvailable, persistent);
    }
  }

  const [failure, guestFailure] = await Promise.all([
    recordLoginFailure(request, env),
    guestHash ? recordGuestLoginFailure(env) : Promise.resolve({ locked: false })
  ]);
  const locked = failure.locked || guestFailure.locked;
  return loginPage(
    locked ? LOGIN_LOCKED : INVALID_PASSWORD,
    locked ? 429 : 401,
    passkeyAvailable,
    persistent
  );
}

async function passkeyAuthenticationOptions(request, env) {
  try {
    return json(await createPasskeyAuthenticationOptions(request, env));
  } catch (error) {
    return passkeyErrorResponse(error);
  }
}

async function passkeyLogin(request, env) {
  try {
    const body = await readPasskeyJson(request);
    await authenticatePasskey(request, env, body);
    const headers = await sessionCookieHeaders(env, ADMIN_ROLE, {
      persistent: body.remember === true
    });
    if (!headers) return json({ error: "Login is temporarily unavailable" }, 503);
    await clearLoginFailure(request, env);
    return json({ ok: true }, 200, headers);
  } catch (error) {
    return passkeyErrorResponse(error);
  }
}

async function readPasskeyJson(request) {
  const contentType = String(request.headers.get("Content-Type") || "").toLowerCase();
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (!contentType.startsWith("application/json")) {
    throw new PasskeyError("JSON 요청만 사용할 수 있습니다.", 415, "CONTENT_TYPE_INVALID");
  }
  if (Number.isFinite(contentLength) && contentLength > MAX_PASSKEY_REQUEST_BYTES) {
    throw new PasskeyError("패스키 요청이 너무 큽니다.", 413, "REQUEST_TOO_LARGE");
  }
  const bytes = await readBoundedRequestBytes(request, MAX_PASSKEY_REQUEST_BYTES);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    throw new PasskeyError("패스키 요청 형식이 올바르지 않습니다.", 400, "JSON_INVALID");
  }
}

async function readBoundedRequestBytes(request, maxBytes) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("request body too large").catch(() => {});
        throw new PasskeyError("패스키 요청이 너무 큽니다.", 413, "REQUEST_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function passkeyErrorResponse(error) {
  if (error instanceof PasskeyError) {
    return json({ error: error.message, code: error.code }, error.status);
  }
  console.error(JSON.stringify({
    event: "passkey.request.failed",
    error: error instanceof Error ? error.name : "UnknownError"
  }));
  return json({ error: "패스키 요청을 처리하지 못했습니다." }, 500);
}

async function sessionCookieHeaders(env, role, options = {}) {
  if (!isSessionRole(role)) throw new Error("Invalid session role");
  const persistent = options.persistent === true;
  const ttlSeconds = sessionTtlSeconds(persistent);
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const revision = role === GUEST_ROLE
    ? await guestSessionRevision(env)
    : await adminSessionRevision(env);
  if (!SESSION_REVISION_PATTERN.test(revision)) return null;
  const existingRevision = String(options.existingRevision || "");
  if (existingRevision && !timingSafeEqual(existingRevision, revision)) return null;
  const sessionId = String(options.existingSessionId || "") || createSessionId();
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  const mode = persistent ? REMEMBER_SESSION_MODE : STANDARD_SESSION_MODE;
  const payload = `${SESSION_VERSION}.${role}.${mode}.${revision}.${sessionId}.${expiresAt}`;
  const signature = await sign(payload, env);
  const headers = clearSessionCookies();
  headers.append("Set-Cookie", [
    `${SESSION_COOKIE}=${payload}.${signature}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${ttlSeconds}`
  ].join("; "));
  return headers;
}

function sessionTtlSeconds(persistent) {
  return persistent ? REMEMBER_SESSION_TTL_SECONDS : SESSION_TTL_SECONDS;
}

async function verifySitePasswordRevision(password, env) {
  const credential = await getAdminPasswordCredential(env);
  if (credential.status !== "ready") return "";
  const verified = credential.source === "stored"
    ? await verifyPasswordHash(password, credential.value)
    : await timingSafeStringEqual(password, credential.value);
  if (!verified) return "";
  return adminSessionRevisionForCredential(credential, env);
}

async function getAdminPasswordCredential(env) {
  const stored = await readPasswordSettingStrict(env, PASSWORD_HASH_KEY);
  if (stored.status === "unavailable") return stored;
  if (stored.status === "present") {
    return stored.value
      ? { status: "ready", source: "stored", value: stored.value }
      : { status: "unavailable" };
  }
  const environmentPassword = String(env.SITE_PASSWORD || "");
  return environmentPassword
    ? { status: "ready", source: "environment", value: environmentPassword }
    : { status: "missing" };
}

async function readPasswordSettingStrict(env, key) {
  if (!env.DB) return { status: "missing", value: "" };
  try {
    const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?")
      .bind(key)
      .first();
    if (!row) return { status: "missing", value: "" };
    return typeof row.value === "string"
      ? { status: "present", value: row.value }
      : { status: "unavailable", value: "" };
  } catch {
    return { status: "unavailable", value: "" };
  }
}

async function getStoredPasswordHash(env, key = PASSWORD_HASH_KEY) {
  if (!env.DB) return "";
  try {
    const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?")
      .bind(key)
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

async function getValidSession(request, env) {
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const value = cookies[SESSION_COOKIE];
  if (!value) return null;

  const parts = value.split(".");
  let version;
  let role;
  let mode;
  let revision;
  let sessionId;
  let expiresAt;
  let signature;
  if (parts.length === 7 && parts[0] === SESSION_VERSION) {
    [version, role, mode, revision, sessionId, expiresAt, signature] = parts;
    if (mode !== STANDARD_SESSION_MODE && mode !== REMEMBER_SESSION_MODE) return null;
  } else if (parts.length === 6 && parts[0] === LEGACY_SESSION_VERSION) {
    [version, role, revision, sessionId, expiresAt, signature] = parts;
    mode = STANDARD_SESSION_MODE;
  } else {
    return null;
  }
  if (!isSessionRole(role)
    || !SESSION_REVISION_PATTERN.test(revision)
    || !SESSION_ID_PATTERN.test(sessionId)
    || !isUnexpiredTimestamp(expiresAt)
    || !SESSION_SIGNATURE_PATTERN.test(signature)) return null;
  const payload = version === SESSION_VERSION
    ? `${version}.${role}.${mode}.${revision}.${sessionId}.${expiresAt}`
    : `${version}.${role}.${revision}.${sessionId}.${expiresAt}`;
  const expected = await sign(payload, env);
  if (!timingSafeEqual(signature, expected)) return null;
  const currentRevision = role === GUEST_ROLE
    ? await guestSessionRevision(env)
    : await adminSessionRevision(env);
  if (!currentRevision || !timingSafeEqual(revision, currentRevision)) return null;
  return {
    role,
    revision,
    sessionId,
    expiresAt: Number(expiresAt),
    persistent: mode === REMEMBER_SESSION_MODE,
    legacy: version === LEGACY_SESSION_VERSION
  };
}

async function adminSessionRevision(env) {
  const credential = await getAdminPasswordCredential(env);
  if (credential.status !== "ready") return "";
  return adminSessionRevisionForCredential(credential, env);
}

async function adminSessionRevisionForCredential(credential, env) {
  if (credential.status !== "ready" || !credential.source || !credential.value) return "";
  return (await sign(`admin-session:${credential.source}:${credential.value}`, env)).slice(0, 32);
}

async function guestSessionRevision(env) {
  const storedHash = await getStoredPasswordHash(env, GUEST_PASSWORD_HASH_KEY);
  if (!storedHash) return "";
  return guestSessionRevisionForHash(storedHash, env);
}

async function guestSessionRevisionForHash(storedHash, env) {
  if (!storedHash) return "";
  return (await sign(`guest-session:${storedHash}`, env)).slice(0, 32);
}

function isSessionRole(role) {
  return role === ADMIN_ROLE || role === GUEST_ROLE;
}

function isUnexpiredTimestamp(value) {
  const expiresAt = Number(value);
  return Number.isInteger(expiresAt)
    && expiresAt > Math.floor(Date.now() / 1000);
}

function createSessionId() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

function requestWithoutSessionRoleHeader(request) {
  const headers = new Headers(request.headers);
  headers.delete(SESSION_ROLE_HEADER);
  return new Request(request, { headers });
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

function loginPage(error = "", status = 200, passkeyAvailable = false, rememberChecked = false) {
  const errorMarkup = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  const rememberAttribute = rememberChecked ? " checked" : "";
  const passkeyAutostart = passkeyAvailable && !error ? "true" : "false";
  const passkeyMarkup = passkeyAvailable ? `
      <section id="passkeyLoginPanel" class="passkey-panel hidden" aria-label="패스키 로그인">
        <button id="passkeyLoginBtn" class="passkey-button" type="button">생체 인증·패스키로 로그인</button>
        <p class="passkey-note">휴대폰·PC의 지문, 얼굴 또는 화면 잠금을 사용합니다.</p>
        <p id="passkeyLoginStatus" class="passkey-status" role="status" aria-live="polite"></p>
      </section>
      <div id="passkeyDivider" class="divider hidden" aria-hidden="true"><span>또는 비밀번호</span></div>` : "";
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
      input[type="password"] {
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
      button:disabled {
        cursor: wait;
        opacity: 0.65;
      }
      .hidden {
        display: none;
      }
      .passkey-panel {
        margin-bottom: 20px;
      }
      .passkey-button {
        margin-top: 0;
        background: #1f675d;
      }
      .passkey-note,
      .passkey-status {
        margin: 8px 0 0;
        color: #6d6255;
        font-size: 13px;
        font-weight: 650;
        line-height: 1.5;
      }
      .passkey-status.error-text {
        color: #b42318;
      }
      .divider {
        display: flex;
        align-items: center;
        gap: 12px;
        margin: 18px 0;
        color: #84786a;
        font-size: 12px;
        font-weight: 800;
      }
      .divider::before,
      .divider::after {
        content: "";
        flex: 1;
        height: 1px;
        background: #e4d9c8;
      }
      .divider.hidden {
        display: none;
      }
      .error {
        margin: 0 0 14px;
        color: #b42318;
        font-weight: 700;
      }
      .remember-login {
        display: grid;
        grid-template-columns: 20px 1fr;
        align-items: start;
        gap: 10px;
        margin-top: 14px;
        color: #3f3931;
        cursor: pointer;
      }
      .remember-login input {
        width: 20px;
        height: 20px;
        margin: 1px 0 0;
        accent-color: #23746b;
      }
      .remember-login strong,
      .remember-login small {
        display: block;
      }
      .remember-login small {
        margin-top: 3px;
        color: #7a6f62;
        font-size: 12px;
        font-weight: 600;
        line-height: 1.45;
      }
    </style>
  </head>
  <body data-passkey-autostart="${passkeyAutostart}">
    <main>
      <p class="eyebrow">남아메리카 공동체</p>
      <h1>공동체관리</h1>
      ${errorMarkup}
      ${passkeyMarkup}
      <form method="post" action="/__auth/login">
        <label>
          비밀번호
          <input name="password" type="password" autocomplete="current-password" required>
        </label>
        <label class="remember-login">
          <input id="rememberLogin" name="remember" type="checkbox" value="1"${rememberAttribute}>
          <span>
            <strong>자동 로그인</strong>
            <small>이 기기에서 30일 동안 유지됩니다. 공용 기기에서는 사용하지 마세요.</small>
          </span>
        </label>
        <button type="submit">로그인</button>
      </form>
    </main>
    <script src="/auth.js?v=remember-login-1" defer></script>
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
    <link rel="icon" href="/favicon.png?v=community-icon-3" type="image/png" sizes="512x512">
    <link rel="apple-touch-icon" href="/apple-touch-icon.png?v=community-icon-3">
    <link rel="manifest" href="/site.webmanifest?v=community-icon-3">`;
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
  if (typeof options.sessionPersistent === "boolean") {
    headers.set(SESSION_PERSISTENCE_HEADER, options.sessionPersistent ? "1" : "0");
  }
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

function json(body, status = 200, extraHeaders = {}) {
  const headers = extraHeaders instanceof Headers ? extraHeaders : new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), {
    status,
    headers
  });
}
