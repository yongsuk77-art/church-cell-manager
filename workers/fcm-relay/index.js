import {
  RELAY_AUTH_HEADERS,
  RelayAuthError,
  sha256Base64Url,
  verifyRelayAuthSignature
} from "../../lib/relay-auth.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const MAX_BODY_BYTES = 16 * 1024;
const NONCE_RETENTION_MS = 10 * 60 * 1000;
const PREVIOUS_KEY_GRACE_MS = 24 * 60 * 60 * 1000;
const DELIVERY_LEASE_MS = 60 * 1000;
const MIN_RETRY_MS = 60 * 1000;
const MAX_RETRY_MS = 6 * 60 * 60 * 1000;
// The clone client currently has a 15-second whole-request timeout. Keep the
// relay's serial OAuth + FCM work inside one smaller deadline so the relay can
// persist and return its normalized outcome before the caller gives up.
const UPSTREAM_TOTAL_TIMEOUT_MS = 12 * 1000;
const DEFAULT_REQUEST_RATE_LIMIT_PER_MINUTE = 90;
const MAX_REQUEST_RATE_LIMIT_PER_MINUTE = 90;
const DEFAULT_SITE_RATE_LIMIT_PER_MINUTE = 60;
const DEFAULT_TARGET_RATE_LIMIT_PER_MINUTE = 30;
const DEFAULT_TARGET_MAX_ROWS_PER_SITE = 100;
const DEFAULT_TARGET_RETENTION_DAYS = 180;
const DEFAULT_DELIVERY_MAX_ROWS_PER_SITE = 10_000;
const DEFAULT_DELIVERY_RETENTION_DAYS = 180;
const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const responseHeaders = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains"
});

export default {
  async fetch(request, env) {
    return handleRelayRequest(request, env);
  }
};

export async function handleRelayRequest(request, env) {
  try {
    if (!env?.DB) throw new RelayHttpError("RELAY_DATABASE_UNAVAILABLE", 503);
    const url = new URL(request.url);
    if (url.protocol !== "https:") throw new RelayHttpError("HTTPS_REQUIRED", 400);

    if (request.method === "POST" && url.pathname === "/admin/v1/sites") {
      await requireAdmin(request, env);
      const rawBody = await readRawBody(request);
      return createSiteResponse(await createSite(env, parseJsonObject(request, rawBody)));
    }

    const rotateMatch = /^\/admin\/v1\/sites\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/keys\/rotate$/.exec(url.pathname);
    if (request.method === "POST" && rotateMatch) {
      await requireAdmin(request, env);
      const rawBody = await readRawBody(request);
      const body = rawBody.byteLength === 0 ? {} : parseJsonObject(request, rawBody);
      requireExactObject(body, [], "ADMIN_SCHEMA_INVALID");
      return rotateKeyResponse(await rotateSiteKey(env, rotateMatch[1]));
    }

    const targetPutMatch = /^\/v1\/targets\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(url.pathname);
    if (request.method === "PUT" && targetPutMatch) {
      const rawBody = await readRawBody(request);
      const auth = await authenticateClone(request, rawBody, env);
      const body = parseJsonObject(request, rawBody);
      return json(await upsertTarget(env, auth.siteId, targetPutMatch[1], body), 200);
    }

    const targetDeleteMatch = /^\/v1\/targets\/(rth_v1_[A-Za-z0-9_-]{32})$/.exec(url.pathname);
    if (request.method === "DELETE" && targetDeleteMatch) {
      const rawBody = await readRawBody(request);
      if (rawBody.byteLength !== 0) throw new RelayHttpError("TARGET_DELETE_BODY_NOT_ALLOWED", 400);
      const auth = await authenticateClone(request, rawBody, env);
      await revokeTarget(env, auth.siteId, targetDeleteMatch[1]);
      return new Response(null, { status: 204, headers: withoutContentType(responseHeaders) });
    }

    if (request.method === "POST" && url.pathname === "/v1/deliveries") {
      const rawBody = await readRawBody(request);
      const auth = await authenticateClone(request, rawBody, env);
      const body = parseJsonObject(request, rawBody);
      return json(await deliverNotification(env, auth.siteId, body), 200);
    }

    if (isKnownPath(url.pathname)) throw new RelayHttpError("METHOD_NOT_ALLOWED", 405);
    throw new RelayHttpError("NOT_FOUND", 404);
  } catch (error) {
    const status = normalizedHttpErrorStatus(error);
    const code = normalizedErrorCode(error, status === 500 ? "RELAY_INTERNAL_ERROR" : "RELAY_REQUEST_FAILED");
    const extraHeaders = Number(error?.retryAfterSeconds || 0) > 0
      ? { "Retry-After": String(Math.ceil(error.retryAfterSeconds)) }
      : {};
    return json({ code }, status, extraHeaders);
  }
}

async function createSite(env, body) {
  requireExactObject(body, ["siteId", "siteOrigin"], "ADMIN_SCHEMA_INVALID");
  const siteId = validateSiteId(body.siteId);
  const siteOrigin = canonicalSiteOrigin(body.siteOrigin);
  const masterSecret = requireMasterSecret(env);
  const keyId = createKeyId();
  const secret = randomSecret();
  const secretCiphertext = await encryptSiteSecret(masterSecret, siteId, keyId, secret);
  const nowIso = new Date().toISOString();

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO relay_sites (site_id, site_origin, status, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?)`
      ).bind(siteId, siteOrigin, nowIso, nowIso),
      env.DB.prepare(
        `INSERT INTO relay_site_keys
          (site_id, key_id, secret_ciphertext, status, created_at)
         VALUES (?, ?, ?, 'current', ?)`
      ).bind(siteId, keyId, secretCiphertext, nowIso),
      env.DB.prepare(
        `INSERT INTO relay_admin_audit
          (id, action, site_id, key_id, result, created_at)
         VALUES (?, 'site.create', ?, ?, 'success', ?)`
      ).bind(randomId("audit_v1_", 16), siteId, keyId, nowIso)
    ]);
  } catch (error) {
    if (isConstraintError(error)) throw new RelayHttpError("SITE_ALREADY_EXISTS", 409);
    throw error;
  }
  return { siteId, siteOrigin, keyId, secret };
}

async function rotateSiteKey(env, requestedSiteId) {
  const siteId = validateSiteId(requestedSiteId);
  const site = await env.DB.prepare(
    "SELECT site_origin AS siteOrigin FROM relay_sites WHERE site_id = ? AND status = 'active'"
  ).bind(siteId).first();
  if (!site) throw new RelayHttpError("SITE_NOT_FOUND", 404);

  const masterSecret = requireMasterSecret(env);
  const keyId = createKeyId();
  const secret = randomSecret();
  const secretCiphertext = await encryptSiteSecret(masterSecret, siteId, keyId, secret);
  const now = new Date();
  const nowIso = now.toISOString();
  const previousValidUntil = new Date(now.getTime() + PREVIOUS_KEY_GRACE_MS).toISOString();

  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE relay_site_keys
         SET status = 'revoked', secret_ciphertext = '', verify_until = '', revoked_at = ?
         WHERE site_id = ? AND status = 'previous'`
      ).bind(nowIso, siteId),
      env.DB.prepare(
        `UPDATE relay_site_keys
         SET status = 'previous', verify_until = ?, previous_at = ?
         WHERE site_id = ? AND status = 'current'`
      ).bind(previousValidUntil, nowIso, siteId),
      env.DB.prepare(
        `INSERT INTO relay_site_keys
          (site_id, key_id, secret_ciphertext, status, created_at)
         VALUES (?, ?, ?, 'current', ?)`
      ).bind(siteId, keyId, secretCiphertext, nowIso),
      env.DB.prepare("UPDATE relay_sites SET updated_at = ? WHERE site_id = ?")
        .bind(nowIso, siteId),
      env.DB.prepare(
        `INSERT INTO relay_admin_audit
          (id, action, site_id, key_id, result, created_at)
         VALUES (?, 'site.key.rotate', ?, ?, 'success', ?)`
      ).bind(randomId("audit_v1_", 16), siteId, keyId, nowIso)
    ]);
  } catch (error) {
    if (isConstraintError(error)) throw new RelayHttpError("KEY_ROTATION_CONFLICT", 409);
    throw error;
  }
  return { siteId, keyId, secret, previousValidUntil };
}

async function authenticateClone(request, rawBody, env) {
  const siteIdHint = String(request.headers.get(RELAY_AUTH_HEADERS.siteId) || "");
  const keyIdHint = String(request.headers.get(RELAY_AUTH_HEADERS.keyId) || "");
  if (!identifierShape(siteIdHint) || !identifierShape(keyIdHint)) {
    throw new RelayHttpError("RELAY_AUTH_INVALID", 401);
  }
  const now = new Date();
  const nowIso = now.toISOString();
  const row = await env.DB.prepare(
    `SELECT key.secret_ciphertext AS secretCiphertext, key.status, key.verify_until AS verifyUntil
     FROM relay_site_keys AS key
     JOIN relay_sites AS site ON site.site_id = key.site_id
     WHERE key.site_id = ? AND key.key_id = ? AND site.status = 'active'
       AND (key.status = 'current' OR (key.status = 'previous' AND key.verify_until > ?))`
  ).bind(siteIdHint, keyIdHint, nowIso).first();
  if (!row) throw new RelayHttpError("RELAY_AUTH_INVALID", 401);

  let secret;
  try {
    secret = await decryptSiteSecret(
      requireMasterSecret(env),
      siteIdHint,
      keyIdHint,
      row.secretCiphertext
    );
  } catch (error) {
    if (error instanceof RelayHttpError) throw error;
    throw new RelayHttpError("RELAY_KEY_DECRYPT_FAILED", 503);
  }

  let verified;
  try {
    verified = await verifyRelayAuthSignature({ request, rawBody, secret, now });
  } catch (error) {
    if (error instanceof RelayAuthError) {
      const status = error.status >= 500 ? 503 : error.status;
      throw new RelayHttpError(error.code, status);
    }
    throw error;
  }
  if (verified.siteId !== siteIdHint || verified.keyId !== keyIdHint) {
    throw new RelayHttpError("RELAY_AUTH_INVALID", 401);
  }

  // Bound every authenticated clone endpoint before persisting a one-use
  // nonce. Otherwise a tenant with a valid key could bypass the endpoint
  // limits with unique nonces and grow the shared replay table without bound.
  await enforceSiteAdmissionRateLimit(env, verified.siteId, now);
  await rememberNonce(env, verified, now);
  return verified;
}

async function rememberNonce(env, auth, now) {
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + NONCE_RETENTION_MS).toISOString();
  await env.DB.prepare("DELETE FROM relay_replay_nonces WHERE expires_at <= ?")
    .bind(nowIso).run();
  try {
    await env.DB.prepare(
      `INSERT INTO relay_replay_nonces
        (site_id, key_id, nonce_hash, request_timestamp, seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(auth.siteId, auth.keyId, auth.nonceHash, auth.timestamp, nowIso, expiresAt).run();
  } catch (error) {
    const replay = await env.DB.prepare(
      `SELECT 1 AS found FROM relay_replay_nonces
       WHERE site_id = ? AND key_id = ? AND nonce_hash = ?`
    ).bind(auth.siteId, auth.keyId, auth.nonceHash).first();
    if (replay) throw new RelayHttpError("RELAY_REPLAY_DETECTED", 409);
    if (isNonceCapError(error)) {
      throw new RelayHttpError("SITE_RATE_LIMITED", 429, retryAfterMinuteBoundary(now));
    }
    throw error;
  }
}

async function upsertTarget(env, siteId, siteDeviceId, body) {
  requireExactObject(
    body,
    ["targetKind", "targetValue", "deviceGeneration", "targetRevision"],
    "TARGET_SCHEMA_INVALID"
  );
  const targetKind = validateTargetKind(body.targetKind);
  const targetValue = validateTargetValue(targetKind, body.targetValue);
  const deviceGeneration = validateInteger(body.deviceGeneration, 0, 2_147_483_647, "DEVICE_GENERATION_INVALID");
  const targetRevision = validateInteger(body.targetRevision, 1, 2_147_483_647, "TARGET_REVISION_INVALID");
  const now = new Date();
  await enforceSiteRateLimit(
    env,
    siteId,
    "target",
    env.RELAY_TARGET_RATE_LIMIT_PER_MINUTE,
    DEFAULT_TARGET_RATE_LIMIT_PER_MINUTE,
    now
  );
  // Old delivery rows may retain foreign keys to old target handles. Release
  // those references before pruning targets so a site cannot become stuck at
  // the target-row cap after the configured retention period.
  await pruneDeliveryRows(env, siteId, now);
  await pruneTargetRows(env, siteId, now);
  const masterSecret = requireMasterSecret(env);
  const fingerprint = await fingerprintTarget(masterSecret, targetKind, targetValue);
  const nowIso = now.toISOString();

  const existing = await env.DB.prepare(
    `SELECT target_handle AS targetHandle, target_kind AS targetKind,
      target_fingerprint AS targetFingerprint, device_generation AS deviceGeneration,
      target_revision AS targetRevision, site_device_id AS siteDeviceId, status
     FROM relay_targets WHERE site_id = ? AND site_device_id = ?`
  ).bind(siteId, siteDeviceId).first();

  const siteVersion = await env.DB.prepare(
    `SELECT status, max_device_generation AS maxDeviceGeneration,
      max_generation_device_id AS maxGenerationDeviceId,
      max_target_revision AS maxTargetRevision
     FROM relay_sites WHERE site_id = ?`
  ).bind(siteId).first();
  if (!siteVersion || siteVersion.status !== "active") {
    throw new RelayHttpError("RELAY_AUTH_INVALID", 401);
  }
  assertSiteTargetVersion(siteVersion, siteDeviceId, deviceGeneration, targetRevision);
  if (existing) {
    assertTargetVersion(existing, deviceGeneration, targetRevision, targetKind, fingerprint);
  }

  const owner = await env.DB.prepare(
    `SELECT site_id AS siteId, site_device_id AS siteDeviceId, target_handle AS targetHandle
     FROM relay_targets WHERE target_fingerprint = ? AND status = 'active'`
  ).bind(fingerprint).first();
  if (owner && owner.siteId !== siteId) {
    throw new RelayHttpError("TARGET_ALREADY_ACTIVE", 409);
  }
  const activeForSite = await env.DB.prepare(
    `SELECT site_device_id AS siteDeviceId, target_handle AS targetHandle
     FROM relay_targets
     WHERE site_id = ? AND status = 'active' AND site_device_id <> ?
     LIMIT 1`
  ).bind(siteId, siteDeviceId).first();

  if (!existing && await targetRowLimitReached(env, siteId)) {
    throw new RelayHttpError("TARGET_STORAGE_LIMIT", 507);
  }
  const targetHandle = existing?.targetHandle || createTargetHandle();
  const ciphertext = await encryptTarget(
    masterSecret,
    siteId,
    targetHandle,
    targetKind,
    targetValue
  );
  const statements = [env.DB.prepare(
    `UPDATE relay_sites
     SET max_device_generation = ?, max_generation_device_id = ?,
       max_target_revision = ?, updated_at = ?
     WHERE site_id = ? AND status = 'active'
       AND (
         max_device_generation < ?
         OR (
           max_device_generation = ?
           AND (max_generation_device_id = '' OR max_generation_device_id = ?)
           AND max_target_revision <= ?
         )
       )`
  ).bind(
    deviceGeneration,
    siteDeviceId,
    targetRevision,
    nowIso,
    siteId,
    deviceGeneration,
    deviceGeneration,
    siteDeviceId,
    targetRevision
  )];
  const transferFrom = activeForSite
    || (owner && owner.siteId === siteId && owner.targetHandle !== targetHandle ? owner : null);
  if (transferFrom) {
    statements.push(env.DB.prepare(
      `UPDATE relay_targets
       SET status = 'revoked', target_ciphertext = '', target_fingerprint = '',
         revoked_at = ?, updated_at = ?
       WHERE site_id = ? AND site_device_id = ? AND status = 'active'
         AND device_generation < ?
         AND EXISTS (
           SELECT 1 FROM relay_sites
           WHERE site_id = ? AND status = 'active'
             AND max_device_generation = ? AND max_generation_device_id = ?
             AND max_target_revision = ?
         )`
    ).bind(
      nowIso,
      nowIso,
      siteId,
      transferFrom.siteDeviceId,
      deviceGeneration,
      siteId,
      deviceGeneration,
      siteDeviceId,
      targetRevision
    ));
  }

  if (existing) {
    statements.push(env.DB.prepare(
      `UPDATE relay_targets
       SET target_kind = ?, target_ciphertext = ?, target_fingerprint = ?,
         device_generation = ?, target_revision = ?, status = 'active',
         last_registered_at = ?, updated_at = ?, unregistered_at = '', revoked_at = ''
       WHERE site_id = ? AND site_device_id = ?
         AND (
           device_generation < ?
           OR (device_generation = ? AND target_revision < ?)
           OR (
            device_generation = ? AND target_revision = ?
            AND target_kind = ? AND target_fingerprint = ?
           )
         )
         AND EXISTS (
           SELECT 1 FROM relay_sites
           WHERE site_id = ? AND status = 'active'
             AND max_device_generation = ? AND max_generation_device_id = ?
             AND max_target_revision = ?
         )`
    ).bind(
      targetKind,
      ciphertext,
      fingerprint,
      deviceGeneration,
      targetRevision,
      nowIso,
      nowIso,
      siteId,
      siteDeviceId,
      deviceGeneration,
      deviceGeneration,
      targetRevision,
      deviceGeneration,
      targetRevision,
      targetKind,
      fingerprint,
      siteId,
      deviceGeneration,
      siteDeviceId,
      targetRevision
    ));
  } else {
    statements.push(env.DB.prepare(
      `INSERT INTO relay_targets
        (target_handle, site_id, site_device_id, target_kind, target_ciphertext,
         target_fingerprint, device_generation, target_revision, status,
         created_at, updated_at, last_registered_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM relay_sites
         WHERE site_id = ? AND status = 'active'
           AND max_device_generation = ? AND max_generation_device_id = ?
           AND max_target_revision = ?
       )`
    ).bind(
      targetHandle,
      siteId,
      siteDeviceId,
      targetKind,
      ciphertext,
      fingerprint,
      deviceGeneration,
      targetRevision,
      nowIso,
      nowIso,
      nowIso,
      siteId,
      deviceGeneration,
      siteDeviceId,
      targetRevision
    ));
  }

  try {
    const results = await env.DB.batch(statements);
    const siteVersionAccepted = Number(results?.[0]?.meta?.changes || 0) === 1;
    const targetChanged = Number(results?.at(-1)?.meta?.changes || 0) === 1;
    if (!siteVersionAccepted || !targetChanged) {
      const currentSiteVersion = await env.DB.prepare(
        `SELECT status, max_device_generation AS maxDeviceGeneration,
          max_generation_device_id AS maxGenerationDeviceId,
          max_target_revision AS maxTargetRevision
         FROM relay_sites WHERE site_id = ?`
      ).bind(siteId).first();
      if (!currentSiteVersion || currentSiteVersion.status !== "active") {
        throw new RelayHttpError("RELAY_AUTH_INVALID", 401);
      }
      assertSiteTargetVersion(
        currentSiteVersion,
        siteDeviceId,
        deviceGeneration,
        targetRevision
      );
      const current = await env.DB.prepare(
        `SELECT target_kind AS targetKind, target_fingerprint AS targetFingerprint,
          device_generation AS deviceGeneration, target_revision AS targetRevision
         FROM relay_targets WHERE site_id = ? AND site_device_id = ?`
      ).bind(siteId, siteDeviceId).first();
      if (Number(current?.deviceGeneration) === deviceGeneration
        && Number(current?.targetRevision) === targetRevision
        && (current?.targetKind !== targetKind || current?.targetFingerprint !== fingerprint)) {
        throw new RelayHttpError("TARGET_VERSION_CONFLICT", 409);
      }
      throw new RelayHttpError("TARGET_VERSION_STALE", 409);
    }
  } catch (error) {
    if (error instanceof RelayHttpError) throw error;
    if (isTargetCapError(error)) throw new RelayHttpError("TARGET_STORAGE_LIMIT", 507);
    if (isConstraintError(error)) throw new RelayHttpError("TARGET_ALREADY_ACTIVE", 409);
    throw error;
  }
  return { targetHandle, status: "active", deviceGeneration, targetRevision };
}

function assertSiteTargetVersion(siteVersion, siteDeviceId, generation, revision) {
  const maximumGeneration = Number(siteVersion?.maxDeviceGeneration || 0);
  const maximumDeviceId = String(siteVersion?.maxGenerationDeviceId || "");
  const maximumRevision = Number(siteVersion?.maxTargetRevision || 0);
  if (generation < maximumGeneration
    || (generation === maximumGeneration && maximumDeviceId === siteDeviceId
      && revision < maximumRevision)) {
    throw new RelayHttpError("TARGET_VERSION_STALE", 409);
  }
  if (generation === maximumGeneration && maximumDeviceId && maximumDeviceId !== siteDeviceId) {
    throw new RelayHttpError("TARGET_GENERATION_CONFLICT", 409);
  }
}

function assertTargetVersion(existing, generation, revision, targetKind, fingerprint) {
  const oldGeneration = Number(existing.deviceGeneration);
  const oldRevision = Number(existing.targetRevision);
  if (generation < oldGeneration || (generation === oldGeneration && revision < oldRevision)) {
    throw new RelayHttpError("TARGET_VERSION_STALE", 409);
  }
  if (generation === oldGeneration && revision === oldRevision
    && (existing.targetKind !== targetKind || existing.targetFingerprint !== fingerprint)) {
    throw new RelayHttpError("TARGET_VERSION_CONFLICT", 409);
  }
}

async function revokeTarget(env, siteId, targetHandle) {
  const nowIso = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE relay_targets
     SET status = 'revoked', target_ciphertext = '', target_fingerprint = '',
       revoked_at = CASE WHEN revoked_at = '' THEN ? ELSE revoked_at END, updated_at = ?
     WHERE site_id = ? AND target_handle = ? AND status <> 'revoked'`
  ).bind(nowIso, nowIso, siteId, targetHandle).run();
}

async function deliverNotification(env, siteId, body) {
  const delivery = validateDelivery(body);
  const payloadHash = await sha256Base64Url(JSON.stringify(delivery));
  const now = new Date();
  const nowIso = now.toISOString();
  await enforceSiteRateLimit(
    env,
    siteId,
    "delivery",
    env.RELAY_SITE_RATE_LIMIT_PER_MINUTE,
    DEFAULT_SITE_RATE_LIMIT_PER_MINUTE,
    now
  );
  await pruneDeliveryRows(env, siteId, now);
  let existing = await selectDelivery(
    env,
    siteId,
    delivery.notificationId,
    delivery.deviceGeneration,
    delivery.targetRevision
  );
  if (existing && existing.payloadHash !== payloadHash) {
    throw new RelayHttpError("IDEMPOTENCY_CONFLICT", 409);
  }
  if (existing && isFinalOutcome(existing.state)) return storedOutcome(existing);
  if (existing && !deliveryAttemptDue(existing, nowIso)) return waitingOutcome(existing, now);

  if (String(env.RELAY_SEND_ENABLED || "").toLowerCase() !== "true") {
    return normalizedOutcome("blocked", 503, "RELAY_SEND_DISABLED", 0, "");
  }

  let fcmConfig;
  try {
    fcmConfig = requireFcmConfig(env);
    requireMasterSecret(env);
  } catch (error) {
    return normalizedOutcome("blocked", 503, normalizedErrorCode(error, "RELAY_CONFIGURATION_ERROR"), 0, "");
  }

  const target = await env.DB.prepare(
    `SELECT target_handle AS targetHandle, target_kind AS targetKind,
      target_ciphertext AS targetCiphertext, device_generation AS deviceGeneration,
      target_revision AS targetRevision
     FROM relay_targets
     WHERE site_id = ? AND target_handle = ? AND status = 'active'`
  ).bind(siteId, delivery.targetHandle).first();
  if (!target) {
    const result = normalizedOutcome("unregistered", 404, "TARGET_UNAVAILABLE", 0, "");
    if (existing) await persistOutcomeWithoutLease(env, siteId, delivery, result, now);
    return result;
  }
  if (Number(target.deviceGeneration) !== delivery.deviceGeneration
    || Number(target.targetRevision) !== delivery.targetRevision) {
    const result = normalizedOutcome("unregistered", 409, "TARGET_VERSION_MISMATCH", 0, "");
    if (existing) await persistOutcomeWithoutLease(env, siteId, delivery, result, now);
    return result;
  }

  if (!existing && await deliveryRowLimitReached(env, siteId)) {
    return normalizedOutcome("blocked", 507, "DELIVERY_STORAGE_LIMIT", 0, "");
  }

  const leaseToken = randomId("lease_v1_", 16);
  const leaseExpiresAt = new Date(now.getTime() + DELIVERY_LEASE_MS).toISOString();
  if (!existing) {
    try {
      await env.DB.prepare(
        `INSERT INTO relay_deliveries
          (site_id, notification_id, payload_hash, target_handle, device_generation,
           target_revision, type, reminder_id, note_id, scheduled_at, route, state,
           attempt_count, lease_token, lease_expires_at,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', 1, ?, ?, ?, ?)`
      ).bind(
        siteId,
        delivery.notificationId,
        payloadHash,
        delivery.targetHandle,
        delivery.deviceGeneration,
        delivery.targetRevision,
        delivery.type,
        delivery.reminderId,
        delivery.noteId,
        delivery.scheduledAt,
        delivery.route,
        leaseToken,
        leaseExpiresAt,
        nowIso,
        nowIso
      ).run();
    } catch (error) {
      if (isDeliveryCapError(error)) {
        return normalizedOutcome("blocked", 507, "DELIVERY_STORAGE_LIMIT", 0, "");
      }
      if (!isConstraintError(error)) throw error;
      existing = await selectDelivery(
        env,
        siteId,
        delivery.notificationId,
        delivery.deviceGeneration,
        delivery.targetRevision
      );
      if (!existing || existing.payloadHash !== payloadHash) {
        throw new RelayHttpError("IDEMPOTENCY_CONFLICT", 409);
      }
      return waitingOutcome(existing, now);
    }
  } else {
    const claimed = await env.DB.prepare(
      `UPDATE relay_deliveries
       SET state = 'processing', outcome = '', http_status = 0, error_code = '',
         retry_after_ms = 0, message_name = '', attempt_count = attempt_count + 1,
         lease_token = ?, lease_expires_at = ?, next_attempt_at = '', updated_at = ?
       WHERE site_id = ? AND notification_id = ? AND payload_hash = ?
         AND device_generation = ? AND target_revision = ?
         AND (
           (state = 'processing' AND lease_expires_at <= ?)
           OR (state IN ('retry', 'blocked') AND (next_attempt_at = '' OR next_attempt_at <= ?))
         )`
    ).bind(
      leaseToken,
      leaseExpiresAt,
      nowIso,
      siteId,
      delivery.notificationId,
      payloadHash,
      delivery.deviceGeneration,
      delivery.targetRevision,
      nowIso,
      nowIso
    ).run();
    if (Number(claimed?.meta?.changes || 0) !== 1) {
      const current = await selectDelivery(
        env,
        siteId,
        delivery.notificationId,
        delivery.deviceGeneration,
        delivery.targetRevision
      );
      return waitingOutcome(current || existing, now);
    }
  }

  let targetValue;
  try {
    targetValue = await decryptTarget(
      requireMasterSecret(env),
      siteId,
      target.targetHandle,
      target.targetKind,
      target.targetCiphertext
    );
  } catch {
    const result = normalizedOutcome("blocked", 503, "TARGET_DECRYPT_FAILED", 0, "");
    const stored = await persistDeliveryOutcome(
      env,
      siteId,
      delivery,
      leaseToken,
      result,
      target,
      now
    );
    return stored || normalizedOutcome("retry", 503, "RELAY_STATE_WRITE_CONFLICT", MIN_RETRY_MS, "");
  }

  const result = await sendFcmDelivery(fcmConfig, target.targetKind, targetValue, siteId, delivery);
  const stored = await persistDeliveryOutcome(
    env,
    siteId,
    delivery,
    leaseToken,
    result,
    target,
    now
  );
  if (!stored) return normalizedOutcome("retry", 503, "RELAY_STATE_WRITE_CONFLICT", MIN_RETRY_MS, "");
  return stored;
}

function validateDelivery(body) {
  requireExactObject(
    body,
    [
      "schemaVersion",
      "targetHandle",
      "deviceGeneration",
      "targetRevision",
      "notificationId",
      "type",
      "reminderId",
      "noteId",
      "scheduledAt",
      "route"
    ],
    "DELIVERY_SCHEMA_INVALID"
  );
  if (body.schemaVersion !== "2") throw new RelayHttpError("DELIVERY_SCHEMA_INVALID", 400);
  const notificationId = validateUuid(body.notificationId, "NOTIFICATION_ID_INVALID");
  const targetHandle = String(body.targetHandle || "");
  if (!/^rth_v1_[A-Za-z0-9_-]{32}$/.test(targetHandle)) {
    throw new RelayHttpError("TARGET_HANDLE_INVALID", 400);
  }
  const deviceGeneration = validateInteger(
    body.deviceGeneration,
    0,
    2_147_483_647,
    "DEVICE_GENERATION_INVALID"
  );
  const targetRevision = validateInteger(
    body.targetRevision,
    1,
    2_147_483_647,
    "TARGET_REVISION_INVALID"
  );
  const type = String(body.type || "");
  if (!new Set(["memo_reminder", "visit_alarm", "connection_test"]).has(type)) {
    throw new RelayHttpError("DELIVERY_TYPE_INVALID", 400);
  }
  const reminderId = String(body.reminderId ?? "");
  if (type === "connection_test") {
    if (reminderId !== "") throw new RelayHttpError("REMINDER_ID_INVALID", 400);
  } else {
    validateUuid(reminderId, "REMINDER_ID_INVALID");
  }
  const noteIdValue = String(body.noteId ?? "").toLowerCase();
  const noteId = type === "memo_reminder"
    ? validateUuid(noteIdValue, "NOTE_ID_INVALID")
    : "";
  if (type !== "memo_reminder" && noteIdValue !== "") {
    throw new RelayHttpError("NOTE_ID_INVALID", 400);
  }
  const scheduledAt = validateIsoTimestamp(body.scheduledAt);
  const route = String(body.route || "");
  if (route !== `reminders/${notificationId}`) throw new RelayHttpError("DELIVERY_ROUTE_INVALID", 400);
  return {
    schemaVersion: "2",
    notificationId,
    targetHandle,
    deviceGeneration,
    targetRevision,
    type,
    reminderId,
    noteId,
    scheduledAt,
    route
  };
}

async function selectDelivery(env, siteId, notificationId, deviceGeneration, targetRevision) {
  return env.DB.prepare(
    `SELECT payload_hash AS payloadHash, state, outcome,
      http_status AS httpStatus, error_code AS errorCode,
      retry_after_ms AS retryAfterMs, message_name AS messageName,
      lease_expires_at AS leaseExpiresAt, next_attempt_at AS nextAttemptAt,
      attempt_count AS attemptCount
     FROM relay_deliveries
     WHERE site_id = ? AND notification_id = ?
       AND device_generation = ? AND target_revision = ?`
  ).bind(siteId, notificationId, deviceGeneration, targetRevision).first();
}

function deliveryAttemptDue(row, nowIso) {
  if (row.state === "processing") return String(row.leaseExpiresAt || "") <= nowIso;
  if (row.state === "retry" || row.state === "blocked") {
    return !row.nextAttemptAt || row.nextAttemptAt <= nowIso;
  }
  return false;
}

function isFinalOutcome(state) {
  return state === "accepted" || state === "unregistered" || state === "dead";
}

function storedOutcome(row) {
  return normalizedOutcome(
    row.outcome || row.state,
    row.httpStatus,
    row.errorCode,
    row.retryAfterMs,
    row.messageName
  );
}

function waitingOutcome(row, now) {
  if (!row) return normalizedOutcome("retry", 503, "RELAY_IN_PROGRESS", 1000, "");
  if (row.state === "retry" || row.state === "blocked") {
    const remaining = Math.max(0, Date.parse(row.nextAttemptAt || "") - now.getTime());
    return normalizedOutcome(
      row.outcome || row.state,
      row.httpStatus,
      row.errorCode,
      Math.max(remaining, Number(row.retryAfterMs || 0)),
      row.messageName
    );
  }
  if (isFinalOutcome(row.state)) return storedOutcome(row);
  return normalizedOutcome("retry", 503, "RELAY_IN_PROGRESS", 1000, "");
}

async function persistOutcomeWithoutLease(env, siteId, delivery, result, now) {
  const nowIso = now.toISOString();
  await env.DB.prepare(
    `UPDATE relay_deliveries
     SET state = ?, outcome = ?, http_status = ?, error_code = ?, retry_after_ms = ?,
       message_name = ?, lease_token = '', lease_expires_at = '', next_attempt_at = '',
       completed_at = ?, updated_at = ?
     WHERE site_id = ? AND notification_id = ?
       AND device_generation = ? AND target_revision = ?`
  ).bind(
    result.outcome,
    result.outcome,
    result.httpStatus,
    result.errorCode,
    result.retryAfterMs,
    result.messageName,
    nowIso,
    nowIso,
    siteId,
    delivery.notificationId,
    delivery.deviceGeneration,
    delivery.targetRevision
  ).run();
}

async function persistDeliveryOutcome(env, siteId, delivery, leaseToken, result, target, now) {
  const nowIso = now.toISOString();
  const retryDelayMs = result.outcome === "retry" || result.outcome === "blocked"
    ? computeRetryDelayMs(result.retryAfterMs)
    : 0;
  const storedResult = retryDelayMs > 0
    ? normalizedOutcome(result.outcome, result.httpStatus, result.errorCode, retryDelayMs, result.messageName)
    : result;
  const nextAttemptAt = retryDelayMs > 0
    ? new Date(now.getTime() + retryDelayMs).toISOString()
    : "";
  const completedAt = isFinalOutcome(storedResult.outcome) ? nowIso : "";
  const acceptedAt = storedResult.outcome === "accepted" ? nowIso : "";
  const deliveryUpdate = env.DB.prepare(
    `UPDATE relay_deliveries
     SET state = ?, outcome = ?, http_status = ?, error_code = ?, retry_after_ms = ?,
       message_name = ?, lease_token = '', lease_expires_at = '', next_attempt_at = ?,
       accepted_at = ?, completed_at = ?, updated_at = ?
     WHERE site_id = ? AND notification_id = ?
       AND device_generation = ? AND target_revision = ? AND lease_token = ?`
  ).bind(
    storedResult.outcome,
    storedResult.outcome,
    storedResult.httpStatus,
    storedResult.errorCode,
    storedResult.retryAfterMs,
    storedResult.messageName,
    nextAttemptAt,
    acceptedAt,
    completedAt,
    nowIso,
    siteId,
    delivery.notificationId,
    delivery.deviceGeneration,
    delivery.targetRevision,
    leaseToken
  );

  let results;
  if (storedResult.outcome === "unregistered") {
    const targetUpdate = env.DB.prepare(
      `UPDATE relay_targets
       SET status = 'unregistered', unregistered_at = ?, updated_at = ?
       WHERE site_id = ? AND target_handle = ? AND device_generation = ?
         AND target_revision = ? AND status = 'active'`
    ).bind(
      nowIso,
      nowIso,
      siteId,
      target.targetHandle,
      target.deviceGeneration,
      target.targetRevision
    );
    results = await env.DB.batch([targetUpdate, deliveryUpdate]);
    return Number(results?.[1]?.meta?.changes || 0) === 1 ? storedResult : null;
  }
  const writeResult = await deliveryUpdate.run();
  return Number(writeResult?.meta?.changes || 0) === 1 ? storedResult : null;
}

export async function sendFcmDelivery(config, targetKind, targetValue, siteId, delivery) {
  const deadline = Date.now() + boundedEnvironmentInteger(
    config.upstreamTimeoutMs,
    UPSTREAM_TOTAL_TIMEOUT_MS,
    1,
    UPSTREAM_TOTAL_TIMEOUT_MS
  );
  let accessToken;
  try {
    accessToken = await createOauthAccessToken(
      config.serviceAccount,
      Math.max(1, deadline - Date.now())
    );
  } catch (error) {
    return deliveryFailureOutcome(error);
  }
  if (Date.now() >= deadline) {
    return normalizedOutcome("retry", 0, "FCM_UPSTREAM_DEADLINE", 0, "");
  }

  const targetField = targetKind === "fid" ? "fid" : "token";
  let response;
  try {
    response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.targetProjectId)}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({
          message: {
            [targetField]: targetValue,
            data: {
              schemaVersion: "2",
              siteId,
              type: delivery.type,
              notificationId: delivery.notificationId,
              reminderId: delivery.reminderId,
              noteId: delivery.type === "memo_reminder" ? delivery.noteId : "",
              scheduledAt: delivery.scheduledAt,
              route: delivery.route
            },
            android: {
              priority: "HIGH",
              ttl: "604800s"
            }
          }
        }),
        signal: timeoutSignal(Math.max(1, deadline - Date.now()))
      }
    );
  } catch (error) {
    return normalizedOutcome(
      "retry",
      0,
      error?.name === "TimeoutError" ? "FCM_TIMEOUT" : "FCM_NETWORK_ERROR",
      0,
      ""
    );
  }

  if (response.ok) {
    const body = await safeResponseJson(response);
    return normalizedOutcome("accepted", response.status, "", 0, cleanValue(body?.name, 500));
  }

  const body = await safeResponseJson(response);
  const fcmCode = extractFcmErrorCode(body);
  const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
  if ((response.status === 404 && isUnregisteredFcmTarget(fcmCode))
    || (response.status === 400 && isUnregisteredFcmTarget(fcmCode))) {
    return normalizedOutcome("unregistered", response.status, "FCM_UNREGISTERED", 0, "");
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return normalizedOutcome(
      "blocked",
      response.status,
      response.status === 403 ? "FCM_PERMISSION_DENIED" : `FCM_HTTP_${response.status}`,
      0,
      ""
    );
  }
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    return normalizedOutcome(
      "retry",
      response.status,
      fcmCode || `FCM_HTTP_${response.status}`,
      retryAfterMs,
      ""
    );
  }
  return normalizedOutcome(
    "dead",
    response.status,
    fcmCode || `FCM_HTTP_${response.status}`,
    0,
    ""
  );
}

export async function createOauthAccessToken(serviceAccount, timeoutMs = UPSTREAM_TOTAL_TIMEOUT_MS) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = base64Url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = base64Url(encoder.encode(JSON.stringify({
    iss: serviceAccount.clientEmail,
    scope: FCM_SCOPE,
    aud: OAUTH_TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600
  })));
  const signingInput = `${header}.${claims}`;
  let privateKey;
  try {
    privateKey = await crypto.subtle.importKey(
      "pkcs8",
      pemPrivateKeyBytes(serviceAccount.privateKey),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );
  } catch {
    throw new RelayDeliveryError("blocked", 0, "FCM_PRIVATE_KEY_INVALID", 0);
  }
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    encoder.encode(signingInput)
  );
  const assertion = `${signingInput}.${base64Url(signature)}`;

  let response;
  try {
    response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion
      }).toString(),
      signal: timeoutSignal(Math.max(1, Math.min(UPSTREAM_TOTAL_TIMEOUT_MS, Number(timeoutMs) || 1)))
    });
  } catch (error) {
    throw new RelayDeliveryError(
      "retry",
      0,
      error?.name === "TimeoutError" ? "FCM_OAUTH_TIMEOUT" : "FCM_OAUTH_NETWORK_ERROR",
      0
    );
  }
  if (!response.ok) {
    const outcome = response.status === 429 || response.status >= 500 ? "retry" : "blocked";
    throw new RelayDeliveryError(
      outcome,
      response.status,
      `FCM_OAUTH_HTTP_${response.status}`,
      parseRetryAfter(response.headers.get("Retry-After"))
    );
  }
  const body = await safeResponseJson(response);
  const token = String(body?.access_token || "");
  if (!token || token.length > 8192) {
    throw new RelayDeliveryError("blocked", response.status, "FCM_OAUTH_RESPONSE_INVALID", 0);
  }
  return token;
}

function requireFcmConfig(env) {
  let value;
  try {
    value = JSON.parse(String(env.FCM_SERVICE_ACCOUNT_JSON || ""));
  } catch {
    throw new RelayHttpError("FCM_SERVICE_ACCOUNT_INVALID", 503);
  }
  const clientEmail = String(value?.client_email || "");
  const privateKey = String(value?.private_key || "");
  const targetProjectId = String(env.FCM_TARGET_PROJECT_ID || "");
  if (!/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/i.test(clientEmail)
    || !privateKey.includes("-----BEGIN PRIVATE KEY-----")
    || !privateKey.includes("-----END PRIVATE KEY-----")) {
    throw new RelayHttpError("FCM_SERVICE_ACCOUNT_INVALID", 503);
  }
  if (!/^[a-z0-9][a-z0-9-]{4,61}[a-z0-9]$/i.test(targetProjectId)) {
    throw new RelayHttpError("FCM_TARGET_PROJECT_INVALID", 503);
  }
  return {
    serviceAccount: { clientEmail, privateKey },
    targetProjectId,
    upstreamTimeoutMs: boundedEnvironmentInteger(
      env.RELAY_UPSTREAM_TIMEOUT_MS,
      UPSTREAM_TOTAL_TIMEOUT_MS,
      1,
      UPSTREAM_TOTAL_TIMEOUT_MS
    )
  };
}

function deliveryFailureOutcome(error) {
  if (error instanceof RelayDeliveryError) {
    return normalizedOutcome(error.outcome, error.httpStatus, error.code, error.retryAfterMs, "");
  }
  return normalizedOutcome("blocked", 503, "FCM_SENDER_ERROR", 0, "");
}

function normalizedOutcome(outcome, httpStatus, errorCode, retryAfterMs, messageName) {
  const allowed = new Set(["accepted", "unregistered", "retry", "blocked", "dead"]);
  const normalized = allowed.has(outcome) ? outcome : "blocked";
  return {
    outcome: normalized,
    httpStatus: Math.max(0, Math.trunc(Number(httpStatus) || 0)),
    errorCode: cleanErrorCode(errorCode),
    retryAfterMs: Math.max(0, Math.trunc(Number(retryAfterMs) || 0)),
    messageName: cleanValue(messageName, 500)
  };
}

function validateSiteId(value) {
  const siteId = String(value || "");
  if (siteId === NIL_UUID || !CANONICAL_UUID_PATTERN.test(siteId)) {
    throw new RelayHttpError("SITE_ID_INVALID", 400);
  }
  return siteId;
}

function identifierShape(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(String(value || ""));
}

function canonicalSiteOrigin(value) {
  const source = String(value || "").trim();
  let url;
  try {
    url = new URL(source);
  } catch {
    throw new RelayHttpError("SITE_ORIGIN_INVALID", 400);
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname || url.port
    || url.pathname !== "/" || url.search || url.hash || source.includes("?") || source.includes("#")) {
    throw new RelayHttpError("SITE_ORIGIN_INVALID", 400);
  }
  return url.origin;
}

function validateTargetKind(value) {
  const kind = String(value || "");
  if (kind !== "fid" && kind !== "registration_token") {
    throw new RelayHttpError("TARGET_KIND_INVALID", 400);
  }
  return kind;
}

function validateTargetValue(kind, value) {
  const target = String(value || "");
  const maxLength = kind === "fid" ? 512 : 4096;
  if (target.length < 10 || target.length > maxLength || /[\s\u0000-\u001f\u007f]/u.test(target)) {
    throw new RelayHttpError("TARGET_VALUE_INVALID", 400);
  }
  return target;
}

function validateInteger(value, minimum, maximum, code) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RelayHttpError(code, 400);
  }
  return value;
}

function validateUuid(value, code) {
  const text = String(value || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text)) {
    throw new RelayHttpError(code, 400);
  }
  return text;
}

function validateIsoTimestamp(value) {
  const text = String(value || "");
  const timestamp = Date.parse(text);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)
    || !Number.isFinite(timestamp)
    || new Date(timestamp).toISOString() !== text) {
    throw new RelayHttpError("SCHEDULED_AT_INVALID", 400);
  }
  return text;
}

function requireExactObject(value, expectedKeys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RelayHttpError(code, 400);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new RelayHttpError(code, 400);
  }
}

function parseJsonObject(request, rawBody) {
  if (!String(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) {
    throw new RelayHttpError("CONTENT_TYPE_INVALID", 415);
  }
  try {
    return JSON.parse(decoder.decode(rawBody));
  } catch {
    throw new RelayHttpError("JSON_INVALID", 400);
  }
}

async function readRawBody(request) {
  const lengthHeader = request.headers.get("Content-Length");
  if (lengthHeader && /^\d+$/.test(lengthHeader) && Number(lengthHeader) > MAX_BODY_BYTES) {
    throw new RelayHttpError("REQUEST_TOO_LARGE", 413);
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* Best-effort resource release. */ }
        throw new RelayHttpError("REQUEST_TOO_LARGE", 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RelayHttpError) throw error;
    throw new RelayHttpError("REQUEST_BODY_READ_FAILED", 400);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function requireAdmin(request, env) {
  const configured = String(env.RELAY_ADMIN_TOKEN || "");
  if (encoder.encode(configured).byteLength < 32) {
    throw new RelayHttpError("RELAY_ADMIN_NOT_CONFIGURED", 503);
  }
  const match = /^Bearer ([^\s]{32,4096})$/.exec(String(request.headers.get("Authorization") || ""));
  if (!match || !(await timingSafeEqual(match[1], configured))) {
    throw new RelayHttpError("ADMIN_UNAUTHORIZED", 401);
  }
}

async function timingSafeEqual(left, right) {
  const [a, b] = await Promise.all([sha256Bytes(left), sha256Bytes(right)]);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

function requireMasterSecret(env) {
  const secret = String(env.RELAY_MASTER_SECRET || "");
  if (encoder.encode(secret).byteLength < 32) {
    throw new RelayHttpError("RELAY_MASTER_SECRET_INVALID", 503);
  }
  return secret;
}

async function encryptSiteSecret(masterSecret, siteId, keyId, value) {
  return encryptValue(
    masterSecret,
    "callsum-relay-site-key-encryption:v1",
    `callsum-relay-site-key\u0000v1\u0000${siteId}\u0000${keyId}`,
    value
  );
}

async function decryptSiteSecret(masterSecret, siteId, keyId, ciphertext) {
  return decryptValue(
    masterSecret,
    "callsum-relay-site-key-encryption:v1",
    `callsum-relay-site-key\u0000v1\u0000${siteId}\u0000${keyId}`,
    ciphertext
  );
}

async function encryptTarget(masterSecret, siteId, handle, kind, value) {
  return encryptValue(
    masterSecret,
    "callsum-relay-target-encryption:v1",
    `callsum-relay-target\u0000v1\u0000${siteId}\u0000${handle}\u0000${kind}`,
    value
  );
}

async function decryptTarget(masterSecret, siteId, handle, kind, ciphertext) {
  return decryptValue(
    masterSecret,
    "callsum-relay-target-encryption:v1",
    `callsum-relay-target\u0000v1\u0000${siteId}\u0000${handle}\u0000${kind}`,
    ciphertext
  );
}

async function encryptValue(masterSecret, purpose, additionalData, value) {
  const key = await deriveAesKey(masterSecret, purpose, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(additionalData), tagLength: 128 },
    key,
    encoder.encode(String(value))
  );
  return `v1.${base64Url(iv)}.${base64Url(encrypted)}`;
}

async function decryptValue(masterSecret, purpose, additionalData, ciphertext) {
  const parts = String(ciphertext || "").split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("CIPHERTEXT_INVALID");
  const key = await deriveAesKey(masterSecret, purpose, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlToBytes(parts[1]),
      additionalData: encoder.encode(additionalData),
      tagLength: 128
    },
    key,
    base64UrlToBytes(parts[2])
  );
  return decoder.decode(decrypted);
}

async function deriveAesKey(masterSecret, purpose, usages) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${purpose}\u0000${masterSecret}`)
  );
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, usages);
}

async function fingerprintTarget(masterSecret, kind, targetValue) {
  const material = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`callsum-relay-target-fingerprint-key:v1\u0000${masterSecret}`)
  );
  const key = await crypto.subtle.importKey(
    "raw",
    material,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return base64Url(await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`callsum-relay-target-fingerprint:v1\u0000${kind}\u0000${targetValue}`)
  ));
}

async function sha256Bytes(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(String(value))));
}

function createSiteResponse(result) {
  return json({ code: "SITE_CREATED", ...result }, 201);
}

function rotateKeyResponse(result) {
  return json({ code: "SITE_KEY_ROTATED", ...result }, 200);
}

function createKeyId() {
  return randomId("rkey_v1_", 16);
}

function createTargetHandle() {
  return randomId("rth_v1_", 24);
}

function randomSecret() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function randomId(prefix, byteLength) {
  return `${prefix}${base64Url(crypto.getRandomValues(new Uint8Array(byteLength)))}`;
}

async function enforceSiteAdmissionRateLimit(env, siteId, now) {
  const limit = boundedEnvironmentInteger(
    env.RELAY_REQUEST_RATE_LIMIT_PER_MINUTE,
    DEFAULT_REQUEST_RATE_LIMIT_PER_MINUTE,
    1,
    MAX_REQUEST_RATE_LIMIT_PER_MINUTE
  );
  const windowMinute = Math.floor(now.getTime() / 60_000);
  const nowIso = now.toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO relay_site_admission_limits (site_id, window_minute, request_count, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(site_id) DO UPDATE SET
       request_count = CASE
         WHEN relay_site_admission_limits.window_minute = excluded.window_minute
           THEN relay_site_admission_limits.request_count + 1
         ELSE 1
       END,
       window_minute = excluded.window_minute,
       updated_at = excluded.updated_at
     WHERE relay_site_admission_limits.window_minute <> excluded.window_minute
       OR relay_site_admission_limits.request_count < ?
     RETURNING request_count AS requestCount`
  ).bind(siteId, windowMinute, nowIso, limit).first();
  if (!row || Number(row.requestCount || 0) > limit) {
    throw new RelayHttpError("SITE_RATE_LIMITED", 429, retryAfterMinuteBoundary(now));
  }
}

async function enforceSiteRateLimit(env, siteId, scope, configuredLimit, fallbackLimit, now) {
  const limit = boundedEnvironmentInteger(configuredLimit, fallbackLimit, 1, 600);
  const windowMinute = Math.floor(now.getTime() / 60_000);
  const nowIso = now.toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO relay_site_rate_limits (site_id, scope, window_minute, request_count, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(site_id, scope) DO UPDATE SET
       request_count = CASE
         WHEN relay_site_rate_limits.window_minute = excluded.window_minute
           THEN relay_site_rate_limits.request_count + 1
         ELSE 1
       END,
       window_minute = excluded.window_minute,
       updated_at = excluded.updated_at
     RETURNING request_count AS requestCount`
  ).bind(siteId, scope, windowMinute, nowIso).first();
  if (Number(row?.requestCount || 0) > limit) {
    throw new RelayHttpError("SITE_RATE_LIMITED", 429, retryAfterMinuteBoundary(now));
  }
}

function retryAfterMinuteBoundary(now) {
  return Math.max(1, 60 - Math.floor((now.getTime() % 60_000) / 1000));
}

async function pruneDeliveryRows(env, siteId, now) {
  const retentionDays = boundedEnvironmentInteger(
    env.RELAY_DELIVERY_RETENTION_DAYS,
    DEFAULT_DELIVERY_RETENTION_DAYS,
    7,
    365
  );
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    "DELETE FROM relay_deliveries WHERE site_id = ? AND updated_at < ?"
  ).bind(siteId, cutoff).run();
}

async function pruneTargetRows(env, siteId, now) {
  const retentionDays = boundedEnvironmentInteger(
    env.RELAY_TARGET_RETENTION_DAYS,
    DEFAULT_TARGET_RETENTION_DAYS,
    7,
    365
  );
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    `DELETE FROM relay_targets
     WHERE site_id = ? AND status <> 'active' AND updated_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM relay_deliveries
         WHERE relay_deliveries.site_id = relay_targets.site_id
           AND relay_deliveries.target_handle = relay_targets.target_handle
       )`
  ).bind(siteId, cutoff).run();
}

async function targetRowLimitReached(env, siteId) {
  const maximum = boundedEnvironmentInteger(
    env.RELAY_TARGET_MAX_ROWS_PER_SITE,
    DEFAULT_TARGET_MAX_ROWS_PER_SITE,
    1,
    DEFAULT_TARGET_MAX_ROWS_PER_SITE
  );
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM relay_targets WHERE site_id = ?"
  ).bind(siteId).first();
  return Number(row?.count || 0) >= maximum;
}

async function deliveryRowLimitReached(env, siteId) {
  const maximum = boundedEnvironmentInteger(
    env.RELAY_DELIVERY_MAX_ROWS_PER_SITE,
    DEFAULT_DELIVERY_MAX_ROWS_PER_SITE,
    1,
    DEFAULT_DELIVERY_MAX_ROWS_PER_SITE
  );
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM relay_deliveries WHERE site_id = ?"
  ).bind(siteId).first();
  return Number(row?.count || 0) >= maximum;
}

function boundedEnvironmentInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function computeRetryDelayMs(retryAfterMs) {
  return Math.max(MIN_RETRY_MS, Math.min(MAX_RETRY_MS, Number(retryAfterMs || 0)));
}

function parseRetryAfter(value) {
  const text = String(value || "").trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) return Math.min(Number(text) * 1000, MAX_RETRY_MS);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(parsed - Date.now(), MAX_RETRY_MS)) : 0;
}

async function safeResponseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function extractFcmErrorCode(body) {
  const details = Array.isArray(body?.error?.details) ? body.error.details : [];
  for (const detail of details) {
    if (typeof detail?.errorCode === "string") return cleanErrorCode(detail.errorCode);
  }
  return cleanErrorCode(body?.error?.status);
}

function isUnregisteredFcmTarget(code) {
  return new Set([
    "UNREGISTERED",
    "INSTALLATION_ID_NOT_REGISTERED",
    "REGISTRATION_TOKEN_NOT_REGISTERED"
  ]).has(String(code || "").toUpperCase().replace(/-/g, "_"));
}

function pemPrivateKeyBytes(pem) {
  const base64 = String(pem || "")
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function timeoutSignal(milliseconds) {
  return typeof globalThis.AbortSignal?.timeout === "function"
    ? globalThis.AbortSignal.timeout(milliseconds)
    : undefined;
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
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function withoutContentType(headers) {
  const copy = { ...headers };
  delete copy["Content-Type"];
  return copy;
}

function isKnownPath(path) {
  return path === "/admin/v1/sites"
    || /^\/admin\/v1\/sites\//.test(path)
    || path === "/v1/deliveries"
    || /^\/v1\/targets\//.test(path);
}

function json(value, status, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...responseHeaders, ...extraHeaders }
  });
}

function cleanValue(value, maximum) {
  return Array.from(String(value || "").replace(/[\u0000-\u001f\u007f]/gu, " ").trim())
    .slice(0, maximum)
    .join("");
}

function cleanErrorCode(value) {
  const code = cleanValue(value, 100).toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return /^[A-Z0-9_]+$/.test(code) ? code : "";
}

function normalizedErrorCode(error, fallback) {
  return cleanErrorCode(error?.code) || fallback;
}

function normalizedHttpErrorStatus(error) {
  const status = Number(error?.status || 500);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

function isConstraintError(error) {
  return /constraint|unique|primary key/i.test(String(error?.message || error || ""));
}

function isDeliveryCapError(error) {
  return /RELAY_DELIVERY_SITE_CAP/i.test(String(error?.message || error || ""));
}

function isTargetCapError(error) {
  return /RELAY_TARGET_SITE_CAP/i.test(String(error?.message || error || ""));
}

function isNonceCapError(error) {
  return /RELAY_NONCE_SITE_CAP/i.test(String(error?.message || error || ""));
}

class RelayHttpError extends Error {
  constructor(code, status, retryAfterSeconds = 0) {
    super(code);
    this.name = "RelayHttpError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

class RelayDeliveryError extends Error {
  constructor(outcome, httpStatus, code, retryAfterMs) {
    super(code);
    this.name = "RelayDeliveryError";
    this.outcome = outcome;
    this.httpStatus = httpStatus;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}
