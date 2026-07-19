import {
  createDeviceCredential,
  deviceCredentialHmac,
  encryptDeviceTarget,
  requireNotificationSecret,
  targetFingerprint
} from "./notification-crypto.js";
import { normalizeTrustedViewer, ownerViewer, viewerAuditActor } from "./community-access.js";

const ADMIN_ROLE = "admin";
const DISPATCHER_STATUS_KEY = "notification.dispatcherStatus";
const REQUEST_MAX_BYTES = 16 * 1024;
const DISPATCHER_FRESH_MS = 10 * 60 * 1000;
const TARGET_KIND = "registration_token";
const WEB_PUSH_TRANSPORT = "webpush";
const PLATFORM_VALUES = new Set(["android", "ios", "windows", "macos", "linux", "other"]);
const PUSH_HOSTS = new Set([
  "fcm.googleapis.com",
  "web.push.apple.com",
  "push.services.mozilla.com",
  "updates.push.services.mozilla.com"
]);

const responseHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff"
};

export async function handleWebPushNotificationApi({ request, env, path, viewerRole, viewer }) {
  try {
    const principal = normalizeTrustedViewer(viewer) || (viewerRole === ADMIN_ROLE ? ownerViewer() : null);
    if (!principal) throw new WebPushApiError("Login is required", 403, "LOGIN_REQUIRED");
    if (!env.DB) throw new WebPushApiError("D1 binding DB is not configured", 503, "DATABASE_UNAVAILABLE");
    if (path[0] !== "notifications" || path[1] !== "web-push") return webPushJson({ error: "Not found" }, 404);

    if (path.length === 2 && request.method === "GET") {
      return webPushJson(await readWebPushStatus(env, principal));
    }
    if (path.length === 3 && path[2] === "subscription" && request.method === "POST") {
      return webPushJson(await registerWebPushSubscription(request, env, principal), 201);
    }
    if (path.length === 3 && path[2] === "subscription" && request.method === "DELETE") {
      return webPushJson(await revokeWebPushSubscription(request, env, principal));
    }
    if (path.length === 3 && path[2] === "test" && request.method === "POST") {
      return webPushJson(await queueWebPushTest(env, principal), 202);
    }
    return webPushJson({ error: "Method not allowed" }, 405, { Allow: "GET, POST, DELETE" });
  } catch (error) {
    if (error instanceof WebPushApiError) {
      return webPushJson({ error: error.message, code: error.code }, error.status);
    }
    console.error(JSON.stringify({
      event: "web_push_api.failed",
      error: error instanceof Error ? error.name : "UnknownError"
    }));
    return webPushJson({ error: "Web Push request failed", code: "INTERNAL_ERROR" }, 500);
  }
}

export async function readWebPushStatus(env, viewer = ownerViewer()) {
  const publicKey = normalizeVapidPublicKey(env.VAPID_PUBLIC_KEY);
  const [device, latestTest, dispatcherRaw] = await Promise.all([
    env.DB.prepare(
      `SELECT id AS deviceId, generation, device_name AS deviceName,
        notification_permission AS notificationPermission,
        paired_at AS pairedAt, last_seen_at AS lastSeenAt, updated_at AS updatedAt
       FROM call_note_devices
       WHERE status = 'active' AND transport = 'webpush' AND user_id = ?
       ORDER BY generation DESC
       LIMIT 1`
    ).bind(viewer.id).first(),
    env.DB.prepare(
      `SELECT notification_id AS notificationId, send_state AS sendState,
        last_error_code AS errorCode, scheduled_at AS scheduledAt,
        accepted_at AS acceptedAt, failed_at AS failedAt, updated_at AS updatedAt
       FROM call_note_push_deliveries
       WHERE kind = 'connection_test' AND target_user_id = ?
       ORDER BY created_at DESC
       LIMIT 1`
    ).bind(viewer.id).first(),
    readSetting(env, DISPATCHER_STATUS_KEY)
  ]);
  const dispatcher = parseObject(dispatcherRaw);
  const lastRunAt = normalizeDate(dispatcher.lastRunAt);
  const workerFresh = Boolean(lastRunAt)
    && Date.parse(lastRunAt) >= Date.now() - DISPATCHER_FRESH_MS;
  const workerConfigured = dispatcher.pushTransport === WEB_PUSH_TRANSPORT
    && Boolean(dispatcher.webPushConfigured);
  const senderEnabled = Boolean(dispatcher.senderEnabled);

  return {
    configured: Boolean(publicKey),
    publicKey,
    active: Boolean(device),
    ready: Boolean(publicKey && device && workerFresh && workerConfigured && senderEnabled),
    workerFresh,
    workerConfigured,
    senderEnabled,
    device: device ? publicDevice(device) : null,
    latestTest: latestTest ? publicTestDelivery(latestTest) : null,
    serverTime: new Date().toISOString()
  };
}

async function registerWebPushSubscription(request, env, viewer) {
  normalizeVapidPublicKey(env.VAPID_PUBLIC_KEY, true);
  const secret = requireNotificationSecret(env);
  const body = await readBoundedJson(request);
  const subscription = normalizeSubscription(body.subscription);
  const canonical = JSON.stringify(subscription);
  const fingerprint = await targetFingerprint(secret, TARGET_KIND, canonical);
  const nowIso = new Date().toISOString();
  const metadata = normalizeDeviceMetadata(body);

  const existing = await env.DB.prepare(
    `SELECT id AS deviceId, generation
     FROM call_note_devices
     WHERE status = 'active' AND transport = 'webpush' AND target_fingerprint = ? AND user_id = ?
     LIMIT 1`
  ).bind(fingerprint, viewer.id).first();
  if (existing) {
    await env.DB.prepare(
      `UPDATE call_note_devices
       SET device_name = ?, notification_permission = 'granted', notifications_enabled = 1,
         last_registered_at = ?, last_seen_at = ?, updated_at = ?
       WHERE id = ? AND status = 'active' AND transport = 'webpush'`
    ).bind(metadata.deviceName, nowIso, nowIso, nowIso, existing.deviceId).run();
    await audit(env, viewerAuditActor(viewer), "notification.webpush.refresh", existing.deviceId, {
      deviceName: metadata.deviceName,
      platform: metadata.platform
    });
    return readWebPushStatus(env, viewer);
  }

  const generationRow = await env.DB.prepare(
    "SELECT COALESCE(MAX(generation), 0) AS generation FROM call_note_devices"
  ).first();
  const generation = Number(generationRow?.generation || 0) + 1;
  const deviceId = crypto.randomUUID();
  const credential = createDeviceCredential();
  const credentialHmac = await deviceCredentialHmac(secret, deviceId, credential);
  const ciphertext = await encryptDeviceTarget(secret, deviceId, TARGET_KIND, canonical);
  const pairCodeId = `webpush:${deviceId}`;
  const auditId = crypto.randomUUID();

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE call_note_devices
       SET status = 'revoked', pending_expires_at = '', target_ciphertext = '',
         target_fingerprint = '', target_revision = target_revision + 1,
         relay_target_state = CASE WHEN relay_target_handle = '' THEN 'none' ELSE 'revoked' END,
         revoked_at = ?, revoke_reason = 'web_push_replaced', updated_at = ?
       WHERE status IN ('active', 'pending') AND user_id = ?`
    ).bind(nowIso, nowIso, viewer.id),
    env.DB.prepare(
      `UPDATE call_note_push_deliveries
       SET send_state = 'cancelled', lease_token = '', lease_expires_at = '',
         last_error_code = 'TEST_DEVICE_REPLACED', failed_at = ?, updated_at = ?
       WHERE kind = 'connection_test' AND target_user_id = ?
         AND send_state NOT IN ('accepted', 'cancelled', 'dead')`
    ).bind(nowIso, nowIso, viewer.id),
    env.DB.prepare(
      `INSERT INTO call_note_devices (
        id, status, generation, credential_hmac, target_kind, target_ciphertext,
        target_fingerprint, target_revision, registration_version, registration_client_at,
        crypto_version, device_name, app_version, notification_permission,
        notifications_enabled, pair_code_id, paired_at, pending_expires_at, activated_at,
        last_registered_at, last_seen_at, revoked_at, revoke_reason, updated_at, transport, user_id
       ) VALUES (
        ?, 'active', ?, ?, ?, ?, ?, 1, 1, ?, 1, ?, 'pwa-web-push/1', 'granted',
        1, ?, ?, '', ?, ?, ?, '', '', ?, 'webpush', ?
       )`
    ).bind(
      deviceId, generation, credentialHmac, TARGET_KIND, ciphertext, fingerprint,
      nowIso, metadata.deviceName, pairCodeId, nowIso, nowIso, nowIso, nowIso, nowIso, viewer.id
    ),
    env.DB.prepare(
      `UPDATE call_note_push_deliveries
       SET send_state = 'retry_wait', next_attempt_at = ?, last_error_code = '', updated_at = ?
       WHERE kind <> 'connection_test' AND target_user_id = ?
         AND send_state IN ('waiting_target', 'blocked_config')
         AND accepted_at = ''`
    ).bind(nowIso, nowIso, viewer.id),
    env.DB.prepare(
      `INSERT INTO audit_logs
        (id, actor, action, entity_type, entity_id, before_json, after_json)
       VALUES (?, ?, 'notification.webpush.register', 'notification_device', ?, '', ?)`
    ).bind(auditId, viewerAuditActor(viewer), deviceId, JSON.stringify({
      deviceName: metadata.deviceName,
      platform: metadata.platform,
      generation,
      transport: WEB_PUSH_TRANSPORT
    }))
  ]);

  return readWebPushStatus(env, viewer);
}

async function revokeWebPushSubscription(request, env, viewer) {
  const secret = requireNotificationSecret(env);
  const body = await readBoundedJson(request);
  const subscription = normalizeSubscription(body.subscription);
  const canonical = JSON.stringify(subscription);
  const fingerprint = await targetFingerprint(secret, TARGET_KIND, canonical);
  const device = await env.DB.prepare(
    `SELECT id AS deviceId
     FROM call_note_devices
     WHERE status = 'active' AND transport = 'webpush' AND target_fingerprint = ? AND user_id = ?
     LIMIT 1`
  ).bind(fingerprint, viewer.id).first();
  if (!device) return { removed: false, ...(await readWebPushStatus(env, viewer)) };

  const nowIso = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE call_note_devices
       SET status = 'revoked', target_ciphertext = '', target_fingerprint = '',
         target_revision = target_revision + 1, notifications_enabled = 0,
         revoked_at = ?, revoke_reason = 'web_push_unsubscribed', updated_at = ?
       WHERE id = ? AND status = 'active' AND transport = 'webpush' AND target_fingerprint = ?`
    ).bind(nowIso, nowIso, device.deviceId, fingerprint),
    env.DB.prepare(
      `UPDATE call_note_push_deliveries
       SET send_state = 'cancelled', lease_token = '', lease_expires_at = '',
         last_error_code = 'TEST_DEVICE_UNAVAILABLE', failed_at = ?, updated_at = ?
       WHERE device_id = ? AND kind = 'connection_test'
         AND send_state NOT IN ('accepted', 'cancelled', 'dead')`
    ).bind(nowIso, nowIso, device.deviceId),
    env.DB.prepare(
      `INSERT INTO audit_logs
        (id, actor, action, entity_type, entity_id, before_json, after_json)
       VALUES (?, ?, 'notification.webpush.revoke', 'notification_device', ?, '', ?)`
    ).bind(crypto.randomUUID(), viewerAuditActor(viewer), device.deviceId, JSON.stringify({ revokedAt: nowIso }))
  ]);

  return { removed: true, ...(await readWebPushStatus(env, viewer)) };
}

async function queueWebPushTest(env, viewer = ownerViewer()) {
  const status = await readWebPushStatus(env, viewer);
  if (!status.configured) throw new WebPushApiError("Web Push key is not configured", 503, "VAPID_NOT_CONFIGURED");
  if (!status.active || !status.device) throw new WebPushApiError("This site has no registered notification device", 409, "WEB_PUSH_DEVICE_MISSING");
  if (!status.workerFresh || !status.workerConfigured || !status.senderEnabled) {
    throw new WebPushApiError("Notification sender is not ready", 503, "WEB_PUSH_SENDER_NOT_READY");
  }

  const nowIso = new Date().toISOString();
  const notificationId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO call_note_push_deliveries
        (notification_id, dedupe_key, kind, reminder_id, note_id, visit_id,
         device_id, device_generation, scheduled_at, send_state, attempt_count,
         next_attempt_at, created_at, updated_at, target_user_id)
       VALUES (?, ?, 'connection_test', '', '', '', ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`
    ).bind(
      notificationId, `webpush-test:${notificationId}`, status.device.deviceId,
      status.device.generation, nowIso, nowIso, nowIso, nowIso, viewer.id
    ),
    env.DB.prepare(
      `INSERT INTO audit_logs
        (id, actor, action, entity_type, entity_id, before_json, after_json)
       VALUES (?, ?, 'notification.webpush.test', 'push_delivery', ?, '', ?)`
    ).bind(crypto.randomUUID(), viewerAuditActor(viewer), notificationId, JSON.stringify({ queuedAt: nowIso }))
  ]);
  return { queued: true, notificationId, queuedAt: nowIso };
}

function normalizeSubscription(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WebPushApiError("Push subscription is required", 400, "SUBSCRIPTION_REQUIRED");
  }
  const allowed = new Set(["endpoint", "expirationTime", "keys"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new WebPushApiError("Push subscription contains an unknown field", 400, "SUBSCRIPTION_INVALID");
  }
  const endpoint = String(value.endpoint || "");
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new WebPushApiError("Push endpoint is invalid", 400, "PUSH_ENDPOINT_INVALID");
  }
  if (endpoint.length > 4096 || url.protocol !== "https:" || url.username || url.password
    || !isAllowedPushHost(url.hostname)) {
    throw new WebPushApiError("Push endpoint is not an approved browser push service", 400, "PUSH_ENDPOINT_INVALID");
  }
  const keys = value.keys;
  if (!keys || typeof keys !== "object" || Array.isArray(keys)
    || Object.keys(keys).some((key) => key !== "p256dh" && key !== "auth")) {
    throw new WebPushApiError("Push subscription keys are invalid", 400, "PUSH_KEYS_INVALID");
  }
  const p256dh = String(keys.p256dh || "");
  const auth = String(keys.auth || "");
  const publicKeyBytes = decodeBase64Url(p256dh);
  const authBytes = decodeBase64Url(auth);
  if (publicKeyBytes.length !== 65 || publicKeyBytes[0] !== 4 || authBytes.length !== 16) {
    throw new WebPushApiError("Push subscription keys are invalid", 400, "PUSH_KEYS_INVALID");
  }
  let expirationTime = null;
  if (value.expirationTime !== undefined && value.expirationTime !== null) {
    expirationTime = Number(value.expirationTime);
    if (!Number.isFinite(expirationTime) || expirationTime <= Date.now()) {
      throw new WebPushApiError("Push subscription has expired", 400, "SUBSCRIPTION_EXPIRED");
    }
  }
  return { endpoint: url.toString(), expirationTime, keys: { p256dh, auth } };
}

function normalizeDeviceMetadata(body) {
  const platform = PLATFORM_VALUES.has(body.platform) ? body.platform : "other";
  const fallback = {
    android: "Android 휴대폰",
    ios: "iPhone 또는 iPad",
    windows: "Windows PC",
    macos: "Mac",
    linux: "Linux PC",
    other: "웹 브라우저"
  }[platform];
  const deviceName = cleanText(body.deviceName || fallback, 80);
  if (!deviceName) throw new WebPushApiError("Device name is invalid", 400, "DEVICE_NAME_INVALID");
  return { platform, deviceName };
}

function normalizeVapidPublicKey(value, required = false) {
  const key = String(value || "");
  const bytes = decodeBase64Url(key, false);
  const valid = bytes.length === 65 && bytes[0] === 4;
  if (!valid && required) throw new WebPushApiError("Web Push key is not configured", 503, "VAPID_NOT_CONFIGURED");
  return valid ? key : "";
}

function decodeBase64Url(value, throwOnInvalid = true) {
  try {
    const text = String(value || "");
    if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("invalid base64url");
    const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    if (throwOnInvalid) throw new WebPushApiError("Push subscription keys are invalid", 400, "PUSH_KEYS_INVALID");
    return new Uint8Array();
  }
}

function isAllowedPushHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return PUSH_HOSTS.has(host)
    || host.endsWith(".push.apple.com")
    || host.endsWith(".push.services.mozilla.com")
    || host.endsWith(".notify.windows.com");
}

async function readBoundedJson(request) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > REQUEST_MAX_BYTES) throw new WebPushApiError("Request is too large", 413, "REQUEST_TOO_LARGE");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > REQUEST_MAX_BYTES) {
    throw new WebPushApiError("Request is too large", 413, "REQUEST_TOO_LARGE");
  }
  let body;
  try {
    body = JSON.parse(text || "{}");
  } catch {
    throw new WebPushApiError("Request body must be valid JSON", 400, "JSON_INVALID");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new WebPushApiError("Request body must be an object", 400, "BODY_INVALID");
  }
  const allowed = new Set(["subscription", "deviceName", "platform"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new WebPushApiError("Request contains an unknown field", 400, "BODY_INVALID");
  }
  return body;
}

function publicDevice(row) {
  return {
    deviceId: String(row.deviceId || ""),
    generation: Math.max(0, Number(row.generation || 0)),
    deviceName: cleanText(row.deviceName, 80),
    notificationPermission: row.notificationPermission === "granted" ? "granted" : "unknown",
    pairedAt: normalizeDate(row.pairedAt),
    lastSeenAt: normalizeDate(row.lastSeenAt || row.updatedAt)
  };
}

function publicTestDelivery(row) {
  return {
    notificationId: String(row.notificationId || ""),
    sendState: cleanText(row.sendState, 40),
    errorCode: cleanText(row.errorCode, 100),
    scheduledAt: normalizeDate(row.scheduledAt),
    acceptedAt: normalizeDate(row.acceptedAt),
    failedAt: normalizeDate(row.failedAt),
    updatedAt: normalizeDate(row.updatedAt)
  };
}

async function readSetting(env, key) {
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(key).first();
  return String(row?.value || "");
}

async function audit(env, actor, action, entityId, after) {
  await env.DB.prepare(
    `INSERT INTO audit_logs
      (id, actor, action, entity_type, entity_id, before_json, after_json)
     VALUES (?, ?, ?, 'notification_device', ?, '', ?)`
  ).bind(crypto.randomUUID(), actor, action, entityId, JSON.stringify(after || {})).run();
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeDate(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function cleanText(value, maxLength) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength);
}

function webPushJson(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...responseHeaders, ...extraHeaders }
  });
}

class WebPushApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "WebPushApiError";
    this.status = status;
    this.code = code;
  }
}
