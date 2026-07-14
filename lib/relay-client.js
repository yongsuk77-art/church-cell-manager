import { createRelayAuthHeaders } from "./relay-auth.js";

const TARGET_UPSERT_TIMEOUT_MS = 10 * 1000;
const TARGET_REVOKE_TIMEOUT_MS = 5 * 1000;
// The relay enforces a shorter total upstream deadline; this leaves time for
// its final idempotency write and response without holding a cron indefinitely.
const DELIVERY_TIMEOUT_MS = 20 * 1000;
const RESPONSE_MAX_BYTES = 16 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RELAY_KEY_ID_PATTERN = /^rkey_v1_[A-Za-z0-9_-]{22}$/;
export const RELAY_TARGET_HANDLE_PATTERN = /^rth_v1_[A-Za-z0-9_-]{32}$/;

export class RelayClientError extends Error {
  constructor(message, code, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "RelayClientError";
    this.code = code;
    this.status = Number(options.status || 503);
    this.retryable = Boolean(options.retryable);
    this.retryAfterMs = Number(options.retryAfterMs || 0);
  }
}

export function inspectRelayClientConfiguration(env) {
  let baseUrl = "";
  let keyId = "";
  let secret = "";
  let errorCode = "";
  try {
    baseUrl = canonicalRelayBaseUrl(env?.RELAY_BASE_URL);
  } catch {
    errorCode = "RELAY_BASE_URL_INVALID";
  }
  keyId = String(env?.RELAY_KEY_ID || "");
  if (!RELAY_KEY_ID_PATTERN.test(keyId) && !errorCode) errorCode = "RELAY_KEY_ID_INVALID";
  secret = String(env?.RELAY_HMAC_SECRET || "");
  if ([...secret].length < 32 && !errorCode) errorCode = "RELAY_HMAC_SECRET_INVALID";
  return {
    ready: !errorCode,
    errorCode,
    baseUrl,
    keyId,
    secret
  };
}

export async function upsertRelayTarget({
  env,
  siteId,
  deviceId,
  targetKind,
  targetValue,
  deviceGeneration,
  targetRevision
}) {
  assertUuid(deviceId, "deviceId");
  return relayRequest(env, siteId, "PUT", `/v1/targets/${deviceId}`, {
    targetKind,
    targetValue,
    deviceGeneration,
    targetRevision
  }, TARGET_UPSERT_TIMEOUT_MS);
}

export async function revokeRelayTarget({ env, siteId, targetHandle }) {
  assertTargetHandle(targetHandle);
  return relayRequest(
    env,
    siteId,
    "DELETE",
    `/v1/targets/${targetHandle}`,
    null,
    TARGET_REVOKE_TIMEOUT_MS
  );
}

export async function sendRelayDelivery({ env, siteId, delivery, device }) {
  assertTargetHandle(device?.relayTargetHandle);
  return relayRequest(env, siteId, "POST", "/v1/deliveries", {
    schemaVersion: "2",
    targetHandle: device.relayTargetHandle,
    deviceGeneration: Number(device.generation || 0),
    targetRevision: Number(device.targetRevision || 0),
    notificationId: String(delivery.notificationId || "").toLowerCase(),
    type: String(delivery.kind || ""),
    reminderId: delivery.kind === "memo_reminder" || delivery.kind === "visit_alarm"
      ? String(delivery.reminderId || "").toLowerCase()
      : "",
    scheduledAt: String(delivery.scheduledAt || ""),
    route: `reminders/${String(delivery.notificationId || "").toLowerCase()}`
  }, DELIVERY_TIMEOUT_MS);
}

async function relayRequest(env, siteIdValue, method, path, body, timeoutMs) {
  const configuration = inspectRelayClientConfiguration(env);
  if (!configuration.ready) {
    throw new RelayClientError("Push relay is not configured", configuration.errorCode, { status: 503 });
  }
  const siteId = String(siteIdValue || "").toLowerCase();
  assertUuid(siteId, "siteId");
  const rawBody = body === null ? "" : JSON.stringify(body);
  const authHeaders = await createRelayAuthHeaders({
    method,
    path,
    rawBody,
    siteId,
    keyId: configuration.keyId,
    secret: configuration.secret
  });

  let response;
  try {
    const requestUrl = `${configuration.baseUrl}${path}`;
    const viaServiceBinding = typeof env?.RELAY?.fetch === "function";
    const requestInit = {
      method,
      headers: {
        Accept: "application/json",
        ...(body === null ? {} : { "Content-Type": "application/json; charset=utf-8" }),
        ...authHeaders
      },
      body: body === null ? undefined : rawBody,
      redirect: viaServiceBinding ? "manual" : "error",
      signal: timeoutSignal(timeoutMs)
    };
    response = viaServiceBinding
      ? await env.RELAY.fetch(requestUrl, requestInit)
      : await globalThis.fetch(requestUrl, requestInit);
  } catch (error) {
    const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw new RelayClientError(
      timeout ? "Push relay request timed out" : "Push relay network request failed",
      timeout ? "RELAY_TIMEOUT" : "RELAY_NETWORK_ERROR",
      { status: 503, retryable: true, cause: error }
    );
  }

  let payload;
  try {
    payload = await readBoundedJsonResponse(response);
  } catch (error) {
    if (error instanceof RelayClientError) throw error;
    throw new RelayClientError(
      "Push relay response could not be read",
      "RELAY_RESPONSE_READ_FAILED",
      { status: 502, retryable: true }
    );
  }
  if (!response.ok) {
    const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
    const retryable = response.status === 408 || response.status === 409
      || response.status === 429 || response.status >= 500;
    throw new RelayClientError(
      "Push relay rejected the request",
      cleanErrorCode(payload?.code, `RELAY_HTTP_${response.status}`),
      { status: response.status, retryable, retryAfterMs }
    );
  }
  return payload;
}

async function readBoundedJsonResponse(response) {
  const declaredLength = Number(response.headers.get("Content-Length") || 0);
  if (declaredLength > RESPONSE_MAX_BYTES) {
    throw new RelayClientError(
      "Push relay response was too large",
      "RELAY_RESPONSE_TOO_LARGE",
      { status: 502, retryable: true }
    );
  }
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > RESPONSE_MAX_BYTES) {
      try { await reader.cancel(); } catch { /* Best effort. */ }
      throw new RelayClientError(
        "Push relay response was too large",
        "RELAY_RESPONSE_TOO_LARGE",
        { status: 502, retryable: true }
      );
    }
    chunks.push(value);
  }
  if (!total) return {};
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return value;
  } catch {
    throw new RelayClientError(
      "Push relay response was invalid",
      "RELAY_RESPONSE_INVALID",
      { status: 502, retryable: true }
    );
  }
}

function canonicalRelayBaseUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("invalid");
  if (url.pathname !== "/" || (url.port && url.port !== "443")) throw new Error("invalid");
  return `https://${url.hostname.toLowerCase()}`;
}

function assertUuid(value, field) {
  if (!UUID_PATTERN.test(String(value || ""))) {
    throw new RelayClientError(`${field} is invalid`, "RELAY_IDENTIFIER_INVALID", { status: 400 });
  }
}

function assertTargetHandle(value) {
  if (!RELAY_TARGET_HANDLE_PATTERN.test(String(value || ""))) {
    throw new RelayClientError("targetHandle is invalid", "RELAY_IDENTIFIER_INVALID", { status: 400 });
  }
}

function timeoutSignal(milliseconds) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(milliseconds);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), milliseconds);
  return controller.signal;
}

function parseRetryAfter(value) {
  const text = String(value || "").trim();
  if (!text) return 0;
  const seconds = Number(text);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0;
}

function cleanErrorCode(value, fallback) {
  const code = String(value || "").replace(/[^A-Z0-9_]/g, "").slice(0, 100);
  return code || fallback;
}
