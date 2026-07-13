const encoder = new TextEncoder();
const AUTH_VERSION = "CALLSUM-RELAY-HMAC-V1";
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;

export const RELAY_AUTH_HEADERS = Object.freeze({
  siteId: "X-Callsum-Site-Id",
  keyId: "X-Callsum-Key-Id",
  timestamp: "X-Callsum-Timestamp",
  nonce: "X-Callsum-Nonce",
  signature: "X-Callsum-Signature"
});

export class RelayAuthError extends Error {
  constructor(code, status = 401) {
    super(code);
    this.name = "RelayAuthError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Create the complete set of clone-to-relay authentication headers.
 * The caller must sign the exact raw bytes it later places in Request.body.
 */
export async function createRelayAuthHeaders({
  method,
  path,
  rawBody,
  siteId,
  keyId,
  secret,
  timestamp,
  nonce
}) {
  const normalizedMethod = normalizeMethod(method);
  const normalizedPath = normalizePath(path);
  const normalizedSiteId = normalizeIdentifier(siteId, "RELAY_SITE_ID_INVALID");
  const normalizedKeyId = normalizeIdentifier(keyId, "RELAY_KEY_ID_INVALID");
  const normalizedTimestamp = normalizeTimestamp(timestamp ?? Math.floor(Date.now() / 1000));
  const normalizedNonce = nonce == null ? randomNonce() : validateNonce(nonce);
  const key = await importHmacKey(secret, ["sign"]);
  const bodyHash = await sha256Base64Url(rawBody);
  const canonical = canonicalRequest({
    method: normalizedMethod,
    path: normalizedPath,
    siteId: normalizedSiteId,
    keyId: normalizedKeyId,
    timestamp: normalizedTimestamp,
    nonce: normalizedNonce,
    bodyHash
  });
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(canonical));

  return {
    [RELAY_AUTH_HEADERS.siteId]: normalizedSiteId,
    [RELAY_AUTH_HEADERS.keyId]: normalizedKeyId,
    [RELAY_AUTH_HEADERS.timestamp]: String(normalizedTimestamp),
    [RELAY_AUTH_HEADERS.nonce]: normalizedNonce,
    [RELAY_AUTH_HEADERS.signature]: `v1=${base64Url(signature)}`
  };
}

/**
 * Verify request authentication without consuming request.body.
 * Replay persistence is deliberately the Worker's responsibility, after this
 * cryptographic verification succeeds.
 */
export async function verifyRelayAuthSignature({ request, rawBody, secret, now }) {
  if (!(request instanceof Request)) throw new RelayAuthError("RELAY_REQUEST_INVALID", 400);

  const siteId = normalizeIdentifier(
    requiredHeader(request, RELAY_AUTH_HEADERS.siteId),
    "RELAY_SITE_ID_INVALID"
  );
  const keyId = normalizeIdentifier(
    requiredHeader(request, RELAY_AUTH_HEADERS.keyId),
    "RELAY_KEY_ID_INVALID"
  );
  const timestamp = normalizeTimestamp(requiredHeader(request, RELAY_AUTH_HEADERS.timestamp));
  const nonce = validateNonce(requiredHeader(request, RELAY_AUTH_HEADERS.nonce));
  const signature = parseSignature(requiredHeader(request, RELAY_AUTH_HEADERS.signature));
  const nowSeconds = normalizeNowSeconds(now);
  if (Math.abs(nowSeconds - timestamp) > MAX_CLOCK_SKEW_SECONDS) {
    throw new RelayAuthError("RELAY_TIMESTAMP_OUT_OF_WINDOW");
  }

  const method = normalizeMethod(request.method);
  const path = normalizePath(new URL(request.url).pathname);
  const bodyHash = await sha256Base64Url(rawBody);
  const canonical = canonicalRequest({ method, path, siteId, keyId, timestamp, nonce, bodyHash });
  const key = await importHmacKey(secret, ["verify"]);
  const valid = await crypto.subtle.verify("HMAC", key, signature, encoder.encode(canonical));
  if (!valid) throw new RelayAuthError("RELAY_SIGNATURE_INVALID");

  return {
    siteId,
    keyId,
    timestamp,
    nonce,
    nonceHash: await sha256Base64Url(nonce)
  };
}

export async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", toBytes(value));
  return base64Url(digest);
}

function canonicalRequest({ method, path, siteId, keyId, timestamp, nonce, bodyHash }) {
  return [
    AUTH_VERSION,
    method,
    path,
    siteId,
    keyId,
    String(timestamp),
    nonce,
    bodyHash
  ].join("\n");
}

function requiredHeader(request, name) {
  const value = request.headers.get(name);
  if (!value) throw new RelayAuthError("RELAY_AUTH_HEADERS_MISSING");
  return value;
}

function normalizeMethod(value) {
  const method = String(value || "").toUpperCase();
  if (!/^[A-Z]{3,10}$/.test(method)) throw new RelayAuthError("RELAY_METHOD_INVALID", 400);
  return method;
}

function normalizePath(value) {
  const path = String(value || "");
  if (!path.startsWith("/") || path.includes("?") || path.includes("#") || /[\r\n]/.test(path)) {
    throw new RelayAuthError("RELAY_PATH_INVALID", 400);
  }
  return path;
}

function normalizeIdentifier(value, code) {
  const identifier = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(identifier)) {
    throw new RelayAuthError(code, 400);
  }
  return identifier;
}

function normalizeTimestamp(value) {
  const text = typeof value === "number" ? String(value) : String(value || "");
  if (!/^\d{1,12}$/.test(text)) throw new RelayAuthError("RELAY_TIMESTAMP_INVALID");
  const timestamp = Number(text);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new RelayAuthError("RELAY_TIMESTAMP_INVALID");
  }
  return timestamp;
}

function normalizeNowSeconds(value) {
  if (value == null) return Math.floor(Date.now() / 1000);
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new RelayAuthError("RELAY_CLOCK_INVALID", 500);
  return Math.floor(numeric > 100_000_000_000 ? numeric / 1000 : numeric);
}

function validateNonce(value) {
  const nonce = String(value || "");
  if (!/^[A-Za-z0-9_-]{22}$/.test(nonce)) throw new RelayAuthError("RELAY_NONCE_INVALID");
  const bytes = base64UrlToBytes(nonce);
  if (bytes.length !== 16 || base64Url(bytes) !== nonce) {
    throw new RelayAuthError("RELAY_NONCE_INVALID");
  }
  return nonce;
}

function parseSignature(value) {
  const match = /^v1=([A-Za-z0-9_-]{43})$/.exec(String(value || ""));
  if (!match) throw new RelayAuthError("RELAY_SIGNATURE_INVALID");
  const bytes = base64UrlToBytes(match[1]);
  if (bytes.length !== 32 || base64Url(bytes) !== match[1]) {
    throw new RelayAuthError("RELAY_SIGNATURE_INVALID");
  }
  return bytes;
}

async function importHmacKey(secret, usages) {
  const bytes = toBytes(secret);
  if (bytes.length < 32) throw new RelayAuthError("RELAY_SECRET_INVALID", 500);
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, usages);
}

function randomNonce() {
  return base64Url(crypto.getRandomValues(new Uint8Array(16)));
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return encoder.encode(String(value ?? ""));
}

function base64Url(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const base64 = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new RelayAuthError("RELAY_BASE64_INVALID");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
