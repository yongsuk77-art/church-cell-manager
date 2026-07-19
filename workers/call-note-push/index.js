import webpush from "web-push";
import {
  base64Url,
  base64UrlToBytes,
  decryptDeviceTarget,
  requireNotificationSecret
} from "../../lib/notification-crypto.js";
import {
  RELAY_TARGET_HANDLE_PATTERN,
  RelayClientError,
  resolveRelayClientConfiguration,
  revokeRelayTarget,
  sendRelayDelivery,
  upsertRelayTarget
} from "../../lib/relay-client.js";
import {
  SiteIdentityError,
  readStoredSiteIdentity
} from "../../lib/site-identity.js";
import {
  koreaDateKey,
  readTodayPastoralNotificationSummary,
  todayPastoralTriggerAt
} from "../../lib/today-pastoral-notification.js";

const DISPATCHER_STATUS_KEY = "notification.dispatcherStatus";
const TODAY_PASTORAL_CHECK_KEY = "notification.todayPastoralCheck";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const MAX_MATERIALIZE = 100;
const MAX_DELIVERIES_PER_RUN = 20;
const SCHEDULE_LOOKAHEAD_MS = 65 * 1000;
// A claim starts immediately before its network work. Three minutes comfortably
// covers the bounded OAuth + FCM request path while still recovering quickly.
const LEASE_MS = 3 * 60 * 1000;
const DELIVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DELIVERY_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const NOTE_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const NOTE_PURGE_CLAIM_STALE_MS = 15 * 60 * 1000;
const MAX_NOTE_PURGES_PER_RUN = 20;
const MAX_SEND_ATTEMPTS = 10;
const FETCH_TIMEOUT_MS = 15 * 1000;
const MIN_RETRY_MS = 60 * 1000;
const TODAY_PASTORAL_RECHECK_MS = 15 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WEB_PUSH_HOSTS = new Set([
  "fcm.googleapis.com",
  "web.push.apple.com",
  "push.services.mozilla.com",
  "updates.push.services.mozilla.com"
]);
const schemaColumnCache = new WeakMap();

async function d1HasColumn(env, table, column) {
  if (!env?.DB || !/^[a-z0-9_]+$/i.test(table) || !/^[a-z0-9_]+$/i.test(column)) return false;
  let cache = schemaColumnCache.get(env.DB);
  if (!cache) {
    cache = new Map();
    schemaColumnCache.set(env.DB, cache);
  }
  const key = `${table}.${column}`;
  if (cache.has(key)) return cache.get(key);
  try {
    const rows = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    const found = (rows.results || []).some((row) => String(row.name || "") === column);
    cache.set(key, found);
    return found;
  } catch {
    cache.set(key, false);
    return false;
  }
}

export default {
  async fetch() {
    return new Response("Not Found", { status: 404 });
  },

  async scheduled(controller, env) {
    const startedAt = new Date();
    try {
      const result = await runNotificationDispatcher(env, startedAt, {
        lookaheadMs: SCHEDULE_LOOKAHEAD_MS,
        wait: (delayMs) => scheduler.wait(delayMs),
        clock: () => new Date()
      });
      console.log(JSON.stringify({
        event: "call_note_push.completed",
        status: result.status,
        materialized: result.materialized,
        purged: result.purged,
        purgeFailed: result.purgeFailed,
        processed: result.processed,
        accepted: result.accepted,
        retried: result.retried,
        failed: result.failed
      }));
    } catch (error) {
      controller.noRetry();
      const code = safeErrorCode(error, "DISPATCHER_UNEXPECTED_ERROR");
      console.error(JSON.stringify({ event: "call_note_push.failed", errorCode: code }));
      try {
        await writeDispatcherStatus(env, {
          status: "error",
          lastRunAt: startedAt.toISOString(),
          errorCode: code
        });
      } catch {
        console.error(JSON.stringify({ event: "call_note_push.status_write_failed" }));
      }
    }
  }
};

export async function runNotificationDispatcher(env, now = new Date(), timing = {}) {
  if (!env.DB) throw workerError("DATABASE_UNAVAILABLE");
  let purgeResult = { scanned: 0, purged: 0, failed: 0 };
  const senderEnabled = String(env.PUSH_SEND_ENABLED || "").toLowerCase() === "true";
  let siteIdentity = null;
  let siteIdentityError = "";
  try {
    siteIdentity = await readStoredSiteIdentity(env);
  } catch (error) {
    siteIdentityError = error?.code || "SITE_IDENTITY_INVALID";
  }
  const configuration = await inspectConfiguration(env, siteIdentity, siteIdentityError);
  const baseStatus = {
    lastRunAt: now.toISOString(),
    senderEnabled,
    pushTransport: configuration.pushTransport,
    siteId: siteIdentity?.siteId || "",
    siteOrigin: siteIdentity?.siteOrigin || "",
    siteIdentityConfigured: Boolean(siteIdentity),
    relayConfigured: configuration.relayConfigured,
    webPushConfigured: configuration.webPushConfigured,
    fcmConfigured: configuration.fcmConfigured,
    notificationSecretConfigured: configuration.notificationSecretConfigured
  };

  let relayCleanupErrorCode = "";
  const cleanupRelayConfiguration = configuration.pushTransport === "relay"
    ? configuration.relayConfiguration
    : { ready: false };
  if (siteIdentity && cleanupRelayConfiguration.ready) {
    relayCleanupErrorCode = await cleanupRevokedRelayTargets(env, siteIdentity.siteId);
  }

  if (!senderEnabled) {
    purgeResult = await purgeExpiredDeletedNotes(env, now);
    await writeDispatcherStatus(env, {
      ...baseStatus,
      status: "disabled",
      trashPurgedCount: purgeResult.purged,
      trashPurgeFailedCount: purgeResult.failed,
      errorCode: relayCleanupErrorCode
    });
    return emptyRunResult("disabled", purgeResult);
  }
  if (!configuration.ready) {
    purgeResult = await purgeExpiredDeletedNotes(env, now);
    await writeDispatcherStatus(env, {
      ...baseStatus,
      status: "configuration_error",
      trashPurgedCount: purgeResult.purged,
      trashPurgeFailedCount: purgeResult.failed,
      errorCode: configuration.errorCode
    });
    return emptyRunResult("configuration_error", purgeResult);
  }

  let relaySyncErrorCode = "";
  let relaySyncErrorDetail = "";
  if (configuration.pushTransport === "relay" && configuration.notificationSecretConfigured) {
    try {
      await synchronizeActiveRelayTarget(env, siteIdentity, configuration.notificationSecret);
    } catch (error) {
      relaySyncErrorCode = safeErrorCode(error, "RELAY_TARGET_SYNC_FAILED");
      relaySyncErrorDetail = cleanForStorage(error?.diagnostic, 200);
    }
  }

  const waiter = typeof timing.wait === "function" ? timing.wait : null;
  const clock = typeof timing.clock === "function" ? timing.clock : () => new Date();
  const lookaheadMs = waiter
    ? Math.max(0, Math.min(SCHEDULE_LOOKAHEAD_MS, Number(timing.lookaheadMs || 0)))
    : 0;
  const materializeThrough = new Date(now.getTime() + lookaheadMs);

  await cleanupState(env, now);
  const memoMaterialized = await materializeDueReminders(env, now, materializeThrough);
  const visitMaterialized = await materializeDueVisitAlarms(env, now, materializeThrough);
  const todayPastoralMaterialized = await materializeTodayPastoralNotification(env, now, materializeThrough);
  const materialized = memoMaterialized + visitMaterialized + todayPastoralMaterialized;
  const sender = {
    pushTransport: configuration.pushTransport,
    siteIdentity,
    relayConfiguration: configuration.relayConfiguration,
    serviceAccount: configuration.serviceAccount,
    vapid: configuration.vapid,
    notificationSecret: configuration.notificationSecret,
    accessToken: ""
  };
  const counters = { processed: 0, accepted: 0, retried: 0, failed: 0 };
  let runErrorCode = relaySyncErrorCode || relayCleanupErrorCode;

  const processDue = async (due) => {
    for (const delivery of due) {
      if (counters.processed >= MAX_DELIVERIES_PER_RUN) break;
      // Do not reuse the cron start time here: a later item in the batch may not
      // be claimed until minutes after the run began or after an intentional wait.
      const deliveryNow = clock();
      const claimed = await claimDelivery(env, delivery, deliveryNow);
      if (!claimed) continue;
      counters.processed += 1;
      const result = await processClaimedDelivery(env, claimed, sender, deliveryNow);
      if (result.kind === "accepted") counters.accepted += 1;
      else if (result.kind === "retry") counters.retried += 1;
      else if (result.kind === "failed") counters.failed += 1;
      if (result.errorCode && !runErrorCode) runErrorCode = result.errorCode;
    }
  };

  await processDue(await listDueDeliveries(env, now, MAX_DELIVERIES_PER_RUN));

  // Cron executions are commonly offset from the minute boundary. Production pre-creates the
  // next minute's ledgers, then waits only until their persisted next_attempt_at. Direct unit
  // calls omit a waiter and therefore retain the historical fixed-time behavior.
  if (waiter && counters.processed < MAX_DELIVERIES_PER_RUN) {
    // A lookahead window can contain several distinct reminder times. Keep waking for the
    // next persisted due time so later reminders in the same minute do not fall through to
    // the next cron invocation. The wake bound matches the delivery bound and prevents a
    // malformed or concurrently changing ledger from keeping one scheduled event alive.
    let wakeCount = 0;
    while (counters.processed < MAX_DELIVERIES_PER_RUN && wakeCount < MAX_DELIVERIES_PER_RUN) {
      const nextAttemptAt = await nextImminentPendingDeliveryAt(env, materializeThrough);
      const nextAttemptMillis = Date.parse(nextAttemptAt);
      if (!nextAttemptAt || !Number.isFinite(nextAttemptMillis)) break;

      const beforeWait = clock();
      const delayMs = Math.max(0, nextAttemptMillis - beforeWait.getTime());
      wakeCount += 1;
      await waiter(delayMs);

      const afterWait = clock();
      if (afterWait.getTime() < nextAttemptMillis) break;
      const remaining = MAX_DELIVERIES_PER_RUN - counters.processed;
      const due = await listDueDeliveries(env, afterWait, remaining);
      if (!due.length && delayMs === 0) break;
      await processDue(due);
    }
  }

  // Reminder delivery is latency-sensitive; retention cleanup runs only after all
  // due notifications so slow R2 operations cannot make an alarm arrive late.
  purgeResult = await purgeExpiredDeletedNotes(env, clock());
  const completedAt = new Date().toISOString();
  const status = runErrorCode ? "degraded" : "ready";
  await writeDispatcherStatus(env, {
    ...baseStatus,
    status,
    trashPurgedCount: purgeResult.purged,
    trashPurgeFailedCount: purgeResult.failed,
    lastSuccessAt: completedAt,
    processedCount: counters.processed,
    acceptedCount: counters.accepted,
    errorCode: runErrorCode,
    errorDetail: relaySyncErrorDetail
  });
  return {
    status,
    materialized,
    purged: purgeResult.purged,
    purgeFailed: purgeResult.failed,
    ...counters
  };
}

export async function purgeExpiredDeletedNotes(env, now = new Date()) {
  if (!env.DB) throw workerError("DATABASE_UNAVAILABLE");
  const cutoff = new Date(now.getTime() - NOTE_TRASH_RETENTION_MS).toISOString();
  const staleClaimCutoff = new Date(now.getTime() - NOTE_PURGE_CLAIM_STALE_MS).toISOString();
  const candidates = await env.DB.prepare(
    `SELECT id, revision, deleted_at AS deletedAt
     FROM notes
     WHERE deleted_at <> ''
       AND deleted_at <= ?
       AND (purge_started_at = '' OR purge_started_at <= ?)
     ORDER BY deleted_at, id
     LIMIT ?`
  ).bind(cutoff, staleClaimCutoff, MAX_NOTE_PURGES_PER_RUN).all();
  const result = { scanned: 0, purged: 0, failed: 0 };

  for (const candidate of candidates.results || []) {
    const id = String(candidate.id || "");
    const revision = Number(candidate.revision || 0);
    const deletedAt = String(candidate.deletedAt || "");
    if (!id || revision < 1 || !deletedAt) continue;
    const claimTime = now.toISOString();
    const claim = await env.DB.prepare(
      `UPDATE notes
       SET purge_started_at = ?
       WHERE id = ? AND revision = ? AND deleted_at = ?
         AND (purge_started_at = '' OR purge_started_at <= ?)`
    ).bind(claimTime, id, revision, deletedAt, staleClaimCutoff).run();
    if (Number(claim?.meta?.changes || 0) !== 1) continue;
    result.scanned += 1;

    try {
      const attachments = await env.DB.prepare(
        "SELECT object_key AS objectKey FROM note_attachments WHERE note_id = ? ORDER BY id"
      ).bind(id).all();
      const objectKeys = (attachments.results || [])
        .map((row) => String(row.objectKey || ""))
        .filter(Boolean);
      if (objectKeys.length) {
        if (!env.PHOTOS || typeof env.PHOTOS.delete !== "function") {
          throw workerError("NOTE_PHOTOS_BINDING_UNAVAILABLE");
        }
        try {
          await env.PHOTOS.delete(objectKeys);
        } catch {
          throw workerError("NOTE_PHOTO_DELETE_FAILED");
        }
      }
      const deleted = await env.DB.prepare(
        `DELETE FROM notes
         WHERE id = ? AND revision = ? AND deleted_at = ? AND purge_started_at = ?`
      ).bind(id, revision, deletedAt, claimTime).run();
      if (Number(deleted?.meta?.changes || 0) !== 1) {
        throw workerError("NOTE_PURGE_STATE_CHANGED");
      }
      result.purged += 1;
    } catch (error) {
      result.failed += 1;
      try {
        await env.DB.prepare(
          "UPDATE notes SET purge_started_at = '' WHERE id = ? AND purge_started_at = ?"
        ).bind(id, claimTime).run();
      } catch {
        console.error(JSON.stringify({ event: "note_trash.claim_release_failed", noteId: id }));
      }
      console.error(JSON.stringify({
        event: "note_trash.purge_failed",
        noteId: id,
        errorCode: safeErrorCode(error, "NOTE_PURGE_FAILED")
      }));
    }
  }
  return result;
}

export async function synchronizeActiveRelayTarget(env, siteIdentity, notificationSecret) {
  if (!siteIdentity?.siteId) throw workerError("SITE_IDENTITY_INVALID");
  const device = await env.DB.prepare(
    `SELECT id, status, generation,
      target_kind AS targetKind, target_ciphertext AS targetCiphertext,
      target_revision AS targetRevision,
      relay_target_handle AS relayTargetHandle,
      relay_target_generation AS relayTargetGeneration,
      relay_target_revision AS relayTargetRevision,
      relay_target_state AS relayTargetState
     FROM call_note_devices
     WHERE status = 'active'
     ORDER BY generation DESC
     LIMIT 1`
  ).first();
  if (!device) return { status: "no_device", changed: false };

  const generation = Number(device.generation || 0);
  const targetRevision = Number(device.targetRevision || 0);
  const alreadyReady = RELAY_TARGET_HANDLE_PATTERN.test(String(device.relayTargetHandle || ""))
    && device.relayTargetState === "active"
    && Number(device.relayTargetGeneration || 0) === generation
    && Number(device.relayTargetRevision || 0) === targetRevision;
  if (alreadyReady) {
    await releaseWaitingRelayDeliveries(env, new Date().toISOString());
    return { status: "ready", changed: false };
  }
  if (generation < 1 || targetRevision < 1 || !device.targetKind || !device.targetCiphertext) {
    throw workerError("DEVICE_TARGET_INVALID");
  }

  let targetValue;
  try {
    targetValue = await decryptDeviceTarget(
      notificationSecret,
      device.id,
      device.targetKind,
      device.targetCiphertext
    );
  } catch {
    throw workerError("TARGET_DECRYPT_FAILED");
  }

  let relay;
  try {
    relay = await upsertRelayTarget({
      env,
      siteId: siteIdentity.siteId,
      deviceId: device.id,
      targetKind: device.targetKind,
      targetValue,
      deviceGeneration: generation,
      targetRevision
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "call_note_push.relay_target_sync_failed",
      errorCode: safeErrorCode(error, "RELAY_TARGET_SYNC_FAILED"),
      causeName: cleanForStorage(error?.cause?.name, 80),
      causeMessage: cleanForStorage(error?.cause?.message, 200)
    }));
    const wrapped = workerError(safeErrorCode(error, "RELAY_TARGET_SYNC_FAILED"));
    wrapped.diagnostic = [error?.cause?.name, error?.cause?.message]
      .map((value) => cleanForStorage(value, 120))
      .filter(Boolean)
      .join(": ");
    throw wrapped;
  }

  const targetHandle = String(relay?.targetHandle || "");
  if (!RELAY_TARGET_HANDLE_PATTERN.test(targetHandle)
    || relay?.status !== "active"
    || Number(relay?.deviceGeneration) !== generation
    || Number(relay?.targetRevision) !== targetRevision) {
    throw workerError("RELAY_RESPONSE_INVALID");
  }

  const nowIso = new Date().toISOString();
  const saved = await env.DB.prepare(
    `UPDATE call_note_devices
     SET relay_target_handle = ?, relay_target_generation = ?, relay_target_revision = ?,
       relay_target_state = 'active', relay_synced_at = ?, updated_at = ?
     WHERE id = ? AND status = 'active' AND generation = ? AND target_revision = ?`
  ).bind(
    targetHandle,
    generation,
    targetRevision,
    nowIso,
    nowIso,
    device.id,
    generation,
    targetRevision
  ).run();
  if (Number(saved.meta?.changes || 0) !== 1) throw workerError("RELAY_TARGET_SYNC_CONFLICT");
  await releaseWaitingRelayDeliveries(env, nowIso);

  await env.DB.prepare(
    `INSERT INTO audit_logs
      (id, actor, action, entity_type, entity_id, before_json, after_json)
     VALUES (?, ?, 'notification.device.relay_sync', 'notification_device', ?, '', ?)`
  ).bind(
    crypto.randomUUID(),
    "system:notification-dispatcher",
    device.id,
    JSON.stringify({
      relayTargetState: "active",
      deviceGeneration: generation,
      targetRevision,
      syncedAt: nowIso,
      recovery: true
    })
  ).run();
  return { status: "ready", changed: true, syncedAt: nowIso };
}

async function releaseWaitingRelayDeliveries(env, nowIso) {
  await env.DB.prepare(
    `UPDATE call_note_push_deliveries
     SET send_state = 'retry_wait', next_attempt_at = ?, last_error_code = '', updated_at = ?
     WHERE send_state = 'waiting_target' AND accepted_at = ''`
  ).bind(nowIso, nowIso).run();
}

async function inspectConfiguration(env, siteIdentity, siteIdentityError = "") {
  const pushTransport = normalizePushTransport(env.PUSH_TRANSPORT);
  let notificationSecret = "";
  let serviceAccount = null;
  let notificationSecretConfigured = false;
  let fcmConfigured = false;
  let relayConfigured = false;
  let webPushConfigured = false;
  let relayConfiguration = null;
  let vapid = null;
  let errorCode = "";
  try {
    notificationSecret = requireNotificationSecret(env);
    notificationSecretConfigured = true;
  } catch {
    // Relay transport does not decrypt the Firebase target in this Worker.
  }
  if (!siteIdentity) errorCode = siteIdentityError || "SITE_IDENTITY_INVALID";
  if (pushTransport === "relay") {
    relayConfiguration = await resolveRelayClientConfiguration(env);
    relayConfigured = relayConfiguration.ready;
    fcmConfigured = relayConfigured;
    if (!relayConfigured && !errorCode) errorCode = relayConfiguration.errorCode;
  } else if (pushTransport === "direct") {
    if (!notificationSecretConfigured && !errorCode) errorCode = "NOTIFICATION_SECRET_MISSING";
    try {
      serviceAccount = parseServiceAccount(env.FCM_SERVICE_ACCOUNT_JSON);
      fcmConfigured = true;
    } catch {
      if (!errorCode) errorCode = "FCM_SERVICE_ACCOUNT_INVALID";
    }
  } else if (pushTransport === "webpush") {
    if (!notificationSecretConfigured && !errorCode) errorCode = "NOTIFICATION_SECRET_MISSING";
    try {
      vapid = parseVapidConfiguration(env);
      webPushConfigured = true;
    } catch {
      if (!errorCode) errorCode = "VAPID_CONFIGURATION_INVALID";
    }
  } else if (!errorCode) {
    errorCode = "PUSH_TRANSPORT_INVALID";
  }
  const ready = Boolean(siteIdentity)
    && (pushTransport === "relay"
      ? relayConfigured
      : pushTransport === "direct"
        ? notificationSecretConfigured && fcmConfigured
        : pushTransport === "webpush" && notificationSecretConfigured && webPushConfigured);
  return {
    ready,
    pushTransport,
    notificationSecretConfigured,
    fcmConfigured,
    relayConfigured,
    webPushConfigured,
    relayConfiguration,
    vapid,
    notificationSecret,
    serviceAccount,
    errorCode
  };
}

async function cleanupState(env, now) {
  const nowIso = now.toISOString();
  const attemptCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const pairCodeCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const deliveryCutoff = new Date(now.getTime() - DELIVERY_RETENTION_MS).toISOString();
  const deliveryDeadCutoff = new Date(now.getTime() - DELIVERY_MAX_AGE_MS).toISOString();
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
    ).bind(pairCodeCutoff),
    env.DB.prepare(
      `UPDATE call_note_push_deliveries
       SET send_state = 'retry_wait', lease_token = '', lease_expires_at = '', next_attempt_at = ?,
         last_error_code = 'LEASE_RECOVERED', updated_at = ?
       WHERE send_state = 'sending' AND lease_expires_at <> '' AND lease_expires_at <= ?`
    ).bind(nowIso, nowIso, nowIso),
    env.DB.prepare(
      `UPDATE call_note_push_deliveries AS delivery
       SET send_state = 'cancelled', lease_token = '', lease_expires_at = '',
         last_error_code = 'REMINDER_CANCELLED', failed_at = ?, updated_at = ?
       WHERE delivery.kind = 'memo_reminder'
         AND delivery.send_state NOT IN ('accepted', 'cancelled', 'dead')
         AND NOT EXISTS (
           SELECT 1 FROM notes
           WHERE notes.id = delivery.note_id
             AND notes.reminder_id = delivery.reminder_id
             AND notes.remind_at = delivery.scheduled_at
             AND notes.status = 'active'
             AND notes.reminder_state = 'scheduled'
             AND COALESCE(notes.deleted_at, '') = ''
         )`
    ).bind(nowIso, nowIso),
    env.DB.prepare(
      `UPDATE call_note_push_deliveries AS delivery
       SET send_state = 'cancelled', lease_token = '', lease_expires_at = '',
         last_error_code = 'VISIT_ALARM_CANCELLED', failed_at = ?, updated_at = ?
       WHERE delivery.kind = 'visit_alarm'
         AND delivery.send_state NOT IN ('accepted', 'cancelled', 'dead')
         AND NOT EXISTS (
           SELECT 1 FROM visit_notes
           WHERE visit_notes.id = delivery.visit_id
             AND visit_notes.alarm_id = delivery.reminder_id
             AND visit_notes.alarm_at = delivery.scheduled_at
             AND visit_notes.alarm_state = 'scheduled'
         )`
    ).bind(nowIso, nowIso),
    env.DB.prepare(
      `UPDATE call_note_push_deliveries
       SET send_state = 'cancelled', lease_token = '', lease_expires_at = '',
         last_error_code = 'TODAY_PASTORAL_EXPIRED', failed_at = ?, updated_at = ?
       WHERE kind = 'today_pastoral' AND reminder_id <> ?
         AND send_state NOT IN ('accepted', 'cancelled', 'dead')`
    ).bind(nowIso, nowIso, koreaDateKey(now)),
    env.DB.prepare(
      `UPDATE call_note_push_deliveries AS delivery
       SET send_state = 'cancelled', lease_token = '', lease_expires_at = '',
         last_error_code = 'PASTORAL_ASSIGNMENT_CLOSED', failed_at = ?, updated_at = ?
       WHERE delivery.kind = 'pastoral_assignment'
         AND delivery.send_state NOT IN ('accepted', 'cancelled', 'dead')
         AND NOT EXISTS (
           SELECT 1 FROM pastoral_assignments assignment
           WHERE assignment.id = delivery.reminder_id
             AND assignment.assignee_user_id = delivery.target_user_id
             AND assignment.status IN ('waiting', 'contacted', 'visit_planned')
         )`
    ).bind(nowIso, nowIso),
    env.DB.prepare(
      `UPDATE call_note_push_deliveries
       SET send_state = 'dead', lease_token = '', lease_expires_at = '',
         last_error_code = 'DELIVERY_EXPIRED', failed_at = ?, updated_at = ?
       WHERE created_at < ? AND send_state NOT IN ('accepted', 'cancelled', 'dead')`
    ).bind(nowIso, nowIso, deliveryDeadCutoff),
    env.DB.prepare(
      `DELETE FROM call_note_push_deliveries AS delivery
       WHERE delivery.created_at < ?
         AND delivery.send_state IN ('accepted', 'cancelled', 'dead')
         AND (
           delivery.kind = 'connection_test'
           OR delivery.kind = 'today_pastoral'
           OR delivery.kind = 'pastoral_assignment'
           OR (
             delivery.kind = 'memo_reminder'
             AND NOT EXISTS (
               SELECT 1 FROM notes
               WHERE notes.id = delivery.note_id
                 AND notes.reminder_id = delivery.reminder_id
                 AND delivery.reminder_id <> ''
                 AND COALESCE(notes.deleted_at, '') = ''
             )
           )
           OR (
             delivery.kind = 'visit_alarm'
             AND NOT EXISTS (
               SELECT 1 FROM visit_notes
               WHERE visit_notes.id = delivery.visit_id
                 AND visit_notes.alarm_id = delivery.reminder_id
                 AND delivery.reminder_id <> ''
             )
           )
         )`
    ).bind(deliveryCutoff)
  ]);
}

async function cleanupRevokedRelayTargets(env, siteId) {
  let rows;
  try {
    rows = await env.DB.prepare(
      `SELECT revoked.id, revoked.relay_target_handle AS relayTargetHandle
       FROM call_note_devices revoked
       WHERE revoked.status = 'revoked'
         AND revoked.relay_target_state = 'revoked'
         AND revoked.relay_target_handle <> ''
         AND NOT EXISTS (
           SELECT 1 FROM call_note_devices active
           WHERE active.status = 'active'
             AND active.relay_target_handle = revoked.relay_target_handle
         )
       ORDER BY revoked.updated_at
       LIMIT 10`
    ).all();
  } catch {
    return "RELAY_REVOKE_QUERY_FAILED";
  }

  let lastErrorCode = "";
  for (const row of rows.results || []) {
    const targetHandle = String(row.relayTargetHandle || "");
    if (!RELAY_TARGET_HANDLE_PATTERN.test(targetHandle)) {
      lastErrorCode = "RELAY_TARGET_INVALID";
      continue;
    }
    try {
      await revokeRelayTarget({ env, siteId, targetHandle });
      await env.DB.prepare(
        `UPDATE call_note_devices
         SET relay_target_handle = '', relay_target_generation = 0,
           relay_target_revision = 0, relay_target_state = 'none',
           relay_synced_at = '', updated_at = ?
         WHERE id = ? AND status = 'revoked'
           AND relay_target_state = 'revoked' AND relay_target_handle = ?`
      ).bind(new Date().toISOString(), row.id, targetHandle).run();
    } catch (error) {
      lastErrorCode = cleanForStorage(error?.code, 100) || "RELAY_REVOKE_FAILED";
    }
  }
  return lastErrorCode;
}

export async function materializeDueReminders(env, now, materializeThrough = now) {
  const oldest = new Date(now.getTime() - DELIVERY_MAX_AGE_MS).toISOString();
  const noteChurchScoped = await d1HasColumn(env, "notes", "church_id");
  const deliveryChurchScoped = await d1HasColumn(env, "call_note_push_deliveries", "church_id");
  const rows = await env.DB.prepare(
    `SELECT id AS noteId, reminder_id AS reminderId, remind_at AS scheduledAt,
      ${noteChurchScoped ? "church_id" : "'church-seosan'"} AS churchId
     FROM notes
     WHERE status = 'active' AND reminder_state = 'scheduled' AND reminder_id <> ''
       AND COALESCE(deleted_at, '') = ''
       AND remind_at <= ? AND remind_at >= ?
       AND NOT EXISTS (
         SELECT 1 FROM call_note_push_deliveries delivery
         WHERE delivery.kind = 'memo_reminder'
           AND delivery.reminder_id = notes.reminder_id
       )
     ORDER BY remind_at
     LIMIT ?`
  ).bind(materializeThrough.toISOString(), oldest, MAX_MATERIALIZE).all();
  const statements = (rows.results || []).map((row) => {
    const notificationId = crypto.randomUUID();
    const nowIso = now.toISOString();
    const nextAttemptAt = row.scheduledAt > nowIso ? row.scheduledAt : nowIso;
    const columns = deliveryChurchScoped ? ", church_id" : "";
    const value = deliveryChurchScoped ? ", ?" : "";
    return env.DB.prepare(
      `INSERT OR IGNORE INTO call_note_push_deliveries
        (notification_id, dedupe_key, kind, reminder_id, note_id, device_id, device_generation,
         scheduled_at, send_state, attempt_count, next_attempt_at, created_at, updated_at${columns})
       VALUES (?, ?, 'memo_reminder', ?, ?, NULL, 0, ?, 'pending', 0, ?, ?, ?${value})`
    ).bind(
      notificationId, `memo:${row.reminderId}`, row.reminderId, row.noteId,
      row.scheduledAt, nextAttemptAt, nowIso, nowIso,
      ...(deliveryChurchScoped ? [row.churchId || "church-seosan"] : [])
    );
  });
  if (!statements.length) return 0;
  const results = await env.DB.batch(statements);
  return results.reduce((count, result) => count + Number(result.meta?.changes || 0), 0);
}

export async function materializeDueVisitAlarms(env, now, materializeThrough = now) {
  const oldest = new Date(now.getTime() - DELIVERY_MAX_AGE_MS).toISOString();
  const cellChurchScoped = await d1HasColumn(env, "cells", "church_id");
  const deliveryChurchScoped = await d1HasColumn(env, "call_note_push_deliveries", "church_id");
  const rows = await env.DB.prepare(cellChurchScoped
    ? `SELECT visit.id AS visitId, visit.alarm_id AS alarmId,
      visit.alarm_at AS scheduledAt, cell.church_id AS churchId
       FROM visit_notes visit
       JOIN members member ON member.id = visit.member_id
       JOIN cells cell ON cell.id = member.cell_id
       WHERE visit.alarm_state = 'scheduled' AND visit.alarm_id <> '' AND visit.alarm_at <> ''
       AND alarm_at <= ? AND alarm_at >= ?
       AND NOT EXISTS (
         SELECT 1 FROM call_note_push_deliveries delivery
         WHERE delivery.kind = 'visit_alarm'
           AND delivery.reminder_id = visit.alarm_id
       )
       ORDER BY visit.alarm_at
       LIMIT ?`
    : `SELECT id AS visitId, alarm_id AS alarmId, alarm_at AS scheduledAt,
        'church-seosan' AS churchId
       FROM visit_notes
       WHERE alarm_state = 'scheduled' AND alarm_id <> '' AND alarm_at <> ''
         AND alarm_at <= ? AND alarm_at >= ?
         AND NOT EXISTS (
           SELECT 1 FROM call_note_push_deliveries delivery
           WHERE delivery.kind = 'visit_alarm'
             AND delivery.reminder_id = visit_notes.alarm_id
         )
       ORDER BY alarm_at
       LIMIT ?`
  ).bind(materializeThrough.toISOString(), oldest, MAX_MATERIALIZE).all();
  const statements = (rows.results || []).map((row) => {
    const notificationId = crypto.randomUUID();
    const nowIso = now.toISOString();
    const nextAttemptAt = row.scheduledAt > nowIso ? row.scheduledAt : nowIso;
    const columns = deliveryChurchScoped ? ", church_id" : "";
    const value = deliveryChurchScoped ? ", ?" : "";
    return env.DB.prepare(
      `INSERT OR IGNORE INTO call_note_push_deliveries
        (notification_id, dedupe_key, kind, reminder_id, note_id, visit_id,
         device_id, device_generation, scheduled_at, send_state, attempt_count,
         next_attempt_at, created_at, updated_at${columns})
       VALUES (?, ?, 'visit_alarm', ?, '', ?, NULL, 0, ?, 'pending', 0, ?, ?, ?${value})`
    ).bind(
      notificationId, `visit:${row.alarmId}`, row.alarmId, row.visitId,
      row.scheduledAt, nextAttemptAt, nowIso, nowIso,
      ...(deliveryChurchScoped ? [row.churchId || "church-seosan"] : [])
    );
  });
  if (!statements.length) return 0;
  const results = await env.DB.batch(statements);
  return results.reduce((count, result) => count + Number(result.meta?.changes || 0), 0);
}

export async function materializeTodayPastoralNotification(env, now, materializeThrough = now) {
  const today = koreaDateKey(now);
  const triggerAt = todayPastoralTriggerAt(today, todayPastoralNotificationHour(env));
  if (!Number.isFinite(triggerAt.getTime()) || triggerAt > materializeThrough) return 0;

  const dedupeKey = `today-pastoral:${today}`;
  const existing = await env.DB.prepare(
    "SELECT notification_id AS notificationId FROM call_note_push_deliveries WHERE dedupe_key = ?"
  ).bind(dedupeKey).first();
  if (existing) return 0;

  const triggerReached = now >= triggerAt;
  if (triggerReached && await todayPastoralCheckIsRecent(env, today, now)) return 0;
  const summary = await readTodayPastoralNotificationSummary(env, now);
  if (summary.notificationCount < 1) {
    if (triggerReached) await writeTodayPastoralCheck(env, summary, now);
    return 0;
  }

  const notificationId = crypto.randomUUID();
  const nowIso = now.toISOString();
  const scheduledAt = triggerAt.toISOString();
  const nextAttemptAt = triggerAt > now ? scheduledAt : nowIso;
  const deliveryChurchScoped = await d1HasColumn(env, "call_note_push_deliveries", "church_id");
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO call_note_push_deliveries
      (notification_id, dedupe_key, kind, reminder_id, note_id, visit_id,
       device_id, device_generation, scheduled_at, send_state, attempt_count,
       next_attempt_at, created_at, updated_at${deliveryChurchScoped ? ", church_id" : ""})
     VALUES (?, ?, 'today_pastoral', ?, '', '', NULL, 0, ?, 'pending', 0, ?, ?, ?${
       deliveryChurchScoped ? ", 'church-seosan'" : ""
     })`
  ).bind(notificationId, dedupeKey, today, scheduledAt, nextAttemptAt, nowIso, nowIso).run();
  if (triggerReached) await writeTodayPastoralCheck(env, summary, now);
  return Number(result.meta?.changes || 0);
}

async function todayPastoralCheckIsRecent(env, today, now) {
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?")
    .bind(TODAY_PASTORAL_CHECK_KEY)
    .first();
  let value = {};
  try {
    value = JSON.parse(String(row?.value || "{}"));
  } catch {
    value = {};
  }
  const checkedAt = Date.parse(String(value?.lastCheckedAt || ""));
  return value?.date === today
    && Number.isFinite(checkedAt)
    && checkedAt > now.getTime() - TODAY_PASTORAL_RECHECK_MS;
}

async function writeTodayPastoralCheck(env, summary, now) {
  const nowIso = now.toISOString();
  const value = JSON.stringify({
    date: summary.today,
    lastCheckedAt: nowIso,
    notificationCount: Math.max(0, Number(summary.notificationCount || 0))
  });
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(TODAY_PASTORAL_CHECK_KEY, value, nowIso).run();
}

function todayPastoralNotificationHour(env) {
  const value = Number(env?.TODAY_PASTORAL_NOTIFICATION_HOUR);
  return Number.isInteger(value) && value >= 0 && value <= 23 ? value : 8;
}

async function listDueDeliveries(env, now, limit = MAX_DELIVERIES_PER_RUN) {
  const churchScoped = await d1HasColumn(env, "call_note_push_deliveries", "church_id");
  const rows = await env.DB.prepare(
    `SELECT notification_id AS notificationId, kind, reminder_id AS reminderId, note_id AS noteId,
      visit_id AS visitId, COALESCE(device_id, '') AS deviceId, device_generation AS deviceGeneration,
      target_user_id AS targetUserId${churchScoped ? ", church_id AS churchId" : ""},
      scheduled_at AS scheduledAt, send_state AS sendState, attempt_count AS attemptCount,
      next_attempt_at AS nextAttemptAt, lease_expires_at AS leaseExpiresAt, created_at AS createdAt
     FROM call_note_push_deliveries
     WHERE next_attempt_at <= ?
       AND (
         send_state IN ('pending', 'retry_wait', 'waiting_target', 'blocked_config')
         OR (send_state = 'sending' AND lease_expires_at <= ?)
       )
     ORDER BY next_attempt_at, created_at
     LIMIT ?`
  ).bind(now.toISOString(), now.toISOString(), limit).all();
  return rows.results || [];
}

async function nextImminentPendingDeliveryAt(env, materializeThrough) {
  const row = await env.DB.prepare(
    `SELECT next_attempt_at AS nextAttemptAt
     FROM call_note_push_deliveries
     WHERE send_state = 'pending' AND next_attempt_at <= ?
     ORDER BY next_attempt_at, created_at
     LIMIT 1`
  ).bind(materializeThrough.toISOString()).first();
  return String(row?.nextAttemptAt || "");
}

async function claimDelivery(env, delivery, now) {
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_MS).toISOString();
  const result = await env.DB.prepare(
    `UPDATE call_note_push_deliveries
     SET send_state = 'sending', lease_token = ?, lease_expires_at = ?, updated_at = ?
     WHERE notification_id = ? AND next_attempt_at <= ?
       AND (
         send_state IN ('pending', 'retry_wait', 'waiting_target', 'blocked_config')
         OR (send_state = 'sending' AND lease_expires_at <= ?)
       )`
  ).bind(
    leaseToken, leaseExpiresAt, now.toISOString(), delivery.notificationId,
    now.toISOString(), now.toISOString()
  ).run();
  if (Number(result.meta?.changes || 0) !== 1) return null;
  return { ...delivery, leaseToken, leaseExpiresAt };
}

async function processClaimedDelivery(env, delivery, sender, now) {
  const valid = await validateDeliverySource(env, delivery, now);
  if (!valid) {
    const errorCode = delivery.kind === "visit_alarm"
      ? "VISIT_ALARM_CANCELLED"
      : delivery.kind === "memo_reminder"
        ? "REMINDER_CANCELLED"
        : delivery.kind === "today_pastoral"
          ? "TODAY_PASTORAL_CLEARED"
          : delivery.kind === "pastoral_assignment"
            ? "PASTORAL_ASSIGNMENT_CLOSED"
        : "DELIVERY_SOURCE_INVALID";
    await transitionDelivery(env, delivery, {
      sendState: "cancelled",
      errorCode,
      failedAt: now.toISOString()
    });
    return { kind: "failed", errorCode: "" };
  }

  const device = await resolveDeliveryDevice(env, delivery);
  if (!device) {
    await transitionDelivery(env, delivery, {
      sendState: delivery.kind === "connection_test" ? "cancelled" : "waiting_target",
      errorCode: delivery.kind === "connection_test" ? "TEST_DEVICE_UNAVAILABLE" : "WAITING_FOR_DEVICE",
      nextAttemptAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
      failedAt: delivery.kind === "connection_test" ? now.toISOString() : ""
    });
    return {
      kind: delivery.kind === "connection_test" ? "failed" : "retry",
      errorCode: delivery.kind === "connection_test" ? "TEST_DEVICE_UNAVAILABLE" : "WAITING_FOR_DEVICE"
    };
  }

  let targetValue = "";
  if (sender.pushTransport === "relay") {
    const relayTargetReady = device.relayTargetState === "active"
      && Boolean(device.relayTargetHandle)
      && device.relayTargetGeneration === device.generation
      && device.relayTargetRevision === device.targetRevision;
    if (!relayTargetReady) {
      await transitionDelivery(env, delivery, {
        sendState: delivery.kind === "connection_test" ? "cancelled" : "waiting_target",
        errorCode: "RELAY_TARGET_NOT_SYNCED",
        nextAttemptAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
        failedAt: delivery.kind === "connection_test" ? now.toISOString() : ""
      });
      return {
        kind: delivery.kind === "connection_test" ? "failed" : "retry",
        errorCode: "RELAY_TARGET_NOT_SYNCED"
      };
    }
  } else {
    try {
      targetValue = await decryptDeviceTarget(
        sender.notificationSecret,
        device.id,
        device.targetKind,
        device.targetCiphertext
      );
    } catch {
      await transitionDelivery(env, delivery, {
        sendState: "blocked_config",
        errorCode: "TARGET_DECRYPT_FAILED",
        nextAttemptAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString()
      });
      return { kind: "failed", errorCode: "TARGET_DECRYPT_FAILED" };
    }
  }

  const attemptCount = Number(delivery.attemptCount || 0) + 1;
  const assigned = await env.DB.prepare(
    `UPDATE call_note_push_deliveries
     SET device_id = ?, device_generation = ?, target_revision_used = ?, attempt_count = ?, updated_at = ?
     WHERE notification_id = ? AND send_state = 'sending' AND lease_token = ?`
  ).bind(
    device.id, device.generation, device.targetRevision, attemptCount,
    now.toISOString(), delivery.notificationId, delivery.leaseToken
  ).run();
  if (Number(assigned.meta?.changes || 0) !== 1) return { kind: "retry", errorCode: "" };

  let outcome;
  if (sender.pushTransport === "relay") {
    try {
      const response = await sendRelayDelivery({
        env,
        siteId: sender.siteIdentity.siteId,
        delivery,
        device
      });
      outcome = normalizeRelayOutcome(response);
    } catch (error) {
      outcome = relayFailureOutcome(error);
    }
  } else if (sender.pushTransport === "webpush") {
    outcome = await sendWebPushNotification(sender.vapid, targetValue, delivery);
  } else {
    try {
      outcome = await sendWithSingleAuthRefresh(sender, device.targetKind, targetValue, delivery);
    } catch (error) {
      outcome = senderFailureOutcome(error);
    }
  }
  const outcomeNow = new Date();

  if (outcome.kind === "accepted") {
    const acceptedAt = outcomeNow;
    const accepted = await transitionAcceptedDelivery(
      env,
      delivery,
      device,
      outcome.messageName,
      acceptedAt,
      outcome.httpStatus
    );
    if (accepted) return { kind: "accepted", errorCode: "" };

    // A very fast Android ACK may have finalized the delivery before this
    // Worker resumes. That is a successful race, not a target rotation.
    if (await getDeliverySendState(env, delivery.notificationId) === "accepted") {
      return { kind: "accepted", errorCode: "" };
    }

    // Registration can rotate while an external FCM request is in flight. The
    // old request contained no memo content, but the current device must also
    // receive it, so keep this delivery retryable instead of finalizing it.
    const retried = await transitionDelivery(env, delivery, {
      sendState: "retry_wait",
      httpStatus: 200,
      errorCode: "TARGET_CHANGED_DURING_SEND",
      nextAttemptAt: acceptedAt.toISOString()
    });
    if (!retried && await getDeliverySendState(env, delivery.notificationId) === "accepted") {
      return { kind: "accepted", errorCode: "" };
    }
    return { kind: "retry", errorCode: "TARGET_CHANGED_DURING_SEND" };
  }

  if (outcome.kind === "unregistered") {
    const revoked = await env.DB.prepare(
      `UPDATE call_note_devices
       SET status = 'unregistered',
         relay_target_state = CASE WHEN ? = 'relay' THEN 'unregistered' ELSE relay_target_state END,
         last_seen_at = ?, updated_at = ?
       WHERE id = ? AND status = 'active' AND target_revision = ?`
    ).bind(
      sender.pushTransport,
      outcomeNow.toISOString(),
      outcomeNow.toISOString(),
      device.id,
      device.targetRevision
    ).run();
    const targetStillCurrent = Number(revoked.meta?.changes || 0) === 1;
    const unregisteredCode = sender.pushTransport === "webpush"
      ? "WEB_PUSH_SUBSCRIPTION_GONE"
      : "FCM_UNREGISTERED";
    await transitionDelivery(env, delivery, {
      sendState: targetStillCurrent ? "waiting_target" : "retry_wait",
      httpStatus: outcome.httpStatus,
      errorCode: unregisteredCode,
      nextAttemptAt: targetStillCurrent
        ? new Date(outcomeNow.getTime() + 15 * 60 * 1000).toISOString()
        : outcomeNow.toISOString()
    });
    return { kind: "retry", errorCode: unregisteredCode };
  }

  if (outcome.kind === "blocked") {
    await transitionDelivery(env, delivery, {
      sendState: "blocked_config",
      httpStatus: outcome.httpStatus,
      errorCode: outcome.errorCode,
      nextAttemptAt: new Date(outcomeNow.getTime() + 60 * 60 * 1000).toISOString()
    });
    return { kind: "failed", errorCode: outcome.errorCode };
  }

  if (outcome.kind === "retry") {
    const expired = Date.parse(delivery.createdAt || "") <
      outcomeNow.getTime() - DELIVERY_MAX_AGE_MS;
    if (attemptCount >= MAX_SEND_ATTEMPTS || expired) {
      await transitionDelivery(env, delivery, {
        sendState: "dead",
        httpStatus: outcome.httpStatus,
        errorCode: attemptCount >= MAX_SEND_ATTEMPTS ? "MAX_SEND_ATTEMPTS" : "DELIVERY_EXPIRED",
        failedAt: outcomeNow.toISOString()
      });
      return {
        kind: "failed",
        errorCode: attemptCount >= MAX_SEND_ATTEMPTS ? "MAX_SEND_ATTEMPTS" : "DELIVERY_EXPIRED"
      };
    }
    await transitionDelivery(env, delivery, {
      sendState: "retry_wait",
      httpStatus: outcome.httpStatus,
      errorCode: outcome.errorCode,
      nextAttemptAt: retryAt(outcomeNow, attemptCount, outcome.retryAfterMs)
    });
    return { kind: "retry", errorCode: outcome.errorCode };
  }

  await transitionDelivery(env, delivery, {
    sendState: "dead",
    httpStatus: outcome.httpStatus,
    errorCode: outcome.errorCode,
    failedAt: outcomeNow.toISOString()
  });
  return { kind: "failed", errorCode: outcome.errorCode };
}

export async function validateDeliverySource(env, delivery, now = new Date()) {
  switch (delivery.kind) {
    case "connection_test":
      return true;
    case "memo_reminder": {
      const noteChurchScoped = await d1HasColumn(env, "notes", "church_id");
      const note = await env.DB.prepare(
         `SELECT id FROM notes
          WHERE id = ? AND reminder_id = ? AND remind_at = ?
           ${noteChurchScoped ? "AND church_id = ?" : ""}
           AND status = 'active' AND reminder_state = 'scheduled'
           AND COALESCE(deleted_at, '') = ''`
      ).bind(
        delivery.noteId, delivery.reminderId, delivery.scheduledAt,
        ...(noteChurchScoped ? [delivery.churchId || "church-seosan"] : [])
      ).first();
      return Boolean(note);
    }
    case "visit_alarm": {
      const cellChurchScoped = await d1HasColumn(env, "cells", "church_id");
      const visit = cellChurchScoped
        ? await env.DB.prepare(
          `SELECT visit.id FROM visit_notes visit
           JOIN members member ON member.id = visit.member_id
           JOIN cells cell ON cell.id = member.cell_id
           WHERE visit.id = ? AND visit.alarm_id = ? AND visit.alarm_at = ?
             AND cell.church_id = ? AND visit.alarm_state = 'scheduled'`
        ).bind(
          delivery.visitId, delivery.reminderId, delivery.scheduledAt,
          delivery.churchId || "church-seosan"
        ).first()
        : await env.DB.prepare(
          `SELECT id FROM visit_notes
           WHERE id = ? AND alarm_id = ? AND alarm_at = ? AND alarm_state = 'scheduled'`
        ).bind(delivery.visitId, delivery.reminderId, delivery.scheduledAt).first();
      return Boolean(visit);
    }
    case "today_pastoral": {
      if (delivery.reminderId !== koreaDateKey(now)) return false;
      const triggerAt = todayPastoralTriggerAt(delivery.reminderId, todayPastoralNotificationHour(env));
      if (!Number.isFinite(triggerAt.getTime()) || now < triggerAt) return false;
      const summary = await readTodayPastoralNotificationSummary(env, now);
      return summary.notificationCount > 0;
    }
    case "pastoral_assignment": {
      const assignmentChurchScoped = await d1HasColumn(env, "pastoral_assignments", "church_id");
      const assignment = await env.DB.prepare(
        `SELECT id FROM pastoral_assignments
         WHERE id = ? AND assignee_user_id = ?
           ${assignmentChurchScoped ? "AND church_id = ?" : ""}
           AND status IN ('waiting', 'contacted', 'visit_planned')`
      ).bind(
        delivery.reminderId, delivery.targetUserId,
        ...(assignmentChurchScoped ? [delivery.churchId || "church-seosan"] : [])
      ).first();
      return Boolean(assignment);
    }
    default:
      return false;
  }
}

async function resolveDeliveryDevice(env, delivery) {
  let row;
  const deviceChurchScoped = await d1HasColumn(env, "call_note_devices", "church_id");
  if (delivery.kind === "connection_test") {
    row = await env.DB.prepare(
      `SELECT id, generation, target_kind AS targetKind, target_ciphertext AS targetCiphertext,
        target_revision AS targetRevision, relay_target_handle AS relayTargetHandle,
        relay_target_generation AS relayTargetGeneration,
        relay_target_revision AS relayTargetRevision, relay_target_state AS relayTargetState
       FROM call_note_devices
       WHERE id = ? AND generation = ? AND status = 'active'${
         deviceChurchScoped ? " AND church_id = ?" : ""
       }`
    ).bind(
      delivery.deviceId, delivery.deviceGeneration,
      ...(deviceChurchScoped ? [delivery.churchId || "church-seosan"] : [])
    ).first();
  } else {
    row = await env.DB.prepare(
      `SELECT id, generation, target_kind AS targetKind, target_ciphertext AS targetCiphertext,
        target_revision AS targetRevision, relay_target_handle AS relayTargetHandle,
        relay_target_generation AS relayTargetGeneration,
        relay_target_revision AS relayTargetRevision, relay_target_state AS relayTargetState
       FROM call_note_devices
       WHERE status = 'active' AND user_id = ?${deviceChurchScoped ? " AND church_id = ?" : ""}
       ORDER BY generation DESC
       LIMIT 1`
    ).bind(
      delivery.targetUserId || "owner",
      ...(deviceChurchScoped ? [delivery.churchId || "church-seosan"] : [])
    ).first();
  }
  return row ? {
    ...row,
    generation: Number(row.generation || 0),
    targetRevision: Number(row.targetRevision || 1),
    relayTargetGeneration: Number(row.relayTargetGeneration || 0),
    relayTargetRevision: Number(row.relayTargetRevision || 0)
  } : null;
}

async function transitionDelivery(env, delivery, update) {
  const nowIso = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE call_note_push_deliveries
     SET send_state = ?, next_attempt_at = ?, lease_token = '', lease_expires_at = '',
       fcm_message_name = ?, last_http_status = ?, last_error_code = ?,
       accepted_at = CASE WHEN ? <> '' THEN ? ELSE accepted_at END,
       failed_at = CASE WHEN ? <> '' THEN ? ELSE failed_at END,
       updated_at = ?
     WHERE notification_id = ? AND send_state = 'sending' AND lease_token = ?`
  ).bind(
    update.sendState,
    update.nextAttemptAt || nowIso,
    cleanForStorage(update.fcmMessageName, 500),
    Math.max(0, Number(update.httpStatus || 0)),
    cleanForStorage(update.errorCode, 100),
    update.acceptedAt || "", update.acceptedAt || "",
    update.failedAt || "", update.failedAt || "",
    nowIso,
    delivery.notificationId,
    delivery.leaseToken
  ).run();
  return Number(result.meta?.changes || 0) === 1;
}

async function getDeliverySendState(env, notificationId) {
  const row = await env.DB.prepare(
    "SELECT send_state AS sendState FROM call_note_push_deliveries WHERE notification_id = ?"
  ).bind(notificationId).first();
  return String(row?.sendState || "");
}

async function transitionAcceptedDelivery(
  env,
  delivery,
  device,
  fcmMessageName,
  acceptedAt,
  httpStatus = 200
) {
  const acceptedAtIso = acceptedAt.toISOString();
  const result = await env.DB.prepare(
    `UPDATE call_note_push_deliveries
     SET send_state = 'accepted', next_attempt_at = ?, lease_token = '', lease_expires_at = '',
       fcm_message_name = ?, last_http_status = ?, last_error_code = '',
       accepted_at = ?, updated_at = ?
     WHERE notification_id = ? AND send_state = 'sending' AND lease_token = ?
       AND device_id = ? AND device_generation = ? AND target_revision_used = ?
       AND EXISTS (
         SELECT 1 FROM call_note_devices
         WHERE id = ? AND generation = ? AND target_revision = ? AND status = 'active'
       )`
  ).bind(
    acceptedAtIso,
    cleanForStorage(fcmMessageName, 500),
    Math.max(200, Number(httpStatus || 200)),
    acceptedAtIso,
    acceptedAtIso,
    delivery.notificationId,
    delivery.leaseToken,
    device.id,
    device.generation,
    device.targetRevision,
    device.id,
    device.generation,
    device.targetRevision
  ).run();
  return Number(result.meta?.changes || 0) === 1;
}

export async function sendWebPushNotification(vapid, targetValue, delivery) {
  let subscription;
  try {
    subscription = JSON.parse(String(targetValue || ""));
    validateStoredWebPushSubscription(subscription);
  } catch {
    return { kind: "blocked", httpStatus: 0, errorCode: "WEB_PUSH_SUBSCRIPTION_INVALID" };
  }

  const payload = JSON.stringify({
    schemaVersion: 1,
    kind: delivery.kind,
    tag: `pastoral-${delivery.kind}-${delivery.notificationId}`,
    data: {
      notificationId: delivery.notificationId,
      url: delivery.kind === "memo_reminder"
        ? "/memos.html"
        : delivery.kind === "today_pastoral"
          ? "/?open=today-pastoral"
          : delivery.kind === "pastoral_assignment"
            ? "/community.html?open=assignments"
          : "/index.html"
    }
  });
  try {
    const response = await webpush.sendNotification(subscription, payload, {
      vapidDetails: vapid,
      TTL: 7 * 24 * 60 * 60,
      urgency: "high",
      topic: String(delivery.notificationId || "").replace(/-/g, "").slice(0, 32),
      timeout: FETCH_TIMEOUT_MS
    });
    return {
      kind: "accepted",
      httpStatus: Number(response?.statusCode || 201),
      errorCode: "",
      messageName: `webpush:${Number(response?.statusCode || 201)}`
    };
  } catch (error) {
    const status = Math.max(0, Number(error?.statusCode || 0));
    const retryAfterMs = parseRetryAfter(error?.headers?.["retry-after"] || error?.headers?.["Retry-After"]);
    if (status === 404 || status === 410) {
      return { kind: "unregistered", httpStatus: status, errorCode: "WEB_PUSH_SUBSCRIPTION_GONE" };
    }
    if (status === 401 || status === 403) {
      return { kind: "blocked", httpStatus: status, errorCode: "WEB_PUSH_VAPID_REJECTED" };
    }
    if (status === 408 || status === 429 || status >= 500 || status === 0) {
      return {
        kind: "retry",
        httpStatus: status,
        errorCode: status ? `WEB_PUSH_HTTP_${status}` : "WEB_PUSH_NETWORK_ERROR",
        retryAfterMs
      };
    }
    return {
      kind: "dead",
      httpStatus: status,
      errorCode: status ? `WEB_PUSH_HTTP_${status}` : "WEB_PUSH_SEND_FAILED"
    };
  }
}

async function sendWithSingleAuthRefresh(sender, targetKind, targetValue, delivery) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!sender.accessToken) sender.accessToken = await createOauthAccessToken(sender.serviceAccount);
    const response = await sendFcmMessage(
      sender.serviceAccount.project_id,
      sender.accessToken,
      targetKind,
      targetValue,
      delivery,
      sender.siteIdentity.siteId
    );
    if (response.kind === "auth_refresh" && attempt === 0) {
      sender.accessToken = "";
      continue;
    }
    return response.kind === "auth_refresh"
      ? { kind: "blocked", httpStatus: response.httpStatus, errorCode: "FCM_AUTH_FAILED" }
      : response;
  }
  return { kind: "blocked", httpStatus: 401, errorCode: "FCM_AUTH_FAILED" };
}

export async function sendFcmMessage(projectId, accessToken, targetKind, targetValue, delivery, siteId) {
  const canonicalSiteId = String(siteId || "").toLowerCase();
  if (!UUID_PATTERN.test(canonicalSiteId)) {
    return { kind: "blocked", httpStatus: 0, errorCode: "SITE_IDENTITY_INVALID" };
  }
  const noteId = delivery.kind === "memo_reminder"
    ? String(delivery.noteId || "").toLowerCase()
    : "";
  if (delivery.kind === "memo_reminder" && !UUID_PATTERN.test(noteId)) {
    return { kind: "blocked", httpStatus: 0, errorCode: "NOTE_ID_INVALID" };
  }
  const targetField = targetKind === "fid" ? "fid" : "token";
  let response;
  try {
    response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
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
              siteId: canonicalSiteId,
              type: delivery.kind,
              notificationId: delivery.notificationId,
              reminderId: delivery.kind === "memo_reminder"
                || delivery.kind === "visit_alarm"
                || delivery.kind === "today_pastoral"
                ? delivery.reminderId
                : "",
              noteId,
              scheduledAt: delivery.scheduledAt,
              route: `reminders/${delivery.notificationId}`
            },
            android: {
              priority: "HIGH",
              ttl: "604800s"
            }
          }
        }),
        signal: timeoutSignal(FETCH_TIMEOUT_MS)
      }
    );
  } catch (error) {
    return { kind: "retry", httpStatus: 0, errorCode: error?.name === "TimeoutError" ? "FCM_TIMEOUT" : "FCM_NETWORK_ERROR" };
  }

  if (response.ok) {
    let body = {};
    try {
      body = await response.json();
    } catch {
      // HTTP 2xx means FCM accepted the request even if the optional response body cannot be parsed.
    }
    return { kind: "accepted", httpStatus: response.status, messageName: cleanForStorage(body?.name, 500) };
  }

  const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
  let body = {};
  try {
    body = await response.json();
  } catch {
    // Classification still uses the HTTP status without retaining the response body.
  }
  const fcmError = extractFcmErrorCode(body);
  if (response.status === 401) return { kind: "auth_refresh", httpStatus: 401 };
  if (response.status === 403) return { kind: "blocked", httpStatus: 403, errorCode: "FCM_PERMISSION_DENIED" };
  if (response.status === 404 && isUnregisteredFcmTarget(fcmError)) {
    return { kind: "unregistered", httpStatus: 404, errorCode: "FCM_UNREGISTERED" };
  }
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    return {
      kind: "retry",
      httpStatus: response.status,
      errorCode: fcmError || `FCM_HTTP_${response.status}`,
      retryAfterMs
    };
  }
  if (response.status === 400) {
    return { kind: "dead", httpStatus: 400, errorCode: fcmError || "FCM_INVALID_ARGUMENT" };
  }
  return { kind: "dead", httpStatus: response.status, errorCode: fcmError || `FCM_HTTP_${response.status}` };
}

export async function createOauthAccessToken(serviceAccount) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = base64Url(new TextEncoder().encode(JSON.stringify({
    iss: serviceAccount.client_email,
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
      pemPrivateKeyBytes(serviceAccount.private_key),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );
  } catch {
    throw workerError("FCM_PRIVATE_KEY_INVALID", "blocked", 0);
  }
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput)
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
      signal: timeoutSignal(FETCH_TIMEOUT_MS)
    });
  } catch (error) {
    throw workerError(
      error?.name === "TimeoutError" ? "FCM_OAUTH_TIMEOUT" : "FCM_OAUTH_NETWORK_ERROR",
      "retry",
      0
    );
  }
  if (!response.ok) {
    const kind = response.status === 429 || response.status >= 500 ? "retry" : "blocked";
    throw workerError(`FCM_OAUTH_HTTP_${response.status}`, kind, response.status, parseRetryAfter(response.headers.get("Retry-After")));
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw workerError("FCM_OAUTH_RESPONSE_INVALID", "blocked", response.status);
  }
  const accessToken = String(body?.access_token || "");
  if (!accessToken || accessToken.length > 8192) {
    throw workerError("FCM_OAUTH_RESPONSE_INVALID", "blocked", response.status);
  }
  return accessToken;
}

function senderFailureOutcome(error) {
  const kind = error?.deliveryKind === "retry" ? "retry" : "blocked";
  return {
    kind,
    httpStatus: Number(error?.httpStatus || 0),
    errorCode: safeErrorCode(error, "FCM_SENDER_ERROR"),
    retryAfterMs: Number(error?.retryAfterMs || 0)
  };
}

export function normalizeRelayOutcome(value) {
  const kind = String(value?.outcome || "");
  if (!["accepted", "unregistered", "retry", "blocked", "dead"].includes(kind)) {
    return invalidRelayOutcome();
  }
  const httpStatus = value?.httpStatus;
  const retryAfterMs = value?.retryAfterMs;
  const errorCode = value?.errorCode;
  const messageName = value?.messageName;
  if (!Number.isInteger(httpStatus) || httpStatus < 0 || httpStatus > 599
    || !Number.isInteger(retryAfterMs) || retryAfterMs < 0 || retryAfterMs > DELIVERY_MAX_AGE_MS
    || typeof errorCode !== "string" || !/^[A-Z0-9_]{0,100}$/.test(errorCode)
    || typeof messageName !== "string" || Array.from(messageName).length > 500) {
    return invalidRelayOutcome();
  }
  if ((kind === "accepted" && (httpStatus < 200 || httpStatus > 299 || errorCode || retryAfterMs !== 0))
    || (kind !== "accepted" && !errorCode)) {
    return invalidRelayOutcome();
  }
  return {
    kind,
    httpStatus,
    errorCode,
    retryAfterMs,
    messageName: cleanForStorage(messageName, 500)
  };
}

function invalidRelayOutcome() {
  return {
    kind: "retry",
    httpStatus: 502,
    errorCode: "RELAY_RESPONSE_INVALID",
    retryAfterMs: MIN_RETRY_MS,
    messageName: ""
  };
}

function relayFailureOutcome(error) {
  const status = Math.max(0, Number(error?.status || 0));
  const errorCode = cleanForStorage(error?.code, 100) || "RELAY_REQUEST_FAILED";
  if (error instanceof RelayClientError && error.retryable) {
    return {
      kind: "retry",
      httpStatus: status,
      errorCode,
      retryAfterMs: Math.max(0, Number(error.retryAfterMs || 0))
    };
  }
  if (["RELAY_SEND_DISABLED", "RELAY_CONFIGURATION_ERROR"].includes(errorCode)
    || status === 401 || status === 403) {
    return { kind: "blocked", httpStatus: status, errorCode, retryAfterMs: 0 };
  }
  return { kind: "dead", httpStatus: status, errorCode, retryAfterMs: 0 };
}

function normalizePushTransport(value) {
  const transport = String(value || "direct").toLowerCase();
  return transport === "direct" || transport === "relay" || transport === "webpush"
    ? transport
    : "invalid";
}

async function writeDispatcherStatus(env, patch) {
  let previous = {};
  try {
    const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?")
      .bind(DISPATCHER_STATUS_KEY)
      .first();
    previous = JSON.parse(String(row?.value || "{}"));
  } catch {
    previous = {};
  }
  const value = JSON.stringify({
    lastRunAt: cleanForStorage(patch.lastRunAt || previous.lastRunAt, 40),
    lastSuccessAt: cleanForStorage(patch.lastSuccessAt || previous.lastSuccessAt, 40),
    status: cleanForStorage(patch.status || "unknown", 40),
    senderEnabled: Boolean(patch.senderEnabled ?? previous.senderEnabled),
    pushTransport: cleanForStorage(patch.pushTransport || previous.pushTransport || "direct", 20),
    siteId: cleanForStorage(patch.siteId || previous.siteId, 40),
    siteOrigin: cleanForStorage(patch.siteOrigin || previous.siteOrigin, 300),
    siteIdentityConfigured: Boolean(patch.siteIdentityConfigured ?? previous.siteIdentityConfigured),
    relayConfigured: Boolean(patch.relayConfigured ?? previous.relayConfigured),
    webPushConfigured: Boolean(patch.webPushConfigured ?? previous.webPushConfigured),
    fcmConfigured: Boolean(patch.fcmConfigured ?? previous.fcmConfigured),
    notificationSecretConfigured: Boolean(patch.notificationSecretConfigured ?? previous.notificationSecretConfigured),
    processedCount: Math.max(0, Number(patch.processedCount || 0)),
    acceptedCount: Math.max(0, Number(patch.acceptedCount || 0)),
    errorCode: cleanForStorage(patch.errorCode, 100),
    errorDetail: cleanForStorage(patch.errorDetail, 200)
  });
  const nowIso = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(DISPATCHER_STATUS_KEY, value, nowIso).run();
}

function parseServiceAccount(raw) {
  let value;
  try {
    value = JSON.parse(String(raw || ""));
  } catch {
    throw workerError("FCM_SERVICE_ACCOUNT_INVALID");
  }
  const projectId = String(value?.project_id || "");
  const clientEmail = String(value?.client_email || "");
  const privateKey = String(value?.private_key || "");
  if (!/^[a-z0-9][a-z0-9-]{4,61}[a-z0-9]$/i.test(projectId)
    || !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/i.test(clientEmail)
    || !privateKey.includes("-----BEGIN PRIVATE KEY-----")
    || !privateKey.includes("-----END PRIVATE KEY-----")) {
    throw workerError("FCM_SERVICE_ACCOUNT_INVALID");
  }
  return { project_id: projectId, client_email: clientEmail, private_key: privateKey };
}

function parseVapidConfiguration(env) {
  const subject = String(env.VAPID_SUBJECT || "").trim();
  const publicKey = String(env.VAPID_PUBLIC_KEY || "").trim();
  const privateKey = String(env.VAPID_PRIVATE_KEY || "").trim();
  let subjectUrl;
  try {
    subjectUrl = new URL(subject);
  } catch {
    throw workerError("VAPID_CONFIGURATION_INVALID");
  }
  let publicBytes;
  let privateBytes;
  try {
    publicBytes = base64UrlToBytes(publicKey);
    privateBytes = base64UrlToBytes(privateKey);
  } catch {
    throw workerError("VAPID_CONFIGURATION_INVALID");
  }
  if (!["https:", "mailto:"].includes(subjectUrl.protocol)
    || publicBytes.length !== 65 || publicBytes[0] !== 4
    || privateBytes.length !== 32) {
    throw workerError("VAPID_CONFIGURATION_INVALID");
  }
  return { subject, publicKey, privateKey };
}

function validateStoredWebPushSubscription(subscription) {
  const endpoint = new URL(String(subscription?.endpoint || ""));
  const hostname = endpoint.hostname.toLowerCase();
  const hostAllowed = WEB_PUSH_HOSTS.has(hostname)
    || hostname.endsWith(".push.apple.com")
    || hostname.endsWith(".push.services.mozilla.com")
    || hostname.endsWith(".notify.windows.com");
  const p256dh = base64UrlToBytes(String(subscription?.keys?.p256dh || ""));
  const auth = base64UrlToBytes(String(subscription?.keys?.auth || ""));
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || !hostAllowed
    || p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) {
    throw workerError("WEB_PUSH_SUBSCRIPTION_INVALID");
  }
}

function pemPrivateKeyBytes(pem) {
  const base64 = String(pem || "")
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function extractFcmErrorCode(body) {
  const details = Array.isArray(body?.error?.details) ? body.error.details : [];
  for (const detail of details) {
    if (typeof detail?.errorCode === "string") return cleanForStorage(detail.errorCode, 100);
  }
  return "";
}

function isUnregisteredFcmTarget(errorCode) {
  return new Set([
    "UNREGISTERED",
    "INSTALLATION_ID_NOT_REGISTERED",
    "installation-id-not-registered",
    "REGISTRATION_TOKEN_NOT_REGISTERED",
    "registration-token-not-registered"
  ]).has(String(errorCode || ""));
}

function retryAt(now, attemptCount, retryAfterMs = 0) {
  const random = crypto.getRandomValues(new Uint32Array(1))[0] / 0x1_0000_0000;
  return new Date(now.getTime() + computeRetryDelayMs(attemptCount, retryAfterMs, random)).toISOString();
}

export function computeRetryDelayMs(attemptCount, retryAfterMs = 0, random = 0.5) {
  const exponentialMs = Math.min(
    60 * 60 * 1000,
    60 * 1000 * (2 ** Math.max(0, Number(attemptCount || 0) - 1))
  );
  const randomFraction = Math.max(0, Math.min(1, Number.isFinite(Number(random)) ? Number(random) : 0.5));
  const jitteredExponentialMs = Math.round(exponentialMs * (1 + randomFraction * 0.25));
  return Math.min(
    Math.max(Number(retryAfterMs || 0), exponentialMs, jitteredExponentialMs),
    6 * 60 * 60 * 1000
  );
}

function parseRetryAfter(value) {
  const text = String(value || "").trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) return Math.min(Number(text) * 1000, 6 * 60 * 60 * 1000);
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp)
    ? Math.max(0, Math.min(timestamp - Date.now(), 6 * 60 * 60 * 1000))
    : 0;
}

function timeoutSignal(milliseconds) {
  return typeof globalThis.AbortSignal?.timeout === "function"
    ? globalThis.AbortSignal.timeout(milliseconds)
    : undefined;
}

function emptyRunResult(status, purgeResult = {}) {
  return {
    status,
    materialized: 0,
    purged: Number(purgeResult.purged || 0),
    purgeFailed: Number(purgeResult.failed || 0),
    processed: 0,
    accepted: 0,
    retried: 0,
    failed: 0
  };
}

function cleanForStorage(value, maxLength) {
  return Array.from(String(value || "").replace(/[\u0000-\u001f\u007f]/gu, " ").trim())
    .slice(0, maxLength)
    .join("");
}

function safeErrorCode(error, fallback) {
  const code = cleanForStorage(error?.code, 100);
  return /^[A-Z0-9_]+$/.test(code) ? code : fallback;
}

function workerError(code, deliveryKind = "blocked", httpStatus = 0, retryAfterMs = 0) {
  const error = new Error(code);
  error.code = code;
  error.deliveryKind = deliveryKind;
  error.httpStatus = httpStatus;
  error.retryAfterMs = retryAfterMs;
  return error;
}
