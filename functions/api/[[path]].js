import {
  addOrReplacePasskey,
  clearPasskeyStore,
  createPasskeyRegistrationOptions,
  getPasskeyStore,
  publicPasskeyStatus,
  verifyPasskeyRegistration
} from "../_webauthn.js";

const PHOTO_VERSION = "20260704-photo-fix-2";
const DEFAULT_COMMUNITY_TITLE = "청년공동체 목양웹";
const PASSWORD_HASH_KEY = "auth.passwordHash";
const CALL_NOTE_TOKEN_HASH_KEY = "callNote.tokenHash";
const CALL_NOTE_TOKEN_ENCRYPTED_KEY = "callNote.tokenEncrypted";
const COMMUNITY_TITLE_KEY = "app.communityTitle";
const PASSWORD_ALGORITHM = "pbkdf2-sha256";
const PASSWORD_ITERATIONS = 100000;
const MAX_WEBHOOK_BYTES = 128 * 1024;
const MIN_PASSWORD_LENGTH = 12;
const VISIT_META_PREFIX = "visit-meta:";
const CARE_TASK_STATUSES = new Set(["pending", "completed", "cancelled"]);
const PRAYER_STATUSES = new Set(["praying", "answered", "closed"]);
const PRAYER_PRIORITIES = new Set(["normal", "urgent"]);
const ATTENDANCE_STATUSES = new Set(["present", "online", "absent", "military", "study", "other"]);
const CONTENT_SECURITY_POLICY = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
const securityHeaders = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-create=(self), publickey-credentials-get=(self)",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Robots-Tag": "noindex, nofollow, noarchive"
};

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Admin-Token,X-Call-Note-Token,X-Webhook-Token",
  ...securityHeaders
};

export async function onRequest(context) {
  const { request, env, params } = context;
  if (request.method === "OPTIONS") return new Response(null, { headers: jsonHeaders });

  const path = normalizePath(params.path);
  try {
    if (path[0] === "photos") return await handlePhotoRead(env, path.slice(1));
    if (!env.DB) return json({ error: "D1 binding DB is not configured" }, 503);

    if (path[0] === "auth") return await handleAuth(request, env, path);
    if (path[0] === "settings") return await handleSettings(request, env);
    if (path[0] === "call-note-token") return await handleCallNoteToken(request, env);
    if (request.method === "GET" && path[0] === "bootstrap") return await getBootstrap(env);
    if (request.method === "GET" && path[0] === "dashboard") return await getDashboard(env);
    if (path[0] === "members") return await handleMembers(request, env, path);
    if (path[0] === "visit-notes") return await handleVisitNotes(request, env, path);
    if (path[0] === "care-tasks") return await handleCareTasks(request, env, path);
    if (path[0] === "prayer-topics") return await handlePrayerTopics(request, env, path);
    if (path[0] === "sunday-attendance") return await handleSundayAttendance(request, env);
    if (path[0] === "webhook" && path[1] === "call-note") return await handleCallNotes(request, env);
    if (path[0] === "call-notes") return await handleCallNotes(request, env);
    if (path[0] === "call-note-imports") return await handleCallNoteImports(request, env, path);

    return json({ error: "Not found" }, 404);
  } catch (error) {
    return json({ error: error.message || "Server error" }, error.status || 500);
  }
}

function normalizePath(path) {
  if (!path) return [];
  return Array.isArray(path) ? path : String(path).split("/").filter(Boolean);
}

async function getBootstrap(env) {
  const [settings, cells, members, visits, careTasks, prayerTopics] = await Promise.all([
    getPublicSettings(env),
    env.DB.prepare(
      "SELECT id, name, meta, gender, sort_order AS sortOrder FROM cells ORDER BY sort_order, name"
    ).all(),
    env.DB.prepare(
      `SELECT id, cell_id AS cellId, name, title, role, phone, home_phone AS homePhone, birth, registered_at AS registeredAt, address, memo,
        prayer_requests AS prayerRequests,
        baptized, long_absent AS longAbsent, photo_key AS photoKey, archived_at AS archivedAt, trashed_at AS trashedAt, created_at AS createdAt, updated_at AS updatedAt
       FROM members
       WHERE COALESCE(trashed_at, '') = ''
       ORDER BY cell_id, role DESC, name`
    ).all(),
    env.DB.prepare(
      `SELECT id, member_id AS memberId, visit_date AS visitDate, visit_type AS visitType,
        summary, prayer, action, source, created_at AS createdAt
       FROM visit_notes
       ORDER BY visit_date DESC, created_at DESC
       LIMIT 5000`
    ).all(),
    env.DB.prepare(
      `SELECT id, member_id AS memberId, title, due_date AS dueDate, assignee, note, status,
        source_type AS sourceType, source_id AS sourceId, completed_at AS completedAt,
        created_at AS createdAt, updated_at AS updatedAt
       FROM care_tasks
       ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, due_date, updated_at DESC
       LIMIT 5000`
    ).all(),
    env.DB.prepare(
      `SELECT id, member_id AS memberId, content, status, priority, answered_note AS answeredNote,
        source, started_at AS startedAt, answered_at AS answeredAt, closed_at AS closedAt,
        created_at AS createdAt, updated_at AS updatedAt
       FROM prayer_topics
       ORDER BY CASE status WHEN 'praying' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END, updated_at DESC
       LIMIT 5000`
    ).all()
  ]);
  return json({
    settings,
    cells: cells.results || [],
    members: cellsWithPhotoUrls(members.results || []),
    visits: visits.results || [],
    careTasks: (careTasks.results || []).map(normalizeCareTaskRow),
    prayerTopics: (prayerTopics.results || []).map(normalizePrayerTopicRow)
  });
}

async function handleAuth(request, env, path) {
  if (request.method === "GET" && path[1] === "passkey" && path[2] === "register-options") {
    return passkeyRegisterOptions(request, env);
  }
  if (request.method === "POST" && path[1] === "passkey" && path[2] === "register") {
    return registerPasskey(request, env);
  }
  if (request.method === "GET" && path[1] === "passkeys") {
    return passkeyStatus(env);
  }
  if ((request.method === "POST" || request.method === "DELETE") && path[1] === "passkeys" && path[2] === "clear") {
    return clearPasskeys(request, env);
  }
  if (request.method === "POST" && path[1] === "change-password") {
    return changePassword(request, env);
  }
  return json({ error: "Not found" }, 404);
}

async function passkeyStatus(env) {
  return json(publicPasskeyStatus(await getPasskeyStore(env)));
}

async function passkeyRegisterOptions(request, env) {
  await requireWriteAuth(request, env);
  return json(await createPasskeyRegistrationOptions(env, request));
}

async function registerPasskey(request, env) {
  await requireWriteAuth(request, env);
  const body = await safeJson(request);
  const credential = await verifyPasskeyRegistration(env, request, clean(body.token), body.credential);
  const store = await addOrReplacePasskey(env, credential);
  await audit(env, request, "auth.passkey.register", "setting", "auth.passkeys", "", {
    credentialId: credential.id,
    createdAt: credential.createdAt
  });
  return json(publicPasskeyStatus(store), 201);
}

async function clearPasskeys(request, env) {
  await requireWriteAuth(request, env);
  const previous = await getPasskeyStore(env);
  const store = await clearPasskeyStore(env);
  await audit(env, request, "auth.passkey.clear", "setting", "auth.passkeys", {
    count: previous.credentials.length
  }, {
    count: 0,
    clearedAt: new Date().toISOString()
  });
  return json({ ok: true, ...publicPasskeyStatus(store) });
}

async function handleSettings(request, env) {
  await ensureAppSettingsTable(env);

  if (request.method === "GET") {
    return json(await getPublicSettings(env));
  }

  if (request.method === "PATCH") {
    await requireWriteAuth(request, env);
    const body = await safeJson(request);
    const communityTitle = clean(body.communityTitle).slice(0, 40);
    const updatedAt = new Date().toISOString();
    await appSettingStatement(env, COMMUNITY_TITLE_KEY, communityTitle, updatedAt).run();
    await audit(env, request, "settings.update", "setting", COMMUNITY_TITLE_KEY, "", { communityTitle, updatedAt });
    return json({ communityTitle });
  }

  return json({ error: "Method not allowed" }, 405);
}

async function handleCallNoteToken(request, env) {
  await requireWriteAuth(request, env);
  await ensureAppSettingsTable(env);

  if (request.method === "GET") {
    const envTokenConfigured = Boolean(env.CALL_NOTE_TOKEN || env.CALL_NOTE_WEBHOOK_TOKEN);
    const tokenHash = await getCallNoteTokenHash(env);
    const encryptedToken = await getCallNoteTokenEncrypted(env);
    const token = encryptedToken ? await decryptCallNoteToken(encryptedToken, env) : "";
    return json({
      configured: Boolean(envTokenConfigured || tokenHash || token),
      token,
      viewable: Boolean(token),
      legacyOnly: Boolean(tokenHash && !token && !envTokenConfigured),
      source: envTokenConfigured ? "environment" : token ? "database" : tokenHash ? "legacy" : ""
    });
  }

  if (request.method === "POST") {
    const body = await safeJson(request);
    if (clean(body.action) !== "rotate") {
      return json({ error: "Token reissue confirmation is required" }, 400);
    }
    const token = randomToken();
    const tokenHash = await createPasswordHash(token);
    const encryptedToken = await encryptCallNoteToken(token, env);
    const updatedAt = new Date().toISOString();
    await env.DB.batch([
      appSettingStatement(env, CALL_NOTE_TOKEN_HASH_KEY, tokenHash, updatedAt),
      appSettingStatement(env, CALL_NOTE_TOKEN_ENCRYPTED_KEY, encryptedToken, updatedAt)
    ]);
    await audit(env, request, "call_note.token.reissue", "setting", CALL_NOTE_TOKEN_HASH_KEY, "", { updatedAt });
    return json({ configured: true, token, viewable: true, source: "database" });
  }

  return json({ error: "Method not allowed" }, 405);
}

async function changePassword(request, env) {
  const body = await safeJson(request);
  const currentPassword = clean(body.currentPassword);
  const newPassword = clean(body.newPassword);

  if (!currentPassword || !newPassword) {
    return json({ error: "\uD604\uC7AC \uBE44\uBC00\uBC88\uD638\uC640 \uC0C8 \uBE44\uBC00\uBC88\uD638\uB97C \uC785\uB825\uD558\uC138\uC694" }, 400);
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return json({ error: "\uC0C8 \uBE44\uBC00\uBC88\uD638\uB294 12\uC790 \uC774\uC0C1\uC73C\uB85C \uC785\uB825\uD558\uC138\uC694" }, 400);
  }
  if (newPassword === currentPassword) {
    return json({ error: "\uC0C8 \uBE44\uBC00\uBC88\uD638\uB294 \uD604\uC7AC \uBE44\uBC00\uBC88\uD638\uC640 \uB2E4\uB974\uAC8C \uC785\uB825\uD558\uC138\uC694" }, 400);
  }
  if (!(await verifySitePassword(currentPassword, env))) {
    return json({ error: "\uD604\uC7AC \uBE44\uBC00\uBC88\uD638\uAC00 \uB9DE\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4" }, 401);
  }

  await ensureAppSettingsTable(env);
  const passwordHash = await createPasswordHash(newPassword);
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(PASSWORD_HASH_KEY, passwordHash, updatedAt).run();
  await audit(env, request, "auth.password.update", "setting", PASSWORD_HASH_KEY, "", { updatedAt });
  return json({ ok: true });
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function ensureAppSettingsTable(env) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)"
  ).run();
}

function appSettingStatement(env, key, value, updatedAt = new Date().toISOString()) {
  return env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, value, updatedAt);
}

async function getPublicSettings(env) {
  return {
    communityTitle: await getSettingValue(env, COMMUNITY_TITLE_KEY, DEFAULT_COMMUNITY_TITLE)
  };
}

async function getSettingValue(env, key, fallback = "") {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?")
      .bind(key)
      .first();
    return typeof row?.value === "string" ? row.value : fallback;
  } catch {
    return fallback;
  }
}

async function verifySitePassword(password, env) {
  const storedHash = await getStoredPasswordHash(env);
  if (storedHash) return verifyPasswordHash(password, storedHash);
  return Boolean(env.SITE_PASSWORD) && password === env.SITE_PASSWORD;
}

async function getStoredPasswordHash(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?")
      .bind(PASSWORD_HASH_KEY)
      .first();
    return typeof row?.value === "string" ? row.value : "";
  } catch {
    return "";
  }
}

async function getCallNoteTokenHash(env) {
  return getSettingValue(env, CALL_NOTE_TOKEN_HASH_KEY, "");
}

async function getCallNoteTokenEncrypted(env) {
  return getSettingValue(env, CALL_NOTE_TOKEN_ENCRYPTED_KEY, "");
}

async function createPasswordHash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derivePasswordBits(password, salt, PASSWORD_ITERATIONS);
  return `${PASSWORD_ALGORITHM}$${PASSWORD_ITERATIONS}$${base64Url(salt)}$${base64Url(bits)}`;
}

async function verifyPasswordHash(password, storedHash) {
  const [algorithm, iterationsText, saltText, expectedText] = String(storedHash || "").split("$");
  const iterations = Number(iterationsText);
  if (algorithm !== PASSWORD_ALGORITHM || !Number.isFinite(iterations) || !saltText || !expectedText) {
    return false;
  }
  if (iterations > PASSWORD_ITERATIONS) return false;

  try {
    const salt = base64UrlToBytes(saltText);
    const expected = base64UrlToBytes(expectedText);
    const actual = new Uint8Array(await derivePasswordBits(password, salt, iterations));
    return timingSafeBytesEqual(actual, expected);
  } catch {
    return false;
  }
}

async function derivePasswordBits(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256
  );
}

function base64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return base64Url(bytes);
}

async function encryptCallNoteToken(token, env) {
  const key = await callNoteCryptoKey(env, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(token)
  );
  return `v1.${base64Url(iv)}.${base64Url(cipher)}`;
}

async function decryptCallNoteToken(value, env) {
  const parts = String(value || "").split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return "";
  try {
    const key = await callNoteCryptoKey(env, ["decrypt"]);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(parts[1]) },
      key,
      base64UrlToBytes(parts[2])
    );
    return new TextDecoder().decode(plain);
  } catch {
    return "";
  }
}

async function callNoteCryptoKey(env, usages) {
  const secret = env.SESSION_SECRET || "";
  if (!secret) throw new HttpError("토큰 암호화 키가 설정되어 있지 않습니다", 503);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, usages);
}

function base64UrlToBytes(value) {
  const base64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function timingSafeBytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let index = 0; index < a.length; index += 1) {
    result |= a[index] ^ b[index];
  }
  return result === 0;
}

async function getDashboard(env) {
  const today = koreaDateString();
  const taskHorizon = shiftDateString(today, 7);
  const careThreshold = shiftDateString(today, -90);
  const newFamilyThreshold = shiftDateString(today, -60);
  const [membersResult, visitsResult, tasksResult, prayersResult, sessionsResult, attendanceResult] = await Promise.all([
    env.DB.prepare(
      `SELECT m.id, m.cell_id AS cellId, c.name AS cellName, c.sort_order AS cellSortOrder,
        m.name, m.title, m.role, m.phone, m.home_phone AS homePhone, m.birth,
        m.registered_at AS registeredAt, m.long_absent AS longAbsent, m.photo_key AS photoKey
       FROM members m
       JOIN cells c ON c.id = m.cell_id
       WHERE COALESCE(m.archived_at, '') = '' AND COALESCE(m.trashed_at, '') = ''
       ORDER BY c.sort_order, m.name`
    ).all(),
    env.DB.prepare(
      `SELECT member_id AS memberId, visit_date AS visitDate, action
       FROM visit_notes
       ORDER BY visit_date DESC, created_at DESC`
    ).all(),
    env.DB.prepare(
      `SELECT id, member_id AS memberId, title, due_date AS dueDate, assignee, note, status,
        source_type AS sourceType, source_id AS sourceId, completed_at AS completedAt,
        created_at AS createdAt, updated_at AS updatedAt
       FROM care_tasks
       WHERE status = 'pending' AND due_date <= ?
       ORDER BY due_date, updated_at DESC`
    ).bind(taskHorizon).all(),
    env.DB.prepare(
      `SELECT id, member_id AS memberId, content, status, priority, answered_note AS answeredNote,
        source, started_at AS startedAt, answered_at AS answeredAt, closed_at AS closedAt,
        created_at AS createdAt, updated_at AS updatedAt
       FROM prayer_topics
       WHERE status = 'praying' AND priority = 'urgent'
       ORDER BY updated_at DESC`
    ).all(),
    env.DB.prepare(
      `SELECT id, attendance_date AS attendanceDate
       FROM sunday_attendance_sessions
       ORDER BY attendance_date DESC
       LIMIT 4`
    ).all(),
    env.DB.prepare(
      `SELECT r.member_id AS memberId, r.present, r.attendance_status AS attendanceStatus,
        s.attendance_date AS attendanceDate
       FROM sunday_attendance_records r
       JOIN sunday_attendance_sessions s ON s.id = r.session_id
       WHERE s.id IN (
         SELECT id FROM sunday_attendance_sessions ORDER BY attendance_date DESC LIMIT 4
       )
       ORDER BY s.attendance_date DESC`
    ).all()
  ]);

  const members = (membersResult.results || []).map((member) => ({
    ...member,
    longAbsent: truthy(member.longAbsent),
    photoUrl: member.photoKey ? `/api/photos/${encodeURIComponent(member.photoKey)}` : ""
  }));
  const memberById = new Map(members.map((member) => [member.id, member]));
  const lastVisitByMember = new Map();
  for (const row of visitsResult.results || []) {
    if (!lastVisitByMember.has(row.memberId) && !visitIsTrashed(row.action)) {
      lastVisitByMember.set(row.memberId, clean(row.visitDate));
    }
  }
  const sessions = sessionsResult.results || [];
  const attendanceByMember = new Map();
  for (const row of attendanceResult.results || []) {
    if (!attendanceByMember.has(row.memberId)) attendanceByMember.set(row.memberId, []);
    attendanceByMember.get(row.memberId).push(row);
  }

  const birthdays = members
    .map((member) => ({ ...dashboardMember(member), daysUntil: birthdayDaysUntil(member.birth, today) }))
    .filter((member) => member.daysUntil >= 0 && member.daysUntil <= 7)
    .sort((a, b) => a.daysUntil - b.daysUntil || compareDashboardMembers(a, b));

  const newFamilies = members
    .filter((member) => {
      const registeredAt = normalizeStoredDate(member.registeredAt);
      if (!registeredAt || registeredAt < newFamilyThreshold || registeredAt > today) return false;
      const lastVisitDate = lastVisitByMember.get(member.id) || "";
      return !lastVisitDate || lastVisitDate < registeredAt;
    })
    .map((member) => ({
      ...dashboardMember(member),
      registeredAt: normalizeStoredDate(member.registeredAt),
      lastVisitDate: lastVisitByMember.get(member.id) || ""
    }))
    .sort((a, b) => String(b.registeredAt).localeCompare(String(a.registeredAt)) || compareDashboardMembers(a, b));

  const attendanceRisks = members
    .map((member) => {
      const records = attendanceByMember.get(member.id) || [];
      let consecutiveAbsences = 0;
      for (const session of sessions) {
        const record = records.find((item) => item.attendanceDate === session.attendanceDate);
        if (!record || normalizeAttendanceStatus(record.attendanceStatus, record.present) !== "absent") break;
        consecutiveAbsences += 1;
      }
      return {
        ...dashboardMember(member),
        consecutiveAbsences,
        latestAttendanceDate: sessions[0]?.attendanceDate || ""
      };
    })
    .filter((member) => member.consecutiveAbsences >= 3)
    .sort((a, b) => b.consecutiveAbsences - a.consecutiveAbsences || compareDashboardMembers(a, b));

  const careGaps = members
    .map((member) => {
      const lastVisitDate = lastVisitByMember.get(member.id) || "";
      return {
        ...dashboardMember(member),
        lastVisitDate,
        daysSinceCare: lastVisitDate ? daysBetween(lastVisitDate, today) : null
      };
    })
    .filter((member) => !member.lastVisitDate || member.lastVisitDate <= careThreshold)
    .sort((a, b) => {
      if (!a.lastVisitDate && b.lastVisitDate) return -1;
      if (a.lastVisitDate && !b.lastVisitDate) return 1;
      return String(a.lastVisitDate).localeCompare(String(b.lastVisitDate)) || compareDashboardMembers(a, b);
    });

  const tasks = (tasksResult.results || [])
    .map(normalizeCareTaskRow)
    .map((task) => ({
      ...task,
      member: dashboardMember(memberById.get(task.memberId)),
      overdue: task.dueDate < today
    }))
    .filter((task) => task.member.id);

  const urgentPrayers = (prayersResult.results || [])
    .map(normalizePrayerTopicRow)
    .map((topic) => ({ ...topic, member: dashboardMember(memberById.get(topic.memberId)) }))
    .filter((topic) => topic.member.id);

  const attentionMemberIds = new Set([
    ...newFamilies.map((member) => member.id),
    ...attendanceRisks.map((member) => member.id),
    ...careGaps.map((member) => member.id),
    ...tasks.map((task) => task.memberId),
    ...urgentPrayers.map((topic) => topic.memberId)
  ]);

  return json({
    generatedAt: new Date().toISOString(),
    today,
    summary: {
      attentionMembers: attentionMemberIds.size,
      birthdays: birthdays.filter((member) => member.daysUntil === 0).length,
      upcomingBirthdays: birthdays.length,
      newFamilies: newFamilies.length,
      attendanceRisks: attendanceRisks.length,
      careGaps: careGaps.length,
      overdueTasks: tasks.filter((task) => task.overdue).length,
      upcomingTasks: tasks.length,
      urgentPrayers: urgentPrayers.length
    },
    birthdays,
    newFamilies,
    attendanceRisks,
    careGaps,
    tasks,
    urgentPrayers,
    attendanceSessionCount: sessions.length
  });
}

async function getMemberTimeline(env, memberId) {
  const member = await getMember(env, memberId);
  if (!member) return json({ error: "Member not found" }, 404);

  const [visits, attendance, tasks, prayers, audits, cells] = await Promise.all([
    env.DB.prepare(
      `SELECT id, member_id AS memberId, visit_date AS visitDate, visit_type AS visitType,
        summary, prayer, action, source, created_at AS createdAt
       FROM visit_notes WHERE member_id = ?
       ORDER BY visit_date DESC, created_at DESC LIMIT 200`
    ).bind(memberId).all(),
    env.DB.prepare(
      `SELECT s.attendance_date AS attendanceDate, r.present,
        r.attendance_status AS attendanceStatus, s.updated_at AS updatedAt
       FROM sunday_attendance_records r
       JOIN sunday_attendance_sessions s ON s.id = r.session_id
       WHERE r.member_id = ?
       ORDER BY s.attendance_date DESC LIMIT 80`
    ).bind(memberId).all(),
    env.DB.prepare(
      `SELECT id, member_id AS memberId, title, due_date AS dueDate, assignee, note, status,
        source_type AS sourceType, source_id AS sourceId, completed_at AS completedAt,
        created_at AS createdAt, updated_at AS updatedAt
       FROM care_tasks WHERE member_id = ?
       ORDER BY updated_at DESC LIMIT 200`
    ).bind(memberId).all(),
    env.DB.prepare(
      `SELECT id, member_id AS memberId, content, status, priority, answered_note AS answeredNote,
        source, started_at AS startedAt, answered_at AS answeredAt, closed_at AS closedAt,
        created_at AS createdAt, updated_at AS updatedAt
       FROM prayer_topics WHERE member_id = ?
       ORDER BY updated_at DESC LIMIT 200`
    ).bind(memberId).all(),
    env.DB.prepare(
      `SELECT id, action, before_json AS beforeJson, after_json AS afterJson, created_at AS createdAt
       FROM audit_logs
       WHERE entity_type = 'member' AND entity_id = ?
       ORDER BY created_at DESC LIMIT 100`
    ).bind(memberId).all(),
    env.DB.prepare("SELECT id, name FROM cells").all()
  ]);

  const cellNames = new Map((cells.results || []).map((cell) => [cell.id, cell.name]));
  const events = [];

  for (const visit of visits.results || []) {
    if (visitIsTrashed(visit.action)) continue;
    events.push({
      id: `visit:${visit.id}`,
      kind: "visit",
      date: visit.visitDate,
      sortAt: `${visit.visitDate}T12:00:00Z`,
      title: visit.visitType || "심방",
      summary: visit.summary || "",
      detail: visit.prayer || "",
      status: "recorded",
      sourceId: visit.id
    });
  }

  for (const record of attendance.results || []) {
    const status = normalizeAttendanceStatus(record.attendanceStatus, record.present);
    events.push({
      id: `attendance:${record.attendanceDate}`,
      kind: "attendance",
      date: record.attendanceDate,
      sortAt: `${record.attendanceDate}T12:00:00Z`,
      title: attendanceStatusLabel(status),
      summary: "주일출석",
      detail: "",
      status
    });
  }

  for (const row of tasks.results || []) {
    const task = normalizeCareTaskRow(row);
    events.push({
      id: `task:${task.id}`,
      kind: "task",
      date: task.status === "completed" && task.completedAt ? task.completedAt.slice(0, 10) : task.dueDate,
      sortAt: task.completedAt || `${task.dueDate}T12:00:00Z`,
      title: task.status === "completed" ? "후속 돌봄 완료" : "후속 돌봄",
      summary: task.title,
      detail: [task.assignee ? `담당 ${task.assignee}` : "", task.note].filter(Boolean).join(" · "),
      status: task.status,
      sourceId: task.id
    });
  }

  for (const row of prayers.results || []) {
    const topic = normalizePrayerTopicRow(row);
    const eventAt = topic.status === "answered"
      ? topic.answeredAt || topic.updatedAt
      : topic.status === "closed"
        ? topic.closedAt || topic.updatedAt
        : topic.startedAt;
    events.push({
      id: `prayer:${topic.id}`,
      kind: "prayer",
      date: String(eventAt || topic.startedAt).slice(0, 10),
      sortAt: eventAt || topic.updatedAt || topic.startedAt,
      title: topic.status === "answered" ? "기도 응답" : topic.status === "closed" ? "기도 종료" : "기도 중",
      summary: topic.content,
      detail: topic.answeredNote,
      status: topic.status,
      priority: topic.priority,
      sourceId: topic.id
    });
  }

  for (const row of audits.results || []) {
    const before = parseJsonObject(row.beforeJson);
    const after = parseJsonObject(row.afterJson);
    if (!before.cellId || !after.cellId || before.cellId === after.cellId) continue;
    events.push({
      id: `cell:${row.id}`,
      kind: "cell",
      date: String(row.createdAt || "").slice(0, 10),
      sortAt: row.createdAt || "",
      title: "셀 이동",
      summary: `${cellNames.get(before.cellId) || "이전 셀"} → ${cellNames.get(after.cellId) || "새 셀"}`,
      detail: "",
      status: "changed"
    });
  }

  events.sort((a, b) => String(b.sortAt || b.date).localeCompare(String(a.sortAt || a.date)));
  return json({ memberId, events: events.slice(0, 250) });
}

async function handleMembers(request, env, path) {
  const id = path[1];

  if (request.method === "GET" && id && path[2] === "timeline") {
    return getMemberTimeline(env, clean(id));
  }

  if (request.method === "POST" && path.length === 1) {
    await requireWriteAuth(request, env);
    const body = await request.json();
    const member = normalizeMember({ ...body, id: "" }, crypto.randomUUID());
    await env.DB.prepare(
      `INSERT INTO members
        (id, cell_id, name, title, role, phone, home_phone, birth, registered_at, address, memo, prayer_requests, baptized, long_absent, photo_key, archived_at, trashed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      member.id, member.cellId, member.name, member.title, member.role, member.phone, member.homePhone, member.birth, member.registeredAt,
      member.address, member.memo, member.prayerRequests, member.baptized, member.longAbsent, member.photoKey, member.archivedAt, member.trashedAt, member.createdAt, member.updatedAt
    ).run();
    await syncProfilePrayerTopic(env, member.id, member.prayerRequests, member.updatedAt);
    await audit(env, request, "member.create", "member", member.id, "", member);
    return json(cellsWithPhotoUrls([member])[0], 201);
  }

  if (!id) return json({ error: "Member id required" }, 400);

  if (request.method === "PATCH" && path.length === 2) {
    await requireWriteAuth(request, env);
    const body = await request.json();
    const previous = await getMember(env, id);
    if (!previous) return json({ error: "Member not found" }, 404);
    const member = normalizeMember({ ...previous, ...body, id }, id);
    await env.DB.prepare(
      `UPDATE members
       SET cell_id = ?, name = ?, title = ?, role = ?, phone = ?, home_phone = ?, birth = ?, registered_at = ?, address = ?,
        memo = ?, prayer_requests = ?, baptized = ?, long_absent = ?, photo_key = ?, archived_at = ?, trashed_at = ?, updated_at = ?
       WHERE id = ?`
    ).bind(
      member.cellId, member.name, member.title, member.role, member.phone, member.homePhone, member.birth, member.registeredAt, member.address,
      member.memo, member.prayerRequests, member.baptized, member.longAbsent, member.photoKey, member.archivedAt, member.trashedAt, member.updatedAt, id
    ).run();
    if (clean(previous.prayerRequests) !== member.prayerRequests) {
      await syncProfilePrayerTopic(env, member.id, member.prayerRequests, member.updatedAt);
    }
    await audit(env, request, "member.update", "member", id, previous, member);
    return json(cellsWithPhotoUrls([member])[0]);
  }

  if (request.method === "POST" && path[2] === "archive") {
    await requireWriteAuth(request, env);
    const archivedAt = new Date().toISOString();
    await env.DB.prepare("UPDATE members SET archived_at = ?, updated_at = ? WHERE id = ?")
      .bind(archivedAt, archivedAt, id)
      .run();
    await audit(env, request, "member.archive", "member", id, "", { archivedAt });
    return json({ id, archivedAt });
  }

  if (request.method === "POST" && path[2] === "restore") {
    await requireWriteAuth(request, env);
    const updatedAt = new Date().toISOString();
    await env.DB.prepare("UPDATE members SET archived_at = '', updated_at = ? WHERE id = ?")
      .bind(updatedAt, id)
      .run();
    await audit(env, request, "member.restore", "member", id, "", { archivedAt: "" });
    return json({ id, archivedAt: "" });
  }

  if (request.method === "POST" && path[2] === "trash") {
    await requireWriteAuth(request, env);
    const trashedAt = new Date().toISOString();
    await env.DB.prepare("UPDATE members SET trashed_at = ?, updated_at = ? WHERE id = ?")
      .bind(trashedAt, trashedAt, id)
      .run();
    await audit(env, request, "member.trash", "member", id, "", { trashedAt });
    return json({ id, trashedAt });
  }

  if (request.method === "POST" && path[2] === "photo") {
    await requireWriteAuth(request, env);
    return uploadMemberPhoto(request, env, id);
  }

  if (request.method === "DELETE" && path.length === 2) {
    await requireWriteAuth(request, env);
    const previous = await getMember(env, id);
    await env.DB.prepare("DELETE FROM members WHERE id = ?").bind(id).run();
    await audit(env, request, "member.delete", "member", id, previous || "", "");
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
}

async function handleCareTasks(request, env, path) {
  const id = clean(path[1]);

  if (request.method === "GET" && path.length === 1) {
    const memberId = clean(new URL(request.url).searchParams.get("memberId"));
    const query = memberId
      ? env.DB.prepare(
        `SELECT id, member_id AS memberId, title, due_date AS dueDate, assignee, note, status,
          source_type AS sourceType, source_id AS sourceId, completed_at AS completedAt,
          created_at AS createdAt, updated_at AS updatedAt
         FROM care_tasks WHERE member_id = ? ORDER BY due_date, updated_at DESC`
      ).bind(memberId)
      : env.DB.prepare(
        `SELECT id, member_id AS memberId, title, due_date AS dueDate, assignee, note, status,
          source_type AS sourceType, source_id AS sourceId, completed_at AS completedAt,
          created_at AS createdAt, updated_at AS updatedAt
         FROM care_tasks ORDER BY due_date, updated_at DESC LIMIT 5000`
      );
    const rows = await query.all();
    return json({ tasks: (rows.results || []).map(normalizeCareTaskRow) });
  }

  if (request.method === "POST" && path.length === 1) {
    await requireWriteAuth(request, env);
    const body = await safeJson(request);
    const task = normalizeCareTask(body);
    if (!task.memberId || !task.title) return json({ error: "성도와 후속 돌봄 내용을 입력하세요" }, 400);
    normalizeDateValue(task.dueDate, "후속 돌봄 날짜를 입력하세요");
    if (!(await getMember(env, task.memberId))) return json({ error: "성도를 찾을 수 없습니다" }, 404);
    await env.DB.prepare(
      `INSERT INTO care_tasks
        (id, member_id, title, due_date, assignee, note, status, source_type, source_id,
         completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      task.id, task.memberId, task.title, task.dueDate, task.assignee, task.note,
      task.status, task.sourceType, task.sourceId, task.completedAt, task.createdAt, task.updatedAt
    ).run();
    await audit(env, request, "care_task.create", "care_task", task.id, "", task);
    return json(task, 201);
  }

  if (request.method === "PATCH" && id) {
    await requireWriteAuth(request, env);
    const previous = await getCareTask(env, id);
    if (!previous) return json({ error: "후속 돌봄 일정을 찾을 수 없습니다" }, 404);
    const body = await safeJson(request);
    const task = normalizeCareTask({ ...previous, ...body, id, memberId: previous.memberId, createdAt: previous.createdAt });
    if (!task.title) return json({ error: "후속 돌봄 내용을 입력하세요" }, 400);
    normalizeDateValue(task.dueDate, "후속 돌봄 날짜를 입력하세요");
    await env.DB.prepare(
      `UPDATE care_tasks SET title = ?, due_date = ?, assignee = ?, note = ?, status = ?,
        source_type = ?, source_id = ?, completed_at = ?, updated_at = ? WHERE id = ?`
    ).bind(
      task.title, task.dueDate, task.assignee, task.note, task.status, task.sourceType,
      task.sourceId, task.completedAt, task.updatedAt, id
    ).run();
    await audit(env, request, "care_task.update", "care_task", id, previous, task);
    return json(task);
  }

  if (request.method === "DELETE" && id) {
    await requireWriteAuth(request, env);
    const previous = await getCareTask(env, id);
    if (!previous) return json({ error: "후속 돌봄 일정을 찾을 수 없습니다" }, 404);
    await env.DB.prepare("DELETE FROM care_tasks WHERE id = ?").bind(id).run();
    await audit(env, request, "care_task.delete", "care_task", id, previous, "");
    return json({ ok: true });
  }

  return json({ error: "Method not allowed" }, 405);
}

async function handlePrayerTopics(request, env, path) {
  const id = clean(path[1]);

  if (request.method === "GET" && path.length === 1) {
    const memberId = clean(new URL(request.url).searchParams.get("memberId"));
    const query = memberId
      ? env.DB.prepare(
        `SELECT id, member_id AS memberId, content, status, priority, answered_note AS answeredNote,
          source, started_at AS startedAt, answered_at AS answeredAt, closed_at AS closedAt,
          created_at AS createdAt, updated_at AS updatedAt
         FROM prayer_topics WHERE member_id = ? ORDER BY updated_at DESC`
      ).bind(memberId)
      : env.DB.prepare(
        `SELECT id, member_id AS memberId, content, status, priority, answered_note AS answeredNote,
          source, started_at AS startedAt, answered_at AS answeredAt, closed_at AS closedAt,
          created_at AS createdAt, updated_at AS updatedAt
         FROM prayer_topics ORDER BY updated_at DESC LIMIT 5000`
      );
    const rows = await query.all();
    return json({ prayerTopics: (rows.results || []).map(normalizePrayerTopicRow) });
  }

  if (request.method === "POST" && path.length === 1) {
    await requireWriteAuth(request, env);
    const body = await safeJson(request);
    const topic = normalizePrayerTopic(body);
    if (!topic.memberId || !topic.content) return json({ error: "성도와 기도제목을 입력하세요" }, 400);
    if (!(await getMember(env, topic.memberId))) return json({ error: "성도를 찾을 수 없습니다" }, 404);
    await insertPrayerTopic(env, topic).run();
    await audit(env, request, "prayer_topic.create", "prayer_topic", topic.id, "", topic);
    return json(topic, 201);
  }

  if (request.method === "PATCH" && id) {
    await requireWriteAuth(request, env);
    const previous = await getPrayerTopic(env, id);
    if (!previous) return json({ error: "기도제목을 찾을 수 없습니다" }, 404);
    const body = await safeJson(request);
    const topic = normalizePrayerTopic({
      ...previous,
      ...body,
      id,
      memberId: previous.memberId,
      source: previous.source,
      createdAt: previous.createdAt,
      startedAt: previous.startedAt
    });
    if (!topic.content) return json({ error: "기도제목을 입력하세요" }, 400);
    await env.DB.prepare(
      `UPDATE prayer_topics SET content = ?, status = ?, priority = ?, answered_note = ?,
        answered_at = ?, closed_at = ?, updated_at = ? WHERE id = ?`
    ).bind(
      topic.content, topic.status, topic.priority, topic.answeredNote,
      topic.answeredAt, topic.closedAt, topic.updatedAt, id
    ).run();
    const memberPrayerRequests = await syncProfilePrayerFromTopic(env, topic);
    await audit(env, request, "prayer_topic.update", "prayer_topic", id, previous, topic);
    return json({ ...topic, memberPrayerRequests });
  }

  if (request.method === "DELETE" && id) {
    await requireWriteAuth(request, env);
    const previous = await getPrayerTopic(env, id);
    if (!previous) return json({ error: "기도제목을 찾을 수 없습니다" }, 404);
    await env.DB.prepare("DELETE FROM prayer_topics WHERE id = ?").bind(id).run();
    let memberPrayerRequests;
    if (previous.source === "profile") {
      memberPrayerRequests = "";
      await env.DB.prepare("UPDATE members SET prayer_requests = '', updated_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), previous.memberId)
        .run();
    }
    await audit(env, request, "prayer_topic.delete", "prayer_topic", id, previous, "");
    return json({ ok: true, memberPrayerRequests });
  }

  return json({ error: "Method not allowed" }, 405);
}

async function handleVisitNotes(request, env, path) {
  if (request.method === "POST" && path.length === 1) {
    await requireWriteAuth(request, env);
    const body = await request.json();
    const visit = normalizeVisit(body);
    if (!visit.memberId || !visit.summary) return json({ error: "Visit member and summary are required" }, 400);
    await env.DB.prepare(
      `INSERT INTO visit_notes
        (id, member_id, visit_date, visit_type, summary, prayer, action, source, raw_payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      visit.id, visit.memberId, visit.visitDate, visit.visitType, visit.summary,
      visit.prayer, visit.action, visit.source, visit.rawPayload, visit.createdAt
    ).run();
    await audit(env, request, "visit.create", "visit_note", visit.id, "", visit);
    return json(visit, 201);
  }

  if (request.method === "PATCH" && path.length === 2) {
    await requireWriteAuth(request, env);
    const id = clean(path[1]);
    const previous = await getVisitNote(env, id);
    if (!previous) return json({ error: "Visit note not found" }, 404);
    const body = await request.json();
    const visit = normalizeVisit({
      ...previous,
      ...body,
      id,
      memberId: previous.memberId,
      source: previous.source,
      rawPayload: previous.rawPayload,
      createdAt: previous.createdAt
    });
    if (!visit.summary) return json({ error: "Visit summary is required" }, 400);
    await env.DB.prepare(
      `UPDATE visit_notes
       SET visit_date = ?, visit_type = ?, summary = ?, prayer = ?, action = ?, source = ?, raw_payload = ?
       WHERE id = ?`
    ).bind(
      visit.visitDate, visit.visitType, visit.summary, visit.prayer,
      visit.action, visit.source, visit.rawPayload, id
    ).run();
    await audit(env, request, "visit.update", "visit_note", id, previous, visit);
    return json(visit);
  }

  if (request.method === "DELETE" && path.length === 2) {
    await requireWriteAuth(request, env);
    const id = clean(path[1]);
    const previous = await getVisitNote(env, id);
    if (!previous) return json({ error: "Visit note not found" }, 404);
    await env.DB.prepare("DELETE FROM visit_notes WHERE id = ?").bind(id).run();
    await audit(env, request, "visit.delete", "visit_note", id, previous, "");
    return json({ ok: true });
  }

  return json({ error: "Method not allowed" }, 405);
}

async function handleSundayAttendance(request, env) {
  if (request.method === "GET") {
    const url = new URL(request.url);
    const attendanceDate = clean(url.searchParams.get("date"));
    return attendanceDate
      ? getSundayAttendanceByDate(env, attendanceDate)
      : listSundayAttendance(env);
  }

  if (request.method === "POST") {
    await requireWriteAuth(request, env);
    const body = await safeJson(request);
    return saveSundayAttendance(request, env, body);
  }

  return json({ error: "Method not allowed" }, 405);
}

async function listSundayAttendance(env) {
  const rows = await env.DB.prepare(
    `SELECT s.id, s.attendance_date AS attendanceDate, s.label, s.created_at AS createdAt, s.updated_at AS updatedAt,
      COUNT(r.member_id) AS totalCount,
      COALESCE(SUM(CASE WHEN r.present = 1 THEN 1 ELSE 0 END), 0) AS presentCount
     FROM sunday_attendance_sessions s
     LEFT JOIN sunday_attendance_records r ON r.session_id = s.id
     GROUP BY s.id, s.attendance_date, s.label, s.created_at, s.updated_at
     ORDER BY s.attendance_date DESC
     LIMIT 80`
  ).all();
  return json({ sessions: (rows.results || []).map(normalizeAttendanceSessionRow) });
}

async function getSundayAttendanceByDate(env, attendanceDateValue) {
  const attendanceDate = normalizeDateValue(attendanceDateValue, "Attendance date is required");
  const session = await env.DB.prepare(
    `SELECT id, attendance_date AS attendanceDate, label, created_at AS createdAt, updated_at AS updatedAt
     FROM sunday_attendance_sessions
     WHERE attendance_date = ?`
  ).bind(attendanceDate).first();

  if (!session) return json({ session: null, records: [] });

  const records = await getSundayAttendanceRecords(env, session.id);
  return json({
    session: attendanceSessionWithCounts(session, records),
    records: records.map(attendanceRecordWithPhotoUrl)
  });
}

async function saveSundayAttendance(request, env, body) {
  const attendanceDate = normalizeDateValue(body.attendanceDate, "Attendance date is required");
  const label = clean(body.label);
  const presentMemberIds = new Set(
    (Array.isArray(body.presentMemberIds) ? body.presentMemberIds : [])
      .map(clean)
      .filter(Boolean)
  );
  const requestedStatuses = body.attendanceStatuses && typeof body.attendanceStatuses === "object"
    ? body.attendanceStatuses
    : {};
  const now = new Date().toISOString();
  const existing = await env.DB.prepare(
    `SELECT id, attendance_date AS attendanceDate, label, created_at AS createdAt, updated_at AS updatedAt
     FROM sunday_attendance_sessions
     WHERE attendance_date = ?`
  ).bind(attendanceDate).first();
  const sessionId = existing?.id || crypto.randomUUID();
  const createdAt = existing?.createdAt || now;

  const members = await getActiveMembersForAttendance(env);
  const records = members.map((member) => {
    const attendanceStatus = normalizeAttendanceStatus(
      requestedStatuses[member.id],
      presentMemberIds.has(member.id)
    );
    return {
      sessionId,
      memberId: member.id,
      memberName: member.name,
      memberTitle: member.title || "",
      memberRole: member.role || "",
      memberLongAbsent: member.longAbsent ? 1 : 0,
      cellId: member.cellId,
      cellName: member.cellName,
      cellSortOrder: Number(member.cellSortOrder || 0),
      photoKey: member.photoKey || "",
      present: attendanceStatus === "present" || attendanceStatus === "online" ? 1 : 0,
      attendanceStatus,
      createdAt: now,
      updatedAt: now
    };
  });

  const statements = [
    existing
      ? env.DB.prepare(
        "UPDATE sunday_attendance_sessions SET label = ?, updated_at = ? WHERE id = ?"
      ).bind(label, now, sessionId)
      : env.DB.prepare(
        `INSERT INTO sunday_attendance_sessions (id, attendance_date, label, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(sessionId, attendanceDate, label, createdAt, now),
    env.DB.prepare("DELETE FROM sunday_attendance_records WHERE session_id = ?").bind(sessionId),
    ...records.map((record) => env.DB.prepare(
      `INSERT INTO sunday_attendance_records
        (session_id, member_id, member_name, member_title, member_role, member_long_absent, cell_id, cell_name, cell_sort_order, photo_key, present, attendance_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      record.sessionId, record.memberId, record.memberName, record.memberTitle, record.memberRole,
      record.memberLongAbsent, record.cellId, record.cellName, record.cellSortOrder, record.photoKey, record.present,
      record.attendanceStatus, record.createdAt, record.updatedAt
    ))
  ];

  await env.DB.batch(statements);
  const session = attendanceSessionWithCounts({
    id: sessionId,
    attendanceDate,
    label,
    createdAt,
    updatedAt: now
  }, records);

  await audit(env, request, "sunday_attendance.save", "sunday_attendance_session", sessionId, existing || "", {
    attendanceDate,
    totalCount: records.length,
    presentCount: session.presentCount
  });

  return json({
    session,
    records: records.map(attendanceRecordWithPhotoUrl)
  }, existing ? 200 : 201);
}

async function getActiveMembersForAttendance(env) {
  const rows = await env.DB.prepare(
    `SELECT m.id, m.name, m.title, m.role, m.cell_id AS cellId, c.name AS cellName,
      c.sort_order AS cellSortOrder, m.long_absent AS longAbsent, m.photo_key AS photoKey
     FROM members m
     JOIN cells c ON c.id = m.cell_id
     WHERE COALESCE(m.archived_at, '') = ''
       AND COALESCE(m.trashed_at, '') = ''
     ORDER BY c.sort_order, m.long_absent, m.role DESC, m.name`
  ).all();
  return rows.results || [];
}

async function getSundayAttendanceRecords(env, sessionId) {
  const rows = await env.DB.prepare(
    `SELECT session_id AS sessionId, member_id AS memberId, member_name AS memberName,
      member_title AS memberTitle, member_role AS memberRole, member_long_absent AS memberLongAbsent, cell_id AS cellId, cell_name AS cellName,
      cell_sort_order AS cellSortOrder, photo_key AS photoKey, present,
      attendance_status AS attendanceStatus, created_at AS createdAt, updated_at AS updatedAt
     FROM sunday_attendance_records
     WHERE session_id = ?
     ORDER BY cell_sort_order, cell_name, member_name`
  ).bind(sessionId).all();
  return rows.results || [];
}

async function handleCallNotes(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  await requireCallNoteAuth(request, env);
  ensureBodySize(request);
  const payload = await safeJson(request);
  const normalized = await normalizeCallNotePayload(payload);
  if (!normalized.summary) return json({ error: "summary is required" }, 400);

  const existing = await findExistingCallNoteImport(env, normalized.sourceId);
  if (existing) {
    return json({
      status: existing.status,
      duplicate: true,
      importId: existing.id,
      memberId: existing.member_id || "",
      visitId: existing.visit_id || ""
    });
  }

  const match = await resolveCallNoteMember(env, normalized);
  const importId = crypto.randomUUID();

  if (!match.member) {
    await insertCallNoteImport(env, {
      id: importId,
      status: "needs_review",
      normalized,
      memberId: "",
      visitId: "",
      candidates: match.candidates,
      reason: match.reason
    });
    return json({
      status: "needs_review",
      importId,
      reason: match.reason,
      candidates: match.candidates.map(publicMemberCandidate)
    }, 202);
  }

  const visit = normalizeVisit({
    memberId: match.member.id,
    visitDate: normalized.visitDate,
    visitType: normalized.visitType,
    summary: normalized.summary,
    prayer: normalized.prayer,
    action: normalized.action,
    source: "call-note-app",
    rawPayload: normalized.rawPayload
  });

  await env.DB.batch([
    insertVisitStatement(env, visit),
    callNoteImportStatement(env, {
      id: importId,
      status: "attached",
      normalized,
      memberId: match.member.id,
      visitId: visit.id,
      candidates: [match.member],
      reason: match.reason,
      resolvedAt: visit.createdAt
    })
  ]);

  await audit(env, request, "call_note_webhook.attach", "visit_note", visit.id, "", {
    importId,
    memberId: match.member.id,
    sourceId: normalized.sourceId,
    matchReason: match.reason
  });

  return json({
    status: "attached",
    importId,
    memberId: match.member.id,
    visitId: visit.id,
    matchReason: match.reason
  }, 201);
}

async function handleCallNoteImports(request, env, path) {
  await requireWriteAuth(request, env);

  if (request.method === "GET" && path.length === 1) {
    const url = new URL(request.url);
    const status = clean(url.searchParams.get("status")) || "needs_review";
    const rows = await env.DB.prepare(
      `SELECT id, source_id AS sourceId, member_id AS memberId, visit_id AS visitId,
        phone, name, cell_hint AS cellHint, status, summary, candidate_members AS candidateMembers,
        match_reason AS matchReason, payload, created_at AS createdAt, resolved_at AS resolvedAt, updated_at AS updatedAt
       FROM call_note_imports
       WHERE status = ?
       ORDER BY created_at DESC
       LIMIT 100`
    ).bind(status).all();
    return json({ imports: (rows.results || []).map(normalizeCallNoteImportRow) });
  }

  const id = clean(path[1]);
  if (!id) return json({ error: "Import id required" }, 400);

  if (request.method === "POST" && path[2] === "attach") {
    const body = await safeJson(request);
    return attachCallNoteImport(request, env, id, body);
  }

  if (request.method === "POST" && path[2] === "ignore") {
    const now = new Date().toISOString();
    await env.DB.prepare(
      "UPDATE call_note_imports SET status = 'ignored', resolved_at = ?, updated_at = ? WHERE id = ?"
    ).bind(now, now, id).run();
    await audit(env, request, "call_note_import.ignore", "call_note_import", id, "", { status: "ignored" });
    return json({ id, status: "ignored" });
  }

  return json({ error: "Not found" }, 404);
}

async function uploadMemberPhoto(request, env, memberId) {
  if (!env.PHOTOS) return json({ error: "R2 binding PHOTOS is not configured" }, 503);
  const formData = await request.formData();
  const photo = formData.get("photo");
  if (!(photo instanceof File)) return json({ error: "photo file is required" }, 400);
  if (!photo.type.startsWith("image/")) return json({ error: "image file is required" }, 400);

  const safeName = photo.name.replace(/[^\w.-]+/g, "_").slice(-80) || "photo";
  const key = `members/${memberId}/${Date.now()}-${safeName}`;
  await env.PHOTOS.put(key, photo.stream(), {
    httpMetadata: { contentType: photo.type }
  });
  const updatedAt = new Date().toISOString();
  await env.DB.prepare("UPDATE members SET photo_key = ?, updated_at = ? WHERE id = ?")
    .bind(key, updatedAt, memberId)
    .run();
  await audit(env, request, "member.photo.update", "member", memberId, "", { photoKey: key });
  return json({ photoKey: key, photoUrl: `/api/photos/${encodeURIComponent(key)}` });
}

async function handlePhotoRead(env, keyParts) {
  if (!env.PHOTOS) return json({ error: "R2 binding PHOTOS is not configured" }, 503);
  const key = decodeURIComponent(keyParts.join("/"));
  const object = await env.PHOTOS.get(key);
  if (!object) return new Response("Not found", { status: 404, headers: securityHeaders });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", "private, max-age=3600");
  for (const [key, value] of Object.entries(securityHeaders)) {
    headers.set(key, value);
  }
  return new Response(object.body, { headers });
}

async function getMember(env, id) {
  return env.DB.prepare(
    `SELECT id, cell_id AS cellId, name, title, role, phone, home_phone AS homePhone, birth, registered_at AS registeredAt, address, memo,
      prayer_requests AS prayerRequests,
      baptized, long_absent AS longAbsent, photo_key AS photoKey, archived_at AS archivedAt, trashed_at AS trashedAt, created_at AS createdAt, updated_at AS updatedAt
     FROM members WHERE id = ?`
  ).bind(id).first();
}

async function getVisitNote(env, id) {
  return env.DB.prepare(
    `SELECT id, member_id AS memberId, visit_date AS visitDate, visit_type AS visitType,
      summary, prayer, action, source, raw_payload AS rawPayload, created_at AS createdAt
     FROM visit_notes
     WHERE id = ?`
  ).bind(id).first();
}

async function getCareTask(env, id) {
  const row = await env.DB.prepare(
    `SELECT id, member_id AS memberId, title, due_date AS dueDate, assignee, note, status,
      source_type AS sourceType, source_id AS sourceId, completed_at AS completedAt,
      created_at AS createdAt, updated_at AS updatedAt
     FROM care_tasks WHERE id = ?`
  ).bind(id).first();
  return row ? normalizeCareTaskRow(row) : null;
}

async function getPrayerTopic(env, id) {
  const row = await env.DB.prepare(
    `SELECT id, member_id AS memberId, content, status, priority, answered_note AS answeredNote,
      source, started_at AS startedAt, answered_at AS answeredAt, closed_at AS closedAt,
      created_at AS createdAt, updated_at AS updatedAt
     FROM prayer_topics WHERE id = ?`
  ).bind(id).first();
  return row ? normalizePrayerTopicRow(row) : null;
}

async function normalizeCallNotePayload(payload) {
  const rawPayload = JSON.stringify(payload || {});
  const summary = clean(payload.summary || payload.note || payload.memo || payload.content);
  const prayer = clean(payload.prayer || payload.prayerRequest || payload.prayerRequests);
  const action = clean(payload.action || payload.nextAction || payload.followUp);
  const calledAt = clean(payload.calledAt || payload.callDateTime || payload.createdAt || payload.recordedAt);
  const visitDate = normalizeCallNoteDate(payload.visitDate || payload.callDate || payload.date || calledAt);
  const visitType = clean(payload.visitType || payload.type) || "전화";
  const phone = clean(payload.phone || payload.callerPhone || payload.phoneNumber || payload.normalizedPhone);
  const name = clean(payload.name || payload.memberName || payload.contactName || payload.personName);
  const cellHint = clean(payload.cell || payload.cellName || payload.cellHint || payload.cellId);
  const sourceId = clean(payload.sourceId || payload.id || payload.callId || payload.recordingId)
    || await callNoteFingerprint({ phone, name, visitDate, summary, prayer, calledAt });

  return {
    sourceId,
    memberId: clean(payload.memberId),
    name,
    phone,
    normalizedPhone: normalizePhone(phone),
    cellHint,
    visitDate,
    visitType,
    summary,
    prayer,
    action,
    calledAt,
    rawTitle: clean(payload.rawTitle || payload.title),
    rawPayload
  };
}

function normalizeCallNoteDate(value) {
  const text = clean(value);
  const match = text.match(/\b(\d{4})[-.년/]\s*(\d{1,2})[-.월/]\s*(\d{1,2})/);
  if (match) {
    return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  }
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

async function callNoteFingerprint(parts) {
  const data = [parts.phone, parts.name, parts.visitDate, parts.summary, parts.prayer, parts.calledAt]
    .map((part) => clean(part))
    .join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return `call-note-${base64Url(digest).slice(0, 32)}`;
}

async function findExistingCallNoteImport(env, sourceId) {
  if (!sourceId) return null;
  return env.DB.prepare(
    "SELECT id, member_id, visit_id, status FROM call_note_imports WHERE source_id = ? LIMIT 1"
  ).bind(sourceId).first();
}

async function resolveCallNoteMember(env, normalized) {
  const members = await listActiveMembersForMatching(env);

  if (normalized.memberId) {
    const member = members.find((item) => item.id === normalized.memberId);
    if (member) return { member, candidates: [member], reason: "member-id" };
  }

  if (normalized.normalizedPhone) {
    const matches = members.filter((member) => memberPhoneValues(member).includes(normalized.normalizedPhone));
    if (matches.length === 1) return { member: matches[0], candidates: matches, reason: "phone" };
    if (matches.length > 1) return { member: null, candidates: matches, reason: "ambiguous-phone" };
  }

  const specialKim = resolveKnownSpecialName(members, normalized);
  if (specialKim) return specialKim;

  const name = compactKoreanName(normalized.name);
  if (!name) return { member: null, candidates: [], reason: "missing-name-phone" };

  const nameMatches = members.filter((member) => compactKoreanName(member.name) === name);
  const hinted = nameMatches.filter((member) => memberMatchesCellHint(member, normalized.cellHint));
  if (hinted.length === 1) return { member: hinted[0], candidates: hinted, reason: "name-cell" };
  if (hinted.length > 1) return { member: null, candidates: hinted, reason: "ambiguous-name-cell" };
  if (nameMatches.length === 1) return { member: nameMatches[0], candidates: nameMatches, reason: "unique-name" };
  if (nameMatches.length > 1) return { member: null, candidates: nameMatches, reason: "ambiguous-name" };

  return { member: null, candidates: [], reason: "no-match" };
}

function resolveKnownSpecialName(members, normalized) {
  const name = compactKoreanName(normalized.name);
  if (name !== "김미숙") return null;
  const text = [normalized.summary, normalized.prayer, normalized.rawTitle].join(" ");
  const female25 = members.filter((member) => member.cellId === "female-25" && member.name === "김미숙");
  if (text.includes("윤동현")) {
    const member = female25.find((item) => item.role === "prayer_leader");
    if (member) return { member, candidates: [member], reason: "special-kimmisook-yoon" };
  }
  if (text.includes("조성도")) {
    const member = female25.find((item) => String(item.title || "").includes("B"));
    if (member) return { member, candidates: [member], reason: "special-kimmisook-cho" };
  }
  return null;
}

async function listActiveMembersForMatching(env) {
  const rows = await env.DB.prepare(
    `SELECT m.id, m.cell_id AS cellId, c.name AS cellName, c.sort_order AS cellSortOrder,
      m.name, m.title, m.role, m.phone, m.home_phone AS homePhone
     FROM members m
     JOIN cells c ON c.id = m.cell_id
     WHERE COALESCE(m.archived_at, '') = ''
       AND COALESCE(m.trashed_at, '') = ''
     ORDER BY c.sort_order, m.name`
  ).all();
  return rows.results || [];
}

function memberPhoneValues(member) {
  return [member.phone, member.homePhone].map(normalizePhone).filter(Boolean);
}

function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("82") && digits.length >= 11) digits = `0${digits.slice(2)}`;
  return digits;
}

function compactKoreanName(value) {
  return String(value || "")
    .replace(/\([^)]*\)/g, "")
    .replace(/(권사님|집사님|성도님|장로님|권사|집사B|집사|성도|장로|님)/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function memberMatchesCellHint(member, hint) {
  const text = clean(hint);
  if (!text) return false;
  if (text === member.cellId || text === member.cellName) return true;
  const match = text.match(/(남|여)(?:자)?\s*(\d+)\s*셀/);
  if (!match) return false;
  const gender = match[1] === "남" ? "male" : "female";
  return member.cellId === `${gender}-${Number(match[2])}`;
}

async function insertCallNoteImport(env, input) {
  await callNoteImportStatement(env, input).run();
}

function callNoteImportStatement(env, input) {
  const now = new Date().toISOString();
  return env.DB.prepare(
    `INSERT INTO call_note_imports
      (id, source_id, member_id, visit_id, phone, name, cell_hint, status, summary, candidate_members, match_reason, payload, created_at, resolved_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    input.id,
    input.normalized.sourceId,
    input.memberId || "",
    input.visitId || "",
    input.normalized.phone,
    input.normalized.name,
    input.normalized.cellHint,
    input.status,
    input.normalized.summary,
    JSON.stringify((input.candidates || []).map(publicMemberCandidate)),
    input.reason || "",
    input.normalized.rawPayload,
    now,
    input.resolvedAt || "",
    now
  );
}

function insertVisitStatement(env, visit) {
  return env.DB.prepare(
    `INSERT INTO visit_notes
      (id, member_id, visit_date, visit_type, summary, prayer, action, source, raw_payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    visit.id, visit.memberId, visit.visitDate, visit.visitType, visit.summary,
    visit.prayer, visit.action, visit.source, visit.rawPayload, visit.createdAt
  );
}

function publicMemberCandidate(member) {
  return {
    id: member.id,
    name: member.name,
    title: member.title || "",
    role: member.role || "",
    cellId: member.cellId || "",
    cellName: member.cellName || "",
    phone: member.phone || ""
  };
}

function normalizeCallNoteImportRow(row) {
  let payload = {};
  let candidates = [];
  try {
    payload = JSON.parse(row.payload || "{}");
  } catch {
    payload = {};
  }
  try {
    candidates = JSON.parse(row.candidateMembers || "[]");
  } catch {
    candidates = [];
  }
  return {
    ...row,
    payload,
    candidates,
    visitDate: normalizeCallNoteDate(payload.visitDate || payload.callDate || payload.date || payload.calledAt || row.createdAt),
    visitType: clean(payload.visitType || payload.type) || "전화",
    prayer: clean(payload.prayer || payload.prayerRequest || payload.prayerRequests),
    action: clean(payload.action || payload.nextAction || payload.followUp)
  };
}

async function attachCallNoteImport(request, env, id, body) {
  const row = await env.DB.prepare(
    `SELECT id, source_id AS sourceId, status, payload, summary
     FROM call_note_imports
     WHERE id = ?`
  ).bind(id).first();
  if (!row) return json({ error: "Import not found" }, 404);
  if (row.status !== "needs_review") return json({ error: "Import is already resolved" }, 409);

  const memberId = clean(body.memberId);
  const member = memberId ? await getMember(env, memberId) : null;
  if (!member || member.trashedAt || member.archivedAt) return json({ error: "Active member is required" }, 400);

  let payload = {};
  try {
    payload = JSON.parse(row.payload || "{}");
  } catch {
    payload = {};
  }
  const normalized = await normalizeCallNotePayload(payload);
  const visit = normalizeVisit({
    memberId,
    visitDate: body.visitDate || normalized.visitDate,
    visitType: body.visitType || normalized.visitType,
    summary: body.summary || normalized.summary,
    prayer: body.prayer ?? normalized.prayer,
    action: body.action ?? normalized.action,
    source: "call-note-app",
    rawPayload: row.payload
  });
  if (!visit.summary) return json({ error: "Visit summary is required" }, 400);

  const now = new Date().toISOString();
  await env.DB.batch([
    insertVisitStatement(env, visit),
    env.DB.prepare(
      `UPDATE call_note_imports
       SET member_id = ?, visit_id = ?, status = 'attached', summary = ?, resolved_at = ?, updated_at = ?
       WHERE id = ?`
    ).bind(memberId, visit.id, visit.summary, now, now, id)
  ]);

  await audit(env, request, "call_note_import.attach", "visit_note", visit.id, "", {
    importId: id,
    memberId,
    sourceId: row.sourceId || ""
  });

  return json({ importId: id, status: "attached", visit, memberId }, 201);
}

function normalizeCareTask(body) {
  const now = new Date().toISOString();
  const status = CARE_TASK_STATUSES.has(clean(body.status)) ? clean(body.status) : "pending";
  return {
    id: clean(body.id) || crypto.randomUUID(),
    memberId: clean(body.memberId),
    title: clean(body.title).slice(0, 300),
    dueDate: clean(body.dueDate),
    assignee: clean(body.assignee).slice(0, 80),
    note: clean(body.note).slice(0, 2000),
    status,
    sourceType: clean(body.sourceType).slice(0, 40) || "manual",
    sourceId: clean(body.sourceId).slice(0, 120),
    completedAt: status === "completed" ? clean(body.completedAt) || now : "",
    createdAt: clean(body.createdAt) || now,
    updatedAt: now
  };
}

function normalizeCareTaskRow(row) {
  return {
    id: clean(row.id),
    memberId: clean(row.memberId),
    title: clean(row.title),
    dueDate: clean(row.dueDate),
    assignee: clean(row.assignee),
    note: clean(row.note),
    status: CARE_TASK_STATUSES.has(clean(row.status)) ? clean(row.status) : "pending",
    sourceType: clean(row.sourceType) || "manual",
    sourceId: clean(row.sourceId),
    completedAt: clean(row.completedAt),
    createdAt: clean(row.createdAt),
    updatedAt: clean(row.updatedAt)
  };
}

function normalizePrayerTopic(body) {
  const now = new Date().toISOString();
  const status = PRAYER_STATUSES.has(clean(body.status)) ? clean(body.status) : "praying";
  const priority = PRAYER_PRIORITIES.has(clean(body.priority)) ? clean(body.priority) : "normal";
  return {
    id: clean(body.id) || crypto.randomUUID(),
    memberId: clean(body.memberId),
    content: clean(body.content).slice(0, 3000),
    status,
    priority,
    answeredNote: clean(body.answeredNote).slice(0, 2000),
    source: clean(body.source).slice(0, 40) || "manual",
    startedAt: clean(body.startedAt) || now,
    answeredAt: status === "answered" ? clean(body.answeredAt) || now : "",
    closedAt: status === "closed" ? clean(body.closedAt) || now : "",
    createdAt: clean(body.createdAt) || now,
    updatedAt: now
  };
}

function normalizePrayerTopicRow(row) {
  return {
    id: clean(row.id),
    memberId: clean(row.memberId),
    content: clean(row.content),
    status: PRAYER_STATUSES.has(clean(row.status)) ? clean(row.status) : "praying",
    priority: PRAYER_PRIORITIES.has(clean(row.priority)) ? clean(row.priority) : "normal",
    answeredNote: clean(row.answeredNote),
    source: clean(row.source) || "manual",
    startedAt: clean(row.startedAt),
    answeredAt: clean(row.answeredAt),
    closedAt: clean(row.closedAt),
    createdAt: clean(row.createdAt),
    updatedAt: clean(row.updatedAt)
  };
}

function insertPrayerTopic(env, topic) {
  return env.DB.prepare(
    `INSERT INTO prayer_topics
      (id, member_id, content, status, priority, answered_note, source, started_at,
       answered_at, closed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    topic.id, topic.memberId, topic.content, topic.status, topic.priority, topic.answeredNote,
    topic.source, topic.startedAt, topic.answeredAt, topic.closedAt, topic.createdAt, topic.updatedAt
  );
}

async function syncProfilePrayerTopic(env, memberId, content, updatedAt = new Date().toISOString()) {
  const text = clean(content);
  const id = `profile-prayer-${memberId}`;
  if (!text) {
    await env.DB.prepare("DELETE FROM prayer_topics WHERE id = ? AND source = 'profile'").bind(id).run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO prayer_topics
      (id, member_id, content, status, priority, answered_note, source, started_at,
       answered_at, closed_at, created_at, updated_at)
     VALUES (?, ?, ?, 'praying', 'normal', '', 'profile', ?, '', '', ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       content = excluded.content,
       status = 'praying',
       answered_note = '',
       answered_at = '',
       closed_at = '',
       updated_at = excluded.updated_at`
  ).bind(id, memberId, text, updatedAt, updatedAt, updatedAt).run();
}

async function syncProfilePrayerFromTopic(env, topic) {
  if (topic.source !== "profile") return undefined;
  const memberPrayerRequests = topic.status === "praying" ? topic.content : "";
  await env.DB.prepare("UPDATE members SET prayer_requests = ?, updated_at = ? WHERE id = ?")
    .bind(memberPrayerRequests, topic.updatedAt, topic.memberId)
    .run();
  return memberPrayerRequests;
}

function dashboardMember(member) {
  if (!member) return { id: "", name: "", cellId: "", cellName: "", photoUrl: "" };
  return {
    id: clean(member.id),
    name: clean(member.name),
    title: clean(member.title),
    cellId: clean(member.cellId),
    cellName: clean(member.cellName),
    cellSortOrder: Number(member.cellSortOrder || 0),
    phone: clean(member.phone),
    birth: clean(member.birth),
    longAbsent: truthy(member.longAbsent),
    photoUrl: clean(member.photoUrl) || (member.photoKey ? `/api/photos/${encodeURIComponent(member.photoKey)}` : "")
  };
}

function compareDashboardMembers(a, b) {
  const sortDifference = Number(a.cellSortOrder || 0) - Number(b.cellSortOrder || 0);
  if (sortDifference) return sortDifference;
  return String(a.name || "").localeCompare(String(b.name || ""), "ko-KR", { numeric: true });
}

function koreaDateString(date = new Date()) {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function shiftDateString(value, dayOffset) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean(value));
  if (!match) return "";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + Number(dayOffset || 0)));
  return date.toISOString().slice(0, 10);
}

function daysBetween(fromValue, toValue) {
  const from = normalizeStoredDate(fromValue);
  const to = normalizeStoredDate(toValue);
  if (!from || !to) return 0;
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

function normalizeStoredDate(value) {
  const match = /(\d{4})[-./](\d{1,2})[-./](\d{1,2})/.exec(clean(value));
  if (!match) return "";
  const month = String(Number(match[2])).padStart(2, "0");
  const day = String(Number(match[3])).padStart(2, "0");
  return `${match[1]}-${month}-${day}`;
}

function birthdayDaysUntil(birthValue, todayValue) {
  const birth = normalizeStoredDate(birthValue);
  const today = normalizeStoredDate(todayValue);
  if (!birth || !today) return -1;
  const [, month, day] = birth.split("-").map(Number);
  const [year, todayMonth, todayDay] = today.split("-").map(Number);
  const todayUtc = Date.UTC(year, todayMonth - 1, todayDay);
  let birthdayUtc = Date.UTC(year, month - 1, day);
  if (birthdayUtc < todayUtc) birthdayUtc = Date.UTC(year + 1, month - 1, day);
  return Math.round((birthdayUtc - todayUtc) / 86400000);
}

function normalizeAttendanceStatus(value, presentFallback = false) {
  const status = clean(value);
  if (ATTENDANCE_STATUSES.has(status)) return status;
  return truthy(presentFallback) ? "present" : "absent";
}

function attendanceStatusLabel(status) {
  return {
    present: "출석",
    online: "온라인",
    absent: "결석",
    military: "군복무",
    study: "유학",
    other: "기타"
  }[status] || "결석";
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function visitIsTrashed(action) {
  const text = clean(action);
  if (!text.startsWith(VISIT_META_PREFIX)) return false;
  return Boolean(parseJsonObject(text.slice(VISIT_META_PREFIX.length)).trashedAt);
}

function normalizeMember(body, fallbackId) {
  const now = new Date().toISOString();
  return {
    id: clean(body.id) || fallbackId,
    cellId: clean(body.cellId),
    name: clean(body.name),
    title: clean(body.title),
    role: clean(body.role),
    phone: clean(body.phone),
    homePhone: clean(body.homePhone),
    birth: clean(body.birth),
    registeredAt: clean(body.registeredAt),
    address: clean(body.address),
    memo: clean(body.memo),
    prayerRequests: clean(body.prayerRequests),
    baptized: defaultTruthy(body.baptized) ? 1 : 0,
    longAbsent: truthy(body.longAbsent) ? 1 : 0,
    photoKey: clean(body.photoKey),
    archivedAt: clean(body.archivedAt),
    trashedAt: clean(body.trashedAt),
    createdAt: clean(body.createdAt) || now,
    updatedAt: now
  };
}

function normalizeVisit(body) {
  const now = new Date().toISOString();
  return {
    id: clean(body.id) || crypto.randomUUID(),
    memberId: clean(body.memberId),
    visitDate: clean(body.visitDate) || now.slice(0, 10),
    visitType: clean(body.visitType) || "심방",
    summary: clean(body.summary),
    prayer: clean(body.prayer),
    action: clean(body.action),
    source: clean(body.source) || "manual",
    rawPayload: clean(body.rawPayload),
    createdAt: clean(body.createdAt) || now
  };
}

function cellsWithPhotoUrls(members) {
  return members.map((member) => ({
    ...member,
    baptized: defaultTruthy(member.baptized),
    longAbsent: truthy(member.longAbsent),
    photoUrl: member.photoKey
      ? `/api/photos/${encodeURIComponent(member.photoKey)}`
      : ""
  }));
}

function attendanceSessionWithCounts(session, records) {
  const totalCount = records.length;
  const presentCount = records.filter((record) => Number(record.present) === 1).length;
  return {
    id: session.id,
    attendanceDate: session.attendanceDate,
    label: session.label || "",
    totalCount,
    presentCount,
    absentCount: Math.max(totalCount - presentCount, 0),
    createdAt: session.createdAt || "",
    updatedAt: session.updatedAt || ""
  };
}

function normalizeAttendanceSessionRow(row) {
  const totalCount = Number(row.totalCount || 0);
  const presentCount = Number(row.presentCount || 0);
  return {
    id: row.id,
    attendanceDate: row.attendanceDate,
    label: row.label || "",
    totalCount,
    presentCount,
    absentCount: Math.max(totalCount - presentCount, 0),
    createdAt: row.createdAt || "",
    updatedAt: row.updatedAt || ""
  };
}

function attendanceRecordWithPhotoUrl(record) {
  const attendanceStatus = normalizeAttendanceStatus(record.attendanceStatus, record.present);
  return {
    ...record,
    present: attendanceStatus === "present" || attendanceStatus === "online",
    attendanceStatus,
    memberLongAbsent: truthy(record.memberLongAbsent),
    photoUrl: record.photoKey ? `/api/photos/${encodeURIComponent(record.photoKey)}` : ""
  };
}

function normalizeDateValue(value, message) {
  const date = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(message, 400);
  return date;
}

async function requireWriteAuth(request, env) {
  // Write APIs are already protected by functions/_middleware.js before this
  // handler runs. Keep this hook so existing call sites stay explicit without
  // asking logged-in users for a second ADMIN_TOKEN.
}

async function requireCallNoteAuth(request, env) {
  const token = request.headers.get("X-Webhook-Token") || request.headers.get("X-Call-Note-Token") || bearer(request);
  const expected = env.CALL_NOTE_TOKEN || env.CALL_NOTE_WEBHOOK_TOKEN || env.ADMIN_TOKEN || "";
  if (expected) {
    if (!timingSafeStringEqual(token, expected)) throw new HttpError("Unauthorized", 401);
    return;
  }

  const tokenHash = await getCallNoteTokenHash(env);
  if (!tokenHash) throw new HttpError("CALL_NOTE_TOKEN is not configured", 503);
  if (!token || !(await verifyPasswordHash(token, tokenHash))) throw new HttpError("Unauthorized", 401);
}

function ensureBodySize(request) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_WEBHOOK_BYTES) throw new HttpError("Payload too large", 413);
}

async function audit(env, request, action, entityType, entityId, before, after) {
  const actor = request.headers.get("CF-Access-Authenticated-User-Email") || request.headers.get("X-Actor") || "";
  await env.DB.prepare(
    "INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    crypto.randomUUID(), actor, action, entityType, entityId,
    before ? JSON.stringify(before) : "",
    after ? JSON.stringify(after) : ""
  ).run();
}

function bearer(request) {
  const header = request.headers.get("Authorization") || "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7) : "";
}

function timingSafeStringEqual(actual, expected) {
  const actualBytes = new TextEncoder().encode(String(actual || ""));
  const expectedBytes = new TextEncoder().encode(String(expected || ""));
  return timingSafeBytesEqual(actualBytes, expectedBytes);
}

function clean(value) {
  return String(value ?? "").trim();
}

function truthy(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function defaultTruthy(value) {
  return value === undefined || value === null || value === "" ? true : truthy(value);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
