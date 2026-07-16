import {
  base64Url,
  base64UrlToBytes,
  constantTimeStringEqual,
  requireNotificationSecret
} from "./notification-crypto.js";
import { requireCanonicalSiteId } from "./site-identity.js";

export const MOBILE_MEMO_TOKEN_PREFIX = "mmo_v1_";
export const MOBILE_MEMO_TOKEN_TTL_SECONDS = 15 * 60;
export const MOBILE_MEMO_SCOPES = Object.freeze([
  "notes:read",
  "notes:write",
  "members:read",
  "photos:read",
  "photos:write"
]);

const TOKEN_AUDIENCE = "church-cell-manager-mobile-memo";
const TOKEN_VERSION = 1;
const TOKEN_MAX_LENGTH = 2048;
const TOKEN_CLOCK_SKEW_SECONDS = 60;
const TOKEN_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_PAYLOAD_PATTERN = /^[A-Za-z0-9_-]{1,1600}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLAIM_KEYS = ["aud", "deviceId", "exp", "generation", "iat", "scopes", "siteId", "v"];
const textEncoder = new TextEncoder();

export class MobileMemoAuthError extends Error {
  constructor(message, status = 401, code = "MOBILE_MEMO_TOKEN_INVALID") {
    super(message);
    this.name = "MobileMemoAuthError";
    this.status = status;
    this.code = code;
  }
}

export async function createMobileMemoAccessToken({
  env,
  siteId,
  deviceId,
  generation,
  now = Date.now()
}) {
  const normalizedSiteId = normalizeSiteId(siteId);
  const normalizedDeviceId = normalizeDeviceId(deviceId);
  const normalizedGeneration = normalizeGeneration(generation);
  const issuedAt = epochSeconds(now);
  const expiresAt = issuedAt + MOBILE_MEMO_TOKEN_TTL_SECONDS;
  const claims = {
    v: TOKEN_VERSION,
    aud: TOKEN_AUDIENCE,
    siteId: normalizedSiteId,
    deviceId: normalizedDeviceId,
    generation: normalizedGeneration,
    scopes: [...MOBILE_MEMO_SCOPES],
    iat: issuedAt,
    exp: expiresAt
  };
  const encodedPayload = base64Url(textEncoder.encode(JSON.stringify(claims)));
  const signature = await signEncodedPayload(requireMemoSecret(env), encodedPayload);
  return {
    accessToken: `${MOBILE_MEMO_TOKEN_PREFIX}${encodedPayload}.${signature}`,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    expiresInSeconds: MOBILE_MEMO_TOKEN_TTL_SECONDS,
    scopes: [...MOBILE_MEMO_SCOPES]
  };
}

export async function verifyMobileMemoAccessToken(token, env, { now = Date.now() } = {}) {
  const parts = splitToken(token);
  const expectedSignature = await signEncodedPayload(requireMemoSecret(env), parts.encodedPayload);
  if (!constantTimeStringEqual(parts.signature, expectedSignature)) {
    throw invalidToken();
  }

  const claims = decodeClaims(parts.encodedPayload);
  validateClaims(claims, epochSeconds(now));
  return claims;
}

export async function authenticateMobileMemoRequest(request, env, requiredScope = "") {
  if (!(request instanceof Request)) {
    throw new MobileMemoAuthError("A request is required", 500, "MOBILE_MEMO_REQUEST_REQUIRED");
  }
  if (!env?.DB || typeof env.DB.prepare !== "function") {
    throw new MobileMemoAuthError("D1 binding DB is not configured", 503, "DATABASE_UNAVAILABLE");
  }

  const token = bearerToken(request);
  const claims = await verifyMobileMemoAccessToken(token, env);
  if (requiredScope && !MOBILE_MEMO_SCOPES.includes(requiredScope)) {
    throw new MobileMemoAuthError("Mobile memo scope is not supported", 500, "MOBILE_MEMO_SCOPE_INVALID");
  }
  if (requiredScope && !claims.scopes.includes(requiredScope)) {
    throw new MobileMemoAuthError("Mobile memo permission is required", 403, "MOBILE_MEMO_SCOPE_REQUIRED");
  }

  let liveSiteId;
  try {
    const siteRow = await env.DB.prepare(
      "SELECT value FROM app_settings WHERE key = 'notification.siteId' LIMIT 1"
    ).first();
    liveSiteId = requireCanonicalSiteId(siteRow?.value);
  } catch (error) {
    if (error instanceof MobileMemoAuthError) throw error;
    throw new MobileMemoAuthError(
      "Mobile memo site identity is unavailable",
      Number(error?.status || 503),
      String(error?.code || "SITE_IDENTITY_INVALID")
    );
  }
  if (claims.siteId !== liveSiteId) {
    throw invalidToken();
  }

  const device = await env.DB.prepare(
    `SELECT id, status, generation
     FROM call_note_devices
     WHERE id = ?
     LIMIT 1`
  ).bind(claims.deviceId).first();
  const generation = Number(device?.generation || 0);
  if (!device
    || (device.status !== "active" && device.status !== "unregistered")
    || generation !== claims.generation) {
    throw new MobileMemoAuthError(
      "Mobile memo authorization is no longer active",
      401,
      "MOBILE_MEMO_DEVICE_INACTIVE"
    );
  }

  return {
    kind: "mobile",
    deviceId: claims.deviceId,
    generation: claims.generation,
    siteId: claims.siteId,
    scopes: [...claims.scopes]
  };
}

export function isMobileMemoTokenShape(value) {
  try {
    splitToken(value);
    return true;
  } catch {
    return false;
  }
}

function splitToken(value) {
  const token = String(value || "");
  if (token.length > TOKEN_MAX_LENGTH || !token.startsWith(MOBILE_MEMO_TOKEN_PREFIX)) {
    throw invalidToken();
  }
  const encoded = token.slice(MOBILE_MEMO_TOKEN_PREFIX.length);
  const parts = encoded.split(".");
  if (parts.length !== 2
    || !TOKEN_PAYLOAD_PATTERN.test(parts[0])
    || !TOKEN_SIGNATURE_PATTERN.test(parts[1])) {
    throw invalidToken();
  }
  return { encodedPayload: parts[0], signature: parts[1] };
}

function decodeClaims(encodedPayload) {
  try {
    const bytes = base64UrlToBytes(encodedPayload);
    if (base64Url(bytes) !== encodedPayload) throw new Error("Non-canonical base64url");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const claims = JSON.parse(text);
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) throw new Error("Invalid claims");
    return claims;
  } catch {
    throw invalidToken();
  }
}

function validateClaims(claims, now) {
  const keys = Object.keys(claims).sort();
  if (keys.length !== CLAIM_KEYS.length || keys.some((key, index) => key !== CLAIM_KEYS[index])) {
    throw invalidToken();
  }
  if (claims.v !== TOKEN_VERSION || claims.aud !== TOKEN_AUDIENCE) throw invalidToken();
  normalizeSiteId(claims.siteId);
  normalizeDeviceId(claims.deviceId);
  normalizeGeneration(claims.generation);
  if (!Array.isArray(claims.scopes)
    || claims.scopes.length !== MOBILE_MEMO_SCOPES.length
    || claims.scopes.some((scope, index) => scope !== MOBILE_MEMO_SCOPES[index])) {
    throw invalidToken();
  }
  if (!Number.isSafeInteger(claims.iat)
    || !Number.isSafeInteger(claims.exp)
    || claims.exp - claims.iat !== MOBILE_MEMO_TOKEN_TTL_SECONDS
    || claims.iat > now + TOKEN_CLOCK_SKEW_SECONDS) {
    throw invalidToken();
  }
  if (claims.exp <= now) {
    throw new MobileMemoAuthError("Mobile memo token has expired", 401, "MOBILE_MEMO_TOKEN_EXPIRED");
  }
}

function normalizeSiteId(value) {
  try {
    const siteId = requireCanonicalSiteId(value);
    if (siteId !== String(value || "").toLowerCase()) throw new Error("Site id is not canonical");
    return siteId;
  } catch {
    throw invalidToken();
  }
}

function normalizeDeviceId(value) {
  const deviceId = String(value || "");
  if (!UUID_PATTERN.test(deviceId)) throw invalidToken();
  return deviceId;
}

function normalizeGeneration(value) {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > 2147483647) {
    throw invalidToken();
  }
  return generation;
}

function bearerToken(request) {
  const header = String(request.headers.get("Authorization") || "").trim();
  const match = /^Bearer[\t ]+([^\s,]+)$/i.exec(header);
  if (!match) throw invalidToken();
  return match[1];
}

function requireMemoSecret(env) {
  try {
    return requireNotificationSecret(env);
  } catch (error) {
    throw new MobileMemoAuthError(
      error?.message || "Mobile memo secret is not configured",
      503,
      String(error?.code || "NOTIFICATION_SECRET_MISSING")
    );
  }
}

async function signEncodedPayload(secret, encodedPayload) {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(`mobile-memo-access-token:v1\u0000${encodedPayload}`)
  );
  return base64Url(signature);
}

function epochSeconds(value) {
  const timestamp = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(timestamp)) {
    throw new MobileMemoAuthError("Mobile memo token time is invalid", 500, "MOBILE_MEMO_TIME_INVALID");
  }
  return Math.floor(timestamp / 1000);
}

function invalidToken() {
  return new MobileMemoAuthError("Mobile memo token is invalid", 401, "MOBILE_MEMO_TOKEN_INVALID");
}
