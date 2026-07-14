import {
  clearPasskeys,
  createPasskeyPasswordResetOptions,
  createPasskeyRegistrationOptions,
  getPasskeyStatus,
  PASSKEYS_KEY,
  registerPasskey,
  verifyPasskeyPasswordReset
} from "../../lib/webauthn.js";
import { handleCallNoteNotificationApi } from "../../lib/call-note-notification-api.js";
import { clearGuestLoginFailures } from "../../lib/login-rate-limit.js";

const PHOTO_VERSION = "20260704-photo-fix-2";
const DEFAULT_COMMUNITY_TITLE = "";
const PASSWORD_HASH_KEY = "auth.passwordHash";
const GUEST_PASSWORD_HASH_KEY = "auth.guestPasswordHash";
const CALL_NOTE_TOKEN_HASH_KEY = "callNote.tokenHash";
const CALL_NOTE_TOKEN_ENCRYPTED_KEY = "callNote.tokenEncrypted";
const COMMUNITY_TITLE_KEY = "app.communityTitle";
const PASSWORD_ALGORITHM = "pbkdf2-sha256";
const PASSWORD_ITERATIONS = 100000;
const MAX_WEBHOOK_BYTES = 128 * 1024;
const MAX_PASSKEY_REQUEST_BYTES = 192 * 1024;
const CALL_NOTE_REVIEW_RETENTION_DAYS = 3;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_BYTES = 128;
const GUEST_PASSWORD_PATTERN = /^\d{4}$/;
const UNASSIGNED_CELL_ID = "__unassigned__";
const GROUP_NAME_MAX_LENGTH = 80;
const GROUP_DESCRIPTION_MAX_LENGTH = 500;
const GROUP_MEMBER_LIMIT = 1000;
const ADMIN_ROLE = "admin";
const GUEST_ROLE = "guest";
const NOTE_TITLE_MAX_LENGTH = 160;
const NOTE_BODY_MAX_LENGTH = 50000;
const NOTE_REFERENCE_ID_MAX_LENGTH = 128;
const NOTE_LIST_LIMIT = 2000;
const NOTE_REQUEST_MAX_BYTES = 256 * 1024;
const NOTE_CATEGORIES = new Set(["personal", "visitation", "admin"]);
const NOTE_STATUSES = new Set(["active", "done"]);
const NOTE_REMINDER_STATES = new Set(["none", "scheduled", "dismissed"]);
const NOTE_COLORS = new Set(["default", "coral", "peach", "yellow", "sage", "mint", "blue", "lavender", "pink", "gray"]);
const NOTE_ATTACHMENT_LIMIT = 8;
const NOTE_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
const NOTE_ATTACHMENT_REQUEST_MAX_BYTES = 10 * 1024 * 1024;
const NOTE_ATTACHMENT_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"
]);
const VISIT_TYPE_ALARM = "알람";
const VISIT_ALARM_STATES = new Set(["none", "scheduled", "dismissed"]);
const VISIT_META_PREFIX = "visit-meta:";

const securityHeaders = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-create=(self), publickey-credentials-get=(self)",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "X-Robots-Tag": "noindex, nofollow, noarchive"
};

const jsonHeaders = {
  ...securityHeaders,
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Admin-Token,X-Call-Note-Token,X-Webhook-Token"
};

export async function onRequest(context) {
  const { request, env, params, data } = context;
  if (request.method === "OPTIONS") return new Response(null, { headers: jsonHeaders });

  const path = normalizePath(params.path);
  const viewerRole = normalizeViewerRole(data?.viewerRole);
  if (viewerRole === GUEST_ROLE && !isGuestSafeRequest(request, path)) {
    return json({ error: "Guest access is limited to contact information" }, 403);
  }
  try {
    if (path[0] === "photos") return await handlePhotoRead(env, path.slice(1), viewerRole);
    if (!env.DB) return json({ error: "D1 binding DB is not configured" }, 503);

    if (path[0] === "auth") return await handleAuth(request, env, path, viewerRole);
    if (path[0] === "integrations" && path[1] === "call-note") {
      return await handleCallNoteNotificationApi({ request, env, path, viewerRole });
    }
    if (path[0] === "settings") return await handleSettings(request, env, viewerRole);
    if (path[0] === "call-note-token") return await handleCallNoteToken(request, env, viewerRole);
    if (request.method === "GET" && path[0] === "bootstrap") return await getBootstrap(env, viewerRole);
    if (path[0] === "notes") return await handleNotes(request, env, path, viewerRole);
    if (path[0] === "groups") return await handleGroups(request, env, path, viewerRole);
    if (path[0] === "members") return await handleMembers(request, env, path, viewerRole);
    if (path[0] === "visit-notes") return await handleVisitNotes(request, env, path, viewerRole);
    if (path[0] === "sunday-attendance") return await handleSundayAttendance(request, env, viewerRole);
    if (path[0] === "webhook" && path[1] === "call-note") return await handleCallNotes(request, env);
    if (path[0] === "call-notes") return await handleCallNotes(request, env);
    if (path[0] === "call-note-imports") return await handleCallNoteImports(request, env, path, viewerRole);

    return json({ error: "Not found" }, 404);
  } catch (error) {
    const payload = { error: error.message || "Server error" };
    if (typeof error.code === "string" && error.code) {
      payload.code = error.code;
    }
    return json(payload, error.status || 500);
  }
}

function normalizePath(path) {
  if (!path) return [];
  return Array.isArray(path) ? path : String(path).split("/").filter(Boolean);
}

function normalizeViewerRole(value) {
  return value === ADMIN_ROLE || value === GUEST_ROLE ? value : "";
}

function isGuestSafeRequest(request, path) {
  return request.method === "GET"
    && (path[0] === "bootstrap" || path[0] === "settings" || path[0] === "photos");
}

async function getBootstrap(env, viewerRole) {
  if (viewerRole === GUEST_ROLE) return getGuestBootstrap(env);
  if (viewerRole !== ADMIN_ROLE) throw new HttpError("Authenticated role is required", 403);

  const settings = await getPublicSettings(env);
  const cells = await env.DB.prepare(
    "SELECT id, name, meta, gender, sort_order AS sortOrder, is_system AS isSystem FROM cells ORDER BY is_system, sort_order, name"
  ).all();
  const groups = await listManagedGroups(env);
  const members = await env.DB.prepare(
    `SELECT id, cell_id AS cellId, name, title, role, phone, home_phone AS homePhone, birth, registered_at AS registeredAt, address, memo,
      prayer_requests AS prayerRequests,
      baptized, long_absent AS longAbsent, photo_key AS photoKey, archived_at AS archivedAt, trashed_at AS trashedAt, created_at AS createdAt, updated_at AS updatedAt
     FROM members
     WHERE COALESCE(trashed_at, '') = ''
     ORDER BY cell_id, role DESC, name`
  ).all();
  const visits = await env.DB.prepare(
    `SELECT id, member_id AS memberId, visit_date AS visitDate, visit_type AS visitType,
      summary, prayer, action, source, alarm_at AS alarmAt, alarm_state AS alarmState,
      alarm_id AS alarmId, dismissed_at AS alarmDismissedAt,
      created_at AS createdAt, updated_at AS updatedAt
     FROM visit_notes
     ORDER BY visit_date DESC, created_at DESC
     LIMIT 5000`
  ).all();
  const notes = await listNotes(env);
  return json({
    viewerRole: ADMIN_ROLE,
    settings,
    cells: (cells.results || []).map(normalizeCellRow),
    groups,
    members: cellsWithPhotoUrls(members.results || []),
    visits: visits.results || [],
    notes
  });
}

async function getGuestBootstrap(env) {
  const [settings, cellRows, groups, memberRows] = await Promise.all([
    getPublicSettings(env),
    env.DB.prepare(
      `SELECT id, name, gender, sort_order AS sortOrder, is_system AS isSystem
       FROM cells
       ORDER BY is_system, sort_order, name`
    ).all(),
    listManagedGroups(env),
    env.DB.prepare(
      `SELECT id, cell_id AS cellId, name, title, role, phone, home_phone AS homePhone,
        address, photo_key AS photoKey
       FROM members
       WHERE COALESCE(archived_at, '') = ''
         AND COALESCE(trashed_at, '') = ''
       ORDER BY cell_id, role DESC, name`
    ).all()
  ]);
  const members = contactMembersWithPhotoUrls(memberRows.results || []);
  const visibleMemberIds = new Set(members.map((member) => member.id));
  return json({
    viewerRole: GUEST_ROLE,
    settings,
    cells: (cellRows.results || []).map(normalizeCellRow),
    groups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      sortOrder: group.sortOrder,
      memberIds: group.memberIds.filter((memberId) => visibleMemberIds.has(memberId))
    })),
    members
  });
}

async function handleAuth(request, env, path, viewerRole) {
  if (path[1] === "guest-password" && path.length === 2) {
    return handleGuestPassword(request, env, viewerRole);
  }

  if (request.method === "POST" && path[1] === "change-password") {
    return changePassword(request, env, viewerRole);
  }

  if (path[1] === "passkey" && path[2] === "password-reset-options" && path.length === 3) {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    await requireWriteAuth(viewerRole);
    return json(await createPasskeyPasswordResetOptions(request, env));
  }

  if (path[1] === "passkey" && path[2] === "reset-password" && path.length === 3) {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    await requireWriteAuth(viewerRole);
    return resetPasswordWithPasskey(request, env);
  }

  if (path[1] === "passkey" && path[2] === "register-options") {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    await requireWriteAuth(viewerRole);
    return json(await createPasskeyRegistrationOptions(request, env));
  }

  if (path[1] === "passkey" && path[2] === "register") {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    await requireWriteAuth(viewerRole);
    const result = await registerPasskey(request, env, await readPasskeyJson(request));
    await audit(env, request, "auth.passkey.register", "setting", PASSKEYS_KEY, "", {
      count: result.count,
      registeredAt: new Date().toISOString()
    });
    return json(result, 201);
  }

  if (path[1] === "passkeys" && path.length === 2) {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    await requireWriteAuth(viewerRole);
    return json(await getPasskeyStatus(request, env));
  }

  if (path[1] === "passkeys" && path[2] === "clear") {
    if (request.method !== "POST" && request.method !== "DELETE") {
      return json({ error: "Method not allowed" }, 405);
    }
    await requireWriteAuth(viewerRole);
    const body = await readPasskeyJson(request);
    if (body.confirm !== "clear") {
      return json({ error: "패스키 삭제 확인이 필요합니다." }, 400);
    }
    const result = await clearPasskeys(request, env);
    await audit(env, request, "auth.passkeys.clear", "setting", PASSKEYS_KEY, "", {
      removed: result.removed,
      clearedAt: new Date().toISOString()
    });
    return json(result);
  }

  return json({ error: "Not found" }, 404);
}

async function readPasskeyJson(request) {
  const contentType = String(request.headers.get("Content-Type") || "").toLowerCase();
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (!contentType.startsWith("application/json")) {
    throw new HttpError("JSON 요청만 사용할 수 있습니다.", 415);
  }
  if (Number.isFinite(contentLength) && contentLength > MAX_PASSKEY_REQUEST_BYTES) {
    throw new HttpError("패스키 요청이 너무 큽니다.", 413);
  }
  const bytes = await readRequestBytes(request, MAX_PASSKEY_REQUEST_BYTES);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    throw new HttpError("패스키 요청 형식이 올바르지 않습니다.", 400);
  }
}

async function readRequestBytes(request, maxBytes) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("request body too large").catch(() => {});
        throw new HttpError("패스키 요청이 너무 큽니다.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function handleSettings(request, env, viewerRole) {
  await ensureAppSettingsTable(env);

  if (request.method === "GET") {
    return json(await getPublicSettings(env));
  }

  if (request.method === "PATCH") {
    await requireWriteAuth(viewerRole);
    const body = await safeJson(request);
    const communityTitle = clean(body.communityTitle).slice(0, 40);
    const updatedAt = new Date().toISOString();
    await appSettingStatement(env, COMMUNITY_TITLE_KEY, communityTitle, updatedAt).run();
    await audit(env, request, "settings.update", "setting", COMMUNITY_TITLE_KEY, "", { communityTitle, updatedAt });
    return json({ communityTitle });
  }

  return json({ error: "Method not allowed" }, 405);
}

async function handleGroups(request, env, path, viewerRole) {
  if (request.method === "GET" && path.length === 1) {
    return json({ groups: await listManagedGroups(env) });
  }

  if (request.method === "POST" && path.length === 1) {
    await requireWriteAuth(viewerRole);
    const body = (await safeJson(request)) || {};
    const name = normalizeManagedGroupName(body.name);
    if (!name) return json({ error: "Group name is required" }, 400);

    const now = new Date().toISOString();
    const group = {
      id: crypto.randomUUID(),
      name,
      description: normalizeManagedGroupDescription(body.description),
      sortOrder: body.sortOrder === undefined
        ? await nextManagedGroupSortOrder(env)
        : normalizeManagedGroupSortOrder(body.sortOrder),
      memberIds: [],
      createdAt: now,
      updatedAt: now
    };
    await ensureManagedGroupNameAvailable(env, group.name);
    await runManagedGroupNameWrite(env.DB.prepare(
      `INSERT INTO managed_groups (id, name, description, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(group.id, group.name, group.description, group.sortOrder, group.createdAt, group.updatedAt));
    await audit(env, request, "group.create", "managed_group", group.id, "", group);
    return json(group, 201);
  }

  const id = clean(path[1]);
  if (!id) return json({ error: "Group id required" }, 400);

  if (request.method === "PATCH" && path.length === 3 && path[2] === "members") {
    await requireWriteAuth(viewerRole);
    return replaceManagedGroupMembers(request, env, id, (await safeJson(request)) || {});
  }

  if (request.method === "PATCH" && path.length === 2) {
    await requireWriteAuth(viewerRole);
    const previous = await getManagedGroup(env, id);
    if (!previous) return json({ error: "Group not found" }, 404);

    const body = (await safeJson(request)) || {};
    const expectedUpdatedAt = clean(body.expectedUpdatedAt);
    if (!expectedUpdatedAt) {
      return json({ error: "expectedUpdatedAt is required", code: "GROUP_PRECONDITION_REQUIRED" }, 428);
    }
    if (expectedUpdatedAt !== previous.updatedAt) {
      return json({ error: "Group changed; reload and try again", code: "GROUP_VERSION_CONFLICT", group: previous }, 409);
    }
    const name = body.name === undefined ? previous.name : normalizeManagedGroupName(body.name);
    if (!name) return json({ error: "Group name is required" }, 400);
    await ensureManagedGroupNameAvailable(env, name, id);
    const updatedAt = nextIsoTimestamp(previous.updatedAt);
    const group = {
      ...previous,
      name,
      description: body.description === undefined
        ? previous.description
        : normalizeManagedGroupDescription(body.description),
      sortOrder: body.sortOrder === undefined
        ? previous.sortOrder
        : normalizeManagedGroupSortOrder(body.sortOrder),
      updatedAt
    };
    const updateResult = await runManagedGroupNameWrite(env.DB.prepare(
      `UPDATE managed_groups
        SET name = ?, description = ?, sort_order = ?, updated_at = ?
        WHERE id = ? AND updated_at = ?`
    ).bind(group.name, group.description, group.sortOrder, group.updatedAt, id, expectedUpdatedAt));
    if (Number(updateResult?.meta?.changes || 0) !== 1) {
      const current = await getManagedGroup(env, id);
      if (!current) return json({ error: "Group not found" }, 404);
      return json({ error: "Group changed; reload and try again", code: "GROUP_VERSION_CONFLICT", group: current }, 409);
    }
    await audit(env, request, "group.update", "managed_group", id, previous, group);
    return json(group);
  }

  if (request.method === "DELETE" && path.length === 2) {
    await requireWriteAuth(viewerRole);
    const previous = await getManagedGroup(env, id);
    if (!previous) return json({ error: "Group not found" }, 404);
    await env.DB.prepare("DELETE FROM managed_groups WHERE id = ?").bind(id).run();
    await audit(env, request, "group.delete", "managed_group", id, previous, "");
    return json({ ok: true, id });
  }

  return json({ error: "Not found" }, 404);
}

async function handleGuestPassword(request, env, viewerRole) {
  await requireWriteAuth(viewerRole);
  await ensureAppSettingsTable(env);

  if (request.method === "GET") {
    return json({ enabled: Boolean(await getSettingValue(env, GUEST_PASSWORD_HASH_KEY, "")) });
  }

  if (request.method === "POST") {
    const body = await readPasskeyJson(request);
    if (typeof body?.password !== "string") {
      return json({ error: "게스트 비밀번호 형식이 올바르지 않습니다" }, 400);
    }
    const password = clean(body.password);
    if (!GUEST_PASSWORD_PATTERN.test(password)) {
      return json({ error: "게스트 비밀번호는 숫자 4자리로 입력하세요" }, 400);
    }
    if (await verifySitePassword(password, env)) {
      return json({ error: "게스트 비밀번호는 관리자 비밀번호와 달라야 합니다" }, 400);
    }
    const wasEnabled = Boolean(await getSettingValue(env, GUEST_PASSWORD_HASH_KEY, ""));
    const passwordHash = await createPasswordHash(password);
    const updatedAt = new Date().toISOString();
    await appSettingStatement(env, GUEST_PASSWORD_HASH_KEY, passwordHash, updatedAt).run();
    await clearGuestLoginFailures(env);
    await audit(env, request, "auth.guest_password.set", "setting", GUEST_PASSWORD_HASH_KEY, {
      enabled: wasEnabled
    }, { enabled: true, updatedAt });
    return json({ enabled: true });
  }

  if (request.method === "DELETE") {
    const wasEnabled = Boolean(await getSettingValue(env, GUEST_PASSWORD_HASH_KEY, ""));
    await env.DB.prepare("DELETE FROM app_settings WHERE key = ?")
      .bind(GUEST_PASSWORD_HASH_KEY)
      .run();
    await clearGuestLoginFailures(env);
    await audit(env, request, "auth.guest_password.disable", "setting", GUEST_PASSWORD_HASH_KEY, {
      enabled: wasEnabled
    }, { enabled: false, updatedAt: new Date().toISOString() });
    return json({ enabled: false });
  }

  return json({ error: "Method not allowed" }, 405);
}

async function replaceManagedGroupMembers(request, env, groupId, body) {
  const previous = await getManagedGroup(env, groupId);
  if (!previous) return json({ error: "Group not found" }, 404);
  if (!Array.isArray(body.memberIds)) {
    return json({ error: "memberIds must be an array" }, 400);
  }

  const memberIds = [...new Set(body.memberIds.map(clean).filter(Boolean))];
  if (memberIds.length > GROUP_MEMBER_LIMIT) {
    return json({ error: `A group can contain at most ${GROUP_MEMBER_LIMIT} members` }, 400);
  }

  const expectedUpdatedAt = clean(body.expectedUpdatedAt);
  if (!expectedUpdatedAt) {
    return json({ error: "expectedUpdatedAt is required", code: "GROUP_PRECONDITION_REQUIRED" }, 428);
  }
  if (expectedUpdatedAt !== previous.updatedAt) {
    return json({ error: "Group membership changed; reload and try again", code: "GROUP_VERSION_CONFLICT", group: previous }, 409);
  }

  const memberIdsJson = JSON.stringify(memberIds);
  const missingRows = await env.DB.prepare(
    `SELECT CAST(requested.value AS TEXT) AS memberId
     FROM json_each(?) requested
     WHERE NOT EXISTS (SELECT 1 FROM members m WHERE m.id = CAST(requested.value AS TEXT))`
  ).bind(memberIdsJson).all();
  const missingMemberIds = (missingRows.results || []).map((row) => clean(row.memberId)).filter(Boolean);
  if (missingMemberIds.length) {
    return json({ error: "One or more members were not found", missingMemberIds }, 400);
  }

  const now = nextIsoTimestamp(previous.updatedAt);
  const results = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM managed_group_members
       WHERE group_id = ?
         AND EXISTS (SELECT 1 FROM managed_groups WHERE id = ? AND updated_at = ?)`
    ).bind(groupId, groupId, expectedUpdatedAt),
    env.DB.prepare(
      `INSERT INTO managed_group_members (group_id, member_id, role, created_at)
       SELECT ?, CAST(requested.value AS TEXT), '', ?
       FROM json_each(?) requested
       WHERE EXISTS (SELECT 1 FROM managed_groups WHERE id = ? AND updated_at = ?)`
    ).bind(groupId, now, memberIdsJson, groupId, expectedUpdatedAt),
    env.DB.prepare(
      "UPDATE managed_groups SET updated_at = ? WHERE id = ? AND updated_at = ?"
    ).bind(now, groupId, expectedUpdatedAt)
  ]);
  if (Number(results[2]?.meta?.changes || 0) !== 1) {
    const current = await getManagedGroup(env, groupId);
    if (!current) return json({ error: "Group not found" }, 404);
    return json({ error: "Group membership changed; reload and try again", code: "GROUP_VERSION_CONFLICT", group: current }, 409);
  }

  const group = await getManagedGroup(env, groupId);
  await audit(env, request, "group.members.replace", "managed_group", groupId, {
    memberIds: previous.memberIds
  }, {
    memberIds: group.memberIds,
    updatedAt: now
  });
  return json(group);
}

async function ensureManagedGroupNameAvailable(env, name, excludeId = "") {
  const existing = await env.DB.prepare(
    "SELECT id FROM managed_groups WHERE name = ? COLLATE NOCASE AND id <> ? LIMIT 1"
  ).bind(name, excludeId).first();
  if (existing) throw new HttpError("A group with this name already exists", 409, "GROUP_NAME_CONFLICT");
}

async function runManagedGroupNameWrite(statement) {
  try {
    return await statement.run();
  } catch (error) {
    const message = String(error?.message || error || "");
    if (/unique constraint failed:\s*managed_groups\.name/i.test(message)
      || message.includes("idx_managed_groups_name_unique_nocase")) {
      throw new HttpError("A group with this name already exists", 409, "GROUP_NAME_CONFLICT");
    }
    throw error;
  }
}

async function listManagedGroups(env) {
  const groupRows = await env.DB.prepare(
    `SELECT id, name, description, sort_order AS sortOrder, created_at AS createdAt, updated_at AS updatedAt
     FROM managed_groups
     ORDER BY sort_order, name, id`
  ).all();
  const groups = (groupRows.results || []).map(normalizeManagedGroupRow);
  if (!groups.length) return [];

  const memberRows = await env.DB.prepare(
    `SELECT group_id AS groupId, member_id AS memberId
     FROM managed_group_members
     ORDER BY created_at, member_id`
  ).all();
  const memberIdsByGroup = new Map(groups.map((group) => [group.id, []]));
  for (const row of memberRows.results || []) {
    memberIdsByGroup.get(row.groupId)?.push(row.memberId);
  }
  return groups.map((group) => ({
    ...group,
    memberIds: memberIdsByGroup.get(group.id) || []
  }));
}

async function getManagedGroup(env, id) {
  const row = await env.DB.prepare(
    `SELECT id, name, description, sort_order AS sortOrder, created_at AS createdAt, updated_at AS updatedAt
     FROM managed_groups
     WHERE id = ?`
  ).bind(id).first();
  if (!row) return null;
  const members = await env.DB.prepare(
    `SELECT member_id AS memberId
     FROM managed_group_members
     WHERE group_id = ?
     ORDER BY created_at, member_id`
  ).bind(id).all();
  return {
    ...normalizeManagedGroupRow(row),
    memberIds: (members.results || []).map((member) => member.memberId)
  };
}

async function nextManagedGroupSortOrder(env) {
  const row = await env.DB.prepare(
    "SELECT COALESCE(MAX(sort_order), 0) + 10 AS sortOrder FROM managed_groups"
  ).first();
  return normalizeManagedGroupSortOrder(row?.sortOrder, 10);
}

function normalizeManagedGroupRow(row) {
  return {
    id: clean(row.id),
    name: clean(row.name),
    description: clean(row.description),
    sortOrder: normalizeManagedGroupSortOrder(row.sortOrder),
    createdAt: clean(row.createdAt),
    updatedAt: clean(row.updatedAt)
  };
}

function normalizeManagedGroupName(value) {
  return clean(value).replace(/\s+/g, " ").slice(0, GROUP_NAME_MAX_LENGTH);
}

function normalizeManagedGroupDescription(value) {
  return clean(value).slice(0, GROUP_DESCRIPTION_MAX_LENGTH);
}

function nextIsoTimestamp(previous = "") {
  const previousMs = Date.parse(clean(previous));
  const nextMs = Number.isFinite(previousMs)
    ? Math.max(Date.now(), previousMs + 1)
    : Date.now();
  return new Date(nextMs).toISOString();
}

function normalizeManagedGroupSortOrder(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new HttpError("sortOrder must be a number", 400);
  return Math.max(-2147483648, Math.min(2147483647, Math.trunc(number)));
}

function normalizeCellRow(row) {
  return {
    ...row,
    isSystem: truthy(row.isSystem)
  };
}

async function handleNotes(request, env, path, viewerRole) {
  await requireWriteAuth(viewerRole);

  if (request.method === "GET" && path.length === 1) {
    return json({ notes: await listNotes(env) });
  }

  if (request.method === "POST" && path.length === 1) {
    ensureNoteRequestSize(request);
    const note = normalizeNoteInput(await safeJson(request));
    await validateNoteLinks(env, note);
    await env.DB.prepare(
      `INSERT INTO notes
        (id, category, title, body, color, pinned, status, member_id, group_id, remind_at, reminder_state, reminder_id, dismissed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), ?, ?, ?, ?, ?, ?)`
    ).bind(
      note.id, note.category, note.title, note.body, note.color, note.pinned ? 1 : 0, note.status,
      note.memberId, note.groupId, note.remindAt, note.reminderState, note.reminderId, note.dismissedAt,
      note.createdAt, note.updatedAt
    ).run();
    await audit(env, request, "note.create", "note", note.id, "", noteAuditShape(note));
    return json(note, 201);
  }

  const id = clean(path[1]);
  if (!id) return json({ error: "Note id is required" }, 400);

  if (request.method === "POST" && path.length === 3 && path[2] === "attachments") {
    return uploadNoteAttachment(request, env, id);
  }

  if (request.method === "DELETE" && path.length === 4 && path[2] === "attachments") {
    return deleteNoteAttachment(request, env, id, clean(path[3]));
  }

  if (request.method === "PATCH" && path.length === 2) {
    ensureNoteRequestSize(request);
    const previous = await getNote(env, id);
    if (!previous) return json({ error: "Note not found" }, 404);
    const body = await safeJson(request);
    const expectedUpdatedAt = clean(body?.expectedUpdatedAt);
    if (!expectedUpdatedAt) {
      return json({ error: "expectedUpdatedAt is required", code: "NOTE_PRECONDITION_REQUIRED" }, 428);
    }
    if (expectedUpdatedAt !== previous.updatedAt) {
      return json({ error: "Note changed; reload and try again", code: "NOTE_VERSION_CONFLICT", note: previous }, 409);
    }
    const note = normalizeNoteInput(body, previous);
    await validateNoteLinks(env, note);
    const updateResult = await env.DB.prepare(
      `UPDATE notes
       SET category = ?, title = ?, body = ?, color = ?, pinned = ?, status = ?, member_id = NULLIF(?, ''),
           group_id = NULLIF(?, ''), remind_at = ?, reminder_state = ?, reminder_id = ?, dismissed_at = ?, updated_at = ?
       WHERE id = ? AND updated_at = ?`
    ).bind(
      note.category, note.title, note.body, note.color, note.pinned ? 1 : 0, note.status,
      note.memberId, note.groupId, note.remindAt, note.reminderState, note.reminderId, note.dismissedAt,
      note.updatedAt, id, expectedUpdatedAt
    ).run();
    if (Number(updateResult?.meta?.changes || 0) !== 1) {
      const current = await getNote(env, id);
      if (!current) return json({ error: "Note not found" }, 404);
      return json({ error: "Note changed; reload and try again", code: "NOTE_VERSION_CONFLICT", note: current }, 409);
    }
    await audit(env, request, "note.update", "note", id, noteAuditShape(previous), noteAuditShape(note));
    return json(note);
  }

  if (request.method === "DELETE" && path.length === 2) {
    const previous = await getNote(env, id);
    if (!previous) return json({ error: "Note not found" }, 404);
    await env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(id).run();
    await deleteR2Objects(env, previous.attachments.map((attachment) => attachment.objectKey));
    await audit(env, request, "note.delete", "note", id, noteAuditShape(previous), "");
    return json({ ok: true, id });
  }

  return json({ error: "Not found" }, 404);
}

async function listNotes(env) {
  const [rows, attachmentRows] = await Promise.all([
    env.DB.prepare(
      `SELECT id, category, title, body, color, pinned, status, COALESCE(member_id, '') AS memberId,
      COALESCE(group_id, '') AS groupId, remind_at AS remindAt, reminder_state AS reminderState,
      reminder_id AS reminderId, dismissed_at AS dismissedAt, created_at AS createdAt, updated_at AS updatedAt
     FROM notes
     ORDER BY pinned DESC, updated_at DESC
     LIMIT ?`
    ).bind(NOTE_LIST_LIMIT).all(),
    env.DB.prepare(
      `SELECT a.id, a.note_id AS noteId, a.object_key AS objectKey, a.file_name AS fileName,
        a.content_type AS contentType, a.byte_size AS byteSize, a.created_at AS createdAt
       FROM note_attachments a
       INNER JOIN (
         SELECT id FROM notes ORDER BY pinned DESC, updated_at DESC LIMIT ?
       ) visible_notes ON visible_notes.id = a.note_id
       ORDER BY a.created_at`
    ).bind(NOTE_LIST_LIMIT).all()
  ]);
  const attachmentsByNote = groupNoteAttachments(attachmentRows.results || []);
  return (rows.results || []).map((row) => normalizeNoteRow(row, attachmentsByNote.get(clean(row.id)) || []));
}

async function getNote(env, id) {
  const [row, attachmentRows] = await Promise.all([
    env.DB.prepare(
      `SELECT id, category, title, body, color, pinned, status, COALESCE(member_id, '') AS memberId,
        COALESCE(group_id, '') AS groupId, remind_at AS remindAt, reminder_state AS reminderState,
        reminder_id AS reminderId, dismissed_at AS dismissedAt, created_at AS createdAt, updated_at AS updatedAt
       FROM notes
       WHERE id = ?`
    ).bind(id).first(),
    env.DB.prepare(
      `SELECT id, note_id AS noteId, object_key AS objectKey, file_name AS fileName,
        content_type AS contentType, byte_size AS byteSize, created_at AS createdAt
       FROM note_attachments
       WHERE note_id = ?
       ORDER BY created_at`
    ).bind(id).all()
  ]);
  return row ? normalizeNoteRow(row, attachmentRows.results || []) : null;
}

function normalizeNoteRow(row, attachments = []) {
  return {
    id: clean(row.id),
    category: clean(row.category),
    title: clean(row.title),
    body: String(row.body ?? ""),
    color: NOTE_COLORS.has(clean(row.color)) ? clean(row.color) : "default",
    pinned: truthy(row.pinned),
    status: clean(row.status),
    memberId: clean(row.memberId),
    groupId: clean(row.groupId),
    remindAt: clean(row.remindAt),
    reminderState: clean(row.reminderState) || "none",
    reminderId: clean(row.reminderId),
    dismissedAt: clean(row.dismissedAt),
    createdAt: clean(row.createdAt),
    updatedAt: clean(row.updatedAt),
    attachments: attachments.map(normalizeNoteAttachmentRow)
  };
}

function normalizeNoteInput(body, previous = null) {
  const input = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const category = normalizeNoteEnum(
    input.category === undefined ? previous?.category || "personal" : input.category,
    NOTE_CATEGORIES,
    "category"
  );
  const legacyTitle = normalizeNoteText(
    input.title === undefined ? previous?.title || "" : input.title,
    NOTE_TITLE_MAX_LENGTH,
    "title"
  );
  const requestedBody = input.body === undefined ? previous?.body || "" : input.body;
  const noteBody = normalizeNoteText(
    clean(requestedBody) || legacyTitle,
    NOTE_BODY_MAX_LENGTH,
    "body",
    true
  );
  const title = deriveNoteTitle(noteBody);
  const color = normalizeNoteEnum(
    input.color === undefined ? previous?.color || "default" : input.color,
    NOTE_COLORS,
    "color"
  );
  const status = normalizeNoteEnum(
    input.status === undefined ? previous?.status || "active" : input.status,
    NOTE_STATUSES,
    "status"
  );
  const pinned = normalizeNoteBoolean(input.pinned, previous?.pinned || false, "pinned");
  const memberId = normalizeNoteReferenceId(
    input.memberId === undefined ? previous?.memberId || "" : input.memberId,
    "memberId"
  );
  const groupId = normalizeNoteReferenceId(
    input.groupId === undefined ? previous?.groupId || "" : input.groupId,
    "groupId"
  );
  const reminder = normalizeNoteReminder(input, previous, status);
  const now = new Date().toISOString();
  return {
    id: previous?.id || crypto.randomUUID(),
    category,
    title,
    body: noteBody,
    color,
    pinned,
    status,
    memberId,
    groupId,
    ...reminder,
    createdAt: previous?.createdAt || now,
    updatedAt: previous ? nextIsoTimestamp(previous.updatedAt) : now,
    attachments: previous?.attachments || []
  };
}

function deriveNoteTitle(body) {
  const firstLine = String(body || "").split(/\r?\n/).find((line) => clean(line));
  return clean(firstLine).slice(0, NOTE_TITLE_MAX_LENGTH);
}

function normalizeNoteReminder(input, previous, status) {
  const remindAtProvided = input.remindAt !== undefined;
  const remindAt = remindAtProvided
    ? normalizeUtcDateTime(input.remindAt, "remindAt", true)
    : previous?.remindAt || "";
  const remindAtChanged = remindAtProvided && remindAt !== (previous?.remindAt || "");
  const requestedState = input.reminderState === undefined
    ? ""
    : normalizeNoteEnum(input.reminderState, NOTE_REMINDER_STATES, "reminderState");

  if (!remindAt && requestedState && requestedState !== "none" && status !== "done") {
    throw new HttpError("remindAt is required for a scheduled or dismissed reminder", 400);
  }
  if (status === "done" || !remindAt || requestedState === "none") {
    return { remindAt: "", reminderState: "none", reminderId: "", dismissedAt: "" };
  }

  const reactivated = previous?.status === "done" && status === "active";
  const reminderState = requestedState
    || (remindAtChanged || reactivated ? "scheduled" : previous?.reminderState || "scheduled");
  if (reminderState === "dismissed") {
    const dismissedAt = requestedState === "dismissed"
      ? new Date().toISOString()
      : previous?.dismissedAt || new Date().toISOString();
    return { remindAt, reminderState, reminderId: previous?.reminderId || "", dismissedAt };
  }
  const reminderReactivated = previous?.reminderState === "dismissed" && requestedState === "scheduled";
  const reminderId = !previous || remindAtChanged || reminderReactivated
    ? crypto.randomUUID()
    : previous.reminderId || "";
  return { remindAt, reminderState: "scheduled", reminderId, dismissedAt: "" };
}

function normalizeNoteEnum(value, allowed, field) {
  const normalized = clean(value);
  if (!allowed.has(normalized)) {
    throw new HttpError(`${field} has an unsupported value`, 400);
  }
  return normalized;
}

function normalizeNoteText(value, maxLength, field, required = false) {
  const normalized = String(value ?? "").trim();
  if (required && !normalized) throw new HttpError(`${field} is required`, 400);
  if (normalized.length > maxLength) {
    throw new HttpError(`${field} must be ${maxLength} characters or fewer`, 400);
  }
  return normalized;
}

function normalizeNoteBoolean(value, fallback, field) {
  if (value === undefined) return Boolean(fallback);
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  throw new HttpError(`${field} must be a boolean`, 400);
}

function normalizeNoteReferenceId(value, field) {
  const normalized = clean(value);
  if (normalized.length > NOTE_REFERENCE_ID_MAX_LENGTH) {
    throw new HttpError(`${field} is too long`, 400);
  }
  return normalized;
}

function normalizeUtcDateTime(value, field, optional = false) {
  const text = clean(value);
  if (!text && optional) return "";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) {
    throw new HttpError(`${field} must be an ISO date-time with a timezone`, 400);
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new HttpError(`${field} is invalid`, 400);
  return new Date(timestamp).toISOString();
}

async function validateNoteLinks(env, note) {
  const [member, group] = await Promise.all([
    note.memberId
      ? env.DB.prepare("SELECT id FROM members WHERE id = ?").bind(note.memberId).first()
      : Promise.resolve({ id: "" }),
    note.groupId
      ? env.DB.prepare("SELECT id FROM managed_groups WHERE id = ?").bind(note.groupId).first()
      : Promise.resolve({ id: "" })
  ]);
  if (note.memberId && !member) throw new HttpError("Linked member was not found", 400);
  if (note.groupId && !group) throw new HttpError("Linked group was not found", 400);
}

function ensureNoteRequestSize(request) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(contentLength) && contentLength > NOTE_REQUEST_MAX_BYTES) {
    throw new HttpError("Note request is too large", 413);
  }
}

function noteAuditShape(note) {
  return {
    category: note.category,
    title: note.title,
    bodyLength: note.body.length,
    color: note.color,
    pinned: note.pinned,
    status: note.status,
    memberId: note.memberId,
    groupId: note.groupId,
    remindAt: note.remindAt,
    reminderState: note.reminderState,
    reminderId: note.reminderId,
    dismissedAt: note.dismissedAt,
    updatedAt: note.updatedAt,
    attachmentCount: Array.isArray(note.attachments) ? note.attachments.length : 0
  };
}

async function uploadNoteAttachment(request, env, noteId) {
  if (!env.PHOTOS) return json({ error: "R2 binding PHOTOS is not configured" }, 503);
  ensureNoteAttachmentRequestSize(request);
  const note = await getNote(env, noteId);
  if (!note) return json({ error: "Note not found" }, 404);
  if (note.attachments.length >= NOTE_ATTACHMENT_LIMIT) {
    return json({ error: `A note can have up to ${NOTE_ATTACHMENT_LIMIT} photos` }, 400);
  }

  const formData = await request.formData();
  const photo = formData.get("photo");
  if (!(photo instanceof File)) return json({ error: "photo file is required" }, 400);
  if (!NOTE_ATTACHMENT_TYPES.has(clean(photo.type).toLowerCase())) {
    return json({ error: "JPEG, PNG, WebP, GIF, HEIC, or HEIF image is required" }, 400);
  }
  if (!photo.size || photo.size > NOTE_ATTACHMENT_MAX_BYTES) {
    return json({ error: `Each photo must be ${NOTE_ATTACHMENT_MAX_BYTES / 1024 / 1024} MB or smaller` }, 413);
  }

  const attachmentId = crypto.randomUUID();
  const safeName = normalizeAttachmentFileName(photo.name);
  const objectKey = `notes/${noteId}/${attachmentId}-${safeName}`;
  const createdAt = new Date().toISOString();
  await env.PHOTOS.put(objectKey, photo.stream(), {
    httpMetadata: { contentType: photo.type }
  });
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO note_attachments
          (id, note_id, object_key, file_name, content_type, byte_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(attachmentId, noteId, objectKey, safeName, photo.type, photo.size, createdAt),
      env.DB.prepare("UPDATE notes SET updated_at = ? WHERE id = ?").bind(nextIsoTimestamp(note.updatedAt), noteId)
    ]);
  } catch (error) {
    await deleteR2Objects(env, [objectKey]);
    throw error;
  }
  const updated = await getNote(env, noteId);
  await audit(env, request, "note.attachment.create", "note", noteId, noteAuditShape(note), noteAuditShape(updated));
  return json(updated, 201);
}

async function deleteNoteAttachment(request, env, noteId, attachmentId) {
  if (!attachmentId) return json({ error: "Attachment id is required" }, 400);
  const note = await getNote(env, noteId);
  if (!note) return json({ error: "Note not found" }, 404);
  const attachment = note.attachments.find((item) => item.id === attachmentId);
  if (!attachment) return json({ error: "Attachment not found" }, 404);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM note_attachments WHERE id = ? AND note_id = ?").bind(attachmentId, noteId),
    env.DB.prepare("UPDATE notes SET updated_at = ? WHERE id = ?").bind(nextIsoTimestamp(note.updatedAt), noteId)
  ]);
  await deleteR2Objects(env, [attachment.objectKey]);
  const updated = await getNote(env, noteId);
  await audit(env, request, "note.attachment.delete", "note", noteId, noteAuditShape(note), noteAuditShape(updated));
  return json(updated);
}

function normalizeAttachmentFileName(value) {
  return clean(value).replace(/[^\p{L}\p{N}_.-]+/gu, "_").slice(-100) || "photo";
}

function ensureNoteAttachmentRequestSize(request) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(contentLength) && contentLength > NOTE_ATTACHMENT_REQUEST_MAX_BYTES) {
    throw new HttpError("Photo request is too large", 413);
  }
}

function groupNoteAttachments(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const noteId = clean(row.noteId);
    if (!grouped.has(noteId)) grouped.set(noteId, []);
    grouped.get(noteId).push(row);
  }
  return grouped;
}

function normalizeNoteAttachmentRow(row) {
  const objectKey = clean(row.objectKey);
  return {
    id: clean(row.id),
    noteId: clean(row.noteId),
    objectKey,
    fileName: clean(row.fileName),
    contentType: clean(row.contentType),
    byteSize: Number(row.byteSize || 0),
    createdAt: clean(row.createdAt),
    url: `/api/photos/${encodeURIComponent(objectKey)}`
  };
}

async function deleteR2Objects(env, objectKeys) {
  const keys = [...new Set((objectKeys || []).map(clean).filter(Boolean))];
  if (!env.PHOTOS || !keys.length) return;
  try {
    await env.PHOTOS.delete(keys);
  } catch (error) {
    console.error(JSON.stringify({
      event: "note_attachment_r2_delete_failed",
      keyCount: keys.length,
      error: error?.message || String(error)
    }));
  }
}

async function handleCallNoteToken(request, env, viewerRole) {
  await requireWriteAuth(viewerRole);
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

async function changePassword(request, env, viewerRole) {
  await requireWriteAuth(viewerRole);
  const body = await readPasskeyJson(request);
  if (typeof body?.currentPassword !== "string" || typeof body?.newPassword !== "string") {
    return json({ error: "비밀번호 형식이 올바르지 않습니다" }, 400);
  }
  const currentPassword = clean(body.currentPassword);
  const newPassword = clean(body.newPassword);

  if (!currentPassword || !newPassword) {
    return json({ error: "\uD604\uC7AC \uBE44\uBC00\uBC88\uD638\uC640 \uC0C8 \uBE44\uBC00\uBC88\uD638\uB97C \uC785\uB825\uD558\uC138\uC694" }, 400);
  }
  if (newPassword.length < PASSWORD_MIN_LENGTH) {
    return json({ error: "\uC0C8 \uBE44\uBC00\uBC88\uD638\uB294 12\uC790 \uC774\uC0C1\uC73C\uB85C \uC785\uB825\uD558\uC138\uC694" }, 400);
  }
  if (passwordByteLength(newPassword) > PASSWORD_MAX_BYTES) {
    return json({ error: "새 비밀번호는 UTF-8 기준 128바이트 이하로 입력하세요" }, 400);
  }
  if (newPassword === currentPassword) {
    return json({ error: "\uC0C8 \uBE44\uBC00\uBC88\uD638\uB294 \uD604\uC7AC \uBE44\uBC00\uBC88\uD638\uC640 \uB2E4\uB974\uAC8C \uC785\uB825\uD558\uC138\uC694" }, 400);
  }
  const verifiedCredential = await verifySitePasswordCredential(currentPassword, env);
  if (!verifiedCredential) {
    return json({ error: "\uD604\uC7AC \uBE44\uBC00\uBC88\uD638\uAC00 \uB9DE\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4" }, 401);
  }

  const guestPasswordHash = await getPasswordSettingValue(env, GUEST_PASSWORD_HASH_KEY);
  if (guestPasswordHash && await verifyPasswordHash(newPassword, guestPasswordHash)) {
    return json({ error: "Administrator password must differ from the guest password" }, 400);
  }

  await saveAdminPassword(env, newPassword, "auth.password.update", {}, verifiedCredential);
  return json({ ok: true });
}

async function resetPasswordWithPasskey(request, env) {
  const body = await readPasskeyJson(request);
  if (typeof body?.newPassword !== "string") {
    return json({ error: "새 비밀번호 형식이 올바르지 않습니다" }, 400);
  }
  const newPassword = clean(body?.newPassword);

  if (!newPassword) {
    return json({ error: "새 비밀번호를 입력하세요" }, 400);
  }
  if (newPassword.length < PASSWORD_MIN_LENGTH) {
    return json({ error: "새 비밀번호는 12자 이상으로 입력하세요" }, 400);
  }
  if (passwordByteLength(newPassword) > PASSWORD_MAX_BYTES) {
    return json({ error: "새 비밀번호는 UTF-8 기준 128바이트 이하로 입력하세요" }, 400);
  }

  await verifyPasskeyPasswordReset(request, env, body);

  if (await verifySitePassword(newPassword, env)) {
    return json({ error: "새 비밀번호는 현재 비밀번호와 다르게 입력하세요" }, 400);
  }
  const guestPasswordHash = await getPasswordSettingValue(env, GUEST_PASSWORD_HASH_KEY);
  if (guestPasswordHash && await verifyPasswordHash(newPassword, guestPasswordHash)) {
    return json({ error: "Administrator password must differ from the guest password" }, 400);
  }

  await saveAdminPassword(env, newPassword, "auth.password.reset_with_passkey", {
    method: "passkey"
  });
  return json({ ok: true });
}

async function saveAdminPassword(env, password, action, after = {}, expectedCredential = null) {
  await ensureAppSettingsTable(env);
  const passwordHash = await createPasswordHash(password);
  const updatedAt = new Date().toISOString();
  const mutation = expectedCredential
    ? conditionalAdminPasswordStatement(env, passwordHash, updatedAt, expectedCredential)
    : appSettingStatement(env, PASSWORD_HASH_KEY, passwordHash, updatedAt);
  const auditEntry = expectedCredential
    ? conditionalAuditStatement(env, "admin", action, "setting", PASSWORD_HASH_KEY, "", {
      ...after,
      updatedAt
    }, PASSWORD_HASH_KEY, updatedAt, passwordHash)
    : auditStatement(env, "admin", action, "setting", PASSWORD_HASH_KEY, "", {
      ...after,
      updatedAt
    });
  const results = await env.DB.batch([
    mutation,
    auditEntry
  ]);
  if (expectedCredential && Number(results?.[0]?.meta?.changes || 0) !== 1) {
    throw new HttpError(
      "비밀번호가 이미 변경되었습니다. 다시 로그인한 뒤 시도하세요",
      409,
      "PASSWORD_CHANGED_REAUTH_REQUIRED"
    );
  }
  return updatedAt;
}

function conditionalAdminPasswordStatement(env, passwordHash, updatedAt, expectedCredential) {
  if (expectedCredential.source === "stored") {
    return env.DB.prepare(
      `UPDATE app_settings
       SET value = ?, updated_at = ?
       WHERE key = ? AND value = ?`
    ).bind(passwordHash, updatedAt, PASSWORD_HASH_KEY, expectedCredential.value);
  }
  if (expectedCredential.source === "environment") {
    return env.DB.prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       SELECT ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE key = ?)`
    ).bind(PASSWORD_HASH_KEY, passwordHash, updatedAt, PASSWORD_HASH_KEY);
  }
  throw new HttpError("비밀번호 상태를 확인할 수 없습니다", 503, "AUTH_STORAGE_UNAVAILABLE");
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError("Invalid JSON request body", 400);
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
  return Boolean(await verifySitePasswordCredential(password, env));
}

async function verifySitePasswordCredential(password, env) {
  const stored = await readPasswordSetting(env, PASSWORD_HASH_KEY);
  if (stored.status === "present") {
    return await verifyPasswordHash(password, stored.value)
      ? { source: "stored", value: stored.value }
      : null;
  }
  const environmentPassword = String(env.SITE_PASSWORD || "");
  if (!environmentPassword || !(await timingSafeStringEqual(password, environmentPassword))) return null;
  return { source: "environment", value: environmentPassword };
}

async function getPasswordSettingValue(env, key) {
  const setting = await readPasswordSetting(env, key);
  return setting.status === "present" ? setting.value : "";
}

async function readPasswordSetting(env, key) {
  if (!env.DB) return { status: "missing", value: "" };
  try {
    const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?")
      .bind(key)
      .first();
    if (!row) return { status: "missing", value: "" };
    if (typeof row.value !== "string") throw new Error("invalid password setting");
    return { status: "present", value: row.value };
  } catch {
    throw new HttpError("Password settings are temporarily unavailable", 503, "AUTH_STORAGE_UNAVAILABLE");
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
  const secret = env.SESSION_SECRET || env.SITE_PASSWORD || "";
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
async function handleMembers(request, env, path, viewerRole) {
  const id = path[1];

  if (request.method === "POST" && path.length === 1) {
    await requireWriteAuth(viewerRole);
    const body = await request.json();
    const member = normalizeMember({ ...body, id: "" }, crypto.randomUUID());
    const managedGroupId = clean(body.managedGroupId);
    const managedGroup = managedGroupId ? await getManagedGroup(env, managedGroupId) : null;
    if (managedGroupId && !managedGroup) return json({ error: "Group not found" }, 404);
    const managedGroupExpectedUpdatedAt = clean(body.managedGroupExpectedUpdatedAt);
    if (managedGroupId && !managedGroupExpectedUpdatedAt) {
      return json({ error: "managedGroupExpectedUpdatedAt is required", code: "GROUP_PRECONDITION_REQUIRED" }, 428);
    }
    if (managedGroup && managedGroupExpectedUpdatedAt !== managedGroup.updatedAt) {
      return json({ error: "Group changed; reload and try again", code: "GROUP_VERSION_CONFLICT", group: managedGroup }, 409);
    }

    const memberValues = [
      member.id, member.cellId, member.name, member.title, member.role, member.phone, member.homePhone, member.birth, member.registeredAt,
      member.address, member.memo, member.prayerRequests, member.baptized, member.longAbsent, member.photoKey, member.archivedAt, member.trashedAt, member.createdAt, member.updatedAt
    ];
    const memberInsert = managedGroupId
      ? env.DB.prepare(
        `INSERT INTO members
          (id, cell_id, name, title, role, phone, home_phone, birth, registered_at, address, memo, prayer_requests, baptized, long_absent, photo_key, archived_at, trashed_at, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM managed_groups WHERE id = ? AND updated_at = ?)`
      ).bind(...memberValues, managedGroupId, managedGroupExpectedUpdatedAt)
      : env.DB.prepare(
        `INSERT INTO members
          (id, cell_id, name, title, role, phone, home_phone, birth, registered_at, address, memo, prayer_requests, baptized, long_absent, photo_key, archived_at, trashed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(...memberValues);
    let groupUpdatedAt = "";
    if (managedGroupId) {
      groupUpdatedAt = nextIsoTimestamp(managedGroup.updatedAt);
      try {
        const results = await env.DB.batch([
          memberInsert,
          env.DB.prepare(
            `INSERT INTO managed_group_members (group_id, member_id, role, created_at)
             SELECT ?, ?, '', ?
             WHERE EXISTS (SELECT 1 FROM managed_groups WHERE id = ? AND updated_at = ?)`
          ).bind(managedGroupId, member.id, groupUpdatedAt, managedGroupId, managedGroupExpectedUpdatedAt),
          env.DB.prepare("UPDATE managed_groups SET updated_at = ? WHERE id = ? AND updated_at = ?")
            .bind(groupUpdatedAt, managedGroupId, managedGroupExpectedUpdatedAt)
        ]);
        if (Number(results[0]?.meta?.changes || 0) !== 1
          || Number(results[1]?.meta?.changes || 0) !== 1
          || Number(results[2]?.meta?.changes || 0) !== 1) {
          const currentGroup = await getManagedGroup(env, managedGroupId);
          if (!currentGroup) return json({ error: "Group not found" }, 404);
          return json({ error: "Group changed; reload and try again", code: "GROUP_VERSION_CONFLICT", group: currentGroup }, 409);
        }
      } catch (error) {
        const currentGroup = await getManagedGroup(env, managedGroupId);
        if (!currentGroup) return json({ error: "Group not found" }, 404);
        throw error;
      }
    } else {
      await memberInsert.run();
    }
    await audit(env, request, "member.create", "member", member.id, "", member);
    const publicMember = cellsWithPhotoUrls([member])[0];
    return managedGroupId
      ? json({ member: publicMember, managedGroupId, groupUpdatedAt }, 201)
      : json(publicMember, 201);
  }
  if (!id) return json({ error: "Member id required" }, 400);

  if (request.method === "PATCH" && path.length === 2) {
    await requireWriteAuth(viewerRole);
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
    await audit(env, request, "member.update", "member", id, previous, member);
    return json(cellsWithPhotoUrls([member])[0]);
  }

  if (request.method === "POST" && path[2] === "archive") {
    await requireWriteAuth(viewerRole);
    const archivedAt = new Date().toISOString();
    await env.DB.prepare("UPDATE members SET archived_at = ?, updated_at = ? WHERE id = ?")
      .bind(archivedAt, archivedAt, id)
      .run();
    await audit(env, request, "member.archive", "member", id, "", { archivedAt });
    return json({ id, archivedAt });
  }

  if (request.method === "POST" && path[2] === "restore") {
    await requireWriteAuth(viewerRole);
    const updatedAt = new Date().toISOString();
    await env.DB.prepare("UPDATE members SET archived_at = '', updated_at = ? WHERE id = ?")
      .bind(updatedAt, id)
      .run();
    await audit(env, request, "member.restore", "member", id, "", { archivedAt: "" });
    return json({ id, archivedAt: "" });
  }

  if (request.method === "POST" && path[2] === "trash") {
    await requireWriteAuth(viewerRole);
    const trashedAt = new Date().toISOString();
    await env.DB.prepare("UPDATE members SET trashed_at = ?, updated_at = ? WHERE id = ?")
      .bind(trashedAt, trashedAt, id)
      .run();
    await audit(env, request, "member.trash", "member", id, "", { trashedAt });
    return json({ id, trashedAt });
  }

  if (request.method === "POST" && path[2] === "photo") {
    await requireWriteAuth(viewerRole);
    return uploadMemberPhoto(request, env, id);
  }

  if (request.method === "DELETE" && path.length === 2) {
    await requireWriteAuth(viewerRole);
    const previous = await getMember(env, id);
    await env.DB.prepare("DELETE FROM members WHERE id = ?").bind(id).run();
    await audit(env, request, "member.delete", "member", id, previous || "", "");
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
}

async function handleVisitNotes(request, env, path, viewerRole) {
  if (request.method === "POST" && path.length === 1) {
    await requireWriteAuth(viewerRole);
    const body = await request.json();
    const visit = normalizeVisit(body);
    if (!visit.memberId || !visit.summary) return json({ error: "Visit member and summary are required" }, 400);
    await env.DB.prepare(
      `INSERT INTO visit_notes
        (id, member_id, visit_date, visit_type, summary, prayer, action, source, raw_payload,
         alarm_at, alarm_state, alarm_id, dismissed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      visit.id, visit.memberId, visit.visitDate, visit.visitType, visit.summary,
      visit.prayer, visit.action, visit.source, visit.rawPayload,
      visit.alarmAt, visit.alarmState, visit.alarmId, visit.alarmDismissedAt,
      visit.createdAt, visit.updatedAt
    ).run();
    await audit(env, request, "visit.create", "visit_note", visit.id, "", visit);
    return json(visit, 201);
  }

  if (request.method === "PATCH" && path.length === 2) {
    await requireWriteAuth(viewerRole);
    const id = clean(path[1]);
    const previous = await getVisitNote(env, id);
    if (!previous) return json({ error: "Visit note not found" }, 404);
    const body = await request.json();
    const expectedUpdatedAt = clean(body?.expectedUpdatedAt);
    if (!expectedUpdatedAt) {
      return json({ error: "expectedUpdatedAt is required", code: "VISIT_PRECONDITION_REQUIRED" }, 428);
    }
    if (expectedUpdatedAt !== previous.updatedAt) {
      return json({ error: "Visit changed; reload and try again", code: "VISIT_VERSION_CONFLICT", visit: previous }, 409);
    }
    const visit = normalizeVisit(body, previous);
    if (!visit.summary) return json({ error: "Visit summary is required" }, 400);
    const statements = [env.DB.prepare(
      `UPDATE visit_notes
       SET visit_date = ?, visit_type = ?, summary = ?, prayer = ?, action = ?, source = ?, raw_payload = ?,
           alarm_at = ?, alarm_state = ?, alarm_id = ?, dismissed_at = ?, updated_at = ?
       WHERE id = ? AND updated_at = ?`
    ).bind(
      visit.visitDate, visit.visitType, visit.summary, visit.prayer,
      visit.action, visit.source, visit.rawPayload,
      visit.alarmAt, visit.alarmState, visit.alarmId, visit.alarmDismissedAt,
      visit.updatedAt, id, expectedUpdatedAt
    )];
    if (previous.alarmId && (previous.alarmId !== visit.alarmId || visit.alarmState !== "scheduled")) {
      statements.push(cancelVisitAlarmDeliveryStatement(
        env,
        previous.alarmId,
        id,
        visit.updatedAt,
        "VISIT_ALARM_CHANGED"
      ));
    }
    const results = await env.DB.batch(statements);
    if (Number(results[0]?.meta?.changes || 0) !== 1) {
      const current = await getVisitNote(env, id);
      if (!current) return json({ error: "Visit note not found" }, 404);
      return json({ error: "Visit changed; reload and try again", code: "VISIT_VERSION_CONFLICT", visit: current }, 409);
    }
    await audit(env, request, "visit.update", "visit_note", id, previous, visit);
    return json(visit);
  }

  if (request.method === "DELETE" && path.length === 2) {
    await requireWriteAuth(viewerRole);
    const id = clean(path[1]);
    const previous = await getVisitNote(env, id);
    if (!previous) return json({ error: "Visit note not found" }, 404);
    const body = await request.json().catch(() => ({}));
    const expectedUpdatedAt = clean(body?.expectedUpdatedAt);
    if (!expectedUpdatedAt) {
      return json({ error: "expectedUpdatedAt is required", code: "VISIT_PRECONDITION_REQUIRED" }, 428);
    }
    if (expectedUpdatedAt !== previous.updatedAt) {
      return json({ error: "Visit changed; reload and try again", code: "VISIT_VERSION_CONFLICT", visit: previous }, 409);
    }
    const nowIso = new Date().toISOString();
    const statements = [];
    if (previous.alarmId) {
      statements.push(env.DB.prepare(
        `UPDATE call_note_push_deliveries
         SET send_state = 'cancelled', lease_token = '', lease_expires_at = '',
           last_error_code = 'VISIT_ALARM_DELETED', failed_at = ?, updated_at = ?
         WHERE kind = 'visit_alarm' AND reminder_id = ?
           AND send_state NOT IN ('accepted', 'cancelled', 'dead')
           AND EXISTS (
             SELECT 1 FROM visit_notes
             WHERE id = ? AND updated_at = ? AND alarm_id = ?
           )`
      ).bind(nowIso, nowIso, previous.alarmId, id, expectedUpdatedAt, previous.alarmId));
    }
    statements.push(
      env.DB.prepare("DELETE FROM visit_notes WHERE id = ? AND updated_at = ?")
        .bind(id, expectedUpdatedAt)
    );
    const results = await env.DB.batch(statements);
    const deleteResult = results[results.length - 1];
    if (Number(deleteResult?.meta?.changes || 0) !== 1) {
      const current = await getVisitNote(env, id);
      if (!current) return json({ error: "Visit note not found" }, 404);
      return json({ error: "Visit changed; reload and try again", code: "VISIT_VERSION_CONFLICT", visit: current }, 409);
    }
    await audit(env, request, "visit.delete", "visit_note", id, previous, "");
    return json({ ok: true });
  }

  return json({ error: "Method not allowed" }, 405);
}

async function handleSundayAttendance(request, env, viewerRole) {
  if (request.method === "GET") {
    const url = new URL(request.url);
    const attendanceDate = clean(url.searchParams.get("date"));
    return attendanceDate
      ? getSundayAttendanceByDate(env, attendanceDate)
      : listSundayAttendance(env);
  }

  if (request.method === "POST") {
    await requireWriteAuth(viewerRole);
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
  const now = new Date().toISOString();
  const existing = await env.DB.prepare(
    `SELECT id, attendance_date AS attendanceDate, label, created_at AS createdAt, updated_at AS updatedAt
     FROM sunday_attendance_sessions
     WHERE attendance_date = ?`
  ).bind(attendanceDate).first();
  const sessionId = existing?.id || crypto.randomUUID();
  const createdAt = existing?.createdAt || now;

  const members = await getActiveMembersForAttendance(env);
  const records = members.map((member) => ({
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
    present: presentMemberIds.has(member.id) ? 1 : 0,
    createdAt: now,
    updatedAt: now
  }));

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
        (session_id, member_id, member_name, member_title, member_role, member_long_absent, cell_id, cell_name, cell_sort_order, photo_key, present, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      record.sessionId, record.memberId, record.memberName, record.memberTitle, record.memberRole,
      record.memberLongAbsent, record.cellId, record.cellName, record.cellSortOrder, record.photoKey, record.present,
      record.createdAt, record.updatedAt
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
       AND COALESCE(c.is_system, 0) = 0
     ORDER BY c.sort_order, m.long_absent, m.role DESC, m.name`
  ).all();
  return rows.results || [];
}

async function getSundayAttendanceRecords(env, sessionId) {
  const rows = await env.DB.prepare(
    `SELECT session_id AS sessionId, member_id AS memberId, member_name AS memberName,
      member_title AS memberTitle, member_role AS memberRole, member_long_absent AS memberLongAbsent, cell_id AS cellId, cell_name AS cellName,
      cell_sort_order AS cellSortOrder, photo_key AS photoKey, present, created_at AS createdAt, updated_at AS updatedAt
     FROM sunday_attendance_records
     WHERE session_id = ?
     ORDER BY cell_sort_order, cell_name, member_name`
  ).bind(sessionId).all();
  return rows.results || [];
}

async function handleCallNotes(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  await requireCallNoteAuth(request, env);
  await purgeExpiredCallNoteImports(env);
  ensureBodySize(request);
  const payload = await safeJson(request);
  const normalized = await normalizeCallNotePayload(payload);
  if (!normalized.summary) return json({ error: "summary is required" }, 400);

  const existing = await findExistingCallNoteImport(env, normalized.sourceId);
  if (existing && !isCallNoteImportReplayable(existing)) return callNoteDuplicateResponse(existing);

  const match = await resolveCallNoteMember(env, normalized);
  const importId = crypto.randomUUID();

  if (!match.member) {
    const claimResult = await callNoteImportClaimStatement(env, {
      id: importId,
      status: "needs_review",
      normalized,
      memberId: "",
      visitId: "",
      candidates: match.candidates,
      reason: match.reason
    }).run();
    if (Number(claimResult?.meta?.changes || 0) !== 1) {
      return currentCallNoteDuplicateResponse(env, normalized.sourceId);
    }
    const storedImport = await findExistingCallNoteImport(env, normalized.sourceId);
    return json({
      status: "needs_review",
      importId: storedImport?.id || importId,
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

  const results = await env.DB.batch([
    callNoteImportClaimStatement(env, {
      id: importId,
      status: "attached",
      normalized,
      memberId: match.member.id,
      visitId: visit.id,
      candidates: [match.member],
      reason: match.reason,
      resolvedAt: visit.createdAt
    }),
    insertVisitIfCallNoteClaimedStatement(env, visit, normalized.sourceId)
  ]);
  const importChanges = Number(results?.[0]?.meta?.changes || 0);
  const visitChanges = Number(results?.[1]?.meta?.changes || 0);
  if (importChanges === 0 && visitChanges === 0) {
    return currentCallNoteDuplicateResponse(env, normalized.sourceId);
  }
  if (importChanges !== 1 || visitChanges !== 1) {
    console.error(JSON.stringify({
      event: "call_note_webhook.claim_inconsistent",
      sourceId: normalized.sourceId,
      importChanges,
      visitChanges
    }));
    throw new HttpError(
      "Call-note message state changed; resend the message",
      503,
      "CALL_NOTE_STATE_RETRY"
    );
  }

  const storedImport = await findExistingCallNoteImport(env, normalized.sourceId);
  const storedImportId = storedImport?.id || importId;

  await audit(env, request, "call_note_webhook.attach", "visit_note", visit.id, "", {
    importId: storedImportId,
    memberId: match.member.id,
    sourceId: normalized.sourceId,
    matchReason: match.reason
  });

  return json({
    status: "attached",
    importId: storedImportId,
    memberId: match.member.id,
    visitId: visit.id,
    matchReason: match.reason
  }, 201);
}

async function handleCallNoteImports(request, env, path, viewerRole) {
  await requireWriteAuth(viewerRole);
  const expiredDeleted = await purgeExpiredCallNoteImports(env);

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
    return json({ imports: (rows.results || []).map(normalizeCallNoteImportRow), expiredDeleted });
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

async function purgeExpiredCallNoteImports(env) {
  const cutoff = new Date(Date.now() - CALL_NOTE_REVIEW_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const result = await env.DB.prepare(
    "DELETE FROM call_note_imports WHERE status = 'needs_review' AND unixepoch(created_at) <= unixepoch(?)"
  ).bind(cutoff).run();
  return Number(result.meta?.changes || 0);
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

async function handlePhotoRead(env, keyParts, viewerRole) {
  if (!env.PHOTOS) return json({ error: "R2 binding PHOTOS is not configured" }, 503);
  const key = decodeURIComponent(keyParts.join("/"));
  if (viewerRole === GUEST_ROLE) {
    if (!env.DB) return json({ error: "D1 binding DB is not configured" }, 503);
    const activeMember = await env.DB.prepare(
      `SELECT 1 AS allowed
       FROM members
       WHERE photo_key = ?
         AND COALESCE(archived_at, '') = ''
         AND COALESCE(trashed_at, '') = ''
       LIMIT 1`
    ).bind(key).first();
    if (!activeMember) return new Response("Not found", { status: 404 });
  }
  const object = await env.PHOTOS.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", "private, max-age=3600");
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
      summary, prayer, action, source, raw_payload AS rawPayload,
      alarm_at AS alarmAt, alarm_state AS alarmState, alarm_id AS alarmId,
      dismissed_at AS alarmDismissedAt, created_at AS createdAt, updated_at AS updatedAt
     FROM visit_notes
     WHERE id = ?`
  ).bind(id).first();
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
  const cellHints = uniqueCleanValues([payload.cellId, payload.cellName, payload.cellHint, payload.cell]);
  const groupHints = uniqueCleanValues([payload.groupId, payload.groupName, payload.group, payload.organization]);
  const cellHint = cellHints[0] || "";
  const groupHint = groupHints[0] || "";
  const sourceId = clean(payload.sourceId || payload.id || payload.callId || payload.recordingId)
    || await callNoteFingerprint({ phone, name, visitDate, summary, prayer, calledAt });

  return {
    sourceId,
    memberId: clean(payload.memberId),
    name,
    phone,
    normalizedPhone: normalizePhone(phone),
    cellHint,
    groupHint,
    cellHints,
    groupHints,
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

function uniqueCleanValues(values) {
  return [...new Set(values.map((value) => clean(value).replace(/\s+/g, " ")).filter(Boolean))];
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
    `SELECT i.id, i.source_id AS sourceId, i.member_id AS memberId,
      i.visit_id AS visitId, i.status, COALESCE(i.updated_at, '') AS updatedAt,
      CASE WHEN EXISTS (
        SELECT 1 FROM visit_notes v
        WHERE v.id = i.visit_id
          OR (
            v.source = 'call-note-app'
            AND COALESCE(i.payload, '') <> ''
            AND v.raw_payload = i.payload
          )
      ) THEN 1 ELSE 0 END AS visitExists
     FROM call_note_imports i
     WHERE i.source_id = ?
     LIMIT 1`
  ).bind(sourceId).first();
}

function isCallNoteImportReplayable(existing) {
  return (existing?.status === "ignored" || existing?.status === "attached")
    && Number(existing?.visitExists || 0) === 0;
}

function callNoteDuplicateResponse(existing) {
  return json({
    status: existing.status,
    duplicate: true,
    importId: existing.id,
    memberId: existing.memberId || "",
    visitId: existing.visitId || ""
  });
}

async function currentCallNoteDuplicateResponse(env, sourceId) {
  const current = await findExistingCallNoteImport(env, sourceId);
  if (current) return callNoteDuplicateResponse(current);
  throw new HttpError(
    "Call-note message state changed; resend the message",
    503,
    "CALL_NOTE_STATE_RETRY"
  );
}

async function resolveCallNoteMember(env, normalized) {
  const members = await listActiveMembersForMatching(env);
  const phoneMatches = normalized.normalizedPhone
    ? members.filter((member) => memberPhoneValues(member).includes(normalized.normalizedPhone))
    : [];
  const name = compactKoreanName(normalized.name);
  const nameMatches = name
    ? members.filter((member) => compactKoreanName(member.name) === name)
    : [];
  const cellHints = normalized.cellHints || (normalized.cellHint ? [normalized.cellHint] : []);
  const groupHints = normalized.groupHints || (normalized.groupHint ? [normalized.groupHint] : []);
  const cellMatches = cellHints.length
    ? members.filter((member) => cellHints.every((hint) => memberMatchesCellHint(member, hint)))
    : [];
  const groupMatches = groupHints.length
    ? members.filter((member) => groupHints.every((hint) => memberMatchesGroupHint(member, hint)))
    : [];

  if (normalized.memberId) {
    const member = members.find((item) => item.id === normalized.memberId);
    if (member) {
      const conflicts = [
        normalized.normalizedPhone && !phoneMatches.some((item) => item.id === member.id),
        name && !nameMatches.some((item) => item.id === member.id),
        cellHints.length && !cellMatches.some((item) => item.id === member.id),
        groupHints.length && !groupMatches.some((item) => item.id === member.id)
      ].some(Boolean);
      if (!conflicts) return { member, candidates: [member], reason: "member-id" };
      return {
        member: null,
        candidates: uniqueMembers([member, ...phoneMatches, ...nameMatches, ...cellMatches, ...groupMatches]),
        reason: "conflicting-member-id"
      };
    }
  }

  const specialKim = resolveKnownSpecialName(members, normalized);
  if (!name && !normalized.normalizedPhone) {
    return { member: null, candidates: [], reason: "missing-name-phone" };
  }

  const signalSets = [];
  if (name) signalSets.push(nameMatches);
  if (normalized.normalizedPhone) signalSets.push(phoneMatches);
  if (cellHints.length) signalSets.push(cellMatches);
  if (groupHints.length) signalSets.push(groupMatches);
  if (specialKim?.member) signalSets.push([specialKim.member]);
  const candidates = intersectMemberSets(signalSets);
  if (candidates.length === 1) {
    const reason = specialKim?.member
      ? specialKim.reason
      : groupHints.length ? (name ? "name-group" : "phone-group")
        : cellHints.length ? (name ? "name-cell" : "phone-cell")
          : normalized.normalizedPhone && name ? "phone-name"
            : normalized.normalizedPhone ? "phone"
            : "unique-name";
    return { member: candidates[0], candidates, reason };
  }
  if (candidates.length > 1) {
    const reason = normalized.normalizedPhone && !cellHints.length && !groupHints.length
      ? "ambiguous-phone"
      : (cellHints.length || groupHints.length) ? "ambiguous-name-affiliation" : "ambiguous-name";
    return { member: null, candidates, reason };
  }

  const possible = uniqueMembers([...phoneMatches, ...nameMatches, ...cellMatches, ...groupMatches]);
  return {
    member: null,
    candidates: possible,
    reason: possible.length ? "conflicting-signals" : "no-match"
  };
}

function intersectMemberSets(sets) {
  if (!sets.length) return [];
  return sets.slice(1).reduce(
    (current, next) => current.filter((member) => next.some((item) => item.id === member.id)),
    sets[0]
  );
}

function uniqueMembers(members) {
  const byId = new Map();
  for (const member of members) {
    if (member?.id && !byId.has(member.id)) byId.set(member.id, member);
  }
  return [...byId.values()];
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
  const [rows, membershipRows] = await Promise.all([
    env.DB.prepare(
      `SELECT m.id, m.cell_id AS cellId, c.name AS cellName, c.sort_order AS cellSortOrder,
        m.name, m.title, m.role, m.phone, m.home_phone AS homePhone
       FROM members m
       JOIN cells c ON c.id = m.cell_id
       WHERE COALESCE(m.archived_at, '') = ''
         AND COALESCE(m.trashed_at, '') = ''
       ORDER BY c.sort_order, m.name`
    ).all(),
    env.DB.prepare(
      `SELECT gm.member_id AS memberId, g.id AS groupId, g.name AS groupName
       FROM managed_group_members gm
       JOIN managed_groups g ON g.id = gm.group_id
       ORDER BY g.sort_order, g.name`
    ).all()
  ]);
  const groupsByMember = new Map();
  for (const row of membershipRows.results || []) {
    const groups = groupsByMember.get(row.memberId) || [];
    groups.push({ id: row.groupId, name: row.groupName });
    groupsByMember.set(row.memberId, groups);
  }
  return (rows.results || []).map((member) => {
    const groups = groupsByMember.get(member.id) || [];
    return {
      ...member,
      groupIds: groups.map((group) => group.id),
      groupNames: groups.map((group) => group.name)
    };
  });
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
  const key = normalizeAffiliationKey(text);
  if ([member.cellId, member.cellName].some((value) => normalizeAffiliationKey(value) === key)) return true;
  // Older call-note clients sometimes place an organization name in a cell field.
  if (memberMatchesGroupHint(member, text)) return true;
  const numberOnlyMatch = text.match(/^(\d+)\s*셀$/);
  if (numberOnlyMatch) {
    const memberCellNumber = clean(member.cellId).match(/(?:^|-)(\d+)$/);
    return Boolean(memberCellNumber)
      && Number(memberCellNumber[1]) === Number(numberOnlyMatch[1]);
  }
  const match = text.match(/(남|여)(?:자)?\s*(\d+)\s*셀/);
  if (!match) return false;
  const gender = match[1] === "남" ? "male" : "female";
  return member.cellId === `${gender}-${Number(match[2])}`;
}

function memberMatchesGroupHint(member, hint) {
  const key = normalizeAffiliationKey(hint);
  if (!key) return false;
  return [...(member.groupIds || []), ...(member.groupNames || [])]
    .some((value) => normalizeAffiliationKey(value) === key);
}

function normalizeAffiliationKey(value) {
  return clean(value).replace(/\s+/g, " ").toLocaleLowerCase("ko-KR");
}

function callNoteImportClaimStatement(env, input) {
  const now = new Date().toISOString();
  return env.DB.prepare(
    `INSERT INTO call_note_imports
      (id, source_id, member_id, visit_id, phone, name, cell_hint, status, summary, candidate_members, match_reason, payload, created_at, resolved_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id) WHERE source_id <> '' DO UPDATE SET
       member_id = excluded.member_id,
       visit_id = excluded.visit_id,
       phone = excluded.phone,
       name = excluded.name,
       cell_hint = excluded.cell_hint,
       status = excluded.status,
       summary = excluded.summary,
       candidate_members = excluded.candidate_members,
       match_reason = excluded.match_reason,
       payload = excluded.payload,
       created_at = excluded.created_at,
       resolved_at = excluded.resolved_at,
       updated_at = excluded.updated_at
     WHERE call_note_imports.status IN ('ignored', 'attached')
       AND NOT EXISTS (
         SELECT 1 FROM visit_notes v
         WHERE v.id = call_note_imports.visit_id
           OR (
             v.source = 'call-note-app'
             AND COALESCE(call_note_imports.payload, '') <> ''
             AND v.raw_payload = call_note_imports.payload
           )
       )`
  ).bind(
    input.id,
    input.normalized.sourceId,
    input.memberId || "",
    input.visitId || "",
    input.normalized.phone,
    input.normalized.name,
    [input.normalized.cellHint, input.normalized.groupHint].filter(Boolean).join(" / "),
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

function insertVisitIfCallNoteClaimedStatement(env, visit, sourceId) {
  return env.DB.prepare(
    `INSERT INTO visit_notes
      (id, member_id, visit_date, visit_type, summary, prayer, action, source, raw_payload,
       alarm_at, alarm_state, alarm_id, dismissed_at, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM call_note_imports
       WHERE source_id = ? AND status = 'attached' AND visit_id = ?
     )`
  ).bind(
    visit.id, visit.memberId, visit.visitDate, visit.visitType, visit.summary,
    visit.prayer, visit.action, visit.source, visit.rawPayload,
    visit.alarmAt, visit.alarmState, visit.alarmId, visit.alarmDismissedAt,
    visit.createdAt, visit.updatedAt,
    sourceId, visit.id
  );
}

function insertVisitStatement(env, visit) {
  return env.DB.prepare(
    `INSERT INTO visit_notes
      (id, member_id, visit_date, visit_type, summary, prayer, action, source, raw_payload,
       alarm_at, alarm_state, alarm_id, dismissed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    visit.id, visit.memberId, visit.visitDate, visit.visitType, visit.summary,
    visit.prayer, visit.action, visit.source, visit.rawPayload,
    visit.alarmAt, visit.alarmState, visit.alarmId, visit.alarmDismissedAt,
    visit.createdAt, visit.updatedAt
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
    groupIds: member.groupIds || [],
    groupNames: member.groupNames || [],
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

function normalizeMember(body, fallbackId) {
  const now = new Date().toISOString();
  return {
    id: clean(body.id) || fallbackId,
    cellId: clean(body.cellId) || UNASSIGNED_CELL_ID,
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

export function normalizeVisit(body, previous = null) {
  const input = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const now = new Date().toISOString();
  const visitType = clean(input.visitType === undefined ? previous?.visitType : input.visitType) || "심방";
  const action = clean(input.action === undefined ? previous?.action : input.action);
  const source = clean(previous?.source || input.source) || "manual";
  const alarm = normalizeVisitAlarm(input, previous, { visitType, action, source });
  return {
    id: clean(previous?.id || input.id) || crypto.randomUUID(),
    memberId: clean(previous?.memberId || input.memberId),
    visitDate: clean(input.visitDate === undefined ? previous?.visitDate : input.visitDate) || now.slice(0, 10),
    visitType,
    summary: clean(input.summary === undefined ? previous?.summary : input.summary),
    prayer: clean(input.prayer === undefined ? previous?.prayer : input.prayer),
    action,
    source,
    rawPayload: clean(previous?.rawPayload || input.rawPayload),
    ...alarm,
    createdAt: clean(previous?.createdAt || input.createdAt) || now,
    updatedAt: previous ? nextIsoTimestamp(previous.updatedAt) : now
  };
}

function normalizeVisitAlarm(input, previous, context) {
  const isManualAlarm = context.source === "manual" && context.visitType === VISIT_TYPE_ALARM;
  if (!isManualAlarm) {
    const schedulingRequested = context.visitType === VISIT_TYPE_ALARM
      && (clean(input.alarmAt) || input.alarmState === "scheduled");
    if (schedulingRequested) {
      throw new HttpError("Imported visit records cannot schedule alarms", 400);
    }
    return { alarmAt: "", alarmState: "none", alarmId: "", alarmDismissedAt: "" };
  }
  const trashedAt = visitMetaValue(context.action, "trashedAt");
  if (trashedAt) {
    if (previous?.alarmState === "dismissed" && previous.alarmAt) {
      return {
        alarmAt: previous.alarmAt,
        alarmState: "dismissed",
        alarmId: previous.alarmId || "",
        alarmDismissedAt: previous.alarmDismissedAt || new Date().toISOString()
      };
    }
    return { alarmAt: "", alarmState: "none", alarmId: "", alarmDismissedAt: "" };
  }

  const rawAlarmAt = input.alarmAt !== undefined
    ? input.alarmAt
    : input.action !== undefined || !previous
      ? visitMetaValue(context.action, "alarmAt")
      : previous?.alarmAt || "";
  const alarmAt = normalizeVisitAlarmDateTime(rawAlarmAt);
  if (!alarmAt) throw new HttpError("alarmAt is required for an alarm visit", 400);

  const requestedState = input.alarmState === undefined
    ? ""
    : normalizeNoteEnum(input.alarmState, VISIT_ALARM_STATES, "alarmState");
  if (requestedState === "none") {
    return { alarmAt: "", alarmState: "none", alarmId: "", alarmDismissedAt: "" };
  }
  if (requestedState === "dismissed") {
    return {
      alarmAt,
      alarmState: "dismissed",
      alarmId: previous?.alarmId || "",
      alarmDismissedAt: new Date().toISOString()
    };
  }

  const alarmAtChanged = alarmAt !== (previous?.alarmAt || "");
  const reactivated = previous?.alarmState === "dismissed" && requestedState === "scheduled";
  const inheritedState = previous?.alarmState || "scheduled";
  if (!requestedState && inheritedState === "dismissed") {
    return {
      alarmAt,
      alarmState: "dismissed",
      alarmId: previous?.alarmId || "",
      alarmDismissedAt: previous?.alarmDismissedAt || new Date().toISOString()
    };
  }
  return {
    alarmAt,
    alarmState: "scheduled",
    alarmId: !previous || alarmAtChanged || reactivated || !previous.alarmId
      ? crypto.randomUUID()
      : previous.alarmId,
    alarmDismissedAt: ""
  };
}

export function normalizeVisitAlarmDateTime(value) {
  const text = clean(value);
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) {
    return normalizeUtcDateTime(text, "alarmAt");
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) {
    return normalizeUtcDateTime(`${text}:00+09:00`, "alarmAt");
  }
  throw new HttpError("alarmAt must be an ISO date-time", 400);
}

function visitMetaValue(action, key) {
  const text = clean(action);
  if (!text.startsWith(VISIT_META_PREFIX)) return "";
  try {
    const parsed = JSON.parse(text.slice(VISIT_META_PREFIX.length));
    return clean(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed[key] : "");
  } catch {
    return "";
  }
}

function cancelVisitAlarmDeliveryStatement(env, alarmId, visitId, updatedAt, errorCode) {
  const nowIso = new Date().toISOString();
  return env.DB.prepare(
    `UPDATE call_note_push_deliveries
     SET send_state = 'cancelled', lease_token = '', lease_expires_at = '',
       last_error_code = ?, failed_at = ?, updated_at = ?
     WHERE kind = 'visit_alarm' AND reminder_id = ?
       AND send_state NOT IN ('accepted', 'cancelled', 'dead')
       AND EXISTS (
         SELECT 1 FROM visit_notes
         WHERE id = ? AND updated_at = ?
           AND (alarm_id <> ? OR alarm_state <> 'scheduled')
       )`
  ).bind(errorCode, nowIso, nowIso, alarmId, visitId, updatedAt, alarmId);
}

function cellsWithPhotoUrls(members) {
  return members.map((member) => ({
    ...member,
    baptized: defaultTruthy(member.baptized),
    longAbsent: truthy(member.longAbsent),
    photoUrl: member.photoKey
      ? `/api/photos/${encodeURIComponent(member.photoKey)}`
      : member.id?.startsWith("seed-") ? `/photos/${member.id}.jpg?v=${PHOTO_VERSION}` : ""
  }));
}

function contactMembersWithPhotoUrls(members) {
  return members.map((member) => {
    const id = clean(member.id);
    const photoKey = clean(member.photoKey);
    return {
      id,
      cellId: clean(member.cellId),
      name: clean(member.name),
      title: clean(member.title),
      role: clean(member.role),
      phone: clean(member.phone),
      homePhone: clean(member.homePhone),
      address: clean(member.address),
      photoKey,
      photoUrl: photoKey
        ? `/api/photos/${encodeURIComponent(photoKey)}`
        : id.startsWith("seed-") ? `/photos/${id}.jpg?v=${PHOTO_VERSION}` : ""
    };
  });
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
  return {
    ...record,
    present: Number(record.present) === 1,
    memberLongAbsent: truthy(record.memberLongAbsent),
    photoUrl: record.photoKey ? `/api/photos/${encodeURIComponent(record.photoKey)}` : ""
  };
}

function normalizeDateValue(value, message) {
  const date = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(message, 400);
  return date;
}

async function requireWriteAuth(viewerRole) {
  if (viewerRole !== ADMIN_ROLE) {
    throw new HttpError("Administrator access is required", 403);
  }
}

async function requireCallNoteAuth(request, env) {
  const token = request.headers.get("X-Webhook-Token") || request.headers.get("X-Call-Note-Token") || bearer(request);
  const expected = env.CALL_NOTE_TOKEN || env.CALL_NOTE_WEBHOOK_TOKEN || env.ADMIN_TOKEN || "";
  if (expected) {
    if (!(await timingSafeStringEqual(token, expected))) throw new HttpError("Unauthorized", 401);
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
  await auditStatement(env, actor, action, entityType, entityId, before, after).run();
}

function auditStatement(env, actor, action, entityType, entityId, before, after) {
  return env.DB.prepare(
    "INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    crypto.randomUUID(), actor, action, entityType, entityId,
    before ? JSON.stringify(before) : "",
    after ? JSON.stringify(after) : ""
  );
}

function conditionalAuditStatement(env, actor, action, entityType, entityId, before, after, settingKey, updatedAt, settingValue) {
  return env.DB.prepare(
    `INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, before_json, after_json)
     SELECT ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM app_settings WHERE key = ? AND updated_at = ? AND value = ?
     )`
  ).bind(
    crypto.randomUUID(), actor, action, entityType, entityId,
    before ? JSON.stringify(before) : "",
    after ? JSON.stringify(after) : "",
    settingKey,
    updatedAt,
    settingValue
  );
}

function bearer(request) {
  const header = request.headers.get("Authorization") || "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7) : "";
}

async function timingSafeStringEqual(actual, expected) {
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(String(actual || ""))),
    crypto.subtle.digest("SHA-256", encoder.encode(String(expected || "")))
  ]);
  return timingSafeBytesEqual(new Uint8Array(actualHash), new Uint8Array(expectedHash));
}

function clean(value) {
  return String(value ?? "").trim();
}

function passwordByteLength(value) {
  return new TextEncoder().encode(String(value || "")).byteLength;
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
  constructor(message, status, code = "") {
    super(message);
    this.status = status;
    this.code = code;
  }
}
