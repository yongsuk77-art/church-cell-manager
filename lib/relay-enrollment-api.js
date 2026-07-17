import {
  constantTimeStringEqual,
  createRelayEnrollmentToken,
  decryptRelayClientSecret,
  encryptRelayClientSecret,
  relayEnrollmentTokenHmac,
  requireNotificationSecret
} from "./notification-crypto.js";
import {
  canonicalRelayBaseUrl,
  RelayClientError,
  inspectRelayClientConfiguration,
  resolveRelayClientConfiguration,
  verifyRelayClientCredentials
} from "./relay-client.js";
import { createRelayEnrollmentCode } from "./relay-enrollment-code.js";
import { requireSiteIdentity } from "./site-identity.js";

const ENROLLMENT_TTL_MS = 10 * 60 * 1000;
const REQUEST_MAX_BYTES = 16 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class RelayEnrollmentApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "RelayEnrollmentApiError";
    this.status = status;
    this.code = code;
  }
}

export async function createRelayEnrollmentRequest(request, env) {
  const identity = await requireSiteIdentity(request, env);
  const secret = requireNotificationSecret(env);
  const now = new Date();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ENROLLMENT_TTL_MS).toISOString();
  const requestId = crypto.randomUUID();
  const token = createRelayEnrollmentToken();
  const tokenHmac = await relayEnrollmentTokenHmac(secret, requestId, token);
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE relay_enrollment_requests
       SET status = 'invalidated', invalidated_at = ?, updated_at = ?
       WHERE status = 'pending'`
    ).bind(issuedAt, issuedAt),
    env.DB.prepare(
      `INSERT INTO relay_enrollment_requests
        (request_id, token_hmac, site_id, site_origin, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`
    ).bind(
      requestId,
      tokenHmac,
      identity.siteId,
      identity.siteOrigin,
      expiresAt,
      issuedAt,
      issuedAt
    )
  ]);
  if (Number(results?.[1]?.meta?.changes || 0) < 1) {
    throw new RelayEnrollmentApiError(
      "Relay registration request could not be saved",
      503,
      "RELAY_ENROLLMENT_SAVE_FAILED"
    );
  }
  await writeSafeAudit(env, "relay.enrollment.request.create", requestId, {
    siteId: identity.siteId,
    expiresAt
  });
  return {
    requestCode: createRelayEnrollmentCode({
      version: 1,
      requestId,
      siteId: identity.siteId,
      siteOrigin: identity.siteOrigin,
      issuedAt,
      expiresAt,
      token
    }),
    requestId,
    siteId: identity.siteId,
    siteOrigin: identity.siteOrigin,
    issuedAt,
    expiresAt
  };
}

export async function inspectRelayEnrollmentRequest(request, env, requestId) {
  assertUuid(requestId);
  const body = await readExactJson(request, ["token"]);
  const identity = await requireSiteIdentity(request, env);
  const verified = await verifyEnrollmentToken(env, requestId, body.token, identity, {
    allowCompleted: true
  });
  return {
    code: "RELAY_ENROLLMENT_REQUEST_VALID",
    requestId,
    siteId: identity.siteId,
    siteOrigin: identity.siteOrigin,
    status: verified.status,
    expiresAt: verified.expiresAt
  };
}

export async function completeRelayEnrollmentRequest(request, env, requestId) {
  assertUuid(requestId);
  const body = await readExactJson(request, ["token", "relayBaseUrl", "keyId", "secret"]);
  const identity = await requireSiteIdentity(request, env);
  const verified = await verifyEnrollmentToken(env, requestId, body.token, identity, {
    allowCompleted: true
  });
  const supplied = inspectRelayClientConfiguration({
    RELAY_BASE_URL: body.relayBaseUrl,
    RELAY_KEY_ID: body.keyId,
    RELAY_HMAC_SECRET: body.secret
  });
  if (!supplied.ready) {
    throw new RelayEnrollmentApiError(
      "Relay credentials are invalid",
      400,
      supplied.errorCode || "RELAY_CREDENTIAL_INVALID"
    );
  }
  let expectedBaseUrl;
  try {
    expectedBaseUrl = canonicalRelayBaseUrl(env.RELAY_BASE_URL);
  } catch {
    throw new RelayEnrollmentApiError(
      "Relay public address is not configured",
      503,
      "RELAY_BASE_URL_INVALID"
    );
  }
  if (supplied.baseUrl !== expectedBaseUrl) {
    throw new RelayEnrollmentApiError(
      "Relay address does not match this site",
      400,
      "RELAY_BASE_URL_MISMATCH"
    );
  }

  if (verified.status === "completed") {
    await assertIdempotentCompletion(env, identity, supplied);
    return {
      code: "RELAY_ENROLLMENT_COMPLETED",
      requestId,
      siteId: identity.siteId,
      keyId: supplied.keyId,
      alreadyCompleted: true
    };
  }

  await verifyRelayClientCredentials({
    env,
    siteId: identity.siteId,
    baseUrl: supplied.baseUrl,
    keyId: supplied.keyId,
    secret: supplied.secret
  });
  const notificationSecret = requireNotificationSecret(env);
  const ciphertext = await encryptRelayClientSecret(
    notificationSecret,
    identity.siteId,
    identity.siteOrigin,
    supplied.baseUrl,
    supplied.keyId,
    supplied.secret
  );
  const nowIso = new Date().toISOString();
  const tokenHmac = await relayEnrollmentTokenHmac(notificationSecret, requestId, body.token);
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO relay_client_credentials
        (singleton, site_id, site_origin, relay_base_url, key_id, secret_ciphertext,
         status, installed_at, updated_at, revoked_at)
       SELECT 1, ?, ?, ?, ?, ?, 'active', ?, ?, ''
       FROM relay_enrollment_requests
       WHERE request_id = ? AND token_hmac = ?
         AND status = 'pending' AND expires_at > ?
       ON CONFLICT(singleton) DO UPDATE SET
         site_id = excluded.site_id,
         site_origin = excluded.site_origin,
         relay_base_url = excluded.relay_base_url,
         key_id = excluded.key_id,
         secret_ciphertext = excluded.secret_ciphertext,
         status = 'active',
         installed_at = excluded.installed_at,
         updated_at = excluded.updated_at,
         revoked_at = ''`
    ).bind(
      identity.siteId,
      identity.siteOrigin,
      supplied.baseUrl,
      supplied.keyId,
      ciphertext,
      nowIso,
      nowIso,
      requestId,
      tokenHmac,
      nowIso
    ),
    env.DB.prepare(
      `UPDATE relay_enrollment_requests
       SET status = 'completed', relay_base_url = ?, key_id = ?,
         completed_at = ?, updated_at = ?
       WHERE request_id = ? AND token_hmac = ? AND status = 'pending' AND expires_at > ?`
    ).bind(
      supplied.baseUrl,
      supplied.keyId,
      nowIso,
      nowIso,
      requestId,
      tokenHmac,
      nowIso
    )
  ]);
  if (Number(results?.[0]?.meta?.changes || 0) < 1
    || Number(results?.[1]?.meta?.changes || 0) < 1) {
    const current = await env.DB.prepare(
      "SELECT status FROM relay_enrollment_requests WHERE request_id = ?"
    ).bind(requestId).first();
    if (current?.status === "completed") {
      await assertIdempotentCompletion(env, identity, supplied);
      return {
        code: "RELAY_ENROLLMENT_COMPLETED",
        requestId,
        siteId: identity.siteId,
        keyId: supplied.keyId,
        alreadyCompleted: true
      };
    }
    throw new RelayEnrollmentApiError(
      "Relay registration changed while it was being completed",
      409,
      "RELAY_ENROLLMENT_CONFLICT"
    );
  }
  await writeSafeAudit(env, "relay.enrollment.complete", requestId, {
    siteId: identity.siteId,
    keyId: supplied.keyId,
    completedAt: nowIso
  });
  return {
    code: "RELAY_ENROLLMENT_COMPLETED",
    requestId,
    siteId: identity.siteId,
    keyId: supplied.keyId,
    alreadyCompleted: false
  };
}

export async function readRelayEnrollmentStatus(env, relayConfiguration = null) {
  const configuration = relayConfiguration || await resolveRelayClientConfiguration(env);
  let latest = null;
  try {
    latest = await env.DB.prepare(
      `SELECT request_id AS requestId, status, expires_at AS expiresAt,
        key_id AS keyId, created_at AS createdAt, completed_at AS completedAt
       FROM relay_enrollment_requests ORDER BY created_at DESC LIMIT 1`
    ).first();
  } catch (error) {
    if (!/no such table:\s*relay_enrollment_requests/i.test(String(error?.message || error || ""))) {
      throw error;
    }
  }
  const pending = latest?.status === "pending" && Date.parse(latest.expiresAt || "") > Date.now();
  if (configuration.ready) {
    return {
      state: "connected",
      source: configuration.source === "d1" ? "self_enrollment" : "legacy_environment",
      keyId: configuration.keyId,
      completedAt: configuration.source === "d1" ? normalizeDate(latest?.completedAt) : "",
      pendingExpiresAt: pending ? normalizeDate(latest.expiresAt) : "",
      reissuePending: pending
    };
  }
  return {
    state: pending ? "pending" : "not_registered",
    source: "",
    keyId: "",
    completedAt: "",
    pendingExpiresAt: pending ? normalizeDate(latest.expiresAt) : "",
    reissuePending: false,
    errorCode: configuration.errorCode || ""
  };
}

export async function reconcileRelayEnrollmentConfiguration(env, relayConfiguration = null) {
  const configuration = relayConfiguration || await resolveRelayClientConfiguration(env);
  if (!configuration.ready || configuration.source !== "d1") return configuration;
  try {
    await verifyRelayClientCredentials({
      env,
      siteId: configuration.siteId,
      baseUrl: configuration.baseUrl,
      keyId: configuration.keyId,
      secret: configuration.secret
    });
    return configuration;
  } catch (error) {
    if (!(error instanceof RelayClientError) || Number(error.status || 0) !== 401) throw error;
    const revokedAt = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE relay_client_credentials
       SET status = 'revoked', secret_ciphertext = '', revoked_at = ?, updated_at = ?
       WHERE singleton = 1 AND key_id = ? AND status = 'active'`
    ).bind(revokedAt, revokedAt, configuration.keyId).run();
    return {
      ...configuration,
      ready: false,
      errorCode: "RELAY_SITE_REVOKED",
      secret: ""
    };
  }
}

async function verifyEnrollmentToken(env, requestId, tokenValue, identity, options = {}) {
  const token = String(tokenValue || "");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new RelayEnrollmentApiError("Registration request is invalid", 401, "RELAY_ENROLLMENT_TOKEN_INVALID");
  }
  const row = await env.DB.prepare(
    `SELECT token_hmac AS tokenHmac, site_id AS siteId, site_origin AS siteOrigin,
      status, expires_at AS expiresAt
     FROM relay_enrollment_requests WHERE request_id = ?`
  ).bind(requestId).first();
  const candidate = await relayEnrollmentTokenHmac(requireNotificationSecret(env), requestId, token);
  if (!row || !constantTimeStringEqual(candidate, row.tokenHmac)
    || row.siteId !== identity.siteId || row.siteOrigin !== identity.siteOrigin) {
    throw new RelayEnrollmentApiError("Registration request is invalid", 401, "RELAY_ENROLLMENT_TOKEN_INVALID");
  }
  if (row.status === "completed" && options.allowCompleted) return row;
  if (row.status !== "pending") {
    throw new RelayEnrollmentApiError("Registration request is no longer active", 410, "RELAY_ENROLLMENT_INACTIVE");
  }
  if (Date.parse(row.expiresAt || "") <= Date.now()) {
    const nowIso = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE relay_enrollment_requests
       SET status = 'invalidated', invalidated_at = ?, updated_at = ?
       WHERE request_id = ? AND status = 'pending'`
    ).bind(nowIso, nowIso, requestId).run();
    throw new RelayEnrollmentApiError("Registration request expired", 410, "RELAY_ENROLLMENT_EXPIRED");
  }
  return row;
}

async function assertIdempotentCompletion(env, identity, supplied) {
  const row = await env.DB.prepare(
    `SELECT site_id AS siteId, site_origin AS siteOrigin, relay_base_url AS baseUrl,
      key_id AS keyId, secret_ciphertext AS secretCiphertext, status
     FROM relay_client_credentials WHERE singleton = 1`
  ).first();
  if (!row || row.status !== "active" || row.siteId !== identity.siteId
    || row.siteOrigin !== identity.siteOrigin || row.baseUrl !== supplied.baseUrl
    || row.keyId !== supplied.keyId) {
    throw new RelayEnrollmentApiError(
      "Completed registration does not match stored credentials",
      409,
      "RELAY_ENROLLMENT_CONFLICT"
    );
  }
  let storedSecret;
  try {
    storedSecret = await decryptRelayClientSecret(
      requireNotificationSecret(env),
      row.siteId,
      row.siteOrigin,
      row.baseUrl,
      row.keyId,
      row.secretCiphertext
    );
  } catch {
    throw new RelayEnrollmentApiError(
      "Stored Relay credentials cannot be verified",
      503,
      "RELAY_CREDENTIAL_DECRYPT_FAILED"
    );
  }
  if (!constantTimeStringEqual(storedSecret, supplied.secret)) {
    throw new RelayEnrollmentApiError(
      "Completed registration does not match stored credentials",
      409,
      "RELAY_ENROLLMENT_CONFLICT"
    );
  }
}

async function readExactJson(request, expectedFields) {
  const contentType = String(request.headers.get("Content-Type") || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new RelayEnrollmentApiError("Content-Type must be application/json", 415, "CONTENT_TYPE_INVALID");
  }
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(declared) && declared > REQUEST_MAX_BYTES) {
    throw new RelayEnrollmentApiError("Request body is too large", 413, "REQUEST_TOO_LARGE");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new RelayEnrollmentApiError("JSON body is required", 400, "JSON_REQUIRED");
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > REQUEST_MAX_BYTES) {
      try { await reader.cancel(); } catch { /* Best effort. */ }
      throw new RelayEnrollmentApiError("Request body is too large", 413, "REQUEST_TOO_LARGE");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RelayEnrollmentApiError("Request body is not valid JSON", 400, "JSON_INVALID");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RelayEnrollmentApiError("JSON body must be an object", 400, "JSON_INVALID");
  }
  const actual = Object.keys(body).sort();
  const expected = [...expectedFields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new RelayEnrollmentApiError("Request fields are invalid", 400, "REQUEST_FIELDS_INVALID");
  }
  return body;
}

async function writeSafeAudit(env, action, entityId, after) {
  await env.DB.prepare(
    `INSERT INTO audit_logs
      (id, actor, action, entity_type, entity_id, before_json, after_json)
     VALUES (?, 'admin', ?, 'relay_enrollment', ?, '', ?)`
  ).bind(crypto.randomUUID(), action, entityId, JSON.stringify(after)).run();
}

function assertUuid(value) {
  if (!UUID_PATTERN.test(String(value || ""))) {
    throw new RelayEnrollmentApiError("Registration request id is invalid", 400, "RELAY_ENROLLMENT_ID_INVALID");
  }
}

function normalizeDate(value) {
  const milliseconds = Date.parse(String(value || ""));
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : "";
}
