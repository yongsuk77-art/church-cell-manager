const GUEST_SCOPE = "guest";
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOCK_DURATION_MS = 15 * 60 * 1000;
const FAILURE_LIMIT = 20;

export async function getGuestLoginLock(env, now = Date.now()) {
  if (!env?.DB) return { locked: false, lockedUntil: 0 };
  try {
    await ensureLoginLimitsTable(env);
    const row = await env.DB.prepare(
      "SELECT locked_until AS lockedUntil FROM auth_login_limits WHERE scope = ?"
    ).bind(GUEST_SCOPE).first();
    const lockedUntil = Math.max(0, Number(row?.lockedUntil || 0));
    return { locked: lockedUntil > now, lockedUntil };
  } catch {
    // The existing per-IP limiter still applies if D1 is temporarily unavailable.
    return { locked: false, lockedUntil: 0 };
  }
}

export async function recordGuestLoginFailure(env, now = Date.now()) {
  if (!env?.DB) return { locked: false, lockedUntil: 0 };
  try {
    await ensureLoginLimitsTable(env);
    const updatedAt = new Date(now).toISOString();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO auth_login_limits
        (scope, failure_count, window_started_at, locked_until, updated_at)
       VALUES (?, 0, ?, 0, ?)`
    ).bind(GUEST_SCOPE, now, updatedAt).run();

    // One atomic UPDATE prevents parallel requests from losing increments.
    const row = await env.DB.prepare(
      `UPDATE auth_login_limits
       SET failure_count = CASE
             WHEN locked_until > ? THEN failure_count
             WHEN window_started_at + ? > ? THEN failure_count + 1
             ELSE 1
           END,
           window_started_at = CASE
             WHEN locked_until > ? OR window_started_at + ? > ? THEN window_started_at
             ELSE ?
           END,
           locked_until = CASE
             WHEN locked_until > ? THEN locked_until
             WHEN (CASE
               WHEN window_started_at + ? > ? THEN failure_count + 1
               ELSE 1
             END) >= ? THEN ?
             ELSE 0
           END,
           updated_at = ?
       WHERE scope = ?
       RETURNING failure_count AS failureCount, locked_until AS lockedUntil`
    ).bind(
      now,
      FAILURE_WINDOW_MS,
      now,
      now,
      FAILURE_WINDOW_MS,
      now,
      now,
      now,
      FAILURE_WINDOW_MS,
      now,
      FAILURE_LIMIT,
      now + LOCK_DURATION_MS,
      updatedAt,
      GUEST_SCOPE
    ).first();
    const lockedUntil = Math.max(0, Number(row?.lockedUntil || 0));
    return { locked: lockedUntil > now, lockedUntil };
  } catch {
    return { locked: false, lockedUntil: 0 };
  }
}

export async function clearGuestLoginFailures(env) {
  if (!env?.DB) return;
  try {
    await ensureLoginLimitsTable(env);
    await env.DB.prepare("DELETE FROM auth_login_limits WHERE scope = ?")
      .bind(GUEST_SCOPE)
      .run();
  } catch {
    // Best effort: changing or disabling the guest password must still succeed.
  }
}

async function ensureLoginLimitsTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS auth_login_limits (
      scope TEXT PRIMARY KEY,
      failure_count INTEGER NOT NULL DEFAULT 0,
      window_started_at INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`
  ).run();
}
