import {
  base64Url,
  decryptDeviceTarget,
  requireNotificationSecret
} from "../../lib/notification-crypto.js";

const DISPATCHER_STATUS_KEY = "notification.dispatcherStatus";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const MAX_MATERIALIZE = 100;
const MAX_DELIVERIES_PER_RUN = 20;
// A claim starts immediately before its network work. Three minutes comfortably
// covers the bounded OAuth + FCM request path while still recovering quickly.
const LEASE_MS = 3 * 60 * 1000;
const DELIVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DELIVERY_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_SEND_ATTEMPTS = 10;
const FETCH_TIMEOUT_MS = 15 * 1000;

export default {
  async fetch() {
    return new Response("Not Found", { status: 404 });
  },

  async scheduled(controller, env) {
    const startedAt = new Date();
    try {
      const result = await runNotificationDispatcher(env, startedAt);
      console.log(JSON.stringify({
        event: "call_note_push.completed",
        status: result.status,
        materialized: result.materialized,
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

export async function runNotificationDispatcher(env, now = new Date()) {
  if (!env.DB) throw workerError("DATABASE_UNAVAILABLE");
  const senderEnabled = String(env.PUSH_SEND_ENABLED || "").toLowerCase() === "true";
  const configuration = inspectConfiguration(env);
  const baseStatus = {
    lastRunAt: now.toISOString(),
    senderEnabled,
    fcmConfigured: configuration.fcmConfigured,
    notificationSecretConfigured: configuration.notificationSecretConfigured
  };

  if (!senderEnabled) {
    await writeDispatcherStatus(env, { ...baseStatus, status: "disabled", errorCode: "" });
    return emptyRunResult("disabled");
  }
  if (!configuration.ready) {
    await writeDispatcherStatus(env, {
      ...baseStatus,
      status: "configuration_error",
      errorCode: configuration.errorCode
    });
    return emptyRunResult("configuration_error");
  }

  await cleanupState(env, now);
  const memoMaterialized = await materializeDueReminders(env, now);
  const visitMaterialized = await materializeDueVisitAlarms(env, now);
  const materialized = memoMaterialized + visitMaterialized;
  const due = await listDueDeliveries(env, now);
  const sender = {
    serviceAccount: configuration.serviceAccount,
    notificationSecret: configuration.notificationSecret,
    accessToken: ""
  };
  const counters = { processed: 0, accepted: 0, retried: 0, failed: 0 };
  let runErrorCode = "";

  for (const delivery of due) {
    // Do not reuse the cron start time here: a later item in the batch may not
    // be claimed until minutes after the run began.
    const deliveryNow = new Date();
    const claimed = await claimDelivery(env, delivery, deliveryNow);
    if (!claimed) continue;
    counters.processed += 1;
    const result = await processClaimedDelivery(env, claimed, sender, deliveryNow);
    if (result.kind === "accepted") counters.accepted += 1;
    else if (result.kind === "retry") counters.retried += 1;
    else if (result.kind === "failed") counters.failed += 1;
    if (result.errorCode) runErrorCode = result.errorCode;
  }

  const completedAt = new Date().toISOString();
  const status = runErrorCode ? "degraded" : "ready";
  await writeDispatcherStatus(env, {
    ...baseStatus,
    status,
    lastSuccessAt: completedAt,
    processedCount: counters.processed,
    acceptedCount: counters.accepted,
    errorCode: runErrorCode
  });
  return { status, materialized, ...counters };
}

function inspectConfiguration(env) {
  let notificationSecret = "";
  let serviceAccount = null;
  let notificationSecretConfigured = false;
  let fcmConfigured = false;
  let errorCode = "";
  try {
    notificationSecret = requireNotificationSecret(env);
    notificationSecretConfigured = true;
  } catch {
    errorCode = "NOTIFICATION_SECRET_MISSING";
  }
  try {
    serviceAccount = parseServiceAccount(env.FCM_SERVICE_ACCOUNT_JSON);
    fcmConfigured = true;
  } catch {
    if (!errorCode) errorCode = "FCM_SERVICE_ACCOUNT_INVALID";
  }
  return {
    ready: notificationSecretConfigured && fcmConfigured,
    notificationSecretConfigured,
    fcmConfigured,
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
           OR (
             delivery.kind = 'memo_reminder'
             AND NOT EXISTS (
               SELECT 1 FROM notes
               WHERE notes.id = delivery.note_id
                 AND notes.reminder_id = delivery.reminder_id
                 AND delivery.reminder_id <> ''
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

export async function materializeDueReminders(env, now) {
  const oldest = new Date(now.getTime() - DELIVERY_MAX_AGE_MS).toISOString();
  const rows = await env.DB.prepare(
    `SELECT id AS noteId, reminder_id AS reminderId, remind_at AS scheduledAt
     FROM notes
     WHERE status = 'active' AND reminder_state = 'scheduled' AND reminder_id <> ''
       AND remind_at <= ? AND remind_at >= ?
       AND NOT EXISTS (
         SELECT 1 FROM call_note_push_deliveries delivery
         WHERE delivery.kind = 'memo_reminder'
           AND delivery.reminder_id = notes.reminder_id
       )
     ORDER BY remind_at
     LIMIT ?`
  ).bind(now.toISOString(), oldest, MAX_MATERIALIZE).all();
  const statements = (rows.results || []).map((row) => {
    const notificationId = crypto.randomUUID();
    const nowIso = now.toISOString();
    return env.DB.prepare(
      `INSERT OR IGNORE INTO call_note_push_deliveries
        (notification_id, dedupe_key, kind, reminder_id, note_id, device_id, device_generation,
         scheduled_at, send_state, attempt_count, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, 'memo_reminder', ?, ?, NULL, 0, ?, 'pending', 0, ?, ?, ?)`
    ).bind(
      notificationId, `memo:${row.reminderId}`, row.reminderId, row.noteId,
      row.scheduledAt, nowIso, nowIso, nowIso
    );
  });
  if (!statements.length) return 0;
  const results = await env.DB.batch(statements);
  return results.reduce((count, result) => count + Number(result.meta?.changes || 0), 0);
}

export async function materializeDueVisitAlarms(env, now) {
  const oldest = new Date(now.getTime() - DELIVERY_MAX_AGE_MS).toISOString();
  const rows = await env.DB.prepare(
    `SELECT id AS visitId, alarm_id AS alarmId, alarm_at AS scheduledAt
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
  ).bind(now.toISOString(), oldest, MAX_MATERIALIZE).all();
  const statements = (rows.results || []).map((row) => {
    const notificationId = crypto.randomUUID();
    const nowIso = now.toISOString();
    return env.DB.prepare(
      `INSERT OR IGNORE INTO call_note_push_deliveries
        (notification_id, dedupe_key, kind, reminder_id, note_id, visit_id,
         device_id, device_generation, scheduled_at, send_state, attempt_count,
         next_attempt_at, created_at, updated_at)
       VALUES (?, ?, 'visit_alarm', ?, '', ?, NULL, 0, ?, 'pending', 0, ?, ?, ?)`
    ).bind(
      notificationId, `visit:${row.alarmId}`, row.alarmId, row.visitId,
      row.scheduledAt, nowIso, nowIso, nowIso
    );
  });
  if (!statements.length) return 0;
  const results = await env.DB.batch(statements);
  return results.reduce((count, result) => count + Number(result.meta?.changes || 0), 0);
}

async function listDueDeliveries(env, now) {
  const rows = await env.DB.prepare(
    `SELECT notification_id AS notificationId, kind, reminder_id AS reminderId, note_id AS noteId,
      visit_id AS visitId, COALESCE(device_id, '') AS deviceId, device_generation AS deviceGeneration,
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
  ).bind(now.toISOString(), now.toISOString(), MAX_DELIVERIES_PER_RUN).all();
  return rows.results || [];
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
  const valid = await validateDeliverySource(env, delivery);
  if (!valid) {
    const errorCode = delivery.kind === "visit_alarm"
      ? "VISIT_ALARM_CANCELLED"
      : delivery.kind === "memo_reminder"
        ? "REMINDER_CANCELLED"
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

  let targetValue;
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
  try {
    outcome = await sendWithSingleAuthRefresh(sender, device.targetKind, targetValue, delivery);
  } catch (error) {
    outcome = senderFailureOutcome(error);
  }
  const outcomeNow = new Date();

  if (outcome.kind === "accepted") {
    const acceptedAt = outcomeNow;
    const accepted = await transitionAcceptedDelivery(
      env,
      delivery,
      device,
      outcome.messageName,
      acceptedAt
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
       SET status = 'unregistered', last_seen_at = ?, updated_at = ?
       WHERE id = ? AND status = 'active' AND target_revision = ?`
    ).bind(
      outcomeNow.toISOString(),
      outcomeNow.toISOString(),
      device.id,
      device.targetRevision
    ).run();
    const targetStillCurrent = Number(revoked.meta?.changes || 0) === 1;
    await transitionDelivery(env, delivery, {
      sendState: targetStillCurrent ? "waiting_target" : "retry_wait",
      httpStatus: outcome.httpStatus,
      errorCode: "FCM_UNREGISTERED",
      nextAttemptAt: targetStillCurrent
        ? new Date(outcomeNow.getTime() + 15 * 60 * 1000).toISOString()
        : outcomeNow.toISOString()
    });
    return { kind: "retry", errorCode: "FCM_UNREGISTERED" };
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

export async function validateDeliverySource(env, delivery) {
  switch (delivery.kind) {
    case "connection_test":
      return true;
    case "memo_reminder": {
      const note = await env.DB.prepare(
        `SELECT id FROM notes
         WHERE id = ? AND reminder_id = ? AND remind_at = ?
           AND status = 'active' AND reminder_state = 'scheduled'`
      ).bind(delivery.noteId, delivery.reminderId, delivery.scheduledAt).first();
      return Boolean(note);
    }
    case "visit_alarm": {
      const visit = await env.DB.prepare(
        `SELECT id FROM visit_notes
         WHERE id = ? AND alarm_id = ? AND alarm_at = ?
           AND alarm_state = 'scheduled'`
      ).bind(delivery.visitId, delivery.reminderId, delivery.scheduledAt).first();
      return Boolean(visit);
    }
    default:
      return false;
  }
}

async function resolveDeliveryDevice(env, delivery) {
  let row;
  if (delivery.kind === "connection_test") {
    row = await env.DB.prepare(
      `SELECT id, generation, target_kind AS targetKind, target_ciphertext AS targetCiphertext,
        target_revision AS targetRevision
       FROM call_note_devices
       WHERE id = ? AND generation = ? AND status = 'active'`
    ).bind(delivery.deviceId, delivery.deviceGeneration).first();
  } else {
    row = await env.DB.prepare(
      `SELECT id, generation, target_kind AS targetKind, target_ciphertext AS targetCiphertext,
        target_revision AS targetRevision
       FROM call_note_devices
       WHERE status = 'active'
       ORDER BY generation DESC
       LIMIT 1`
    ).first();
  }
  return row ? {
    ...row,
    generation: Number(row.generation || 0),
    targetRevision: Number(row.targetRevision || 1)
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
  acceptedAt
) {
  const acceptedAtIso = acceptedAt.toISOString();
  const result = await env.DB.prepare(
    `UPDATE call_note_push_deliveries
     SET send_state = 'accepted', next_attempt_at = ?, lease_token = '', lease_expires_at = '',
       fcm_message_name = ?, last_http_status = 200, last_error_code = '',
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

async function sendWithSingleAuthRefresh(sender, targetKind, targetValue, delivery) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!sender.accessToken) sender.accessToken = await createOauthAccessToken(sender.serviceAccount);
    const response = await sendFcmMessage(
      sender.serviceAccount.project_id,
      sender.accessToken,
      targetKind,
      targetValue,
      delivery
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

export async function sendFcmMessage(projectId, accessToken, targetKind, targetValue, delivery) {
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
              schemaVersion: "1",
              type: delivery.kind,
              notificationId: delivery.notificationId,
              reminderId: delivery.kind === "memo_reminder" || delivery.kind === "visit_alarm"
                ? delivery.reminderId
                : "",
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
    fcmConfigured: Boolean(patch.fcmConfigured ?? previous.fcmConfigured),
    notificationSecretConfigured: Boolean(patch.notificationSecretConfigured ?? previous.notificationSecretConfigured),
    processedCount: Math.max(0, Number(patch.processedCount || 0)),
    acceptedCount: Math.max(0, Number(patch.acceptedCount || 0)),
    errorCode: cleanForStorage(patch.errorCode, 100)
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

function emptyRunResult(status) {
  return { status, materialized: 0, processed: 0, accepted: 0, retried: 0, failed: 0 };
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
