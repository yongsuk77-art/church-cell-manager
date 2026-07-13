import {
  NotificationSecretError,
  constantTimeStringEqual,
  createDeviceCredential,
  createSixDigitPairCode,
  decryptDeviceTarget,
  deviceCredentialHmac,
  encryptDeviceTarget,
  isDeviceCredentialShape,
  pairActorHmac,
  pairCodeHmac,
  requireNotificationSecret,
  targetFingerprint
} from "./notification-crypto.js";
import {
  RELAY_TARGET_HANDLE_PATTERN,
  RelayClientError,
  inspectRelayClientConfiguration,
  revokeRelayTarget,
  upsertRelayTarget
} from "./relay-client.js";
import {
  SiteIdentityError,
  readStoredSiteIdentity,
  requireSiteIdentity
} from "./site-identity.js";

const ADMIN_ROLE = "admin";
const DISPATCHER_STATUS_KEY = "notification.dispatcherStatus";
const REQUEST_MAX_BYTES = 16 * 1024;
const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
const PENDING_DEVICE_TTL_MS = 15 * 60 * 1000;
const PAIR_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const PAIR_FAILURE_LOCK_MS = 15 * 60 * 1000;
const PAIR_FAILURE_LIMIT = 5;
const PAIR_CODE_CREATION_WINDOW_MS = 15 * 60 * 1000;
const PAIR_CODE_CREATION_LIMIT = 3;
const DISPATCHER_FRESH_MS = 10 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_STATUSES = new Set(["pending", "active", "unregistered", "revoked"]);
const ACK_STATUSES = new Set(["received", "displayed", "opened"]);
const PERMISSION_STATES = new Set(["unknown", "granted", "denied"]);
const DELIVERY_KINDS = new Set(["memo_reminder", "visit_alarm", "connection_test"]);

const responseHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff"
};

export async function handleCallNoteNotificationApi({ request, env, path, viewerRole }) {
  try {
    if (!env.DB) throw new NotificationApiError("D1 binding DB is not configured", 503, "DATABASE_UNAVAILABLE");
    if (path[0] !== "integrations" || path[1] !== "call-note") return notificationJson({ error: "Not found" }, 404);

    if (path[2] === "admin") {
      requireAdmin(viewerRole);
      return await handleAdminRequest(request, env, path);
    }

    if (request.method === "POST" && path.length === 4 && path[2] === "devices" && path[3] === "pair") {
      return await pairDevice(request, env);
    }

    if (path[2] === "devices" && path.length === 5 && path[4] === "registration") {
      if (request.method !== "PUT") return methodNotAllowed(["PUT"]);
      return await registerDevice(request, env, path[3]);
    }

    if (path[2] === "devices" && path.length === 4) {
      if (request.method !== "DELETE") return methodNotAllowed(["DELETE"]);
      return await disconnectOwnDevice(request, env, path[3]);
    }

    if (path[2] === "notifications" && path.length === 5 && path[4] === "ack") {
      if (request.method !== "POST") return methodNotAllowed(["POST"]);
      return await acknowledgeNotification(request, env, path[3]);
    }

    return notificationJson({ error: "Not found" }, 404);
  } catch (error) {
    if (error instanceof NotificationApiError) {
      return notificationJson(errorPayload(error), error.status, error.headers);
    }
    if (error instanceof NotificationSecretError) {
      return notificationJson({ error: error.message, code: error.code }, 503);
    }
    if (error instanceof RelayClientError) {
      const upstreamStatus = Number(error.status || 0);
      const status = upstreamStatus >= 500 || error.retryable ? 503 : 502;
      const retryAfterSeconds = Math.max(1, Math.ceil(Number(error.retryAfterMs || 60_000) / 1000));
      return notificationJson(
        { error: error.message, code: error.code || "NOTIFICATION_CONFIGURATION_ERROR" },
        status,
        { "Retry-After": String(retryAfterSeconds) }
      );
    }
    if (error instanceof SiteIdentityError) {
      return notificationJson(
        { error: error.message, code: error.code || "SITE_IDENTITY_INVALID" },
        Number(error.status || 503)
      );
    }
    console.error(JSON.stringify({
      event: "call_note_notification_api.failed",
      error: error instanceof Error ? error.name : "UnknownError"
    }));
    return notificationJson({ error: "Mobile notification request failed", code: "INTERNAL_ERROR" }, 500);
  }
}

async function handleAdminRequest(request, env, path) {
  if (path.length === 4 && path[3] === "status") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    return getAdminStatus(request, env);
  }

  if (path.length === 4 && path[3] === "pair-codes") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return createPairCode(request, env);
  }

  if (path.length === 6 && path[3] === "devices" && path[5] === "test") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return queueTestNotification(request, env, path[4]);
  }

  if (path.length === 5 && path[3] === "devices") {
    if (request.method !== "DELETE") return methodNotAllowed(["DELETE"]);
    return disconnectAdminDevice(request, env, path[4]);
  }

  return notificationJson({ error: "Not found" }, 404);
}

async function getAdminStatus(request, env) {
  const now = new Date();
  await cleanupNotificationState(env, now);
  const siteIdentity = await requireSiteIdentity(request, env);
  const relayConfiguration = inspectRelayClientConfiguration(env);
  const url = new URL(request.url);
  const deliveryLimit = clampInteger(url.searchParams.get("deliveryLimit"), 10, 1, 25);
  const [deviceRows, deliveryRows, pairCodeRow, dispatcherRaw] = await Promise.all([
    env.DB.prepare(
      `SELECT id AS deviceId, status, generation, target_kind AS registrationMode,
        target_revision AS targetRevision,
        relay_target_generation AS relayTargetGeneration,
        relay_target_revision AS relayTargetRevision,
        relay_target_state AS relayTargetState,
        device_name AS deviceName, app_version AS appVersion,
        notification_permission AS notificationPermission, notifications_enabled AS notificationsEnabled,
        paired_at AS pairedAt, pending_expires_at AS pendingExpiresAt,
        activated_at AS activatedAt, last_registered_at AS lastRegisteredAt,
        last_seen_at AS lastSeenAt, updated_at AS updatedAt
       FROM call_note_devices
       WHERE status <> 'revoked'
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, updated_at DESC`
    ).all(),
    env.DB.prepare(
      `SELECT notification_id AS notificationId, kind, COALESCE(device_id, '') AS deviceId,
        scheduled_at AS scheduledAt, send_state AS sendState, attempt_count AS attemptCount,
        last_error_code AS errorCode, accepted_at AS acceptedAt, received_at AS receivedAt,
        displayed_at AS displayedAt, opened_at AS openedAt, failed_at AS failedAt,
        created_at AS createdAt, updated_at AS updatedAt
       FROM call_note_push_deliveries
       ORDER BY created_at DESC
       LIMIT ?`
    ).bind(deliveryLimit).all(),
    env.DB.prepare(
      `SELECT expires_at AS expiresAt, used_at AS usedAt, invalidated_at AS invalidatedAt
       FROM call_note_pair_codes
       ORDER BY created_at DESC
       LIMIT 1`
    ).first(),
    readSetting(env, DISPATCHER_STATUS_KEY)
  ]);

  const dispatcher = parseDispatcherStatus(dispatcherRaw);
  const configuredTransport = pushTransport(env);
  const workerTransport = String(dispatcher.pushTransport || "");
  const workerTransportMatches = workerTransport === configuredTransport;
  const lastRunMs = Date.parse(dispatcher.lastRunAt || "");
  const schedulerConfigured = Number.isFinite(lastRunMs) && lastRunMs >= now.getTime() - DISPATCHER_FRESH_MS;
  let apiSecretConfigured = true;
  try {
    requireNotificationSecret(env);
  } catch {
    apiSecretConfigured = false;
  }

  return notificationJson({
    serverTime: now.toISOString(),
    siteId: siteIdentity.siteId,
    siteOrigin: siteIdentity.siteOrigin,
    pushTransport: configuredTransport,
    workerPushTransport: workerTransport,
    workerTransportMatches,
    relayClientConfigured: relayConfiguration.ready,
    workerRelayConfigured: Boolean(dispatcher.relayConfigured),
    relayConfigured: configuredTransport !== "relay"
      || (relayConfiguration.ready && workerTransportMatches && Boolean(dispatcher.relayConfigured)),
    relayErrorCode: relayConfiguration.errorCode,
    apiSecretConfigured,
    schedulerConfigured,
    fcmConfigured: Boolean(dispatcher.fcmConfigured),
    workerSecretConfigured: Boolean(dispatcher.notificationSecretConfigured),
    senderEnabled: Boolean(dispatcher.senderEnabled),
    dispatcher: {
      status: cleanText(dispatcher.status, 40),
      lastRunAt: normalizeStoredDate(dispatcher.lastRunAt),
      lastSuccessAt: normalizeStoredDate(dispatcher.lastSuccessAt),
      errorCode: cleanText(dispatcher.errorCode, 80)
    },
    pairCode: pairCodeRow ? {
      expiresAt: normalizeStoredDate(pairCodeRow.expiresAt),
      usedAt: normalizeStoredDate(pairCodeRow.usedAt),
      invalidatedAt: normalizeStoredDate(pairCodeRow.invalidatedAt)
    } : null,
    devices: (deviceRows.results || []).map(publicDevice),
    deliveries: (deliveryRows.results || []).map(publicDelivery)
  });
}

async function createPairCode(request, env) {
  await requireSiteIdentity(request, env);
  if (pushTransport(env) === "relay") {
    const relayConfiguration = inspectRelayClientConfiguration(env);
    if (!relayConfiguration.ready) {
      throw new RelayClientError("Push relay is not configured", relayConfiguration.errorCode, { status: 503 });
    }
  }
  const secret = requireNotificationSecret(env);
  const now = new Date();
  await cleanupNotificationState(env, now);
  const windowStart = new Date(now.getTime() - PAIR_CODE_CREATION_WINDOW_MS).toISOString();
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM call_note_pair_codes WHERE created_at >= ?"
  ).bind(windowStart).first();
  if (Number(recent?.count || 0) >= PAIR_CODE_CREATION_LIMIT) {
    throw new NotificationApiError(
      "Too many pairing codes were created. Try again in 15 minutes.",
      429,
      "PAIR_CODE_RATE_LIMITED",
      { "Retry-After": "900" }
    );
  }

  const pairCode = createSixDigitPairCode();
  const codeHmac = await pairCodeHmac(secret, pairCode);
  const id = crypto.randomUUID();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + PAIR_CODE_TTL_MS).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE call_note_devices
       SET status = 'revoked', pending_expires_at = '', target_ciphertext = '', target_fingerprint = '',
         target_revision = target_revision + 1,
         revoked_at = ?, revoke_reason = 'pair_code_replaced', updated_at = ?
       WHERE status = 'pending'`
    ).bind(nowIso, nowIso),
    env.DB.prepare(
      `UPDATE call_note_pair_codes
       SET invalidated_at = ?
       WHERE used_at = '' AND invalidated_at = ''`
    ).bind(nowIso),
    env.DB.prepare(
      `INSERT INTO call_note_pair_codes
        (id, code_hmac, expires_at, used_at, invalidated_at, failed_attempts, created_at)
       VALUES (?, ?, ?, '', '', 0, ?)`
    ).bind(id, codeHmac, expiresAt, nowIso)
  ]);
  await auditNotificationEvent(env, "admin", "notification.pair_code.create", "pair_code", id, {
    expiresAt,
    createdAt: nowIso
  });
  return notificationJson({ pairCode, expiresAt, serverTime: nowIso }, 201);
}

async function pairDevice(request, env) {
  const siteIdentity = await requireSiteIdentity(request, env);
  const secret = requireNotificationSecret(env);
  const body = await readBoundedJson(request, [
    "pairCode", "fid", "installationId", "fcmToken", "registrationToken", "target",
    "deviceName", "appVersion", "platform", "notificationPermission", "notificationsEnabled"
  ]);
  const pairCode = String(body.pairCode || "");
  if (!/^\d{6}$/.test(pairCode)) {
    throw new NotificationApiError("Pairing code is invalid or expired", 401, "PAIR_CODE_INVALID");
  }
  if (body.platform !== undefined && body.platform !== "android") {
    throw new NotificationApiError("Only Android devices are supported", 400, "PLATFORM_UNSUPPORTED");
  }

  const now = new Date();
  const actor = await pairRequestActor(request);
  const actorHmac = await pairActorHmac(secret, actor);
  await ensurePairActorNotLocked(env, actorHmac, now);
  await cleanupNotificationState(env, now);

  const codeHmac = await pairCodeHmac(secret, pairCode);
  const codeRow = await env.DB.prepare(
    `SELECT id, expires_at AS expiresAt
     FROM call_note_pair_codes
     WHERE code_hmac = ? AND used_at = '' AND invalidated_at = '' AND expires_at > ?
     LIMIT 1`
  ).bind(codeHmac, now.toISOString()).first();
  if (!codeRow) {
    await recordPairFailure(env, actorHmac, now);
    throw new NotificationApiError("Pairing code is invalid or expired", 401, "PAIR_CODE_INVALID");
  }

  const pending = await env.DB.prepare(
    "SELECT id FROM call_note_devices WHERE status = 'pending' AND pending_expires_at > ? LIMIT 1"
  ).bind(now.toISOString()).first();
  if (pending) {
    throw new NotificationApiError("Another device connection is already pending", 409, "PAIRING_ALREADY_PENDING");
  }

  const target = normalizeTarget(body);
  const metadata = normalizeDeviceMetadata(body);
  const deviceId = crypto.randomUUID();
  const credential = createDeviceCredential();
  const [credentialHmac, ciphertext, fingerprint] = await Promise.all([
    deviceCredentialHmac(secret, deviceId, credential),
    encryptDeviceTarget(secret, deviceId, target.kind, target.value),
    targetFingerprint(secret, target.kind, target.value)
  ]);
  const nowIso = now.toISOString();
  const pendingExpiresAt = new Date(now.getTime() + PENDING_DEVICE_TTL_MS).toISOString();

  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO call_note_devices
          (id, status, generation, credential_hmac, target_kind, target_ciphertext, target_fingerprint,
           target_revision, registration_version, registration_client_at, crypto_version,
           device_name, app_version, notification_permission,
           notifications_enabled, pair_code_id, paired_at, pending_expires_at, activated_at,
           last_registered_at, last_seen_at, revoked_at, revoke_reason, updated_at)
         SELECT ?, 'pending', 0, ?, ?, ?, ?, 1, 0, '', 1, ?, ?, ?, ?, pc.id, ?, ?, '', '', ?, '', '', ?
          FROM call_note_pair_codes pc
          WHERE pc.id = ? AND pc.code_hmac = ? AND pc.used_at = '' AND pc.invalidated_at = ''
            AND pc.expires_at > ?
            AND NOT EXISTS (SELECT 1 FROM call_note_devices WHERE status = 'pending')`
      ).bind(
        deviceId, credentialHmac, target.kind, ciphertext, fingerprint,
        metadata.deviceName, metadata.appVersion, metadata.notificationPermission,
        metadata.notificationsEnabled ? 1 : 0, nowIso, pendingExpiresAt, nowIso, nowIso,
        codeRow.id, codeHmac, nowIso
      ),
      env.DB.prepare(
        `UPDATE call_note_pair_codes
         SET used_at = ?
         WHERE id = ? AND used_at = ''
           AND EXISTS (SELECT 1 FROM call_note_devices WHERE id = ? AND pair_code_id = call_note_pair_codes.id)`
      ).bind(nowIso, codeRow.id, deviceId),
      env.DB.prepare(
        `DELETE FROM call_note_pair_attempts
         WHERE actor_hmac = ? AND EXISTS (SELECT 1 FROM call_note_devices WHERE id = ?)`
      ).bind(actorHmac, deviceId)
    ]);
  } catch (error) {
    if (isConstraintError(error)) {
      throw new NotificationApiError("Pairing code is invalid or expired", 401, "PAIR_CODE_INVALID");
    }
    throw error;
  }
  if (Number(results[0]?.meta?.changes || 0) !== 1 || Number(results[1]?.meta?.changes || 0) !== 1) {
    await recordPairFailure(env, actorHmac, now);
    throw new NotificationApiError("Pairing code is invalid or expired", 401, "PAIR_CODE_INVALID");
  }

  await auditNotificationEvent(env, `device:${deviceId}`, "notification.device.pair", "notification_device", deviceId, {
    status: "pending",
    registrationMode: target.kind,
    deviceName: metadata.deviceName,
    appVersion: metadata.appVersion,
    pendingExpiresAt
  });
  return notificationJson({
    deviceId,
    deviceCredential: credential,
    status: "pending",
    siteId: siteIdentity.siteId,
    siteOrigin: siteIdentity.siteOrigin,
    registrationRequired: true,
    registrationMode: target.kind,
    pairedAt: nowIso,
    pendingExpiresAt,
    serverTime: nowIso
  }, 201);
}

async function registerDevice(request, env, deviceId) {
  assertUuid(deviceId, "deviceId");
  const siteIdentity = await requireSiteIdentity(request, env);
  const secret = requireNotificationSecret(env);
  let device = await authenticateDevice(request, env, secret, deviceId, { allowUnregistered: true });
  const body = await readBoundedJson(request, [
    "fid", "installationId", "fcmToken", "registrationToken", "target",
    "deviceName", "appVersion", "notificationPermission", "notificationsEnabled",
    "registrationVersion", "occurredAt"
  ]);
  const target = normalizeTarget(body);
  const metadata = normalizeDeviceMetadata(body, device);
  const registrationVersion = normalizeRegistrationVersion(body.registrationVersion);
  if (body.occurredAt === undefined || body.occurredAt === null || body.occurredAt === "") {
    throw new NotificationApiError(
      "occurredAt is required for device registration",
      400,
      "REGISTRATION_OCCURRED_AT_REQUIRED"
    );
  }
  const registrationClientAt = normalizeClientDate(body.occurredAt);
  const [ciphertext, fingerprint] = await Promise.all([
    encryptDeviceTarget(secret, deviceId, target.kind, target.value),
    targetFingerprint(secret, target.kind, target.value)
  ]);
  const now = new Date();
  const nowIso = now.toISOString();
  let registered = false;
  let registrationChanged = false;
  let staleIgnored = false;

  for (let attempt = 0; attempt < 4 && !registered; attempt += 1) {
    if (attempt > 0) device = await getDevice(env, deviceId);
    if (!device) throw new NotificationApiError("Device authentication failed", 401, "DEVICE_AUTH_INVALID");
    if (device.status === "revoked") {
      throw new NotificationApiError("Device was disconnected", 410, "DEVICE_REVOKED");
    }

    if (device.status === "pending") {
      if (!device.pendingExpiresAt || Date.parse(device.pendingExpiresAt) <= now.getTime()) {
        await revokeDevice(env, deviceId, "pairing_expired", nowIso);
        throw new NotificationApiError(
          "Device connection expired; create a new pairing code",
          410,
          "DEVICE_PAIRING_EXPIRED"
        );
      }
      try {
        const results = await env.DB.batch([
          env.DB.prepare(
            `UPDATE call_note_devices
             SET status = 'revoked', pending_expires_at = '', target_ciphertext = '', target_fingerprint = '',
               target_revision = target_revision + 1, revoked_at = ?,
               relay_target_state = CASE WHEN relay_target_handle = '' THEN 'none' ELSE 'revoked' END,
               revoke_reason = 'replaced_by_new_device', updated_at = ?
             WHERE id <> ? AND status IN ('active', 'unregistered')
               AND EXISTS (
                 SELECT 1 FROM call_note_devices candidate
                 WHERE candidate.id = ? AND candidate.status = 'pending'
                   AND candidate.pending_expires_at > ? AND candidate.registration_version < ?
               )`
          ).bind(nowIso, nowIso, deviceId, deviceId, nowIso, registrationVersion),
          env.DB.prepare(
            `UPDATE call_note_devices
             SET status = 'active',
               generation = (SELECT COALESCE(MAX(generation), 0) + 1 FROM call_note_devices),
               target_kind = ?, target_ciphertext = ?, target_fingerprint = ?,
               target_revision = target_revision + 1,
               registration_version = ?, registration_client_at = ?,
               device_name = ?, app_version = ?, notification_permission = ?, notifications_enabled = ?,
               pending_expires_at = '', activated_at = ?, last_registered_at = ?, last_seen_at = ?, updated_at = ?
             WHERE id = ? AND status = 'pending' AND pending_expires_at > ?
               AND registration_version < ?`
          ).bind(
            target.kind, ciphertext, fingerprint, registrationVersion, registrationClientAt,
            metadata.deviceName, metadata.appVersion, metadata.notificationPermission,
            metadata.notificationsEnabled ? 1 : 0, nowIso, nowIso, nowIso, nowIso,
            deviceId, nowIso, registrationVersion
          ),
          env.DB.prepare(
            `UPDATE call_note_push_deliveries
             SET send_state = 'retry_wait', next_attempt_at = ?, lease_token = '', lease_expires_at = '',
               last_error_code = '', updated_at = ?
             WHERE send_state = 'waiting_target' AND accepted_at = ''`
          ).bind(nowIso, nowIso)
        ]);
        if (Number(results[1]?.meta?.changes || 0) === 1) {
          registered = true;
          registrationChanged = true;
          break;
        }
      } catch (error) {
        if (!isConstraintError(error)) throw error;
      }
      continue;
    }

    if (device.status !== "active" && device.status !== "unregistered") {
      throw new NotificationApiError("Device is no longer active", 410, "DEVICE_REVOKED");
    }
    if (device.status === "unregistered") {
      const otherActive = await env.DB.prepare(
        "SELECT id FROM call_note_devices WHERE status = 'active' AND id <> ? LIMIT 1"
      ).bind(deviceId).first();
      if (otherActive) {
        await revokeDevice(env, deviceId, "replaced_by_new_device", nowIso);
        throw new NotificationApiError("Device was replaced and must be paired again", 410, "DEVICE_REVOKED");
      }
    }

    if (registrationVersion < device.registrationVersion) {
      if (device.status === "unregistered") {
        throw new NotificationApiError(
          "Firebase registration target must be refreshed",
          410,
          "DEVICE_TARGET_UNREGISTERED"
        );
      }
      staleIgnored = true;
      registered = true;
      break;
    }

    if (registrationVersion === device.registrationVersion) {
      const sameRegistrationEvent = target.kind === device.targetKind
        && fingerprint === device.targetFingerprint
        && registrationClientAt === device.registrationClientAt
        && metadata.deviceName === device.deviceName
        && metadata.appVersion === device.appVersion
        && metadata.notificationPermission === device.notificationPermission
        && metadata.notificationsEnabled === device.notificationsEnabled;
      if (!sameRegistrationEvent) {
        throw new NotificationApiError(
          "registrationVersion was already used for a different registration event",
          409,
          "REGISTRATION_VERSION_CONFLICT"
        );
      }
      if (device.status === "unregistered") {
        throw new NotificationApiError(
          "Firebase registration target must be refreshed",
          410,
          "DEVICE_TARGET_UNREGISTERED"
        );
      }
      registered = true;
      break;
    }

    let results;
    try {
      results = await env.DB.batch([
        env.DB.prepare(
          `UPDATE call_note_devices
           SET status = 'active', target_kind = ?, target_ciphertext = ?, target_fingerprint = ?,
             target_revision = target_revision + 1,
             relay_target_generation = 0, relay_target_revision = 0,
             relay_target_state = 'none', relay_synced_at = '',
             registration_version = ?, registration_client_at = ?,
             device_name = ?, app_version = ?, notification_permission = ?, notifications_enabled = ?,
             last_registered_at = ?, last_seen_at = ?, updated_at = ?
           WHERE id = ? AND status IN ('active', 'unregistered') AND registration_version < ?`
        ).bind(
          target.kind, ciphertext, fingerprint, registrationVersion, registrationClientAt,
          metadata.deviceName, metadata.appVersion, metadata.notificationPermission,
          metadata.notificationsEnabled ? 1 : 0, nowIso, nowIso, nowIso,
          deviceId, registrationVersion
        ),
        env.DB.prepare(
          `UPDATE call_note_push_deliveries
           SET send_state = 'retry_wait', next_attempt_at = ?, lease_token = '', lease_expires_at = '',
             last_error_code = '', updated_at = ?
           WHERE send_state = 'waiting_target' AND accepted_at = ''
             AND EXISTS (
               SELECT 1 FROM call_note_devices
               WHERE id = ? AND status = 'active' AND registration_version = ?
             )`
        ).bind(nowIso, nowIso, deviceId, registrationVersion)
      ]);
    } catch (error) {
      if (!isConstraintError(error)) throw error;
      results = null;
    }
    if (Number(results?.[0]?.meta?.changes || 0) !== 1) continue;
    registered = true;
    registrationChanged = true;
  }

  if (!registered) {
    throw new NotificationApiError(
      "Device registration changed concurrently; retry with the latest registrationVersion",
      409,
      "REGISTRATION_CONFLICT"
    );
  }

  const active = await getDevice(env, deviceId);
  if (!active || active.status !== "active") {
    if (active?.status === "unregistered") {
      throw new NotificationApiError(
        "Firebase registration target must be refreshed",
        410,
        "DEVICE_TARGET_UNREGISTERED"
      );
    }
    throw new NotificationApiError("Device is no longer active", 410, "DEVICE_REVOKED");
  }
  if (registrationChanged) {
    await auditNotificationEvent(env, `device:${deviceId}`, "notification.device.register", "notification_device", deviceId, {
      status: active.status,
      generation: active.generation,
      registrationMode: active.targetKind,
      targetRevision: active.targetRevision,
      registrationVersion: active.registrationVersion,
      registrationClientAt: active.registrationClientAt,
      notificationPermission: active.notificationPermission,
      notificationsEnabled: active.notificationsEnabled,
      registeredAt: active.lastRegisteredAt
    });
  }
  if (pushTransport(env) === "relay") {
    const relaySync = await synchronizeRelayDevice({
      env,
      secret,
      siteIdentity,
      device: active,
      requestTarget: target,
      requestTargetFingerprint: fingerprint
    });
    if (relaySync.changed) {
      await auditNotificationEvent(
        env,
        `device:${deviceId}`,
        "notification.device.relay_sync",
        "notification_device",
        deviceId,
        {
          relayTargetState: "active",
          deviceGeneration: active.generation,
          targetRevision: active.targetRevision,
          syncedAt: relaySync.syncedAt
        }
      );
    }
  }
  return notificationJson({
    deviceId,
    status: active.status,
    siteId: siteIdentity.siteId,
    siteOrigin: siteIdentity.siteOrigin,
    generation: active.generation,
    registrationMode: active.targetKind,
    registrationVersion: active.registrationVersion,
    registrationOccurredAt: active.registrationClientAt,
    staleIgnored,
    registeredAt: active.lastRegisteredAt,
    serverTime: nowIso
  });
}

async function acknowledgeNotification(request, env, notificationId) {
  assertUuid(notificationId, "notificationId");
  const secret = requireNotificationSecret(env);
  const body = await readBoundedJson(request, ["status", "occurredAt", "appVersion"]);
  const status = String(body.status || "");
  if (!ACK_STATUSES.has(status)) {
    throw new NotificationApiError("Unsupported acknowledgement status", 400, "ACK_STATUS_INVALID");
  }
  const occurredAt = normalizeClientDate(body.occurredAt);
  const device = await authenticateAnyCurrentDevice(request, env, secret);
  if (device.status === "pending") {
    throw new NotificationApiError("Device registration is incomplete", 409, "DEVICE_REGISTRATION_REQUIRED");
  }

  const nowIso = new Date().toISOString();
  const rank = { received: 1, displayed: 2, opened: 3 }[status];
  const result = await env.DB.prepare(
    `UPDATE call_note_push_deliveries
     SET send_state = CASE WHEN send_state = 'accepted' THEN send_state ELSE 'accepted' END,
       accepted_at = CASE WHEN accepted_at = '' THEN ? ELSE accepted_at END,
       received_at = CASE WHEN ? >= 1 AND received_at = '' THEN ? ELSE received_at END,
       received_client_at = CASE WHEN ? >= 1 AND received_client_at = '' THEN ? ELSE received_client_at END,
       displayed_at = CASE WHEN ? >= 2 AND displayed_at = '' THEN ? ELSE displayed_at END,
       displayed_client_at = CASE WHEN ? >= 2 AND displayed_client_at = '' THEN ? ELSE displayed_client_at END,
       opened_at = CASE WHEN ? >= 3 AND opened_at = '' THEN ? ELSE opened_at END,
       opened_client_at = CASE WHEN ? >= 3 AND opened_client_at = '' THEN ? ELSE opened_client_at END,
       last_error_code = '', failed_at = '', lease_token = '', lease_expires_at = '', updated_at = ?
     WHERE notification_id = ? AND device_id = ? AND device_generation = ?`
  ).bind(
    nowIso,
    rank, nowIso, rank, occurredAt,
    rank, nowIso, rank, occurredAt,
    rank, nowIso, rank, occurredAt,
    nowIso, notificationId, device.id, device.generation
  ).run();
  if (Number(result.meta?.changes || 0) !== 1) {
    throw new NotificationApiError("Notification is unavailable for this device", 410, "NOTIFICATION_EXPIRED");
  }

  await env.DB.prepare(
    `UPDATE call_note_devices
     SET last_seen_at = ?, updated_at = ?
     WHERE id = ? AND status IN ('active', 'unregistered')`
  ).bind(nowIso, nowIso, device.id).run();
  const delivery = await getDelivery(env, notificationId);
  return notificationJson({
    notificationId,
    acknowledged: status,
    ackState: highestAckState(delivery),
    serverTime: nowIso
  });
}

async function synchronizeRelayDevice({
  env,
  secret,
  siteIdentity,
  device,
  requestTarget,
  requestTargetFingerprint
}) {
  const configuration = inspectRelayClientConfiguration(env);
  if (!configuration.ready) {
    throw new RelayClientError("Push relay is not configured", configuration.errorCode, { status: 503 });
  }
  let targetKind = requestTarget.kind;
  let targetValue = requestTarget.value;
  if (targetKind !== device.targetKind || requestTargetFingerprint !== device.targetFingerprint) {
    targetKind = device.targetKind;
    try {
      targetValue = await decryptDeviceTarget(
        secret,
        device.id,
        device.targetKind,
        device.targetCiphertext
      );
    } catch {
      throw new RelayClientError("Stored Firebase target could not be synchronized", "TARGET_DECRYPT_FAILED", {
        status: 503
      });
    }
  }

  const relay = await upsertRelayTarget({
    env,
    siteId: siteIdentity.siteId,
    deviceId: device.id,
    targetKind,
    targetValue,
    deviceGeneration: device.generation,
    targetRevision: device.targetRevision
  });
  const targetHandle = String(relay?.targetHandle || "");
  if (!RELAY_TARGET_HANDLE_PATTERN.test(targetHandle)
    || relay?.status !== "active"
    || Number(relay?.deviceGeneration) !== device.generation
    || Number(relay?.targetRevision) !== device.targetRevision) {
    throw new RelayClientError("Push relay returned an invalid target response", "RELAY_RESPONSE_INVALID", {
      status: 502
    });
  }

  const nowIso = new Date().toISOString();
  const saved = await env.DB.prepare(
    `UPDATE call_note_devices
     SET relay_target_handle = ?, relay_target_generation = ?, relay_target_revision = ?,
       relay_target_state = 'active', relay_synced_at = ?, updated_at = ?
     WHERE id = ? AND status = 'active' AND generation = ? AND target_revision = ?`
  ).bind(
    targetHandle,
    device.generation,
    device.targetRevision,
    nowIso,
    nowIso,
    device.id,
    device.generation,
    device.targetRevision
  ).run();
  if (Number(saved.meta?.changes || 0) !== 1) {
    throw new NotificationApiError(
      "Device registration changed concurrently; retry registration",
      409,
      "REGISTRATION_CONFLICT"
    );
  }
  return {
    changed: device.relayTargetHandle !== targetHandle
      || device.relayTargetState !== "active"
      || Number(device.relayTargetGeneration || 0) !== device.generation
      || Number(device.relayTargetRevision || 0) !== device.targetRevision,
    syncedAt: nowIso
  };
}

async function disconnectRelayDeviceIfPresent(env, device) {
  const targetHandle = String(device?.relayTargetHandle || "");
  if (!targetHandle) return { pending: false, errorCode: "" };
  if (!RELAY_TARGET_HANDLE_PATTERN.test(targetHandle)) {
    return { pending: true, errorCode: "RELAY_TARGET_INVALID" };
  }
  const configuration = inspectRelayClientConfiguration(env);
  if (!configuration.ready) {
    return { pending: true, errorCode: configuration.errorCode || "RELAY_CONFIGURATION_ERROR" };
  }
  try {
    const identity = await readStoredSiteIdentity(env);
    await revokeRelayTarget({ env, siteId: identity.siteId, targetHandle });
    return { pending: false, errorCode: "" };
  } catch (error) {
    const errorCode = cleanText(error?.code || "RELAY_REVOKE_FAILED", 100);
    console.warn(JSON.stringify({
      event: "call_note_notification_api.relay_revoke_deferred",
      deviceId: device?.id || "",
      errorCode
    }));
    return { pending: true, errorCode };
  }
}

async function disconnectOwnDevice(request, env, deviceId) {
  assertUuid(deviceId, "deviceId");
  const secret = requireNotificationSecret(env);
  const device = await authenticateDevice(request, env, secret, deviceId, {
    allowPending: true,
    allowUnregistered: true,
    allowRevoked: true
  });
  const nowIso = new Date().toISOString();
  if (device.status === "revoked") {
    return notificationJson({
      deviceId,
      disconnected: true,
      alreadyDisconnected: true,
      serverTime: nowIso
    });
  }
  await revokeDevice(env, deviceId, "device_disconnect", nowIso);
  const relayCleanup = await disconnectRelayDeviceIfPresent(env, device);
  await auditNotificationEvent(env, `device:${deviceId}`, "notification.device.disconnect", "notification_device", deviceId, {
    disconnected: true,
    disconnectedAt: nowIso,
    relayCleanupPending: relayCleanup.pending,
    relayCleanupErrorCode: relayCleanup.errorCode
  });
  return notificationJson({
    deviceId,
    disconnected: true,
    relayCleanupPending: relayCleanup.pending,
    serverTime: nowIso
  });
}

async function disconnectAdminDevice(request, env, deviceId) {
  assertUuid(deviceId, "deviceId");
  const device = await getDevice(env, deviceId);
  if (!device) throw new NotificationApiError("Device not found", 404, "DEVICE_NOT_FOUND");
  const nowIso = new Date().toISOString();
  let relayCleanup = { pending: false, errorCode: "" };
  if (device.status !== "revoked") {
    await revokeDevice(env, deviceId, "admin_disconnect", nowIso);
    relayCleanup = await disconnectRelayDeviceIfPresent(env, device);
  }
  await auditNotificationEvent(env, "admin", "notification.device.admin_disconnect", "notification_device", deviceId, {
    disconnected: true,
    disconnectedAt: nowIso,
    relayCleanupPending: relayCleanup.pending,
    relayCleanupErrorCode: relayCleanup.errorCode
  });
  return notificationJson({
    deviceId,
    disconnected: true,
    relayCleanupPending: relayCleanup.pending,
    serverTime: nowIso
  });
}

async function queueTestNotification(request, env, deviceId) {
  assertUuid(deviceId, "deviceId");
  const device = await getDevice(env, deviceId);
  if (!device || device.status !== "active") {
    throw new NotificationApiError("An active device is required", 409, "ACTIVE_DEVICE_REQUIRED");
  }
  if (pushTransport(env) === "relay" && !isRelayTargetReady(device)) {
    throw new NotificationApiError(
      "The active device has not completed relay synchronization",
      409,
      "RELAY_TARGET_NOT_SYNCED"
    );
  }
  const dispatcher = parseDispatcherStatus(await readSetting(env, DISPATCHER_STATUS_KEY));
  const lastRunMs = Date.parse(dispatcher.lastRunAt || "");
  const schedulerReady = Number.isFinite(lastRunMs) && lastRunMs >= Date.now() - DISPATCHER_FRESH_MS;
  const dispatcherHealthy = !["configuration_error", "error"].includes(dispatcher.status);
  const configuredTransport = pushTransport(env);
  const transportReady = dispatcher.pushTransport === configuredTransport
    && (configuredTransport === "relay"
      ? Boolean(dispatcher.relayConfigured)
      : Boolean(dispatcher.fcmConfigured) && Boolean(dispatcher.notificationSecretConfigured));
  if (!schedulerReady || !transportReady || !dispatcher.senderEnabled || !dispatcherHealthy) {
    throw new NotificationApiError("Push sender is not ready", 409, "PUSH_SENDER_NOT_READY");
  }

  const notificationId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO call_note_push_deliveries
      (notification_id, dedupe_key, kind, reminder_id, note_id, device_id, device_generation,
       scheduled_at, send_state, attempt_count, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, 'connection_test', '', '', ?, ?, ?, 'pending', 0, ?, ?, ?)`
  ).bind(
    notificationId, `test:${notificationId}`, device.id, device.generation,
    nowIso, nowIso, nowIso, nowIso
  ).run();
  await auditNotificationEvent(env, "admin", "notification.test.queue", "push_delivery", notificationId, {
    deviceId: device.id,
    queuedAt: nowIso
  });
  return notificationJson({ notificationId, state: "queued", queuedAt: nowIso }, 202);
}

async function authenticateDevice(request, env, secret, deviceId, options = {}) {
  assertUuid(deviceId, "deviceId");
  const credential = bearerCredential(request);
  const candidateHmac = await deviceCredentialHmac(secret, deviceId, credential);
  const device = await getDevice(env, deviceId);
  const credentialMatches = isDeviceCredentialShape(credential)
    && constantTimeStringEqual(candidateHmac, device?.credentialHmac || "invalid-device-credential-hmac-value");
  if (!device || !credentialMatches) {
    throw new NotificationApiError("Device authentication failed", 401, "DEVICE_AUTH_INVALID");
  }
  if (device.status === "pending" && device.pendingExpiresAt && Date.parse(device.pendingExpiresAt) <= Date.now()) {
    await revokeDevice(env, device.id, "pairing_expired", new Date().toISOString());
    throw new NotificationApiError("Device connection expired", 410, "DEVICE_PAIRING_EXPIRED");
  }
  if (device.status === "revoked" && !options.allowRevoked) {
    throw new NotificationApiError("Device was disconnected", 410, "DEVICE_REVOKED");
  }
  if (device.status === "pending" && options.allowPending === false) {
    throw new NotificationApiError("Device registration is incomplete", 409, "DEVICE_REGISTRATION_REQUIRED");
  }
  if (device.status === "unregistered" && !options.allowUnregistered) {
    throw new NotificationApiError("Device registration target is unavailable", 410, "DEVICE_TARGET_UNREGISTERED");
  }
  return device;
}

async function authenticateAnyCurrentDevice(request, env, secret) {
  const credential = bearerCredential(request);
  const rows = await env.DB.prepare(
    `SELECT id FROM call_note_devices
     WHERE status IN ('pending', 'active', 'unregistered')
     ORDER BY generation DESC, updated_at DESC
     LIMIT 4`
  ).all();
  let matchedDevice = null;
  for (const row of rows.results || []) {
    const device = await getDevice(env, String(row.id || ""));
    const candidateHmac = await deviceCredentialHmac(secret, String(row.id || ""), credential);
    const matches = isDeviceCredentialShape(credential)
      && constantTimeStringEqual(candidateHmac, device?.credentialHmac || "invalid-device-credential-hmac-value");
    if (matches) matchedDevice = device;
  }
  if (!matchedDevice) {
    throw new NotificationApiError("Device authentication failed", 401, "DEVICE_AUTH_INVALID");
  }
  if (matchedDevice.status === "pending" && matchedDevice.pendingExpiresAt
    && Date.parse(matchedDevice.pendingExpiresAt) <= Date.now()) {
    await revokeDevice(env, matchedDevice.id, "pairing_expired", new Date().toISOString());
    throw new NotificationApiError("Device connection expired", 410, "DEVICE_PAIRING_EXPIRED");
  }
  return matchedDevice;
}

async function getDevice(env, deviceId) {
  const row = await env.DB.prepare(
    `SELECT id, status, generation, credential_hmac AS credentialHmac,
      target_kind AS targetKind, target_ciphertext AS targetCiphertext,
      target_fingerprint AS targetFingerprint, target_revision AS targetRevision,
      relay_target_handle AS relayTargetHandle,
      relay_target_generation AS relayTargetGeneration,
      relay_target_revision AS relayTargetRevision,
      relay_target_state AS relayTargetState, relay_synced_at AS relaySyncedAt,
      registration_version AS registrationVersion, registration_client_at AS registrationClientAt,
      device_name AS deviceName, app_version AS appVersion,
      notification_permission AS notificationPermission, notifications_enabled AS notificationsEnabled,
      pair_code_id AS pairCodeId, paired_at AS pairedAt, pending_expires_at AS pendingExpiresAt,
      activated_at AS activatedAt, last_registered_at AS lastRegisteredAt,
      last_seen_at AS lastSeenAt, revoked_at AS revokedAt, updated_at AS updatedAt
     FROM call_note_devices
     WHERE id = ?`
  ).bind(deviceId).first();
  if (!row) return null;
  return {
    ...row,
    generation: Number(row.generation || 0),
    targetRevision: Number(row.targetRevision || 1),
    registrationVersion: Number(row.registrationVersion || 0),
    notificationsEnabled: Boolean(Number(row.notificationsEnabled || 0))
  };
}

async function getDelivery(env, notificationId) {
  return env.DB.prepare(
    `SELECT notification_id AS notificationId, send_state AS sendState,
      received_at AS receivedAt, displayed_at AS displayedAt, opened_at AS openedAt
     FROM call_note_push_deliveries WHERE notification_id = ?`
  ).bind(notificationId).first();
}

async function revokeDevice(env, deviceId, reason, nowIso) {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE call_note_devices
       SET status = 'revoked', pending_expires_at = '', target_ciphertext = '', target_fingerprint = '',
         target_revision = target_revision + 1,
         relay_target_state = CASE WHEN relay_target_handle = '' THEN 'none' ELSE 'revoked' END,
         revoked_at = CASE WHEN revoked_at = '' THEN ? ELSE revoked_at END,
         revoke_reason = CASE WHEN revoke_reason = '' THEN ? ELSE revoke_reason END, updated_at = ?
       WHERE id = ? AND status <> 'revoked'`
    ).bind(nowIso, cleanText(reason, 80), nowIso, deviceId),
    env.DB.prepare(
      `UPDATE call_note_push_deliveries
       SET send_state = 'cancelled', last_error_code = 'DEVICE_DISCONNECTED', failed_at = ?, updated_at = ?
       WHERE device_id = ? AND kind = 'connection_test' AND send_state NOT IN ('accepted', 'cancelled', 'dead')`
    ).bind(nowIso, nowIso, deviceId),
    env.DB.prepare(
      `UPDATE call_note_push_deliveries
       SET device_id = NULL, device_generation = 0, send_state = 'waiting_target',
         next_attempt_at = ?, lease_token = '', lease_expires_at = '', last_error_code = 'WAITING_FOR_DEVICE', updated_at = ?
       WHERE device_id = ? AND kind IN ('memo_reminder', 'visit_alarm')
         AND send_state NOT IN ('accepted', 'cancelled', 'dead')`
    ).bind(nowIso, nowIso, deviceId)
  ]);
}

async function cleanupNotificationState(env, now) {
  const nowIso = now.toISOString();
  const attemptCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const pairCodeCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE call_note_devices
       SET status = 'revoked', pending_expires_at = '', target_ciphertext = '', target_fingerprint = '',
         target_revision = target_revision + 1,
         relay_target_state = CASE WHEN relay_target_handle = '' THEN 'none' ELSE 'revoked' END,
         revoked_at = ?, revoke_reason = 'pairing_expired', updated_at = ?
       WHERE status = 'pending' AND pending_expires_at <= ?`
    ).bind(nowIso, nowIso, nowIso),
    env.DB.prepare(
      `UPDATE call_note_pair_codes
       SET invalidated_at = ?
       WHERE used_at = '' AND invalidated_at = '' AND expires_at <= ?`
    ).bind(nowIso, nowIso),
    env.DB.prepare("DELETE FROM call_note_pair_attempts WHERE updated_at < ?").bind(attemptCutoff),
    env.DB.prepare(
      "DELETE FROM call_note_pair_codes WHERE created_at < ? AND (used_at <> '' OR invalidated_at <> '')"
    ).bind(pairCodeCutoff)
  ]);
}

async function ensurePairActorNotLocked(env, actorHmac, now) {
  const row = await env.DB.prepare(
    "SELECT locked_until AS lockedUntil FROM call_note_pair_attempts WHERE actor_hmac = ?"
  ).bind(actorHmac).first();
  const lockedUntil = Date.parse(row?.lockedUntil || "");
  if (Number.isFinite(lockedUntil) && lockedUntil > now.getTime()) {
    const retryAfter = Math.max(1, Math.ceil((lockedUntil - now.getTime()) / 1000));
    throw new NotificationApiError(
      "Pairing is temporarily locked. Try again later.",
      429,
      "PAIRING_RATE_LIMITED",
      { "Retry-After": String(retryAfter) }
    );
  }
}

async function recordPairFailure(env, actorHmac, now) {
  const nowIso = now.toISOString();
  const windowCutoff = new Date(now.getTime() - PAIR_FAILURE_WINDOW_MS).toISOString();
  const lockedUntil = new Date(now.getTime() + PAIR_FAILURE_LOCK_MS).toISOString();
  await env.DB.prepare(
    `INSERT INTO call_note_pair_attempts
      (actor_hmac, failures, window_started_at, locked_until, updated_at)
     VALUES (?, 1, ?, '', ?)
     ON CONFLICT(actor_hmac) DO UPDATE SET
       failures = CASE
         WHEN call_note_pair_attempts.window_started_at <= ? THEN 1
         ELSE call_note_pair_attempts.failures + 1
       END,
       window_started_at = CASE
         WHEN call_note_pair_attempts.window_started_at <= ? THEN excluded.window_started_at
         ELSE call_note_pair_attempts.window_started_at
       END,
       locked_until = CASE
         WHEN (CASE
           WHEN call_note_pair_attempts.window_started_at <= ? THEN 1
           ELSE call_note_pair_attempts.failures + 1
         END) >= ? THEN ?
         ELSE call_note_pair_attempts.locked_until
       END,
       updated_at = excluded.updated_at`
  ).bind(
    actorHmac, nowIso, nowIso,
    windowCutoff, windowCutoff, windowCutoff, PAIR_FAILURE_LIMIT, lockedUntil
  ).run();
}

async function pairRequestActor(request) {
  const forwarded = request.headers.get("CF-Connecting-IP")
    || request.headers.get("X-Forwarded-For")?.split(",")[0]
    || "";
  if (forwarded.trim()) return forwarded.trim();
  const url = new URL(request.url);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return "local-development";
  throw new NotificationApiError("Client identity is unavailable", 503, "PAIRING_PROTECTION_UNAVAILABLE");
}

function normalizeTarget(body) {
  let kind = "";
  let value = "";
  if (body.target !== undefined) {
    if (!body.target || typeof body.target !== "object" || Array.isArray(body.target)) {
      throw new NotificationApiError("target must be an object", 400, "DEVICE_TARGET_INVALID");
    }
    const keys = Object.keys(body.target);
    if (keys.some((key) => !["kind", "value"].includes(key))) {
      throw new NotificationApiError("target contains unsupported fields", 400, "DEVICE_TARGET_INVALID");
    }
    kind = String(body.target.kind || "");
    value = String(body.target.value || "");
  } else {
    const fid = String(body.fid || body.installationId || "");
    const token = String(body.fcmToken || body.registrationToken || "");
    if (fid) {
      kind = "fid";
      value = fid;
    } else if (token) {
      kind = "registration_token";
      value = token;
    }
  }
  if (kind === "registrationToken" || kind === "token") kind = "registration_token";
  if (kind !== "fid" && kind !== "registration_token") {
    throw new NotificationApiError("A Firebase installation id or registration token is required", 400, "DEVICE_TARGET_REQUIRED");
  }
  const maxLength = kind === "fid" ? 512 : 4096;
  if (value.length < 10 || value.length > maxLength || /[\s\u0000-\u001f\u007f]/u.test(value)) {
    throw new NotificationApiError("Firebase registration target is invalid", 400, "DEVICE_TARGET_INVALID");
  }
  return { kind, value };
}

function normalizeDeviceMetadata(body, previous = {}) {
  const deviceName = body.deviceName === undefined
    ? cleanText(previous.deviceName || "심방콜노트 Android", 40)
    : cleanText(body.deviceName, 40);
  const appVersion = body.appVersion === undefined
    ? cleanText(previous.appVersion, 40)
    : cleanText(body.appVersion, 40);
  const notificationPermission = body.notificationPermission === undefined
    ? (PERMISSION_STATES.has(previous.notificationPermission) ? previous.notificationPermission : "unknown")
    : String(body.notificationPermission || "unknown");
  if (!PERMISSION_STATES.has(notificationPermission)) {
    throw new NotificationApiError("notificationPermission is invalid", 400, "NOTIFICATION_PERMISSION_INVALID");
  }
  let notificationsEnabled = previous.notificationsEnabled === true;
  if (body.notificationsEnabled !== undefined) {
    if (typeof body.notificationsEnabled !== "boolean") {
      throw new NotificationApiError("notificationsEnabled must be a boolean", 400, "NOTIFICATIONS_ENABLED_INVALID");
    }
    notificationsEnabled = body.notificationsEnabled;
  }
  return {
    deviceName: deviceName || "심방콜노트 Android",
    appVersion,
    notificationPermission,
    notificationsEnabled
  };
}

function normalizeRegistrationVersion(value) {
  if (typeof value !== "number" || !Number.isInteger(value)
    || value < 1 || value > 2147483647) {
    throw new NotificationApiError(
      "registrationVersion must be an integer from 1 to 2147483647",
      400,
      "REGISTRATION_VERSION_INVALID"
    );
  }
  return value;
}

async function readBoundedJson(request, allowedFields) {
  const contentType = String(request.headers.get("Content-Type") || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new NotificationApiError("Content-Type must be application/json", 415, "CONTENT_TYPE_INVALID");
  }
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(contentLength) && contentLength > REQUEST_MAX_BYTES) {
    throw new NotificationApiError("Request body is too large", 413, "REQUEST_TOO_LARGE");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new NotificationApiError("JSON request body is required", 400, "JSON_REQUIRED");
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > REQUEST_MAX_BYTES) {
      await reader.cancel();
      throw new NotificationApiError("Request body is too large", 413, "REQUEST_TOO_LARGE");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new NotificationApiError("Request body is not valid JSON", 400, "JSON_INVALID");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new NotificationApiError("JSON body must be an object", 400, "JSON_INVALID");
  }
  const unsupported = Object.keys(body).filter((key) => !allowedFields.includes(key));
  if (unsupported.length) {
    throw new NotificationApiError("Request contains unsupported fields", 400, "REQUEST_FIELDS_INVALID");
  }
  return body;
}

function publicDevice(row) {
  return {
    deviceId: String(row.deviceId || ""),
    status: DEVICE_STATUSES.has(row.status) ? row.status : "revoked",
    generation: Number(row.generation || 0),
    deviceName: cleanText(row.deviceName, 40),
    appVersion: cleanText(row.appVersion, 40),
    registrationMode: row.registrationMode === "fid" ? "fid" : "registration_token",
    relayTargetState: ["none", "active", "unregistered", "revoked"].includes(row.relayTargetState)
      ? row.relayTargetState
      : "none",
    relayTargetReady: isRelayTargetReady(row),
    notificationPermission: PERMISSION_STATES.has(row.notificationPermission) ? row.notificationPermission : "unknown",
    notificationsEnabled: Boolean(Number(row.notificationsEnabled || 0)),
    pairedAt: normalizeStoredDate(row.pairedAt),
    pendingExpiresAt: normalizeStoredDate(row.pendingExpiresAt),
    activatedAt: normalizeStoredDate(row.activatedAt),
    lastRegisteredAt: normalizeStoredDate(row.lastRegisteredAt),
    lastSeenAt: normalizeStoredDate(row.lastSeenAt),
    updatedAt: normalizeStoredDate(row.updatedAt)
  };
}

function publicDelivery(row) {
  return {
    notificationId: String(row.notificationId || ""),
    deviceId: String(row.deviceId || ""),
    kind: DELIVERY_KINDS.has(row.kind) ? row.kind : "unknown",
    sendState: cleanText(row.sendState, 40),
    ackState: highestAckState(row),
    attemptCount: Number(row.attemptCount || 0),
    scheduledAt: normalizeStoredDate(row.scheduledAt),
    acceptedAt: normalizeStoredDate(row.acceptedAt),
    receivedAt: normalizeStoredDate(row.receivedAt),
    displayedAt: normalizeStoredDate(row.displayedAt),
    openedAt: normalizeStoredDate(row.openedAt),
    failedAt: normalizeStoredDate(row.failedAt),
    errorCode: cleanText(row.errorCode, 80),
    createdAt: normalizeStoredDate(row.createdAt),
    updatedAt: normalizeStoredDate(row.updatedAt)
  };
}

function highestAckState(delivery) {
  if (delivery?.openedAt) return "opened";
  if (delivery?.displayedAt) return "displayed";
  if (delivery?.receivedAt) return "received";
  return "";
}

function parseDispatcherStatus(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function readSetting(env, key) {
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(key).first();
  return typeof row?.value === "string" ? row.value : "";
}

async function auditNotificationEvent(env, actor, action, entityType, entityId, after) {
  await env.DB.prepare(
    `INSERT INTO audit_logs
      (id, actor, action, entity_type, entity_id, before_json, after_json)
     VALUES (?, ?, ?, ?, ?, '', ?)`
  ).bind(
    crypto.randomUUID(), cleanText(actor, 120), cleanText(action, 120),
    cleanText(entityType, 80), cleanText(entityId, 128), JSON.stringify(after || {})
  ).run();
}

function normalizeClientDate(value) {
  if (value === undefined || value === null || value === "") return new Date().toISOString();
  const text = String(value || "");
  const timestamp = Date.parse(text);
  const now = Date.now();
  if (!Number.isFinite(timestamp) || timestamp > now + 5 * 60 * 1000 || timestamp < now - 30 * 24 * 60 * 60 * 1000) {
    throw new NotificationApiError("occurredAt is invalid", 400, "OCCURRED_AT_INVALID");
  }
  return new Date(timestamp).toISOString();
}

function normalizeStoredDate(value) {
  const text = String(value || "");
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function cleanText(value, maxLength) {
  return Array.from(String(value || "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim()
    .replace(/\s+/gu, " "))
    .slice(0, maxLength)
    .join("");
}

function bearerCredential(request) {
  const header = String(request.headers.get("Authorization") || "");
  return /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, "").trim() : "";
}

function assertUuid(value, field) {
  if (!UUID_PATTERN.test(String(value || ""))) {
    throw new NotificationApiError(`${field} is invalid`, 400, "IDENTIFIER_INVALID");
  }
}

function requireAdmin(viewerRole) {
  if (viewerRole !== ADMIN_ROLE) {
    throw new NotificationApiError("Administrator access is required", 403, "ADMIN_REQUIRED");
  }
}

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function isRelayTargetReady(device) {
  return device?.relayTargetState === "active"
    && Number(device?.generation || 0) > 0
    && Number(device?.targetRevision || 0) > 0
    && Number(device?.relayTargetGeneration || 0) === Number(device?.generation || 0)
    && Number(device?.relayTargetRevision || 0) === Number(device?.targetRevision || 0);
}

function pushTransport(env) {
  const value = String(env?.PUSH_TRANSPORT || "direct").toLowerCase();
  if (value === "direct" || value === "relay") return value;
  throw new RelayClientError("Push transport setting is invalid", "PUSH_TRANSPORT_INVALID", { status: 503 });
}

function isConstraintError(error) {
  return /constraint|unique/i.test(String(error?.message || error || ""));
}

function errorPayload(error) {
  const payload = { error: error.message || "Request failed" };
  if (error.code) payload.code = error.code;
  return payload;
}

function methodNotAllowed(allowed) {
  return notificationJson(
    { error: "Method not allowed", code: "METHOD_NOT_ALLOWED" },
    405,
    { Allow: allowed.join(", ") }
  );
}

function notificationJson(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...responseHeaders, ...extraHeaders }
  });
}

class NotificationApiError extends Error {
  constructor(message, status, code = "", headers = {}) {
    super(message);
    this.name = "NotificationApiError";
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}
