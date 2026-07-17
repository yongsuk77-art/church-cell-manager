import {
  createPasskeyLoginOptions,
  getPasskeys,
  updatePasskeySignCount,
  verifyPasskeyLogin
} from "./_webauthn.js";

const SESSION_COOKIE = "__Host-seosanch_cell_session";
const LEGACY_SESSION_COOKIE = "seosanch_cell_session";
const SESSION_TTL_SECONDS = 60 * 60 * 4;
const AUTO_LOGIN_COOKIE = "__Host-seosanch_cell_auto_login";
const AUTO_LOGIN_TOKEN_PREFIX = "alt_v1_";
const AUTO_LOGIN_TTL_SECONDS = 60 * 60 * 24 * 30;
const AUTO_LOGIN_PREVIOUS_GRACE_SECONDS = 60 * 2;
const PASSWORD_HASH_KEY = "auth.passwordHash";
const PASSWORD_ALGORITHM = "pbkdf2-sha256";
const MAX_PBKDF2_ITERATIONS = 100000;
const LOGIN_ATTEMPT_PREFIX = "auth.loginAttempt.";
const LOGIN_WINDOW_SECONDS = 60 * 15;
const LOGIN_LOCK_SECONDS = 60 * 15;
const LOGIN_MAX_FAILURES = 5;
const PUBLIC_AUTH_ASSETS = new Set([
  "/auth.js",
  "/share-card.png",
  "/favicon.svg",
  "/favicon.png",
  "/apple-touch-icon.png"
]);
const PUBLIC_API_PATHS = new Set([
  "/api/webhook/call-note"
]);
const BLOCKED_STATIC_PATHS = new Set([
  "/seed-data.js",
  "/member-details.private.js"
]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const STATIC_ASSET_PATTERN = /\.(?:css|js|mjs|png|jpg|jpeg|gif|svg|ico|webp|avif|woff2?|ttf|map)$/i;
const SITE_URL = "https://church-cell-manager.pages.dev/";
const META_TITLE = "\uCCAD\uB144 \uACF5\uB3D9\uCCB4 \uBAA9\uC591\uC6F9";
const META_SITE_NAME = "\uCCAD\uB144 \uACF5\uB3D9\uCCB4";
const META_DESCRIPTION = "\uC140\uBCC4 \uCCAD\uB144 \uC131\uB3C4 \uAD00\uB9AC\uC640 \uC2EC\uBC29 \uAE30\uB85D\uC744 \uC704\uD55C \uBAA9\uC591\uC6F9 \uD398\uC774\uC9C0";
const META_IMAGE = SITE_URL + "share-card.png?v=3";
const LOGIN_NOT_CONFIGURED = "\uB85C\uADF8\uC778 \uC124\uC815\uC774 \uC544\uC9C1 \uBC18\uC601\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4. \uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574\uC8FC\uC138\uC694.";
const INVALID_PASSWORD = "\uBE44\uBC00\uBC88\uD638\uAC00 \uB9DE\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.";
const TOO_MANY_ATTEMPTS = "\uB85C\uADF8\uC778 \uC2DC\uB3C4\uAC00 \uB9CE\uC544 15\uBD84 \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574\uC8FC\uC138\uC694.";
const COUNTRY_BLOCKED = "\uD55C\uAD6D\uC5D0\uC11C\uB9CC \uC811\uC18D\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.";
const CONTENT_SECURITY_POLICY = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
const SECURITY_HEADERS = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-create=(self), publickey-credentials-get=(self)",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Robots-Tag": "noindex, nofollow, noarchive"
};

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const noStore = shouldNoStore(url);
  delete context.data.viewerRole;
  const mobileMemoRequest = isMobileMemoApiRequest(request, url);
  const relayEnrollmentRequest = isPublicRelayEnrollmentApiRequest(request, url);
  const credentialDeviceRequest = isCredentialDeviceApiRequest(request, url)
    || mobileMemoRequest || relayEnrollmentRequest;

  if (!isLocalhost(url.hostname) && !isAllowedCountry(request) && !credentialDeviceRequest) {
    return countryBlockedResponse(url);
  }
  if (isBlockedStaticPath(url.pathname)) {
    return notFoundResponse();
  }

  if (request.method === "OPTIONS") {
    return secureResponse(await next(request), { noStore });
  }
  if (PUBLIC_AUTH_ASSETS.has(url.pathname)) {
    return secureResponse(await next(request), { noStore: false });
  }
  if (PUBLIC_API_PATHS.has(url.pathname) || isPublicCallNoteDeviceApiRequest(request, url)
    || mobileMemoRequest || relayEnrollmentRequest) {
    return secureResponse(await next(request), { noStore: true });
  }

  const authConfigured = await isAuthConfigured(env);
  if (!authConfigured) {
    if (url.pathname.startsWith("/api/")) {
      return json({ error: "Login is not configured" }, 503);
    }
    return loginPage(LOGIN_NOT_CONFIGURED, 503);
  }

  if (url.pathname === "/__auth/login" && request.method === "POST") {
    return login(request, env);
  }

  if (url.pathname === "/__auth/passkey/options") {
    return request.method === "GET" ? passkeyLoginOptions(request, env) : json({ error: "Method not allowed" }, 405);
  }

  if (url.pathname === "/__auth/passkey/login") {
    return request.method === "POST" ? passkeyLogin(request, env) : json({ error: "Method not allowed" }, 405);
  }

  if (url.pathname === "/__auth/logout") {
    return logout(request, env);
  }

  const sessionValid = await hasValidSession(request, env);
  const autoLogin = sessionValid ? null : await resumeAutoLogin(request, env);
  if (sessionValid || autoLogin?.authenticated) {
    context.data.viewerRole = "admin";
    let response;
    if (url.pathname === "/__auth/login") {
      response = redirect("/");
    } else if (url.pathname === "/__auth/auto-login/status") {
      response = request.method === "GET"
        ? await autoLoginStatus(request, env)
        : json({ error: "Method not allowed" }, 405);
    } else if (url.pathname === "/__auth/auto-login/revoke") {
      response = request.method === "POST"
        ? await revokeAutoLogin(request, env)
        : json({ error: "Method not allowed" }, 405);
    } else {
      response = secureResponse(await next(request), { noStore });
    }
    appendResponseHeaders(response, autoLogin?.headers);
    if (url.pathname === "/__auth/auto-login/revoke") {
      response.headers.append("Set-Cookie", expiredCookie(AUTO_LOGIN_COOKIE));
    }
    return response;
  }

  if (url.pathname === "/__auth/login") {
    return appendResponseHeaders(loginPage(), autoLogin?.headers);
  }
  if (url.pathname.startsWith("/api/")) {
    return appendResponseHeaders(json({ error: "Login required" }, 401), autoLogin?.headers);
  }

  return appendResponseHeaders(loginPage(), autoLogin?.headers);
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

function isPublicRelayEnrollmentApiRequest(request, url) {
  if (request.method !== "POST") return false;
  const uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
  return new RegExp(
    `^/api/integrations/call-note/relay-enrollments/${uuid}/(?:inspect|complete)$`
  ).test(url.pathname);
}

function isMobileMemoApiRequest(request, url) {
  const authorization = String(request.headers.get("Authorization") || "").trim();
  if (!/^Bearer[\t ]+mmo_v1_[A-Za-z0-9_-]{1,1600}\.[A-Za-z0-9_-]{43}$/i.test(authorization)) return false;
  const uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
  if (request.method === "GET" && url.pathname === "/api/mobile/notes/sync") return true;
  if (request.method === "GET" && url.pathname === "/api/mobile/members") return true;
  if (request.method === "GET" && url.pathname.startsWith("/api/photos/")) return true;
  if ((request.method === "GET" || request.method === "POST")
    && url.pathname === "/api/note-categories") return true;
  if (request.method === "DELETE"
    && new RegExp(`^/api/note-categories/${uuid}$`).test(url.pathname)) return true;
  if ((request.method === "GET" || request.method === "POST") && url.pathname === "/api/notes") return true;
  if (request.method === "DELETE" && url.pathname === "/api/notes/trash") return true;
  if ((request.method === "GET" || request.method === "PATCH" || request.method === "DELETE")
    && new RegExp(`^/api/notes/${uuid}$`).test(url.pathname)) return true;
  if (request.method === "POST"
    && new RegExp(`^/api/notes/${uuid}/restore$`).test(url.pathname)) return true;
  if (request.method === "DELETE"
    && new RegExp(`^/api/notes/${uuid}/permanent$`).test(url.pathname)) return true;
  if (request.method === "POST"
    && new RegExp(`^/api/notes/${uuid}/attachments$`).test(url.pathname)) return true;
  return request.method === "DELETE"
    && new RegExp(`^/api/notes/${uuid}/attachments/${uuid}$`).test(url.pathname);
}

function isLocalhost(hostname) {
  return LOCAL_HOSTS.has(String(hostname || "").toLowerCase());
}

function isAllowedCountry(request) {
  const country = String(request.cf?.country || request.headers.get("CF-IPCountry") || "").toUpperCase();
  return country === "KR";
}

function shouldNoStore(url) {
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/__auth/")) return true;
  return !STATIC_ASSET_PATTERN.test(url.pathname);
}

function isBlockedStaticPath(pathname) {
  return pathname.startsWith("/photos/") || BLOCKED_STATIC_PATHS.has(pathname);
}

async function isAuthConfigured(env) {
  const hasPassword = Boolean((await getStoredPasswordHash(env)) || env.SITE_PASSWORD);
  const hasSessionSecret = Boolean(env.SESSION_SECRET);
  return hasPassword && hasSessionSecret;
}

async function login(request, env) {
  const throttle = await getLoginThrottle(request, env);
  if (throttle.locked) return loginPage(TOO_MANY_ATTEMPTS, 429);

  const form = await request.formData();
  const password = String(form.get("password") || "");
  const remember = form.get("remember") === "1";
  if (!(await verifySitePassword(password, env))) {
    const failure = await recordFailedLogin(request, env);
    return loginPage(failure.locked ? TOO_MANY_ATTEMPTS : INVALID_PASSWORD, failure.locked ? 429 : 401);
  }

  await clearLoginFailures(request, env);

  return redirect("/", await createAuthenticatedHeaders(request, env, remember));
}

async function passkeyLoginOptions(request, env) {
  try {
    return json(await createPasskeyLoginOptions(env, request));
  } catch (error) {
    return json({ enabled: false, error: error.message || "Passkey options failed" }, error.status || 500);
  }
}

async function passkeyLogin(request, env) {
  try {
    const body = await safeJson(request);
    const passkeys = await getPasskeys(env);
    const result = await verifyPasskeyLogin(env, request, body.token, body.credential, passkeys);
    await updatePasskeySignCount(env, result.credential.id, result.signCount);
    return json(
      { ok: true, redirect: "/" },
      200,
      await createAuthenticatedHeaders(request, env, body.remember === true)
    );
  } catch (error) {
    return json({ error: error.message || "Passkey login failed" }, error.status || 401);
  }
}

async function logout(request, env) {
  await deleteAutoLoginToken(request, env);
  return redirect("/", clearAuthenticationCookies());
}

async function createAuthenticatedHeaders(request, env, remember) {
  const headers = await createSessionHeaders(env);
  appendHeaders(headers, await setAutoLoginPreference(request, env, remember));
  return headers;
}

async function createSessionHeaders(env) {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${expiresAt}`;
  const signature = await sign(payload, env);
  const headers = new Headers();
  headers.append("Set-Cookie", [
    `${SESSION_COOKIE}=${payload}.${signature}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`
  ].join("; "));
  headers.append("Set-Cookie", expiredCookie(LEGACY_SESSION_COOKIE));
  return headers;
}

async function setAutoLoginPreference(request, env, remember) {
  const headers = new Headers();
  headers.append("Set-Cookie", expiredCookie(AUTO_LOGIN_COOKIE));
  if (!env.DB) return headers;

  try {
    await deleteAutoLoginToken(request, env);
    await env.DB.prepare("DELETE FROM auth_auto_login_tokens WHERE expires_at <= ?")
      .bind(Math.floor(Date.now() / 1000))
      .run();
    if (!remember) return headers;

    const id = crypto.randomUUID();
    const secret = randomBase64Url(32);
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + AUTO_LOGIN_TTL_SECONDS;
    const nowIso = new Date(now * 1000).toISOString();
    const tokenHash = await autoLoginTokenHash(env, id, secret);
    await env.DB.prepare(
      `INSERT INTO auth_auto_login_tokens (
         id, token_hash, previous_token_hash, previous_valid_until,
         expires_at, created_at, updated_at, last_used_at
       ) VALUES (?, ?, '', 0, ?, ?, ?, ?)`
    ).bind(id, tokenHash, expiresAt, nowIso, nowIso, nowIso).run();
    headers.append("Set-Cookie", autoLoginCookie(`${AUTO_LOGIN_TOKEN_PREFIX}${id}.${secret}`));
  } catch {
    // A database failure must never weaken the primary password/passkey check.
  }
  return headers;
}

async function resumeAutoLogin(request, env) {
  const rawToken = autoLoginCookieValue(request);
  if (!rawToken) return null;
  const parsed = autoLoginTokenFromRequest(request);
  if (!parsed) return failedAutoLogin();
  if (!env.DB) return { authenticated: false };

  try {
    const row = await env.DB.prepare(
      `SELECT id, token_hash, previous_token_hash, previous_valid_until, expires_at
       FROM auth_auto_login_tokens
       WHERE id = ?`
    ).bind(parsed.id).first();
    const now = Math.floor(Date.now() / 1000);
    if (!row || Number(row.expires_at || 0) <= now) {
      if (row) await env.DB.prepare("DELETE FROM auth_auto_login_tokens WHERE id = ?").bind(parsed.id).run();
      return failedAutoLogin();
    }

    const presentedHash = await autoLoginTokenHash(env, parsed.id, parsed.secret);
    const matchesCurrent = timingSafeEqual(presentedHash, String(row.token_hash || ""));
    const matchesPrevious = Number(row.previous_valid_until || 0) > now
      && timingSafeEqual(presentedHash, String(row.previous_token_hash || ""));
    if (!matchesCurrent && !matchesPrevious) return failedAutoLogin();

    const headers = await createSessionHeaders(env);
    const nowIso = new Date(now * 1000).toISOString();
    if (matchesPrevious) {
      await env.DB.prepare(
        "UPDATE auth_auto_login_tokens SET last_used_at = ?, updated_at = ? WHERE id = ?"
      ).bind(nowIso, nowIso, parsed.id).run();
      return { authenticated: true, headers };
    }

    const nextSecret = randomBase64Url(32);
    const nextHash = await autoLoginTokenHash(env, parsed.id, nextSecret);
    const rotation = await env.DB.prepare(
      `UPDATE auth_auto_login_tokens
       SET token_hash = ?, previous_token_hash = ?, previous_valid_until = ?,
           last_used_at = ?, updated_at = ?
       WHERE id = ? AND token_hash = ?`
    ).bind(
      nextHash,
      presentedHash,
      now + AUTO_LOGIN_PREVIOUS_GRACE_SECONDS,
      nowIso,
      nowIso,
      parsed.id,
      presentedHash
    ).run();
    if (Number(rotation.meta?.changes || 0) > 0) {
      headers.append("Set-Cookie", autoLoginCookie(`${AUTO_LOGIN_TOKEN_PREFIX}${parsed.id}.${nextSecret}`));
    }
    return { authenticated: true, headers };
  } catch {
    return { authenticated: false };
  }
}

async function autoLoginStatus(request, env) {
  const rawToken = autoLoginCookieValue(request);
  const parsed = autoLoginTokenFromRequest(request);
  if (!parsed || !env.DB) {
    return json(
      { enabled: false, expiresAt: "" },
      200,
      rawToken && !parsed ? clearAutoLoginCookie() : undefined
    );
  }
  try {
    const row = await env.DB.prepare(
      `SELECT token_hash, previous_token_hash, previous_valid_until, expires_at
       FROM auth_auto_login_tokens WHERE id = ?`
    ).bind(parsed.id).first();
    const now = Math.floor(Date.now() / 1000);
    const presentedHash = await autoLoginTokenHash(env, parsed.id, parsed.secret);
    const active = Boolean(row)
      && Number(row.expires_at || 0) > now
      && (
        timingSafeEqual(presentedHash, String(row.token_hash || ""))
        || (Number(row.previous_valid_until || 0) > now
          && timingSafeEqual(presentedHash, String(row.previous_token_hash || "")))
      );
    if (!active) return json({ enabled: false, expiresAt: "" }, 200, clearAutoLoginCookie());
    return json({ enabled: true, expiresAt: new Date(Number(row.expires_at) * 1000).toISOString() });
  } catch {
    return json({ enabled: false, expiresAt: "" });
  }
}

async function revokeAutoLogin(request, env) {
  await deleteAutoLoginToken(request, env);
  return json({ ok: true, enabled: false }, 200, clearAutoLoginCookie());
}

async function deleteAutoLoginToken(request, env) {
  const parsed = autoLoginTokenFromRequest(request);
  if (!parsed || !env.DB) return;
  try {
    await env.DB.prepare("DELETE FROM auth_auto_login_tokens WHERE id = ?").bind(parsed.id).run();
  } catch {
    // Logout and preference changes still clear the browser cookie if D1 is temporarily unavailable.
  }
}

function failedAutoLogin() {
  return { authenticated: false, headers: clearAutoLoginCookie() };
}

function autoLoginTokenFromRequest(request) {
  const value = autoLoginCookieValue(request);
  const match = value.match(/^alt_v1_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i);
  return match ? { id: match[1].toLowerCase(), secret: match[2] } : null;
}

function autoLoginCookieValue(request) {
  return parseCookies(request.headers.get("Cookie") || "")[AUTO_LOGIN_COOKIE] || "";
}

async function autoLoginTokenHash(env, id, secret) {
  return hmacSha256(env.SESSION_SECRET, `auto-login:${id}:${secret}`);
}

function autoLoginCookie(value) {
  return [
    `${AUTO_LOGIN_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${AUTO_LOGIN_TTL_SECONDS}`
  ].join("; ");
}

function clearAutoLoginCookie() {
  const headers = new Headers();
  headers.append("Set-Cookie", expiredCookie(AUTO_LOGIN_COOKIE));
  return headers;
}

async function getLoginThrottle(request, env) {
  try {
    const key = await loginAttemptKey(request, env);
    if (!key || !env.DB) return { locked: false };
    const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(key).first();
    const attempt = parseLoginAttempt(row?.value);
    const now = Math.floor(Date.now() / 1000);
    return { locked: Number(attempt.lockedUntil || 0) > now };
  } catch {
    return { locked: false };
  }
}

async function recordFailedLogin(request, env) {
  try {
    const key = await loginAttemptKey(request, env);
    if (!key || !env.DB) return { locked: false };
    await ensureAppSettingsTable(env);

    const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(key).first();
    const now = Math.floor(Date.now() / 1000);
    const previous = parseLoginAttempt(row?.value);
    const firstFailedAt = Number(previous.firstFailedAt || 0);
    const inWindow = firstFailedAt && now - firstFailedAt <= LOGIN_WINDOW_SECONDS;
    const count = (inWindow ? Number(previous.count || 0) : 0) + 1;
    const lockedUntil = count >= LOGIN_MAX_FAILURES ? now + LOGIN_LOCK_SECONDS : 0;
    const value = JSON.stringify({
      count,
      firstFailedAt: inWindow ? firstFailedAt : now,
      lockedUntil
    });
    await appSettingStatement(env, key, value, new Date().toISOString()).run();
    return { locked: lockedUntil > now };
  } catch {
    return { locked: false };
  }
}

async function clearLoginFailures(request, env) {
  try {
    const key = await loginAttemptKey(request, env);
    if (key && env.DB) await env.DB.prepare("DELETE FROM app_settings WHERE key = ?").bind(key).run();
  } catch {
    // Best-effort cleanup only.
  }
}

async function loginAttemptKey(request, env) {
  const ip = clientIp(request);
  const secret = env.SESSION_SECRET || "";
  if (!ip || !secret) return "";
  const digest = await hmacSha256(secret, `login:${ip}`);
  return `${LOGIN_ATTEMPT_PREFIX}${digest.slice(0, 43)}`;
}

function clientIp(request) {
  return clean(request.headers.get("CF-Connecting-IP"))
    || clean(request.headers.get("X-Forwarded-For")).split(",")[0].trim()
    || clean(request.headers.get("X-Real-IP"));
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function parseLoginAttempt(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function ensureAppSettingsTable(env) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)"
  ).run();
}

function appSettingStatement(env, key, value, updatedAt = new Date().toISOString()) {
  return env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, value, updatedAt);
}

async function verifySitePassword(password, env) {
  const storedHash = await getStoredPasswordHash(env);
  if (storedHash) return verifyPasswordHash(password, storedHash);
  return Boolean(env.SITE_PASSWORD) && password === env.SITE_PASSWORD;
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
  const secret = env.SESSION_SECRET;
  if (!secret) throw new Error("Session secret is not configured");
  return hmacSha256(secret, payload);
}

async function hmacSha256(secret, payload) {
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
  return secureResponse(new Response(
    `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>목양웹 \uB85C\uADF8\uC778</title>
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
      .remember-label {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-top: 14px;
        color: #4f473d;
        cursor: pointer;
      }
      .remember-label input {
        width: 18px;
        height: 18px;
        margin: 0;
        accent-color: #23746b;
      }
      .remember-help {
        margin: 7px 0 0 28px;
        color: #7a7065;
        font-size: 12px;
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
      .hidden {
        display: none;
      }
      .passkey-login {
        margin-top: 14px;
        padding-top: 14px;
        border-top: 1px solid #e5dac8;
      }
      .passkey-button {
        margin-top: 0;
        background: #3d5f57;
      }
      .passkey-status {
        margin: 10px 0 0;
        color: #7b332a;
        font-size: 13px;
        font-weight: 700;
      }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">\uCCAD\uB144 \uACF5\uB3D9\uCCB4</p>
      <h1>목양웹</h1>
      ${errorMarkup}
      <form method="post" action="/__auth/login">
        <label>
          \uAD00\uB9AC\uC790 \uBE44\uBC00\uBC88\uD638
          <input name="password" type="password" autocomplete="current-password" autofocus required>
        </label>
        <label class="remember-label">
          <input id="rememberLogin" name="remember" type="checkbox" value="1">
          <span>\uC774 \uAE30\uAE30\uC5D0\uC11C \uC790\uB3D9 \uB85C\uADF8\uC778 (30\uC77C)</span>
        </label>
        <p class="remember-help">\uACF5\uC6A9 \uAE30\uAE30\uC5D0\uC11C\uB294 \uC120\uD0DD\uD558\uC9C0 \uB9C8\uC138\uC694.</p>
        <button type="submit">\uB85C\uADF8\uC778</button>
      </form>
      <div class="passkey-login hidden" id="passkeyLoginPanel">
        <button class="passkey-button" id="passkeyLoginBtn" type="button">\uC9C0\uBB38\u00B7\uC5BC\uAD74\uB85C \uB85C\uADF8\uC778</button>
        <p class="passkey-status" id="passkeyLoginStatus"></p>
      </div>
    </main>
    <script src="/auth.js?v=fingerprint-login-1" defer></script>
  </body>
</html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  ), { noStore: true });
}

function countryBlockedResponse(url) {
  if (url.pathname.startsWith("/api/")) return json({ error: "Access denied" }, 403);
  return secureResponse(new Response(
    `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>접속 제한</title>
  </head>
  <body>
    <main>
      <h1>\uC811\uC18D \uC81C\uD55C</h1>
      <p>${COUNTRY_BLOCKED}</p>
    </main>
  </body>
</html>`,
    { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } }
  ), { noStore: true });
}

function notFoundResponse() {
  return secureResponse(new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  }), { noStore: true });
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
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Location", location);
  return secureResponse(new Response(null, {
    status: 302,
    headers: responseHeaders
  }), { noStore: true });
}

function clearAuthenticationCookies() {
  const headers = new Headers();
  headers.append("Set-Cookie", expiredCookie(SESSION_COOKIE));
  headers.append("Set-Cookie", expiredCookie(LEGACY_SESSION_COOKIE));
  headers.append("Set-Cookie", expiredCookie(AUTO_LOGIN_COOKIE));
  return headers;
}

function appendHeaders(target, source) {
  if (!source) return target;
  const setCookies = typeof source.getSetCookie === "function" ? source.getSetCookie() : [];
  source.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") target.append(key, value);
  });
  if (setCookies.length) {
    for (const cookie of setCookies) target.append("Set-Cookie", cookie);
  } else {
    const cookie = source.get("Set-Cookie");
    if (cookie) target.append("Set-Cookie", cookie);
  }
  return target;
}

function appendResponseHeaders(response, headers) {
  if (!headers) return response;
  appendHeaders(response.headers, headers);
  return response;
}

function expiredCookie(name) {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
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

function base64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomBase64Url(size) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return base64Url(bytes.buffer);
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

function clean(value) {
  return String(value || "").trim();
}

function json(body, status = 200, headers = {}) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  return secureResponse(new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders
  }), { noStore: true });
}

function secureResponse(response, options = {}) {
  const secured = new Response(response.body, response);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    secured.headers.set(key, value);
  }
  if (options.noStore) secured.headers.set("Cache-Control", "no-store");
  return secured;
}
