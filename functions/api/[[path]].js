import {
  addOrReplacePasskey,
  clearPasskeyStore,
  createPasskeyRegistrationOptions,
  getPasskeyStore,
  publicPasskeyStatus,
  verifyPasskeyRegistration
} from "../_webauthn.js";
import { handleCallNoteNotificationApi } from "../../lib/call-note-notification-api.js";
import { authenticateMobileMemoRequest } from "../../lib/mobile-memo-auth.js";
import { handleWebPushNotificationApi } from "../../lib/web-push-notification-api.js";
import { handleCommunityApi, handlePublicNewcomerApi } from "../../lib/community-api.js";
import {
  assertViewerMemberAccess,
  filterMembersForViewer,
  maskMemberForViewer,
  maskPrayerForViewer,
  maskTaskForViewer,
  maskVisitForViewer,
  normalizeTrustedViewer,
  ownerViewer,
  publicViewer,
  requireOwner,
  requireViewer,
  requireViewerEdit,
  viewerAuditActor,
  viewerCanAccessCell,
  viewerCanDeleteMembers,
  viewerCanUseMemos,
  viewerHasGlobalScope
} from "../../lib/community-access.js";
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
const CALL_NOTE_DAILY_BATCH_MAX_RECORDS = 100;
const CALL_NOTE_SOURCE_ID_MAX_LENGTH = 256;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_BYTES = 128;
const GROUP_NAME_MAX_LENGTH = 80;
const GROUP_DESCRIPTION_MAX_LENGTH = 500;
const GROUP_MEMBER_LIMIT = 1000;
const ADMIN_ROLE = "admin";
const NOTE_TITLE_MAX_LENGTH = 160;
const NOTE_BODY_MAX_LENGTH = 50000;
const NOTE_REFERENCE_ID_MAX_LENGTH = 128;
const NOTE_LIST_LIMIT = 2000;
const NOTE_TRASH_BULK_DELETE_LIMIT = 100;
const NOTE_REQUEST_MAX_BYTES = 256 * 1024;
const NOTE_CATEGORIES = new Set(["personal", "visitation", "admin"]);
const NOTE_CATEGORY_NAME_MAX_LENGTH = 80;
const NOTE_SYSTEM_CATEGORY_NAMES = new Map([
  ["personal", "개인"],
  ["visitation", "심방"],
  ["admin", "행정"]
]);
const NOTE_STATUSES = new Set(["active", "done"]);
const NOTE_REMINDER_STATES = new Set(["none", "scheduled", "dismissed"]);
const NOTE_COLORS = new Set(["default", "coral", "peach", "yellow", "sage", "mint", "blue", "lavender", "pink", "gray"]);
const NOTE_ATTACHMENT_LIMIT = 8;
const NOTE_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
const NOTE_ATTACHMENT_REQUEST_MAX_BYTES = 10 * 1024 * 1024;
const NOTE_SYNC_DEFAULT_LIMIT = 200;
const NOTE_SYNC_MAX_LIMIT = 500;
const NOTE_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const NOTE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOTE_ATTACHMENT_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"
]);
const NOTE_ATTACHMENT_TYPE_ALIASES = new Map([
  ["image/jpg", "image/jpeg"],
  ["image/pjpeg", "image/jpeg"],
  ["image/x-png", "image/png"]
]);
const NOTE_ATTACHMENT_UNSPECIFIED_TYPES = new Set(["", "application/octet-stream", "text/plain"]);
const NOTE_ATTACHMENT_EXTENSION_TYPES = new Map([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
  ["gif", "image/gif"],
  ["heic", "image/heic"],
  ["heif", "image/heif"]
]);
const NOTE_ATTACHMENT_SIGNATURE_BYTES = 64;
const VISIT_TYPE_ALARM = "알람";
const VISIT_ALARM_STATES = new Set(["none", "scheduled", "dismissed"]);
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
  ...securityHeaders,
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,If-Match,X-Expected-Revision,X-Client-Attachment-Id,X-Admin-Token,X-Call-Note-Token,X-Webhook-Token"
};
const trustedRequestActors = new WeakMap();

export async function onRequest(context) {
  const { request, env, params, data } = context;
  if (request.method === "OPTIONS") return new Response(null, { headers: jsonHeaders });

  const path = normalizePath(params.path);
  // The Pages middleware authenticates browser requests before they reach the API.
  // Mobile memo and device routes perform their own credential checks below.
  const viewerRole = normalizeViewerRole(data?.viewerRole);
  const viewer = normalizeTrustedViewer(data?.viewer) || (viewerRole === ADMIN_ROLE ? ownerViewer() : null);
  if (viewer) trustedRequestActors.set(request, viewerAuditActor(viewer));
  const authenticatedRequest = request;
  try {
    if (path[0] === "photos") return await handlePhotoRead(authenticatedRequest, env, path.slice(1), viewerRole, viewer);
    if (!env.DB) return json({ error: "D1 binding DB is not configured" }, 503);

    if (path[0] === "public" && path[1] === "newcomer") {
      return await handlePublicNewcomerApi({ request, env, path });
    }
    if (path[0] === "community") {
      return await handleCommunityApi({ request: authenticatedRequest, env, path, viewer });
    }
    if (path[0] === "auth") {
      requireOwner(viewer);
      return await handleAuth(authenticatedRequest, env, path);
    }
    if (path[0] === "integrations" && path[1] === "call-note") {
      const integrationRole = viewer?.role === "owner" ? ADMIN_ROLE : "";
      return await handleCallNoteNotificationApi({ request: authenticatedRequest, env, path, viewerRole: integrationRole });
    }
    if (path[0] === "notifications" && path[1] === "web-push") {
      return await handleWebPushNotificationApi({ request: authenticatedRequest, env, path, viewerRole, viewer });
    }
    if (path[0] === "settings") {
      requireOwner(viewer);
      return await handleSettings(authenticatedRequest, env);
    }
    if (path[0] === "call-note-token") {
      requireOwner(viewer);
      return await handleCallNoteToken(authenticatedRequest, env, ADMIN_ROLE);
    }
    if (request.method === "GET" && path[0] === "bootstrap") return await getBootstrap(env, viewer);
    if (request.method === "GET" && path[0] === "dashboard") return await getDashboard(env, viewer);
    if (path[0] === "mobile" && path[1] === "notes" && path[2] === "sync") {
      return await handleMobileNoteSync(request, env, path);
    }
    if (path[0] === "mobile" && path[1] === "members") {
      return await handleMobileMemberSearch(request, env, path);
    }
    if (path[0] === "note-categories") return await handleNoteCategories(authenticatedRequest, env, path, viewerRole);
    if (path[0] === "notes") return await handleNotes(authenticatedRequest, env, path, viewerRole);
    if (path[0] === "groups") return await handleGroups(authenticatedRequest, env, path, viewerRole);
    if (path[0] === "members") return await handleMembers(authenticatedRequest, env, path, viewerRole, viewer);
    if (path[0] === "visit-notes") return await handleVisitNotes(authenticatedRequest, env, path, viewerRole, viewer);
    if (path[0] === "care-tasks") return await handleCareTasks(authenticatedRequest, env, path, viewer);
    if (path[0] === "prayer-topics") return await handlePrayerTopics(authenticatedRequest, env, path, viewer);
    if (path[0] === "sunday-attendance") return await handleSundayAttendance(authenticatedRequest, env, viewerRole, viewer);
    if (path[0] === "webhook" && path[1] === "call-note") return await handleCallNotes(request, env);
    if (path[0] === "call-notes") return await handleCallNotes(request, env);
    if (path[0] === "call-note-imports") return await handleCallNoteImports(authenticatedRequest, env, path, viewerRole);

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
  return value === ADMIN_ROLE ? value : "";
}

async function getBootstrap(env, viewer) {
  requireViewer(viewer);

  const [settings, cells, members, visits, careTasks, prayerTopics, notes, noteCategories] = await Promise.all([
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
        summary, prayer, action, source, alarm_at AS alarmAt, alarm_state AS alarmState,
        alarm_id AS alarmId, dismissed_at AS alarmDismissedAt,
        created_at AS createdAt, updated_at AS updatedAt
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
    ).all(),
    listNotes(env),
    listNoteCategories(env)
  ]);
  const visibleMembers = filterMembersForViewer(members.results || [], viewer);
  const memberIds = new Set(visibleMembers.map((member) => member.id));
  const visibleCells = viewerHasGlobalScope(viewer)
    ? (cells.results || [])
    : (cells.results || []).filter((cell) => viewerCanAccessCell(viewer, cell.id));
  const canUseMemos = viewerCanUseMemos(viewer);
  return json({
    viewerRole: viewer.role === "owner" || viewer.role === "pastor" ? ADMIN_ROLE : viewer.role,
    viewer: publicViewer(viewer),
    settings,
    cells: visibleCells,
    members: cellsWithPhotoUrls(visibleMembers.map((member) => maskMemberForViewer(member, viewer))),
    visits: (visits.results || []).filter((visit) => memberIds.has(visit.memberId)).map((visit) => maskVisitForViewer(visit, viewer)),
    careTasks: (careTasks.results || []).filter((task) => memberIds.has(task.memberId)).map(normalizeCareTaskRow).map((task) => maskTaskForViewer(task, viewer)),
    prayerTopics: (prayerTopics.results || []).filter((topic) => memberIds.has(topic.memberId)).map(normalizePrayerTopicRow).map((topic) => maskPrayerForViewer(topic, viewer)),
    notes: canUseMemos ? notes : [],
    noteCategories: canUseMemos ? noteCategories : []
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
    const updatedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE notes
         SET group_id = NULL, revision = revision + 1, updated_at = ?
         WHERE group_id = ? AND deleted_at = ''`
      ).bind(updatedAt, id),
      env.DB.prepare("DELETE FROM managed_groups WHERE id = ?").bind(id)
    ]);
    await audit(env, request, "group.delete", "managed_group", id, previous, "");
    return json({ ok: true, id });
  }

  return json({ error: "Not found" }, 404);
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

async function handleNoteCategories(request, env, path, viewerRole) {
  const principal = await requireMemoAccess(
    request,
    env,
    viewerRole,
    request.method === "GET" ? ["notes:read"] : ["notes:write"]
  );

  if (request.method === "GET" && path.length === 1) {
    return json({ categories: await listNoteCategories(env) });
  }

  if (request.method === "POST" && path.length === 1) {
    const body = await readBoundedNoteJson(request);
    const name = normalizeNoteCategoryName(body?.name);
    const normalizedName = normalizeNoteCategoryNameKey(name);
    const duplicate = await env.DB.prepare(
      "SELECT id FROM note_categories WHERE normalized_name = ? COLLATE NOCASE LIMIT 1"
    ).bind(normalizedName).first();
    if (duplicate) {
      return json({ error: "A note category with this name already exists", code: "NOTE_CATEGORY_DUPLICATE" }, 409);
    }

    const now = new Date().toISOString();
    const category = {
      id: crypto.randomUUID().toLowerCase(),
      name,
      isSystem: false,
      createdAt: now,
      updatedAt: now
    };
    let results;
    try {
      results = await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO note_categories (id, name, normalized_name, is_system, created_at, updated_at)
           VALUES (?, ?, ?, 0, ?, ?)`
        ).bind(category.id, category.name, normalizedName, now, now),
        mutationAuditStatement(
          env, request, "note_category.create", "note_category", category.id,
          "", noteCategoryAuditShape(category), memoAuditActor(principal)
        )
      ]);
    } catch {
      const concurrentDuplicate = await env.DB.prepare(
        "SELECT id FROM note_categories WHERE normalized_name = ? COLLATE NOCASE LIMIT 1"
      ).bind(normalizedName).first();
      if (concurrentDuplicate) {
        return json({ error: "A note category with this name already exists", code: "NOTE_CATEGORY_DUPLICATE" }, 409);
      }
      throw new HttpError("Note category could not be created", 503, "NOTE_CATEGORY_WRITE_FAILED");
    }
    if (Number(results?.[0]?.meta?.changes || 0) !== 1
      || Number(results?.[1]?.meta?.changes || 0) !== 1) {
      throw new HttpError("Note category could not be created", 503, "NOTE_CATEGORY_WRITE_FAILED");
    }
    return json(category, 201);
  }

  if (request.method === "PATCH" && path.length === 2) {
    const id = normalizeNoteCategoryId(path[1]);
    const storedRow = await env.DB.prepare(
      `SELECT id, name, is_system AS isSystem, created_at AS createdAt, updated_at AS updatedAt
       FROM note_categories WHERE id = ?`
    ).bind(id).first();
    if (!storedRow) {
      return json({ error: "Note category not found", code: "NOTE_CATEGORY_NOT_FOUND" }, 404);
    }
    const stored = normalizeNoteCategoryRow(storedRow);
    const body = await readBoundedNoteJson(request);
    const name = normalizeNoteCategoryName(body?.name);
    const normalizedName = normalizeNoteCategoryNameKey(name);
    const duplicate = await env.DB.prepare(
      "SELECT id FROM note_categories WHERE normalized_name = ? COLLATE NOCASE AND id <> ? LIMIT 1"
    ).bind(normalizedName, id).first();
    if (duplicate) {
      return json({ error: "A note category with this name already exists", code: "NOTE_CATEGORY_DUPLICATE" }, 409);
    }

    const updatedAt = nextIsoTimestamp(stored.updatedAt);
    const updated = { ...stored, name, updatedAt };
    let results;
    try {
      results = await env.DB.batch([
        env.DB.prepare(
          `UPDATE note_categories
           SET name = ?, normalized_name = ?, updated_at = ?
           WHERE id = ?`
        ).bind(name, normalizedName, updatedAt, id),
        mutationAuditStatement(
          env, request, "note_category.update", "note_category", id,
          noteCategoryAuditShape(stored), noteCategoryAuditShape(updated), memoAuditActor(principal)
        )
      ]);
    } catch {
      const concurrentDuplicate = await env.DB.prepare(
        "SELECT id FROM note_categories WHERE normalized_name = ? COLLATE NOCASE AND id <> ? LIMIT 1"
      ).bind(normalizedName, id).first();
      if (concurrentDuplicate) {
        return json({ error: "A note category with this name already exists", code: "NOTE_CATEGORY_DUPLICATE" }, 409);
      }
      throw new HttpError("Note category could not be updated", 503, "NOTE_CATEGORY_WRITE_FAILED");
    }
    if (Number(results?.[0]?.meta?.changes || 0) !== 1) {
      return json({ error: "Note category not found", code: "NOTE_CATEGORY_NOT_FOUND" }, 404);
    }
    if (Number(results?.[1]?.meta?.changes || 0) !== 1) {
      throw new HttpError("Note category could not be updated", 503, "NOTE_CATEGORY_WRITE_FAILED");
    }
    return json(updated);
  }

  if (request.method === "DELETE" && path.length === 2) {
    const id = normalizeNoteCategoryId(path[1]);
    const storedRow = await env.DB.prepare(
      `SELECT id, name, is_system AS isSystem, created_at AS createdAt, updated_at AS updatedAt
       FROM note_categories WHERE id = ?`
    ).bind(id).first();
    if (!storedRow) {
      if (await hasAuditRecord(env, "note_category.delete", "note_category", id)) {
        return json({ ok: true, deleted: true, id });
      }
      return json({ error: "Note category not found", code: "NOTE_CATEGORY_NOT_FOUND" }, 404);
    }
    const stored = normalizeNoteCategoryRow(storedRow);
    const reference = await env.DB.prepare(
      "SELECT 1 AS inUse FROM notes WHERE category_id = ? LIMIT 1"
    ).bind(id).first();
    if (reference) {
      return json({ error: "This note category is still in use", code: "NOTE_CATEGORY_IN_USE" }, 409);
    }

    let results;
    try {
      results = await env.DB.batch([
        env.DB.prepare(
          "DELETE FROM note_categories WHERE id = ?"
        ).bind(id),
        mutationAuditStatement(
          env, request, "note_category.delete", "note_category", id,
          noteCategoryAuditShape(stored), "", memoAuditActor(principal)
        )
      ]);
    } catch (error) {
      if (databaseErrorIncludes(error, "NOTE_CATEGORY_IN_USE")) {
        return json({ error: "This note category is still in use", code: "NOTE_CATEGORY_IN_USE" }, 409);
      }
      throw new HttpError("Note category could not be deleted", 503, "NOTE_CATEGORY_DELETE_FAILED");
    }
    if (Number(results?.[0]?.meta?.changes || 0) !== 1) {
      if (await hasAuditRecord(env, "note_category.delete", "note_category", id)) {
        return json({ ok: true, deleted: true, id });
      }
      return json({ error: "Note category not found", code: "NOTE_CATEGORY_NOT_FOUND" }, 404);
    }
    if (Number(results?.[1]?.meta?.changes || 0) !== 1) {
      throw new HttpError("Note category could not be deleted", 503, "NOTE_CATEGORY_DELETE_FAILED");
    }
    return json({ ok: true, deleted: true, id });
  }

  return json({ error: "Not found" }, 404);
}

async function listNoteCategories(env) {
  const rows = await env.DB.prepare(
    `SELECT id, name, is_system AS isSystem, created_at AS createdAt, updated_at AS updatedAt
     FROM note_categories
     ORDER BY is_system DESC,
       CASE id WHEN 'personal' THEN 0 WHEN 'visitation' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END,
       name COLLATE NOCASE, id`
  ).all();
  return (rows.results || []).map(normalizeNoteCategoryRow);
}

function normalizeNoteCategoryRow(row) {
  return {
    id: clean(row.id),
    name: clean(row.name),
    isSystem: truthy(row.isSystem),
    createdAt: normalizeStoredNoteCategoryTimestamp(row.createdAt, "createdAt"),
    updatedAt: normalizeStoredNoteCategoryTimestamp(row.updatedAt, "updatedAt")
  };
}

function normalizeStoredNoteCategoryTimestamp(value, field) {
  const normalized = normalizeStrictTimestamp(value, true);
  if (!normalized) throw invalidStoredNoteCategoryTimestamp(field);
  return normalized;
}

function normalizeStrictTimestamp(value, allowLegacy = false) {
  const text = typeof value === "string" ? value : "";
  if (!text || text !== text.trim()) return "";
  const legacy = allowLegacy
    ? /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text)
    : null;
  const rfc3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/i.exec(text);
  const match = legacy || rfc3339;
  if (!match || !validStoredDateTimeParts(match, rfc3339?.[8] || "Z")) {
    return "";
  }

  const source = legacy ? `${text.slice(0, 10)}T${text.slice(11)}Z` : text;
  const timestamp = Date.parse(source);
  if (!Number.isFinite(timestamp)) return "";
  const normalized = new Date(timestamp).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(normalized)) {
    return "";
  }
  if (Number(normalized.slice(0, 4)) < 1) return "";
  return normalized;
}

function invalidStoredNoteCategoryTimestamp(field) {
  return new HttpError(
    `Stored note category ${field} is invalid`,
    500,
    "NOTE_CATEGORY_TIMESTAMP_INVALID"
  );
}

function validStoredDateTimeParts(match, timezone) {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  if (timezone.toUpperCase() === "Z") return true;
  const offset = /^([+-])(\d{2}):(\d{2})$/.exec(timezone);
  return Boolean(offset) && Number(offset[2]) <= 23 && Number(offset[3]) <= 59;
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function normalizeNoteCategoryName(value) {
  const name = String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!name) throw new HttpError("Note category name is required", 400, "NOTE_CATEGORY_NAME_REQUIRED");
  if (name.length > NOTE_CATEGORY_NAME_MAX_LENGTH) {
    throw new HttpError(
      `Note category name must be ${NOTE_CATEGORY_NAME_MAX_LENGTH} characters or fewer`,
      400,
      "NOTE_CATEGORY_NAME_TOO_LONG"
    );
  }
  return name;
}

function normalizeNoteCategoryNameKey(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("ko-KR");
}

function normalizeNoteCategoryId(value) {
  const id = clean(value).toLowerCase();
  if (!NOTE_CATEGORIES.has(id) && !NOTE_ID_PATTERN.test(id)) {
    throw new HttpError("categoryId must be a system category id or UUID", 400, "NOTE_CATEGORY_ID_INVALID");
  }
  return id;
}

function normalizeOptionalNoteCategoryId(value) {
  const id = clean(value).toLowerCase();
  return id ? normalizeNoteCategoryId(id) : "";
}

function databaseErrorIncludes(error, marker) {
  return String(error?.message || "").includes(marker);
}

async function handleNotes(request, env, path, viewerRole) {
  const attachmentMutation = path[2] === "attachments" && request.method !== "GET";
  const scopes = request.method === "GET"
    ? ["notes:read"]
    : attachmentMutation
      ? ["notes:write", "photos:write"]
      : ["notes:write"];
  const principal = await requireMemoAccess(request, env, viewerRole, scopes);

  if (request.method === "GET" && path.length === 1) {
    const view = clean(new URL(request.url).searchParams.get("view"));
    if (view === "trash") {
      if (!isMemoTrashPrincipal(principal)) {
        return json({ error: "Administrator access is required", code: "NOTE_TRASH_ADMIN_REQUIRED" }, 403);
      }
      return json({ notes: await listDeletedNotes(env) });
    }
    if (view) return json({ error: "Unknown notes view", code: "NOTE_VIEW_INVALID" }, 400);
    return json({ notes: await listNotes(env) });
  }

  if (request.method === "POST" && path.length === 1) {
    const body = await readBoundedNoteJson(request);
    const note = normalizeNoteInput(body, null, { allowClientId: principal.kind === "mobile" });
    await validateNoteLinks(env, note);
    let results;
    try {
      results = await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO notes
            (id, category, category_id, title, body, color, pinned, status, member_id, group_id, remind_at,
             reminder_state, reminder_id, dismissed_at, revision, deleted_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), ?, ?, ?, ?, ?, '', ?, ?)
           ON CONFLICT(id) DO NOTHING`
        ).bind(
          note.id, note.category, note.categoryId, note.title, note.body, note.color, note.pinned ? 1 : 0, note.status,
          note.memberId, note.groupId, note.remindAt, note.reminderState, note.reminderId, note.dismissedAt,
          note.revision, note.createdAt, note.updatedAt
        ),
        mutationAuditStatement(
          env, request, "note.create", "note", note.id,
          "", noteAuditShape(note), memoAuditActor(principal)
        )
      ]);
    } catch (error) {
      if (databaseErrorIncludes(error, "NOTE_CATEGORY_INVALID")) {
        throw new HttpError("Note category changed; reload categories and try again", 409, "NOTE_CATEGORY_NOT_FOUND");
      }
      throw error;
    }
    // D1 counts the note row and the note_sync_changes trigger row together.
    // The guarded INSERT can affect at most one note, so any positive count is success.
    if (Number(results?.[0]?.meta?.changes || 0) < 1) {
      const existing = await getNote(env, note.id, { includeDeleted: true });
      if (principal.kind === "mobile" && clean(body?.id) && existing) {
        return sameMobileCreateState(existing, note)
          ? json(existing)
          : json({ error: "Note id already exists", code: "NOTE_ID_CONFLICT" }, 409);
      }
      throw new HttpError("Note could not be created", 503, "NOTE_WRITE_FAILED");
    }
    if (Number(results?.[1]?.meta?.changes || 0) !== 1) {
      throw new HttpError("Note could not be created", 503, "NOTE_WRITE_FAILED");
    }
    return json(note, 201);
  }

  if (request.method === "DELETE" && path.length === 2 && path[1] === "trash") {
    if (!isMemoTrashPrincipal(principal)) {
      return json({ error: "Administrator access is required", code: "NOTE_TRASH_ADMIN_REQUIRED" }, 403);
    }
    const candidates = await env.DB.prepare(
      `SELECT id, revision, deleted_at AS deletedAt, updated_at AS updatedAt
       FROM notes
       WHERE deleted_at <> '' AND purge_started_at = ''
       ORDER BY deleted_at, id
       LIMIT ?`
    ).bind(NOTE_TRASH_BULK_DELETE_LIMIT).all();
    const purgedIds = [];
    let failed = 0;
    for (const candidate of candidates.results || []) {
      try {
        await permanentlyDeleteStoredNote(env, candidate, {
          request,
          actorOverride: memoAuditActor(principal),
          before: noteTombstone(candidate)
        });
        purgedIds.push(clean(candidate.id));
      } catch (error) {
        failed += 1;
        console.error(JSON.stringify({
          event: "note_trash.manual_purge_failed",
          noteId: clean(candidate.id),
          errorCode: clean(error?.code) || "NOTE_PURGE_FAILED"
        }));
      }
    }
    const remainingRow = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM notes WHERE deleted_at <> ''"
    ).first();
    const remaining = Math.max(0, Number(remainingRow?.count || 0));
    try {
      await audit(
        env, request, "note.trash.empty", "note_trash", "trash",
        "", { purgedCount: purgedIds.length, failed, remaining }, memoAuditActor(principal)
      );
    } catch (error) {
      console.error(JSON.stringify({
        event: "note_trash.summary_audit_failed",
        errorCode: clean(error?.code) || "NOTE_TRASH_AUDIT_FAILED",
        purgedCount: purgedIds.length,
        failed,
        remaining
      }));
    }
    return json({ ok: failed === 0, purgedIds, failed, remaining }, failed ? 207 : 200);
  }

  const id = normalizeNoteId(path[1]);

  if (request.method === "GET" && path.length === 2) {
    const note = await getNote(env, id);
    return note ? json(note) : json({ error: "Note not found", code: "NOTE_NOT_FOUND" }, 404);
  }

  if (request.method === "POST" && path.length === 3 && path[2] === "attachments") {
    return uploadNoteAttachment(request, env, id, principal);
  }

  if (request.method === "DELETE" && path.length === 4 && path[2] === "attachments") {
    return deleteNoteAttachment(request, env, id, clean(path[3]), principal);
  }

  if (request.method === "DELETE" && path.length === 3 && path[2] === "permanent") {
    if (!isMemoTrashPrincipal(principal)) {
      return json({ error: "Administrator access is required", code: "NOTE_TRASH_ADMIN_REQUIRED" }, 403);
    }
    const stored = await getNote(env, id, { includeDeleted: true });
    if (!stored) {
      if (await hasAuditRecord(env, "note.purge", "note", id)) {
        return json({ ok: true, id, permanentlyDeleted: true });
      }
      return json({ error: "Note not found", code: "NOTE_NOT_FOUND" }, 404);
    }
    if (!stored.deletedAt) {
      return json({ error: "Only trashed notes can be permanently deleted", code: "NOTE_NOT_IN_TRASH" }, 409);
    }
    const expectedRevision = expectedRevisionFromHeaders(request);
    if (expectedRevision.invalid) {
      return json({ error: "If-Match must contain a positive note revision", code: "NOTE_PRECONDITION_INVALID" }, 400);
    }
    if (expectedRevision.value === null) {
      return json({ error: "If-Match is required", code: "NOTE_PRECONDITION_REQUIRED" }, 428);
    }
    if (expectedRevision.value !== stored.revision) {
      return json({ error: "Note changed; reload and try again", code: "NOTE_VERSION_CONFLICT", note: stored }, 409);
    }
    await permanentlyDeleteStoredNote(env, stored, {
      request,
      actorOverride: memoAuditActor(principal),
      before: noteAuditShape(stored)
    });
    return json({ ok: true, id, permanentlyDeleted: true });
  }

  if (request.method === "POST" && path.length === 3 && path[2] === "restore") {
    const stored = await getNote(env, id, { includeDeleted: true });
    if (!stored) return json({ error: "Note not found", code: "NOTE_NOT_FOUND" }, 404);
    const expectedRevision = expectedRevisionFromHeaders(request);
    if (expectedRevision.invalid) {
      return json({ error: "If-Match must contain a positive note revision", code: "NOTE_PRECONDITION_INVALID" }, 400);
    }
    if (!stored.deletedAt) return json(stored);
    if (expectedRevision.value === null) {
      return json({ error: "If-Match is required", code: "NOTE_PRECONDITION_REQUIRED" }, 428);
    }
    if (expectedRevision.value !== stored.revision) {
      return json({ error: "Note changed; reload and try again", code: "NOTE_VERSION_CONFLICT", note: stored }, 409);
    }

    const purge = await env.DB.prepare(
      "SELECT purge_started_at AS purgeStartedAt FROM notes WHERE id = ?"
    ).bind(id).first();
    if (clean(purge?.purgeStartedAt)) {
      return json({ error: "Note purge is already in progress", code: "NOTE_PURGE_IN_PROGRESS" }, 409);
    }
    const restoredAt = nextIsoTimestamp(stored.updatedAt);
    const revision = stored.revision + 1;
    const restoredSnapshot = { ...stored, revision, deletedAt: "", updatedAt: restoredAt };
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE notes
         SET deleted_at = '', revision = ?, updated_at = ?
         WHERE id = ? AND revision = ? AND deleted_at = ? AND purge_started_at = ''`
      ).bind(revision, restoredAt, id, stored.revision, stored.deletedAt),
      mutationAuditStatement(
        env, request, "note.restore", "note", id,
        noteAuditShape(stored), noteAuditShape(restoredSnapshot), memoAuditActor(principal)
      )
    ]);
    if (Number(results?.[0]?.meta?.changes || 0) < 1) {
      const current = await getNote(env, id, { includeDeleted: true });
      if (!current) return json({ error: "Note not found", code: "NOTE_NOT_FOUND" }, 404);
      if (!current.deletedAt) return json(current);
      const currentPurge = await env.DB.prepare(
        "SELECT purge_started_at AS purgeStartedAt FROM notes WHERE id = ?"
      ).bind(id).first();
      if (clean(currentPurge?.purgeStartedAt)) {
        return json({ error: "Note purge is already in progress", code: "NOTE_PURGE_IN_PROGRESS" }, 409);
      }
      return json({ error: "Note changed; reload and try again", code: "NOTE_VERSION_CONFLICT", note: current }, 409);
    }
    if (Number(results?.[1]?.meta?.changes || 0) !== 1) {
      throw new HttpError("Note could not be restored", 503, "NOTE_WRITE_FAILED");
    }
    const restored = await getNote(env, id);
    return json(restored);
  }

  if (request.method === "PATCH" && path.length === 2) {
    const previous = await getNote(env, id);
    if (!previous) return json({ error: "Note not found", code: "NOTE_NOT_FOUND" }, 404);
    const body = await readBoundedNoteJson(request);
    const headerRevision = expectedRevisionFromHeaders(request);
    const hasBodyRevision = Object.prototype.hasOwnProperty.call(body, "expectedRevision");
    const bodyRevision = parseExpectedRevision(body.expectedRevision);
    const hasExpectedUpdatedAt = Object.prototype.hasOwnProperty.call(body, "expectedUpdatedAt");
    const expectedUpdatedAt = hasExpectedUpdatedAt
      ? normalizeStrictTimestamp(body.expectedUpdatedAt)
      : "";
    if (headerRevision.invalid
      || (hasBodyRevision && bodyRevision === null)
      || (bodyRevision !== null && headerRevision.value !== null && bodyRevision !== headerRevision.value)
      || (hasExpectedUpdatedAt && !expectedUpdatedAt)) {
      return json({ error: "Note precondition is invalid", code: "NOTE_PRECONDITION_INVALID" }, 400);
    }
    const expectedRevision = bodyRevision ?? headerRevision.value;
    if ((principal.kind === "mobile" && expectedRevision === null)
      || (expectedRevision === null && !expectedUpdatedAt)) {
      return json({ error: "expectedRevision is required", code: "NOTE_PRECONDITION_REQUIRED" }, 428);
    }
    if ((expectedRevision !== null && expectedRevision !== previous.revision)
      || (expectedUpdatedAt && expectedUpdatedAt !== previous.updatedAt)) {
      if (sameNotePatchState(previous, body)) return json(previous);
      return json({ error: "Note changed; reload and try again", code: "NOTE_VERSION_CONFLICT", note: previous }, 409);
    }
    const note = normalizeNoteInput(body, previous);
    await validateNoteLinks(env, note);
    let results;
    try {
      results = await env.DB.batch([
        env.DB.prepare(
          `UPDATE notes
           SET category = ?, category_id = ?, title = ?, body = ?, color = ?, pinned = ?, status = ?,
               member_id = NULLIF(?, ''), group_id = NULLIF(?, ''), remind_at = ?, reminder_state = ?,
               reminder_id = ?, dismissed_at = ?, revision = ?, updated_at = ?
           WHERE id = ? AND revision = ? AND deleted_at = ''`
        ).bind(
          note.category, note.categoryId, note.title, note.body, note.color, note.pinned ? 1 : 0, note.status,
          note.memberId, note.groupId, note.remindAt, note.reminderState, note.reminderId, note.dismissedAt,
          note.revision, note.updatedAt, id, previous.revision
        ),
        mutationAuditStatement(
          env, request, "note.update", "note", id,
          noteAuditShape(previous), noteAuditShape(note), memoAuditActor(principal)
        )
      ]);
    } catch (error) {
      if (databaseErrorIncludes(error, "NOTE_CATEGORY_INVALID")) {
        throw new HttpError("Note category changed; reload categories and try again", 409, "NOTE_CATEGORY_NOT_FOUND");
      }
      throw error;
    }
    if (Number(results?.[0]?.meta?.changes || 0) < 1) {
      const current = await getNote(env, id, { includeDeleted: true });
      if (!current || current.deletedAt) return json({ error: "Note not found", code: "NOTE_NOT_FOUND" }, 404);
      if (sameNotePatchState(current, body)) return json(current);
      return json({ error: "Note changed; reload and try again", code: "NOTE_VERSION_CONFLICT", note: current }, 409);
    }
    if (Number(results?.[1]?.meta?.changes || 0) !== 1) {
      throw new HttpError("Note could not be updated", 503, "NOTE_WRITE_FAILED");
    }
    return json(note);
  }

  if (request.method === "DELETE" && path.length === 2) {
    const stored = await getNote(env, id, { includeDeleted: true });
    if (!stored) return json({ error: "Note not found", code: "NOTE_NOT_FOUND" }, 404);
    if (stored.deletedAt) return json(noteTombstone(stored));
    const expectedRevision = expectedRevisionFromHeaders(request);
    if (expectedRevision.invalid) {
      return json({ error: "If-Match must contain a positive note revision", code: "NOTE_PRECONDITION_INVALID" }, 400);
    }
    if (principal.kind === "mobile" && expectedRevision.value === null) {
      return json({ error: "If-Match is required", code: "NOTE_PRECONDITION_REQUIRED" }, 428);
    }
    if (expectedRevision.value !== null && expectedRevision.value !== stored.revision) {
      return json({ error: "Note changed; reload and try again", code: "NOTE_VERSION_CONFLICT", note: stored }, 409);
    }
    const deletedAt = nextIsoTimestamp(stored.updatedAt);
    const revision = stored.revision + 1;
    const deleted = { ...stored, revision, deletedAt, updatedAt: deletedAt };
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE notes
         SET deleted_at = ?, revision = ?, updated_at = ?
         WHERE id = ? AND revision = ? AND deleted_at = ''`
      ).bind(deletedAt, revision, deletedAt, id, stored.revision),
      mutationAuditStatement(
        env, request, "note.delete", "note", id,
        noteAuditShape(stored), noteAuditShape(deleted), memoAuditActor(principal)
      )
    ]);
    if (Number(results?.[0]?.meta?.changes || 0) < 1) {
      const current = await getNote(env, id, { includeDeleted: true });
      if (current?.deletedAt) return json(noteTombstone(current));
      return current
        ? json({ error: "Note changed; reload and try again", code: "NOTE_VERSION_CONFLICT", note: current }, 409)
        : json({ error: "Note not found", code: "NOTE_NOT_FOUND" }, 404);
    }
    if (Number(results?.[1]?.meta?.changes || 0) !== 1) {
      throw new HttpError("Note could not be moved to trash", 503, "NOTE_WRITE_FAILED");
    }
    return json(noteTombstone(deleted));
  }

  return json({ error: "Not found" }, 404);
}

async function permanentlyDeleteStoredNote(env, stored, auditContext) {
  const id = clean(stored?.id);
  const revision = Number(stored?.revision || 0);
  const deletedAt = clean(stored?.deletedAt);
  if (!id || revision < 1 || !deletedAt) {
    throw new HttpError("Only trashed notes can be permanently deleted", 409, "NOTE_NOT_IN_TRASH");
  }
  const claimTime = new Date().toISOString();
  const claim = await env.DB.prepare(
    `UPDATE notes
     SET purge_started_at = ?
     WHERE id = ? AND revision = ? AND deleted_at = ? AND purge_started_at = ''`
  ).bind(claimTime, id, revision, deletedAt).run();
  if (Number(claim?.meta?.changes || 0) !== 1) {
    throw new HttpError("Note purge is already in progress", 409, "NOTE_PURGE_IN_PROGRESS");
  }

  try {
    const attachments = await env.DB.prepare(
      "SELECT object_key AS objectKey FROM note_attachments WHERE note_id = ? ORDER BY id"
    ).bind(id).all();
    const objectKeys = (attachments.results || [])
      .map((row) => clean(row.objectKey))
      .filter(Boolean);
    if (objectKeys.length) {
      if (!env.PHOTOS || typeof env.PHOTOS.delete !== "function") {
        throw new HttpError("Photo storage is unavailable", 503, "NOTE_PHOTOS_BINDING_UNAVAILABLE");
      }
      try {
        await env.PHOTOS.delete(objectKeys);
      } catch {
        throw new HttpError("Attached photos could not be deleted", 503, "NOTE_PHOTO_DELETE_FAILED");
      }
    }
    const results = await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM notes
         WHERE id = ? AND revision = ? AND deleted_at = ? AND purge_started_at = ?`
      ).bind(id, revision, deletedAt, claimTime),
      mutationAuditStatement(
        env,
        auditContext.request,
        "note.purge",
        "note",
        id,
        auditContext.before,
        { permanentlyDeleted: true },
        auditContext.actorOverride
      )
    ]);
    if (Number(results?.[0]?.meta?.changes || 0) < 1
      || Number(results?.[1]?.meta?.changes || 0) !== 1) {
      throw new HttpError("Note changed during permanent deletion", 409, "NOTE_PURGE_STATE_CHANGED");
    }
  } catch (error) {
    try {
      await env.DB.prepare(
        "UPDATE notes SET purge_started_at = '' WHERE id = ? AND purge_started_at = ?"
      ).bind(id, claimTime).run();
    } catch {
      console.error(JSON.stringify({ event: "note_trash.claim_release_failed", noteId: id }));
    }
    throw error;
  }
}

async function listNotes(env) {
  const [rows, attachmentRows] = await Promise.all([
    env.DB.prepare(
      `SELECT note.id, note.category, note.category_id AS categoryId,
       COALESCE(category_def.name, '') AS categoryName, note.title, note.body, note.color, note.pinned,
       note.status, COALESCE(note.member_id, '') AS memberId, COALESCE(note.group_id, '') AS groupId,
       note.remind_at AS remindAt, note.reminder_state AS reminderState,
       note.reminder_id AS reminderId, note.dismissed_at AS dismissedAt, note.revision,
       note.deleted_at AS deletedAt, note.created_at AS createdAt, note.updated_at AS updatedAt
      FROM notes note
      LEFT JOIN note_categories category_def ON category_def.id = note.category_id
      WHERE note.deleted_at = ''
      ORDER BY note.pinned DESC, note.updated_at DESC
     LIMIT ?`
    ).bind(NOTE_LIST_LIMIT).all(),
    env.DB.prepare(
      `SELECT a.id, a.note_id AS noteId, a.object_key AS objectKey, a.file_name AS fileName,
        a.content_type AS contentType, a.byte_size AS byteSize, a.created_at AS createdAt
       FROM note_attachments a
       INNER JOIN (
          SELECT id FROM notes WHERE deleted_at = '' ORDER BY pinned DESC, updated_at DESC LIMIT ?
       ) visible_notes ON visible_notes.id = a.note_id
       ORDER BY a.created_at`
    ).bind(NOTE_LIST_LIMIT).all()
  ]);
  const attachmentsByNote = groupNoteAttachments(attachmentRows.results || []);
  return (rows.results || []).map((row) => normalizeNoteRow(row, attachmentsByNote.get(clean(row.id)) || []));
}

async function listDeletedNotes(env) {
  const [rows, attachmentRows] = await Promise.all([
    env.DB.prepare(
      `SELECT note.id, note.category, note.category_id AS categoryId,
        COALESCE(category_def.name, '') AS categoryName, note.title, note.body, note.color, note.pinned,
        note.status, COALESCE(note.member_id, '') AS memberId, COALESCE(note.group_id, '') AS groupId,
        note.remind_at AS remindAt, note.reminder_state AS reminderState,
        note.reminder_id AS reminderId, note.dismissed_at AS dismissedAt, note.revision,
        note.deleted_at AS deletedAt, note.created_at AS createdAt, note.updated_at AS updatedAt
       FROM notes note
       LEFT JOIN note_categories category_def ON category_def.id = note.category_id
       WHERE note.deleted_at <> ''
       ORDER BY note.deleted_at DESC, note.id
       LIMIT ?`
    ).bind(NOTE_LIST_LIMIT).all(),
    env.DB.prepare(
      `SELECT a.id, a.note_id AS noteId, a.object_key AS objectKey, a.file_name AS fileName,
        a.content_type AS contentType, a.byte_size AS byteSize, a.created_at AS createdAt
       FROM note_attachments a
       INNER JOIN (
         SELECT id FROM notes WHERE deleted_at <> '' ORDER BY deleted_at DESC, id LIMIT ?
       ) deleted_notes ON deleted_notes.id = a.note_id
       ORDER BY a.note_id, a.created_at`
    ).bind(NOTE_LIST_LIMIT).all()
  ]);
  const attachmentsByNote = groupNoteAttachments(attachmentRows.results || []);
  const now = Date.now();
  return (rows.results || []).map((row) => {
    const note = normalizeNoteRow(row, attachmentsByNote.get(clean(row.id)) || []);
    const deletedAtMs = Date.parse(note.deletedAt);
    const trashExpiresAt = Number.isFinite(deletedAtMs)
      ? new Date(deletedAtMs + NOTE_TRASH_RETENTION_MS).toISOString()
      : "";
    const trashDaysRemaining = Number.isFinite(deletedAtMs)
      ? Math.max(0, Math.ceil((deletedAtMs + NOTE_TRASH_RETENTION_MS - now) / (24 * 60 * 60 * 1000)))
      : 0;
    return { ...note, trashExpiresAt, trashDaysRemaining };
  });
}

async function handleMobileNoteSync(request, env, path) {
  if (request.method !== "GET" || path.length !== 3) return json({ error: "Not found" }, 404);
  await authenticateMobileMemoRequest(request, env, "notes:read");
  const url = new URL(request.url);
  const cursorText = clean(url.searchParams.get("cursor") || "0");
  if (!/^\d+$/.test(cursorText) || Number(cursorText) > Number.MAX_SAFE_INTEGER) {
    return json({ error: "cursor must be a non-negative integer", code: "NOTE_SYNC_CURSOR_INVALID" }, 400);
  }
  const cursor = Number(cursorText);
  const limit = clampQueryInteger(url.searchParams.get("limit"), NOTE_SYNC_DEFAULT_LIMIT, 1, NOTE_SYNC_MAX_LIMIT);
  const rows = await env.DB.prepare(
    `SELECT change.sequence, change.note_id AS changeNoteId, change.revision AS changeRevision,
       change.change_type AS changeType, change.changed_at AS changedAt,
       note.id, note.category, note.category_id AS categoryId,
       COALESCE(category_def.name, '') AS categoryName, note.title, note.body, note.color, note.pinned, note.status,
       COALESCE(note.member_id, '') AS memberId, COALESCE(note.group_id, '') AS groupId,
       note.remind_at AS remindAt, note.reminder_state AS reminderState,
       note.reminder_id AS reminderId, note.dismissed_at AS dismissedAt,
       note.revision, note.deleted_at AS deletedAt, note.created_at AS createdAt, note.updated_at AS updatedAt
     FROM note_sync_changes change
     LEFT JOIN notes note ON note.id = change.note_id
     LEFT JOIN note_categories category_def ON category_def.id = note.category_id
     WHERE change.sequence > ?
     ORDER BY change.sequence
     LIMIT ?`
  ).bind(cursor, limit + 1).all();
  const pageRows = (rows.results || []).slice(0, limit);
  const hasMore = (rows.results || []).length > limit;
  const visibleNoteIds = [...new Set(pageRows
    .filter((row) => clean(row.id))
    .map((row) => clean(row.id)))];
  const attachmentRows = visibleNoteIds.length
    ? await env.DB.prepare(
      `SELECT id, note_id AS noteId, object_key AS objectKey, file_name AS fileName,
         content_type AS contentType, byte_size AS byteSize, created_at AS createdAt
       FROM note_attachments
       WHERE note_id IN (${visibleNoteIds.map(() => "?").join(",")})
       ORDER BY note_id, created_at`
    ).bind(...visibleNoteIds).all()
    : { results: [] };
  const attachmentsByNote = groupNoteAttachments(attachmentRows.results || []);
  const changes = pageRows.map((row) => {
    const id = clean(row.id || row.changeNoteId);
    const currentDeletedAt = clean(row.deletedAt);
    if (!clean(row.id)) {
      return {
        sequence: String(row.sequence),
        type: "delete",
        noteId: id,
        note: {
          id,
          revision: Math.max(1, Number(row.changeRevision || 1)),
          updatedAt: clean(row.changedAt),
          deletedAt: clean(row.changedAt)
        }
      };
    }
    if (currentDeletedAt) {
      return {
        sequence: String(row.sequence),
        type: "delete",
        noteId: id,
        note: normalizeNoteRow(row, attachmentsByNote.get(id) || [])
      };
    }
    return {
      sequence: String(row.sequence),
      type: "upsert",
      note: normalizeNoteRow(row, attachmentsByNote.get(id) || [])
    };
  });
  const nextCursor = changes.length ? changes[changes.length - 1].sequence : String(cursor);
  return json({ changes, nextCursor, hasMore, serverTime: new Date().toISOString() });
}

async function handleMobileMemberSearch(request, env, path) {
  if (request.method !== "GET" || path.length !== 2) return json({ error: "Not found" }, 404);
  await authenticateMobileMemoRequest(request, env, "members:read");
  const url = new URL(request.url);
  const query = clean(url.searchParams.get("query") ?? url.searchParams.get("q") ?? "").slice(0, 100);
  const limit = clampQueryInteger(url.searchParams.get("limit"), 50, 1, 100);
  const like = `%${escapeSqlLike(query)}%`;
  const memberRows = await env.DB.prepare(
    `SELECT member.id, member.name, member.cell_id AS cellId, COALESCE(cell.name, '') AS cellName,
       COALESCE(member.photo_key, '') AS photoKey
     FROM members member
     LEFT JOIN cells cell ON cell.id = member.cell_id
     WHERE COALESCE(member.archived_at, '') = ''
       AND COALESCE(member.trashed_at, '') = ''
       AND (
         ? = ''
         OR member.name LIKE ? ESCAPE '\\'
         OR COALESCE(cell.name, '') LIKE ? ESCAPE '\\'
         OR EXISTS (
           SELECT 1
           FROM managed_group_members membership
           INNER JOIN managed_groups managed_group ON managed_group.id = membership.group_id
           WHERE membership.member_id = member.id
             AND managed_group.name LIKE ? ESCAPE '\\'
         )
       )
     ORDER BY member.name COLLATE NOCASE, member.id
     LIMIT ?`
  ).bind(query, like, like, like, limit).all();
  const memberIds = (memberRows.results || []).map((row) => clean(row.id)).filter(Boolean);
  const membershipRows = memberIds.length
    ? await env.DB.prepare(
      `SELECT membership.member_id AS memberId, managed_group.id AS groupId, managed_group.name AS groupName
       FROM managed_group_members membership
       INNER JOIN managed_groups managed_group ON managed_group.id = membership.group_id
       WHERE membership.member_id IN (${memberIds.map(() => "?").join(",")})
       ORDER BY managed_group.sort_order, managed_group.name`
    ).bind(...memberIds).all()
    : { results: [] };
  const groupsByMember = new Map();
  for (const row of membershipRows.results || []) {
    const memberId = clean(row.memberId);
    if (!groupsByMember.has(memberId)) groupsByMember.set(memberId, []);
    groupsByMember.get(memberId).push({ id: clean(row.groupId), name: clean(row.groupName) });
  }
  const members = (memberRows.results || []).map((row) => ({
    id: clean(row.id),
    name: clean(row.name),
    cellId: clean(row.cellId),
    cellName: clean(row.cellName),
    groups: groupsByMember.get(clean(row.id)) || [],
    photoUrl: memberPhotoUrl(row)
  }));
  return json({ members, query, serverTime: new Date().toISOString() });
}

async function getNote(env, id, options = {}) {
  const includeDeleted = options.includeDeleted === true;
  const [row, attachmentRows] = await Promise.all([
    env.DB.prepare(
      `SELECT note.id, note.category, note.category_id AS categoryId,
        COALESCE(category_def.name, '') AS categoryName, note.title, note.body, note.color, note.pinned,
        note.status, COALESCE(note.member_id, '') AS memberId, COALESCE(note.group_id, '') AS groupId,
        note.remind_at AS remindAt, note.reminder_state AS reminderState,
        note.reminder_id AS reminderId, note.dismissed_at AS dismissedAt, note.revision,
        note.deleted_at AS deletedAt, note.created_at AS createdAt, note.updated_at AS updatedAt
       FROM notes note
       LEFT JOIN note_categories category_def ON category_def.id = note.category_id
       WHERE note.id = ?${includeDeleted ? "" : " AND note.deleted_at = ''"}`
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
  const storedBody = String(row.body ?? "");
  const legacyCategory = NOTE_CATEGORIES.has(clean(row.category)) ? clean(row.category) : "personal";
  const categoryId = row.categoryId === undefined || row.categoryId === null
    ? legacyCategory
    : clean(row.categoryId);
  return {
    id: clean(row.id),
    category: NOTE_CATEGORIES.has(categoryId) ? categoryId : "personal",
    categoryId,
    categoryName: clean(row.categoryName) || NOTE_SYSTEM_CATEGORY_NAMES.get(categoryId) || "",
    title: clean(row.title),
    body: clean(storedBody) ? storedBody : clean(row.title),
    color: NOTE_COLORS.has(clean(row.color)) ? clean(row.color) : "default",
    pinned: truthy(row.pinned),
    status: clean(row.status),
    memberId: clean(row.memberId),
    groupId: clean(row.groupId),
    remindAt: clean(row.remindAt),
    reminderState: clean(row.reminderState) || "none",
    reminderId: clean(row.reminderId),
    dismissedAt: clean(row.dismissedAt),
    revision: Math.max(1, Number(row.revision || 1)),
    deletedAt: clean(row.deletedAt),
    createdAt: clean(row.createdAt),
    updatedAt: clean(row.updatedAt),
    attachments: attachments.map(normalizeNoteAttachmentRow)
  };
}

function normalizeNoteInput(body, previous = null, options = {}) {
  const input = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const legacyCategoryProvided = input.category !== undefined;
  const legacyCategory = normalizeNoteEnum(
    input.category === undefined ? previous?.category || "personal" : input.category,
    NOTE_CATEGORIES,
    "category"
  );
  const categoryId = input.categoryId === undefined
    ? previous ? previous.categoryId : legacyCategoryProvided ? legacyCategory : ""
    : normalizeOptionalNoteCategoryId(input.categoryId);
  const category = NOTE_CATEGORIES.has(categoryId) ? categoryId : "personal";
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
  const requestedStatus = input.status === undefined ? previous?.status || "active" : input.status;
  const status = normalizeNoteEnum(
    clean(requestedStatus) === "archived" ? "done" : requestedStatus,
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
  const requestedId = options.allowClientId ? clean(input.id) : "";
  const normalizedRequestedId = requestedId ? normalizeNoteId(requestedId) : "";
  return {
    id: previous?.id || normalizedRequestedId || crypto.randomUUID(),
    category,
    categoryId,
    categoryName: previous?.categoryId === categoryId
      ? previous?.categoryName || NOTE_SYSTEM_CATEGORY_NAMES.get(categoryId) || ""
      : NOTE_SYSTEM_CATEGORY_NAMES.get(categoryId) || "",
    title,
    body: noteBody,
    color,
    pinned,
    status,
    memberId,
    groupId,
    ...reminder,
    revision: previous ? previous.revision + 1 : 1,
    deletedAt: previous?.deletedAt || "",
    createdAt: previous?.createdAt || now,
    updatedAt: previous ? nextIsoTimestamp(previous.updatedAt) : now,
    attachments: previous?.attachments || []
  };
}

function normalizeNoteId(value) {
  const id = clean(value).toLowerCase();
  if (!NOTE_ID_PATTERN.test(id)) {
    throw new HttpError("id must be a UUID", 400, "NOTE_ID_INVALID");
  }
  return id;
}

function sameNotePatchState(current, body) {
  if (!current || current.deletedAt) return false;
  const desired = normalizeNoteInput(body, current);
  return clean(current.categoryId) === clean(desired.categoryId)
    && String(current.title || "") === String(desired.title || "")
    && String(current.body || "") === String(desired.body || "")
    && clean(current.color) === clean(desired.color)
    && Boolean(current.pinned) === Boolean(desired.pinned)
    && clean(current.status) === clean(desired.status)
    && clean(current.memberId) === clean(desired.memberId)
    && clean(current.groupId) === clean(desired.groupId)
    && clean(current.remindAt) === clean(desired.remindAt)
    && clean(current.reminderState) === clean(desired.reminderState)
    && clean(current.reminderId) === clean(desired.reminderId);
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
    throw new HttpError("remindAt is required for a scheduled or dismissed reminder", 400, "NOTE_INPUT_INVALID");
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
    throw new HttpError(`${field} has an unsupported value`, 400, "NOTE_INPUT_INVALID");
  }
  return normalized;
}

function normalizeNoteText(value, maxLength, field, required = false) {
  const normalized = String(value ?? "").trim();
  if (required && !normalized) throw new HttpError(`${field} is required`, 400, "NOTE_INPUT_INVALID");
  if (normalized.length > maxLength) {
    throw new HttpError(`${field} must be ${maxLength} characters or fewer`, 400, "NOTE_INPUT_INVALID");
  }
  return normalized;
}

function normalizeNoteBoolean(value, fallback, field) {
  if (value === undefined) return Boolean(fallback);
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  throw new HttpError(`${field} must be a boolean`, 400, "NOTE_INPUT_INVALID");
}

function normalizeNoteReferenceId(value, field) {
  const normalized = clean(value);
  if (normalized.length > NOTE_REFERENCE_ID_MAX_LENGTH) {
    throw new HttpError(`${field} is too long`, 400, "NOTE_INPUT_INVALID");
  }
  return normalized;
}

function normalizeUtcDateTime(value, field, optional = false) {
  const text = clean(value);
  if (!text && optional) return "";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) {
    throw new HttpError(`${field} must be an ISO date-time with a timezone`, 400, "NOTE_INPUT_INVALID");
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new HttpError(`${field} is invalid`, 400, "NOTE_INPUT_INVALID");
  return new Date(timestamp).toISOString();
}

async function validateNoteLinks(env, note) {
  const [member, group, category] = await Promise.all([
    note.memberId
      ? env.DB.prepare("SELECT id FROM members WHERE id = ?").bind(note.memberId).first()
      : Promise.resolve({ id: "" }),
    note.groupId
      ? env.DB.prepare("SELECT id FROM managed_groups WHERE id = ?").bind(note.groupId).first()
      : Promise.resolve({ id: "" }),
    note.categoryId
      ? env.DB.prepare("SELECT id, name FROM note_categories WHERE id = ?").bind(note.categoryId).first()
      : Promise.resolve(null)
  ]);
  if (note.memberId && !member) throw new HttpError("Linked member was not found", 400, "NOTE_MEMBER_NOT_FOUND");
  if (note.groupId && !group) throw new HttpError("Linked group was not found", 400, "NOTE_GROUP_NOT_FOUND");
  if (note.categoryId && !category) {
    throw new HttpError("Note category was not found", 400, "NOTE_CATEGORY_NOT_FOUND");
  }
  note.categoryName = clean(category?.name);
}

function noteAuditShape(note) {
  return {
    bodyLength: String(note?.body || "").length,
    categoryAssigned: Boolean(clean(note?.categoryId)),
    colorAssigned: Boolean(clean(note?.color)),
    pinned: Boolean(note?.pinned),
    status: clean(note?.status),
    memberLinked: Boolean(clean(note?.memberId)),
    groupLinked: Boolean(clean(note?.groupId)),
    reminderScheduled: Boolean(clean(note?.remindAt)),
    reminderState: clean(note?.reminderState),
    revision: Math.max(1, Number(note?.revision || 1)),
    deleted: Boolean(clean(note?.deletedAt)),
    updatedAt: note.updatedAt,
    attachmentCount: Array.isArray(note.attachments) ? note.attachments.length : 0
  };
}

function noteCategoryAuditShape(category) {
  return {
    nameLength: String(category?.name || "").length,
    isSystem: Boolean(category?.isSystem),
    createdAt: clean(category?.createdAt),
    updatedAt: clean(category?.updatedAt)
  };
}

async function uploadNoteAttachment(request, env, noteId, principal) {
  const clientAttachmentId = noteAttachmentClientId(request, principal);
  const note = await getNote(env, noteId);
  if (!note) {
    throw noteAttachmentHttpError("Note not found", 404, "NOTE_NOT_FOUND", "preflight", principal);
  }
  if (clientAttachmentId) {
    const replay = await attachmentIdempotencyState(env, noteId, clientAttachmentId, principal, "preflight");
    if (replay.exists) {
      logNoteAttachmentEvent("note_attachment.upload_replayed", "replay", "NOTE_ATTACHMENT_REPLAYED", principal);
      return json(note);
    }
  }
  if (!env.PHOTOS) {
    throw noteAttachmentHttpError(
      "Photo storage is unavailable", 503, "NOTE_ATTACHMENT_STORAGE_UNAVAILABLE", "preflight", principal
    );
  }
  const precondition = noteHeaderPreconditionResponse(request, principal, note);
  if (precondition) return precondition;
  if (note.attachments.length >= NOTE_ATTACHMENT_LIMIT) {
    throw noteAttachmentHttpError(
      `A note can have up to ${NOTE_ATTACHMENT_LIMIT} photos`,
      400,
      "NOTE_ATTACHMENT_LIMIT_REACHED",
      "validate",
      principal,
      { attachmentCount: note.attachments.length }
    );
  }

  const formData = await readNativeNoteFormData(request, principal);
  const photoParts = formData.getAll("photo");
  if (photoParts.length !== 1 || !(photoParts[0] instanceof File)) {
    throw noteAttachmentHttpError(
      photoParts.length > 1 ? "Exactly one photo file is required" : "photo file is required",
      400,
      photoParts.length > 1 ? "NOTE_ATTACHMENT_FILE_COUNT_INVALID" : "NOTE_ATTACHMENT_FILE_REQUIRED",
      "validate",
      principal,
      { attachmentCount: photoParts.length }
    );
  }
  const photo = photoParts[0];
  const contentType = normalizeNoteAttachmentContentType(photo.type, photo.name);
  if (!contentType) {
    throw noteAttachmentHttpError(
      "JPEG, PNG, WebP, GIF, HEIC, or HEIF image is required",
      415,
      "NOTE_ATTACHMENT_TYPE_UNSUPPORTED",
      "validate",
      principal,
      { contentType }
    );
  }
  if (!Number.isSafeInteger(photo.size) || photo.size <= 0) {
    throw noteAttachmentHttpError(
      "Photo file must not be empty", 400, "NOTE_ATTACHMENT_EMPTY", "validate", principal, { byteSize: photo.size }
    );
  }
  if (photo.size > NOTE_ATTACHMENT_MAX_BYTES) {
    throw noteAttachmentHttpError(
      `Each photo must be ${NOTE_ATTACHMENT_MAX_BYTES / 1024 / 1024} MB or smaller`,
      413,
      "NOTE_ATTACHMENT_TOO_LARGE",
      "validate",
      principal,
      { byteSize: photo.size, contentType }
    );
  }
  if (!(await noteAttachmentSignatureMatches(photo, contentType))) {
    throw noteAttachmentHttpError(
      "Photo contents do not match the declared image type",
      415,
      "NOTE_ATTACHMENT_SIGNATURE_INVALID",
      "validate",
      principal,
      { byteSize: photo.size, contentType }
    );
  }

  const attachmentId = crypto.randomUUID();
  const storageId = clientAttachmentId || attachmentId;
  const safeName = normalizeAttachmentFileName(photo.name);
  const objectKey = `notes/${noteId}/${storageId}`;
  const createdAt = new Date().toISOString();
  const updatedAt = nextIsoTimestamp(note.updatedAt);
  const revision = note.revision + 1;
  const auditUpdated = {
    ...note,
    revision,
    updatedAt,
    attachments: [...note.attachments, { id: attachmentId }]
  };
  try {
    await env.PHOTOS.put(objectKey, photo.stream(), {
      httpMetadata: { contentType }
    });
  } catch {
    throw noteAttachmentHttpError(
      "Photo storage write failed", 503, "NOTE_ATTACHMENT_R2_WRITE_FAILED", "r2_put", principal,
      { byteSize: photo.size, contentType }
    );
  }

  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO note_attachments
          (id, note_id, object_key, file_name, content_type, byte_size, client_attachment_id, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM notes WHERE id = ? AND revision = ? AND deleted_at = '')`
      ).bind(
        attachmentId, noteId, objectKey, safeName, contentType, photo.size, clientAttachmentId, createdAt,
        noteId, note.revision
      ),
       env.DB.prepare(
         `UPDATE notes SET revision = ?, updated_at = ?
          WHERE id = ? AND revision = ? AND deleted_at = ''`
       ).bind(revision, updatedAt, noteId, note.revision),
       mutationAuditStatement(
         env, request, "note.attachment.create", "note", noteId,
         noteAuditShape(note), noteAuditShape(auditUpdated), memoAuditActor(principal)
       )
     ]);
  } catch {
    const replay = clientAttachmentId
      ? await safeAttachmentIdempotencyState(env, noteId, clientAttachmentId)
      : { known: true, exists: false, note: null };
    if (replay.exists && replay.note) {
      logNoteAttachmentEvent("note_attachment.upload_replayed", "d1_write", "NOTE_ATTACHMENT_REPLAYED", principal);
      return json(replay.note);
    }
    if (replay.known && !replay.exists) await compensateNoteAttachmentObject(env, objectKey, principal);
    throw noteAttachmentHttpError(
      "Photo metadata write failed", 503, "NOTE_ATTACHMENT_DB_WRITE_FAILED", "d1_write", principal
    );
  }

  if (Number(results?.[0]?.meta?.changes || 0) !== 1
    || Number(results?.[1]?.meta?.changes || 0) < 1
    || Number(results?.[2]?.meta?.changes || 0) !== 1) {
    const replay = clientAttachmentId
      ? await safeAttachmentIdempotencyState(env, noteId, clientAttachmentId)
      : { known: true, exists: false, note: null };
    if (replay.exists && replay.note) {
      logNoteAttachmentEvent("note_attachment.upload_replayed", "d1_conflict", "NOTE_ATTACHMENT_REPLAYED", principal);
      return json(replay.note);
    }
    if (replay.known && !replay.exists) await compensateNoteAttachmentObject(env, objectKey, principal);
    const current = replay.note || await getNote(env, noteId);
    return current
      ? json({ error: "Note changed; reload and try again", code: "NOTE_VERSION_CONFLICT", note: current }, 409)
      : json({ error: "Note not found", code: "NOTE_NOT_FOUND" }, 404);
  }

  const updated = await getNote(env, noteId);
  logNoteAttachmentEvent(
    "note_attachment.upload_completed", "complete", "NOTE_ATTACHMENT_CREATED", principal,
    { byteSize: photo.size, contentType, attachmentCount: updated?.attachments?.length || 0 }
  );
  return json(updated, 201);
}

function sameMobileCreateState(existing, desired) {
  return !clean(existing?.deletedAt)
    && clean(existing?.categoryId) === clean(desired?.categoryId)
    && String(existing?.title || "") === String(desired?.title || "")
    && String(existing?.body || "") === String(desired?.body || "")
    && clean(existing?.color) === clean(desired?.color)
    && Boolean(existing?.pinned) === Boolean(desired?.pinned)
    && clean(existing?.status) === clean(desired?.status)
    && clean(existing?.memberId) === clean(desired?.memberId)
    && clean(existing?.groupId) === clean(desired?.groupId)
    && clean(existing?.remindAt) === clean(desired?.remindAt)
    && clean(existing?.reminderState) === clean(desired?.reminderState);
}

async function deleteNoteAttachment(request, env, noteId, attachmentId, principal) {
  if (!attachmentId) {
    return json({ error: "Attachment id is required", code: "NOTE_ATTACHMENT_ID_INVALID" }, 400);
  }
  const note = await getNote(env, noteId);
  if (!note) return json({ error: "Note not found" }, 404);
  const attachment = note.attachments.find((item) => item.id === attachmentId);
  if (!attachment) return json(note);
  const precondition = noteHeaderPreconditionResponse(request, principal, note);
  if (precondition) return precondition;
  const updatedAt = nextIsoTimestamp(note.updatedAt);
  const revision = note.revision + 1;
  const auditUpdated = {
    ...note,
    revision,
    updatedAt,
    attachments: note.attachments.filter((item) => item.id !== attachmentId)
  };
  await deleteR2Objects(env, [attachment.objectKey]);
  const results = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM note_attachments
       WHERE id = ? AND note_id = ?
         AND EXISTS (SELECT 1 FROM notes WHERE id = ? AND revision = ? AND deleted_at = '')`
    ).bind(attachmentId, noteId, noteId, note.revision),
    env.DB.prepare(
      `UPDATE notes SET revision = ?, updated_at = ?
       WHERE id = ? AND revision = ? AND deleted_at = ''`
    ).bind(revision, updatedAt, noteId, note.revision),
    mutationAuditStatement(
      env, request, "note.attachment.delete", "note", noteId,
      noteAuditShape(note), noteAuditShape(auditUpdated), memoAuditActor(principal)
    )
  ]);
  if (Number(results?.[0]?.meta?.changes || 0) !== 1
    || Number(results?.[1]?.meta?.changes || 0) < 1
    || Number(results?.[2]?.meta?.changes || 0) !== 1) {
    const current = await getNote(env, noteId);
    return current
      ? json({ error: "Note changed; reload and try again", code: "NOTE_VERSION_CONFLICT", note: current }, 409)
      : json({ error: "Note not found", code: "NOTE_NOT_FOUND" }, 404);
  }
  const updated = await getNote(env, noteId);
  return json(updated);
}

function normalizeAttachmentFileName(value) {
  return clean(value).replace(/[^\p{L}\p{N}_.-]+/gu, "_").slice(-100) || "photo";
}

function normalizeNoteAttachmentContentType(value, fileName) {
  const declared = clean(value).toLowerCase();
  if (NOTE_ATTACHMENT_TYPES.has(declared)) return declared;
  if (NOTE_ATTACHMENT_TYPE_ALIASES.has(declared)) return NOTE_ATTACHMENT_TYPE_ALIASES.get(declared);
  if (!NOTE_ATTACHMENT_UNSPECIFIED_TYPES.has(declared)) return "";
  const extension = clean(fileName).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
  return NOTE_ATTACHMENT_EXTENSION_TYPES.get(extension) || "";
}

async function noteAttachmentSignatureMatches(photo, contentType) {
  let bytes;
  try {
    bytes = new Uint8Array(await photo.slice(0, NOTE_ATTACHMENT_SIGNATURE_BYTES).arrayBuffer());
  } catch {
    return false;
  }
  if (contentType === "image/jpeg") return hasBytePrefix(bytes, [0xff, 0xd8, 0xff]);
  if (contentType === "image/png") {
    return hasBytePrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  if (contentType === "image/gif") {
    const version = asciiBytes(bytes, 0, 6);
    return version === "GIF87a" || version === "GIF89a";
  }
  if (contentType === "image/webp") {
    return asciiBytes(bytes, 0, 4) === "RIFF" && asciiBytes(bytes, 8, 12) === "WEBP";
  }
  if (contentType === "image/heic" || contentType === "image/heif") {
    if (asciiBytes(bytes, 4, 8) !== "ftyp") return false;
    const brands = [asciiBytes(bytes, 8, 12)];
    for (let offset = 16; offset + 4 <= bytes.length; offset += 4) {
      brands.push(asciiBytes(bytes, offset, offset + 4));
    }
    const heicBrands = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis"]);
    if (contentType === "image/heic") return brands.some((brand) => heicBrands.has(brand));
    const heifBrands = new Set(["mif1", "msf1", "heif", ...heicBrands]);
    return brands.some((brand) => heifBrands.has(brand));
  }
  return false;
}

function hasBytePrefix(bytes, prefix) {
  return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}

function asciiBytes(bytes, start, end) {
  if (bytes.length < end) return "";
  return String.fromCharCode(...bytes.subarray(start, end));
}

function noteAttachmentClientId(request, principal) {
  const value = clean(request.headers.get("X-Client-Attachment-Id"));
  if (!value) return "";
  if (!NOTE_ID_PATTERN.test(value)) {
    throw noteAttachmentHttpError(
      "X-Client-Attachment-Id must be a UUID",
      400,
      "NOTE_ATTACHMENT_ID_INVALID",
      "preflight",
      principal
    );
  }
  return value.toLowerCase();
}

async function attachmentIdempotencyState(env, noteId, clientAttachmentId, principal, stage) {
  try {
    return await readAttachmentIdempotencyState(env, noteId, clientAttachmentId);
  } catch {
    throw noteAttachmentHttpError(
      "Photo metadata lookup failed", 503, "NOTE_ATTACHMENT_DB_READ_FAILED", stage, principal
    );
  }
}

async function safeAttachmentIdempotencyState(env, noteId, clientAttachmentId) {
  try {
    return { known: true, ...(await readAttachmentIdempotencyState(env, noteId, clientAttachmentId)) };
  } catch {
    return { known: false, exists: false, note: null };
  }
}

async function readAttachmentIdempotencyState(env, noteId, clientAttachmentId) {
  if (!clientAttachmentId) return { exists: false, note: null };
  const attachment = await env.DB.prepare(
    `SELECT id FROM note_attachments
     WHERE note_id = ? AND client_attachment_id = ?
     LIMIT 1`
  ).bind(noteId, clientAttachmentId).first();
  return attachment
    ? { exists: true, note: await getNote(env, noteId) }
    : { exists: false, note: null };
}

async function compensateNoteAttachmentObject(env, objectKey, principal) {
  try {
    await env.PHOTOS.delete(objectKey);
    logNoteAttachmentEvent(
      "note_attachment.compensation_completed", "r2_compensate", "NOTE_ATTACHMENT_R2_COMPENSATED", principal
    );
    return true;
  } catch {
    logNoteAttachmentEvent(
      "note_attachment.compensation_failed", "r2_compensate", "NOTE_ATTACHMENT_R2_COMPENSATION_FAILED", principal
    );
    return false;
  }
}

function noteAttachmentHttpError(message, status, code, stage, principal, details = {}) {
  logNoteAttachmentEvent("note_attachment.upload_failed", stage, code, principal, details);
  return new HttpError(message, status, code);
}

function logNoteAttachmentEvent(event, stage, code, principal, details = {}) {
  const entry = {
    event,
    stage,
    code,
    principalKind: principal?.kind === "mobile" ? "mobile" : "admin"
  };
  for (const key of ["byteSize", "attachmentCount", "contentLength"]) {
    const value = Number(details[key]);
    if (Number.isFinite(value) && value >= 0) entry[key] = value;
  }
  const contentType = clean(details.contentType).toLowerCase();
  if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(contentType)) entry.contentType = contentType;
  if (event.endsWith("_completed") || event.endsWith("_replayed")) console.log(JSON.stringify(entry));
  else console.error(JSON.stringify(entry));
}

async function requireMemoAccess(request, env, viewerRole, scopes) {
  if (viewerRole === ADMIN_ROLE) return { kind: "admin", scopes: [...scopes] };
  const requiredScopes = Array.isArray(scopes) ? scopes : [scopes];
  const principal = await authenticateMobileMemoRequest(request, env, requiredScopes[0] || "");
  for (const scope of requiredScopes.slice(1)) {
    if (!principal.scopes.includes(scope)) {
      throw new HttpError("Mobile memo permission is required", 403, "MOBILE_MEMO_SCOPE_REQUIRED");
    }
  }
  return principal;
}

function memoAuditActor(principal) {
  return principal?.kind === "mobile" ? "mobile" : "admin";
}

function parseExpectedRevision(value) {
  if (value === undefined || value === null || value === "") return null;
  const text = typeof value === "number" ? String(value) : clean(value);
  if (!/^[1-9]\d*$/.test(text)) return null;
  const revision = Number(text);
  return Number.isSafeInteger(revision) ? revision : null;
}

function expectedRevisionFromHeaders(request) {
  const ifMatch = parseExpectedRevisionHeader(request.headers.get("If-Match"));
  const expectedRevision = parseExpectedRevisionHeader(request.headers.get("X-Expected-Revision"));
  if (ifMatch.invalid || expectedRevision.invalid
    || (ifMatch.value !== null && expectedRevision.value !== null && ifMatch.value !== expectedRevision.value)) {
    return { value: null, invalid: true };
  }
  return { value: ifMatch.value ?? expectedRevision.value, invalid: false };
}

function parseExpectedRevisionHeader(header) {
  const raw = clean(header);
  if (!raw) return { value: null, invalid: false };
  const match = /^(?:W\/)?"?([1-9]\d*)"?$/.exec(raw);
  if (!match) return { value: null, invalid: true };
  const value = Number(match[1]);
  return Number.isSafeInteger(value)
    ? { value, invalid: false }
    : { value: null, invalid: true };
}

function noteHeaderPreconditionResponse(request, principal, note) {
  const expected = expectedRevisionFromHeaders(request);
  if (expected.invalid) {
    return json({ error: "If-Match must contain a positive note revision", code: "NOTE_PRECONDITION_INVALID" }, 400);
  }
  if (principal?.kind === "mobile" && expected.value === null) {
    return json({ error: "If-Match is required", code: "NOTE_PRECONDITION_REQUIRED" }, 428);
  }
  if (expected.value !== null && expected.value !== note.revision) {
    return json({ error: "Note changed; reload and try again", code: "NOTE_VERSION_CONFLICT", note }, 409);
  }
  return null;
}

function noteTombstone(note) {
  return {
    ok: true,
    id: clean(note?.id),
    revision: Math.max(1, Number(note?.revision || 1)),
    updatedAt: clean(note?.updatedAt),
    deletedAt: clean(note?.deletedAt)
  };
}

function clampQueryInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function escapeSqlLike(value) {
  return String(value || "").replace(/[\\%_]/g, (character) => `\\${character}`);
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
  const sizeBytes = Number(row.byteSize || 0);
  return {
    id: clean(row.id),
    noteId: clean(row.noteId),
    objectKey,
    fileName: clean(row.fileName),
    contentType: clean(row.contentType),
    byteSize: sizeBytes,
    sizeBytes,
    createdAt: clean(row.createdAt),
    url: `/api/photos/${encodeURIComponent(objectKey)}`
  };
}

async function deleteR2Objects(env, objectKeys) {
  const keys = [...new Set((objectKeys || []).map(clean).filter(Boolean))];
  if (!env.PHOTOS || !keys.length) return true;
  try {
    await env.PHOTOS.delete(keys);
    return true;
  } catch {
    console.error(JSON.stringify({
      event: "note_attachment_r2_delete_failed",
      keyCount: keys.length,
      code: "NOTE_ATTACHMENT_R2_DELETE_FAILED"
    }));
    return false;
  }
}

function isMemoTrashPrincipal(principal) {
  return principal?.kind === "admin" || principal?.kind === "mobile";
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

async function changePassword(request, env) {
  await requireWriteAuth(request, env);
  const body = await safeJson(request);
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

  await saveAdminPassword(env, newPassword, "auth.password.update", {}, verifiedCredential);
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

async function readBoundedNoteJson(request) {
  const bytes = await readBoundedRequestBytes(request, NOTE_REQUEST_MAX_BYTES, "Note request is too large");
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid object");
    return value;
  } catch {
    throw new HttpError("Invalid JSON request body", 400, "NOTE_JSON_INVALID");
  }
}

async function readNativeNoteFormData(request, principal) {
  const contentType = clean(request.headers.get("Content-Type"));
  if (!/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) {
    throw noteAttachmentHttpError(
      "multipart/form-data is required",
      415,
      "NOTE_ATTACHMENT_MULTIPART_REQUIRED",
      "parse",
      principal
    );
  }
  if (!/(?:^|;)\s*boundary=(?:"[^"]+"|[^;\s]+)/i.test(contentType)) {
    throw noteAttachmentHttpError(
      "Multipart boundary is required",
      400,
      "NOTE_ATTACHMENT_MULTIPART_INVALID",
      "parse",
      principal
    );
  }

  const contentLengthHeader = clean(request.headers.get("Content-Length"));
  if (contentLengthHeader && !/^\d+$/.test(contentLengthHeader)) {
    throw noteAttachmentHttpError(
      "Content-Length is invalid",
      400,
      "NOTE_ATTACHMENT_REQUEST_SIZE_INVALID",
      "parse",
      principal
    );
  }
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : 0;
  if (contentLength > NOTE_ATTACHMENT_REQUEST_MAX_BYTES) {
    throw noteAttachmentHttpError(
      "Photo request is too large",
      413,
      "NOTE_ATTACHMENT_REQUEST_TOO_LARGE",
      "parse",
      principal,
      { contentLength }
    );
  }

  try {
    return await request.formData();
  } catch {
    throw noteAttachmentHttpError(
      "Invalid photo upload",
      400,
      "NOTE_ATTACHMENT_MULTIPART_INVALID",
      "parse",
      principal,
      { contentLength }
    );
  }
}

async function readBoundedCallNoteJson(request) {
  const bytes = await readBoundedRequestBytes(
    request,
    MAX_WEBHOOK_BYTES,
    "Payload too large",
    "CALL_NOTE_BODY_TOO_LARGE"
  );
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid object");
    return value;
  } catch {
    throw new HttpError("Invalid JSON request body", 400, "CALL_NOTE_JSON_INVALID");
  }
}

async function readBoundedRequestBytes(request, maxBytes, errorMessage, errorCode = "") {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new HttpError(errorMessage, 413, errorCode);
  }
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
        throw new HttpError(errorMessage, 413, errorCode);
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
async function getDashboard(env, viewer) {
  requireViewer(viewer);
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

  const members = filterMembersForViewer(membersResult.results || [], viewer).map((member) => ({
    ...maskMemberForViewer(member, viewer),
    longAbsent: truthy(member.longAbsent),
    photoUrl: member.photoKey ? `/api/photos/${encodeURIComponent(member.photoKey)}` : ""
  }));
  const memberById = new Map(members.map((member) => [member.id, member]));
  const memberIds = new Set(memberById.keys());
  const lastVisitByMember = new Map();
  for (const row of visitsResult.results || []) {
    if (memberIds.has(row.memberId) && !lastVisitByMember.has(row.memberId) && !visitIsTrashed(row.action)) {
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
    .filter((task) => memberIds.has(task.memberId))
    .map(normalizeCareTaskRow)
    .map((task) => maskTaskForViewer(task, viewer))
    .map((task) => ({
      ...task,
      member: dashboardMember(memberById.get(task.memberId)),
      overdue: task.dueDate < today
    }))
    .filter((task) => task.member.id);

  const urgentPrayers = (prayersResult.results || [])
    .filter((topic) => memberIds.has(topic.memberId))
    .map(normalizePrayerTopicRow)
    .map((topic) => maskPrayerForViewer(topic, viewer))
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

async function getMemberTimeline(env, memberId, viewer) {
  await assertViewerMemberAccess(env, viewer, memberId);
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

  for (const rawVisit of visits.results || []) {
    const visit = maskVisitForViewer(rawVisit, viewer);
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
    const task = maskTaskForViewer(normalizeCareTaskRow(row), viewer);
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
    const topic = maskPrayerForViewer(normalizePrayerTopicRow(row), viewer);
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

async function handleMembers(request, env, path, viewerRole = ADMIN_ROLE, viewer = ownerViewer()) {
  const id = path[1];

  if (request.method === "GET" && id && path[2] === "timeline") {
    return getMemberTimeline(env, clean(id), viewer);
  }

  if (request.method === "POST" && path.length === 1) {
    requireViewerEdit(viewer);
    const body = await request.json();
    const member = normalizeMember(scopedMemberBody({ ...body, id: "" }, null, viewer), crypto.randomUUID());
    if (!viewerCanAccessCell(viewer, member.cellId)) throw new HttpError("Cell access is required", 403);
    const managedGroupId = clean(body.managedGroupId);
    if (managedGroupId && !viewerHasGlobalScope(viewer)) throw new HttpError("Group access is required", 403);
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
    await syncProfilePrayerTopic(env, member.id, member.prayerRequests, member.updatedAt);
    await audit(env, request, "member.create", "member", member.id, "", member);
    const publicMember = cellsWithPhotoUrls([maskMemberForViewer(member, viewer)])[0];
    return managedGroupId
      ? json({ member: publicMember, managedGroupId, groupUpdatedAt }, 201)
      : json(publicMember, 201);
  }
  if (!id) return json({ error: "Member id required" }, 400);

  if (request.method === "PATCH" && path.length === 2) {
    requireViewerEdit(viewer);
    const body = await request.json();
    const previous = await getMember(env, id);
    if (!previous) return json({ error: "Member not found" }, 404);
    await assertViewerMemberAccess(env, viewer, id);
    const member = normalizeMember(scopedMemberBody({ ...previous, ...body, id }, previous, viewer), id);
    if (!viewerCanAccessCell(viewer, member.cellId)) throw new HttpError("Cell access is required", 403);
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
    return json(cellsWithPhotoUrls([maskMemberForViewer(member, viewer)])[0]);
  }

  if (request.method === "POST" && path[2] === "archive") {
    requireViewerEdit(viewer);
    await assertViewerMemberAccess(env, viewer, id);
    const archivedAt = new Date().toISOString();
    await env.DB.prepare("UPDATE members SET archived_at = ?, updated_at = ? WHERE id = ?")
      .bind(archivedAt, archivedAt, id)
      .run();
    await audit(env, request, "member.archive", "member", id, "", { archivedAt });
    return json({ id, archivedAt });
  }

  if (request.method === "POST" && path[2] === "restore") {
    requireViewerEdit(viewer);
    await assertViewerMemberAccess(env, viewer, id);
    const updatedAt = new Date().toISOString();
    await env.DB.prepare("UPDATE members SET archived_at = '', updated_at = ? WHERE id = ?")
      .bind(updatedAt, id)
      .run();
    await audit(env, request, "member.restore", "member", id, "", { archivedAt: "" });
    return json({ id, archivedAt: "" });
  }

  if (request.method === "POST" && path[2] === "trash") {
    requireViewerEdit(viewer);
    await assertViewerMemberAccess(env, viewer, id);
    const trashedAt = new Date().toISOString();
    await env.DB.prepare("UPDATE members SET trashed_at = ?, updated_at = ? WHERE id = ?")
      .bind(trashedAt, trashedAt, id)
      .run();
    await audit(env, request, "member.trash", "member", id, "", { trashedAt });
    return json({ id, trashedAt });
  }

  if (request.method === "POST" && path[2] === "photo") {
    requireViewerEdit(viewer);
    await assertViewerMemberAccess(env, viewer, id);
    return uploadMemberPhoto(request, env, id);
  }

  if (request.method === "DELETE" && path.length === 2) {
    requireViewerEdit(viewer);
    if (!viewerCanDeleteMembers(viewer)) throw new HttpError("Member delete access is required", 403);
    await assertViewerMemberAccess(env, viewer, id);
    const previous = await getMember(env, id);
    const updatedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE notes
         SET member_id = NULL, revision = revision + 1, updated_at = ?
         WHERE member_id = ? AND deleted_at = ''`
      ).bind(updatedAt, id),
      env.DB.prepare("DELETE FROM members WHERE id = ?").bind(id)
    ]);
    await audit(env, request, "member.delete", "member", id, previous || "", "");
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
}

function scopedMemberBody(value, previous, viewer) {
  if (viewer?.canViewSensitive || viewer?.role === "owner") return value;
  return {
    ...value,
    phone: previous?.phone || "",
    homePhone: previous?.homePhone || "",
    birth: previous?.birth || "",
    address: previous?.address || "",
    memo: previous?.memo || "",
    prayerRequests: previous?.prayerRequests || ""
  };
}

async function handleCareTasks(request, env, path, viewer = ownerViewer()) {
  const id = clean(path[1]);

  if (request.method === "GET" && path.length === 1) {
    requireViewer(viewer);
    const memberId = clean(new URL(request.url).searchParams.get("memberId"));
    if (memberId) await assertViewerMemberAccess(env, viewer, memberId);
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
    const scoped = await filterRowsByViewerMemberScope(env, rows.results || [], viewer);
    return json({ tasks: scoped.map(normalizeCareTaskRow).map((task) => maskTaskForViewer(task, viewer)) });
  }

  if (request.method === "POST" && path.length === 1) {
    requireViewerEdit(viewer);
    const body = await safeJson(request);
    const task = normalizeCareTask(body);
    if (!task.memberId || !task.title) return json({ error: "성도와 후속 돌봄 내용을 입력하세요" }, 400);
    await assertViewerMemberAccess(env, viewer, task.memberId);
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
    return json(maskTaskForViewer(task, viewer), 201);
  }

  if (request.method === "PATCH" && id) {
    requireViewerEdit(viewer);
    const previous = await getCareTask(env, id);
    if (!previous) return json({ error: "후속 돌봄 일정을 찾을 수 없습니다" }, 404);
    await assertViewerMemberAccess(env, viewer, previous.memberId);
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
    return json(maskTaskForViewer(task, viewer));
  }

  if (request.method === "DELETE" && id) {
    requireViewerEdit(viewer);
    const previous = await getCareTask(env, id);
    if (!previous) return json({ error: "후속 돌봄 일정을 찾을 수 없습니다" }, 404);
    await assertViewerMemberAccess(env, viewer, previous.memberId);
    await env.DB.prepare("DELETE FROM care_tasks WHERE id = ?").bind(id).run();
    await audit(env, request, "care_task.delete", "care_task", id, previous, "");
    return json({ ok: true });
  }

  return json({ error: "Method not allowed" }, 405);
}

async function handlePrayerTopics(request, env, path, viewer = ownerViewer()) {
  const id = clean(path[1]);

  if (request.method === "GET" && path.length === 1) {
    requireViewer(viewer);
    const memberId = clean(new URL(request.url).searchParams.get("memberId"));
    if (memberId) await assertViewerMemberAccess(env, viewer, memberId);
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
    const scoped = await filterRowsByViewerMemberScope(env, rows.results || [], viewer);
    return json({ prayerTopics: scoped.map(normalizePrayerTopicRow).map((topic) => maskPrayerForViewer(topic, viewer)) });
  }

  if (request.method === "POST" && path.length === 1) {
    requireViewerEdit(viewer);
    requireSensitiveEdit(viewer);
    const body = await safeJson(request);
    const topic = normalizePrayerTopic(body);
    if (!topic.memberId || !topic.content) return json({ error: "성도와 기도제목을 입력하세요" }, 400);
    await assertViewerMemberAccess(env, viewer, topic.memberId);
    if (!(await getMember(env, topic.memberId))) return json({ error: "성도를 찾을 수 없습니다" }, 404);
    await insertPrayerTopic(env, topic).run();
    await audit(env, request, "prayer_topic.create", "prayer_topic", topic.id, "", topic);
    return json(maskPrayerForViewer(topic, viewer), 201);
  }

  if (request.method === "PATCH" && id) {
    requireViewerEdit(viewer);
    requireSensitiveEdit(viewer);
    const previous = await getPrayerTopic(env, id);
    if (!previous) return json({ error: "기도제목을 찾을 수 없습니다" }, 404);
    await assertViewerMemberAccess(env, viewer, previous.memberId);
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
    return json({ ...maskPrayerForViewer(topic, viewer), memberPrayerRequests });
  }

  if (request.method === "DELETE" && id) {
    requireViewerEdit(viewer);
    requireSensitiveEdit(viewer);
    const previous = await getPrayerTopic(env, id);
    if (!previous) return json({ error: "기도제목을 찾을 수 없습니다" }, 404);
    await assertViewerMemberAccess(env, viewer, previous.memberId);
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

async function handleVisitNotes(request, env, path, viewerRole = ADMIN_ROLE, viewer = ownerViewer()) {
  if (request.method === "POST" && path.length === 1) {
    requireViewerEdit(viewer);
    requireSensitiveEdit(viewer);
    const body = await request.json();
    const visit = normalizeVisit(body);
    if (!visit.memberId || !visit.summary) return json({ error: "Visit member and summary are required" }, 400);
    if (!viewerHasGlobalScope(viewer)) await assertViewerMemberAccess(env, viewer, visit.memberId);
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
    return json(maskVisitForViewer(visit, viewer), 201);
  }

  if (request.method === "PATCH" && path.length === 2) {
    requireViewerEdit(viewer);
    requireSensitiveEdit(viewer);
    const id = clean(path[1]);
    const previous = await getVisitNote(env, id);
    if (!previous) return json({ error: "Visit note not found" }, 404);
    if (!viewerHasGlobalScope(viewer)) await assertViewerMemberAccess(env, viewer, previous.memberId);
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
    return json(maskVisitForViewer(visit, viewer));
  }

  if (request.method === "DELETE" && path.length === 2) {
    requireViewerEdit(viewer);
    requireSensitiveEdit(viewer);
    const id = clean(path[1]);
    const previous = await getVisitNote(env, id);
    if (!previous) return json({ error: "Visit note not found" }, 404);
    if (!viewerHasGlobalScope(viewer)) await assertViewerMemberAccess(env, viewer, previous.memberId);
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

async function handleSundayAttendance(request, env, viewerRole, viewer = ownerViewer()) {
  requireViewer(viewer);
  if (request.method === "GET") {
    const url = new URL(request.url);
    const attendanceDate = clean(url.searchParams.get("date"));
    return attendanceDate
      ? getSundayAttendanceByDate(env, attendanceDate, viewer)
      : listSundayAttendance(env, viewer);
  }

  if (request.method === "POST") {
    requireViewerEdit(viewer);
    const body = await safeJson(request);
    return saveSundayAttendance(request, env, body, viewer);
  }

  return json({ error: "Method not allowed" }, 405);
}

async function listSundayAttendance(env, viewer) {
  const scope = attendanceScopeSql(viewer, "r.cell_id");
  const rows = await env.DB.prepare(
    `SELECT s.id, s.attendance_date AS attendanceDate, s.label, s.created_at AS createdAt, s.updated_at AS updatedAt,
      COUNT(r.member_id) AS totalCount,
      COALESCE(SUM(CASE WHEN r.present = 1 THEN 1 ELSE 0 END), 0) AS presentCount
     FROM sunday_attendance_sessions s
     LEFT JOIN sunday_attendance_records r ON r.session_id = s.id ${scope.clause ? `AND ${scope.clause}` : ""}
     GROUP BY s.id, s.attendance_date, s.label, s.created_at, s.updated_at
     ORDER BY s.attendance_date DESC
     LIMIT 80`
  ).bind(...scope.bindings).all();
  return json({ sessions: (rows.results || []).map(normalizeAttendanceSessionRow) });
}

async function getSundayAttendanceByDate(env, attendanceDateValue, viewer) {
  const attendanceDate = normalizeDateValue(attendanceDateValue, "Attendance date is required");
  const session = await env.DB.prepare(
    `SELECT id, attendance_date AS attendanceDate, label, created_at AS createdAt, updated_at AS updatedAt
     FROM sunday_attendance_sessions
     WHERE attendance_date = ?`
  ).bind(attendanceDate).first();

  if (!session) return json({ session: null, records: [] });

  const records = await getSundayAttendanceRecords(env, session.id, viewer);
  return json({
    session: attendanceSessionWithCounts(session, records),
    records: records.map(attendanceRecordWithPhotoUrl)
  });
}

async function saveSundayAttendance(request, env, body, viewer) {
  const attendanceDate = normalizeDateValue(body.attendanceDate, "Attendance date is required");
  let label = clean(body.label);
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
  if (existing && !viewerHasGlobalScope(viewer)) label = existing.label || "";

  const members = (await getActiveMembersForAttendance(env))
    .filter((member) => viewerCanAccessCell(viewer, member.cellId));
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
    viewerHasGlobalScope(viewer)
      ? env.DB.prepare("DELETE FROM sunday_attendance_records WHERE session_id = ?").bind(sessionId)
      : env.DB.prepare(
        `DELETE FROM sunday_attendance_records
         WHERE session_id = ? AND cell_id IN (${viewer.cellIds.map(() => "?").join(",") || "''"})`
      ).bind(sessionId, ...viewer.cellIds),
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
       AND COALESCE(c.is_system, 0) = 0
     ORDER BY c.sort_order, m.long_absent, m.role DESC, m.name`
  ).all();
  return rows.results || [];
}

async function getSundayAttendanceRecords(env, sessionId, viewer = ownerViewer()) {
  const scope = attendanceScopeSql(viewer, "cell_id");
  const rows = await env.DB.prepare(
    `SELECT session_id AS sessionId, member_id AS memberId, member_name AS memberName,
      member_title AS memberTitle, member_role AS memberRole, member_long_absent AS memberLongAbsent, cell_id AS cellId, cell_name AS cellName,
      cell_sort_order AS cellSortOrder, photo_key AS photoKey, present,
      attendance_status AS attendanceStatus, created_at AS createdAt, updated_at AS updatedAt
     FROM sunday_attendance_records
     WHERE session_id = ? ${scope.clause ? `AND ${scope.clause}` : ""}
     ORDER BY cell_sort_order, cell_name, member_name`
  ).bind(sessionId, ...scope.bindings).all();
  return rows.results || [];
}

function attendanceScopeSql(viewer, column) {
  if (viewerHasGlobalScope(viewer)) return { clause: "", bindings: [] };
  const cellIds = Array.isArray(viewer?.cellIds) ? viewer.cellIds : [];
  if (!cellIds.length) return { clause: "1 = 0", bindings: [] };
  return {
    clause: `${column} IN (${cellIds.map(() => "?").join(",")})`,
    bindings: cellIds
  };
}

async function handleCallNotes(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  await requireCallNoteAuth(request, env);
  const payload = await readBoundedCallNoteJson(request);
  if (clean(payload.batchType).toLowerCase() === "daily") {
    return handleDailyCallNoteBatch(request, env, payload);
  }
  const result = await processCallNoteRecord(request, env, payload);
  return json(result.body, result.httpStatus);
}

async function handleDailyCallNoteBatch(request, env, payload) {
  if (!Array.isArray(payload.records)) {
    throw new HttpError("records must be an array", 400, "CALL_NOTE_BATCH_RECORDS_REQUIRED");
  }
  if (!payload.records.length) {
    throw new HttpError("records must not be empty", 400, "CALL_NOTE_BATCH_EMPTY");
  }
  if (payload.records.length > CALL_NOTE_DAILY_BATCH_MAX_RECORDS) {
    throw new HttpError(
      `A daily batch can contain up to ${CALL_NOTE_DAILY_BATCH_MAX_RECORDS} records`,
      413,
      "CALL_NOTE_BATCH_LIMIT_EXCEEDED"
    );
  }
  if (payload.recordCount !== undefined
    && (!Number.isSafeInteger(payload.recordCount) || payload.recordCount !== payload.records.length)) {
    throw new HttpError("recordCount does not match records", 400, "CALL_NOTE_BATCH_COUNT_MISMATCH");
  }
  const batchDate = strictCallNoteDate(payload.callDate);
  if (!batchDate) throw new HttpError("callDate must be a valid YYYY-MM-DD date", 400, "CALL_NOTE_BATCH_DATE_INVALID");

  let accepted = 0;
  let duplicates = 0;
  let failed = 0;
  let needsReview = 0;
  const results = [];
  for (let index = 0; index < payload.records.length; index += 1) {
    const record = payload.records[index];
    const sourceId = clean(record?.sourceId);
    try {
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        throw new HttpError("Each record must be an object", 400, "CALL_NOTE_BATCH_RECORD_INVALID");
      }
      if (!sourceId) {
        throw new HttpError("Each daily record requires sourceId", 400, "CALL_NOTE_SOURCE_ID_REQUIRED");
      }
      if (sourceId.length > CALL_NOTE_SOURCE_ID_MAX_LENGTH) {
        throw new HttpError("sourceId is too long", 400, "CALL_NOTE_SOURCE_ID_TOO_LONG");
      }
      const recordDate = strictCallNoteRecordDate(record);
      if (!recordDate || recordDate !== batchDate) {
        throw new HttpError("Record date must match the daily callDate", 400, "CALL_NOTE_BATCH_DATE_MISMATCH");
      }
      const result = await processCallNoteRecord(request, env, record, { requireExplicitSourceId: true });
      if (result.outcome === "duplicate") duplicates += 1;
      else {
        accepted += 1;
        if (result.body.status === "needs_review") needsReview += 1;
      }
      results.push(batchCallNoteResult(index, sourceId, result));
    } catch (error) {
      if (!(error instanceof HttpError) || Number(error.status || 500) >= 500) throw error;
      failed += 1;
      results.push({
        index,
        sourceId,
        outcome: "failed",
        code: error.code || "CALL_NOTE_RECORD_INVALID",
        httpStatus: Number(error.status || 400)
      });
    }
  }

  const httpStatus = failed > 0 ? 207 : needsReview > 0 ? 202 : accepted > 0 ? 201 : 200;
  return json({
    batchType: "daily",
    callDate: batchDate,
    recordCount: payload.records.length,
    accepted,
    duplicates,
    failed,
    needsReview,
    results
  }, httpStatus);
}

function batchCallNoteResult(index, sourceId, result) {
  return {
    index,
    sourceId,
    outcome: result.outcome,
    httpStatus: result.httpStatus,
    status: result.body.status,
    importId: result.body.importId || "",
    memberId: result.body.memberId || "",
    visitId: result.body.visitId || "",
    ...(result.body.reason ? { reason: result.body.reason } : {})
  };
}

async function processCallNoteRecord(request, env, payload, options = {}) {
  const normalized = await normalizeCallNotePayload(payload);
  if (options.requireExplicitSourceId && normalized.sourceId !== clean(payload?.sourceId)) {
    throw new HttpError("Each daily record requires sourceId", 400, "CALL_NOTE_SOURCE_ID_REQUIRED");
  }
  if (!normalized.summary) {
    throw new HttpError("summary is required", 400, "CALL_NOTE_SUMMARY_REQUIRED");
  }

  const existing = await findExistingCallNoteImport(env, normalized.sourceId);
  if (existing && !isCallNoteImportReplayable(existing)) return callNoteDuplicateResult(existing);

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
      return currentCallNoteDuplicateResult(env, normalized.sourceId);
    }
    const storedImport = await findExistingCallNoteImport(env, normalized.sourceId);
    return {
      httpStatus: 202,
      outcome: "accepted",
      body: {
        status: "needs_review",
        importId: storedImport?.id || importId,
        reason: match.reason,
        candidates: match.candidates.map(publicMemberCandidate)
      }
    };
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
    return currentCallNoteDuplicateResult(env, normalized.sourceId);
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

  return {
    httpStatus: 201,
    outcome: "accepted",
    body: {
      status: "attached",
      importId: storedImportId,
      memberId: match.member.id,
      visitId: visit.id,
      matchReason: match.reason
    }
  };
}

async function handleCallNoteImports(request, env, path, viewerRole) {
  await requireWriteAuth(viewerRole);

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

async function handlePhotoRead(request, env, keyParts, viewerRole, viewer = null) {
  if (!env.PHOTOS) return json({ error: "R2 binding PHOTOS is not configured" }, 503);
  let key;
  try {
    key = decodeURIComponent(keyParts.join("/"));
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (!key) return new Response("Not found", { status: 404 });
  if (viewer) {
    const member = await env.DB.prepare(
      `SELECT cell_id AS cellId FROM members
       WHERE photo_key = ? AND COALESCE(trashed_at, '') = '' LIMIT 1`
    ).bind(key).first();
    if (member) {
      if (!viewerCanAccessCell(viewer, member.cellId)) return new Response("Not found", { status: 404 });
    } else if (!viewerCanUseMemos(viewer)) {
      return new Response("Not found", { status: 404 });
    }
  } else if (viewerRole !== ADMIN_ROLE) {
    await authenticateMobileMemoRequest(request, env, "photos:read");
    const [activeMember, readableNoteAttachment] = await Promise.all([
      env.DB.prepare(
        `SELECT 1 AS allowed
         FROM members
         WHERE photo_key = ?
           AND COALESCE(archived_at, '') = ''
           AND COALESCE(trashed_at, '') = ''
         LIMIT 1`
      ).bind(key).first(),
      env.DB.prepare(
        `SELECT 1 AS allowed
         FROM note_attachments attachment
         INNER JOIN notes note ON note.id = attachment.note_id
         WHERE attachment.object_key = ?
         LIMIT 1`
      ).bind(key).first()
    ]);
    if (!activeMember && !readableNoteAttachment) return new Response("Not found", { status: 404 });
  }
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
      summary, prayer, action, source, raw_payload AS rawPayload,
      alarm_at AS alarmAt, alarm_state AS alarmState, alarm_id AS alarmId,
      dismissed_at AS alarmDismissedAt, created_at AS createdAt, updated_at AS updatedAt
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

function strictCallNoteDate(value) {
  const text = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const timestamp = Date.parse(`${text}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === text ? text : "";
}

function strictCallNoteRecordDate(record) {
  for (const value of [record.callDate, record.visitDate, record.date]) {
    const date = strictCallNoteDate(value);
    if (date) return date;
    if (clean(value)) return "";
  }
  const calledAt = clean(record.calledAt || record.callDateTime || record.createdAt || record.recordedAt);
  if (!calledAt) return "";
  const localDate = calledAt.match(/^(\d{4}-\d{2}-\d{2})(?:[T\s]|$)/)?.[1] || "";
  if (localDate) return strictCallNoteDate(localDate);
  const timestamp = Date.parse(calledAt);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : "";
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

function callNoteDuplicateBody(existing) {
  return {
    status: existing.status,
    duplicate: true,
    importId: existing.id,
    memberId: existing.memberId || "",
    visitId: existing.visitId || ""
  };
}

function callNoteDuplicateResult(existing) {
  return { httpStatus: 200, outcome: "duplicate", body: callNoteDuplicateBody(existing) };
}

async function currentCallNoteDuplicateResult(env, sourceId) {
  const current = await findExistingCallNoteImport(env, sourceId);
  if (current) return callNoteDuplicateResult(current);
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
      : ""
  }));
}

function memberPhotoUrl(member) {
  const id = clean(member?.id);
  const photoKey = clean(member?.photoKey);
  if (photoKey) return `/api/photos/${encodeURIComponent(photoKey)}`;
  return id.startsWith("seed-") ? `/photos/${id}.jpg?v=${PHOTO_VERSION}` : "";
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

async function filterRowsByViewerMemberScope(env, rows, viewer) {
  if (viewerHasGlobalScope(viewer)) return rows;
  if (!viewer?.cellIds?.length || !rows.length) return [];
  const memberIds = [...new Set(rows.map((row) => clean(row.memberId)).filter(Boolean))];
  if (!memberIds.length) return [];
  const scoped = await env.DB.prepare(
    `SELECT id FROM members
     WHERE id IN (${memberIds.map(() => "?").join(",")})
       AND cell_id IN (${viewer.cellIds.map(() => "?").join(",")})`
  ).bind(...memberIds, ...viewer.cellIds).all();
  const visibleIds = new Set((scoped.results || []).map((row) => row.id));
  return rows.filter((row) => visibleIds.has(row.memberId));
}

function requireSensitiveEdit(viewer) {
  requireViewerEdit(viewer);
  if (!viewer.canViewSensitive && viewer.role !== "owner") {
    throw new HttpError("Sensitive record access is required", 403);
  }
}

async function requireWriteAuth(principal) {
  if (principal === ADMIN_ROLE) return;
  // Existing browser handlers pass the Request object after Pages middleware
  // has already validated the administrator session.
  if (principal && typeof principal === "object" && principal.headers) return;
  throw new HttpError("Administrator access is required", 403);
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

async function audit(env, request, action, entityType, entityId, before, after, actorOverride = null) {
  const actor = requestAuditActor(request, actorOverride);
  await auditStatement(env, actor, action, entityType, entityId, before, after).run();
}

function requestAuditActor(request, actorOverride = null) {
  return actorOverride === null
    ? trustedRequestActors.get(request) || request.headers.get("CF-Access-Authenticated-User-Email") || ""
    : clean(actorOverride);
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

function mutationAuditStatement(env, request, action, entityType, entityId, before, after, actorOverride = null) {
  return env.DB.prepare(
    `INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, before_json, after_json)
     SELECT ?, ?, ?, ?, ?, ?, ?
     WHERE changes() = 1`
  ).bind(
    crypto.randomUUID(), requestAuditActor(request, actorOverride), action, entityType, entityId,
    before ? JSON.stringify(before) : "",
    after ? JSON.stringify(after) : ""
  );
}

async function hasAuditRecord(env, action, entityType, entityId) {
  return Boolean(await env.DB.prepare(
    `SELECT 1 AS found
     FROM audit_logs
     WHERE action = ? AND entity_type = ? AND entity_id = ?
     LIMIT 1`
  ).bind(action, entityType, entityId).first());
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
