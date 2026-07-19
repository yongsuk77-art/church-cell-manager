export const OWNER_USER_ID = "owner";
export const USER_ROLES = new Set(["pastor", "cell_leader", "viewer"]);

export function ownerViewer() {
  return {
    id: OWNER_USER_ID,
    username: "admin",
    displayName: "관리자",
    role: "owner",
    canViewSensitive: true,
    canEdit: true,
    cellIds: [],
    status: "active"
  };
}

export async function readViewerById(env, userId) {
  const id = clean(userId);
  if (!id || id === OWNER_USER_ID) return ownerViewer();
  if (!env?.DB) return null;
  try {
    const row = await env.DB.prepare(
      `SELECT id, username, display_name AS displayName, role,
        can_view_sensitive AS canViewSensitive, can_edit AS canEdit, status
       FROM app_users WHERE id = ? AND status = 'active'`
    ).bind(id).first();
    return row ? hydrateViewer(env, row) : null;
  } catch {
    return null;
  }
}

export async function readViewerByUsername(env, username) {
  const normalized = normalizeUsername(username);
  if (!normalized || normalized === "admin" || normalized === "owner") return null;
  if (!env?.DB) return null;
  try {
    const row = await env.DB.prepare(
      `SELECT id, username, display_name AS displayName, role, password_hash AS passwordHash,
        can_view_sensitive AS canViewSensitive, can_edit AS canEdit, status
       FROM app_users WHERE username = ? COLLATE NOCASE AND status = 'active'`
    ).bind(normalized).first();
    if (!row) return null;
    return { ...(await hydrateViewer(env, row)), passwordHash: clean(row.passwordHash) };
  } catch {
    return null;
  }
}

async function hydrateViewer(env, row) {
  const cells = await env.DB.prepare(
    "SELECT cell_id AS cellId FROM app_user_cells WHERE user_id = ? ORDER BY cell_id"
  ).bind(row.id).all();
  return normalizeTrustedViewer({
    ...row,
    cellIds: (cells.results || []).map((item) => clean(item.cellId)).filter(Boolean)
  });
}

export function normalizeTrustedViewer(value) {
  if (!value || typeof value !== "object") return null;
  if (value.id === OWNER_USER_ID || value.role === "owner") return ownerViewer();
  const role = USER_ROLES.has(value.role) ? value.role : "";
  const id = clean(value.id);
  if (!id || !role || value.status === "disabled") return null;
  return {
    id,
    username: normalizeUsername(value.username),
    displayName: clean(value.displayName || value.display_name).slice(0, 80),
    role,
    canViewSensitive: truthy(value.canViewSensitive ?? value.can_view_sensitive),
    canEdit: truthy(value.canEdit ?? value.can_edit) && role !== "viewer",
    cellIds: Array.isArray(value.cellIds)
      ? [...new Set(value.cellIds.map(clean).filter(Boolean))]
      : [],
    status: "active"
  };
}

export function publicViewer(viewer) {
  const normalized = normalizeTrustedViewer(viewer) || ownerViewer();
  return {
    id: normalized.id,
    username: normalized.username,
    displayName: normalized.displayName,
    role: normalized.role,
    roleLabel: viewerRoleLabel(normalized.role),
    canViewSensitive: normalized.canViewSensitive,
    canEdit: normalized.canEdit,
    canManageUsers: normalized.role === "owner",
    canManageSettings: normalized.role === "owner",
    canUseMemos: normalized.role === "owner" || normalized.role === "pastor",
    hasGlobalScope: viewerHasGlobalScope(normalized),
    cellIds: [...normalized.cellIds]
  };
}

export function viewerRoleLabel(role) {
  return {
    owner: "소유자",
    pastor: "교역자",
    cell_leader: "셀장",
    viewer: "조회자"
  }[role] || "조회자";
}

export function viewerHasGlobalScope(viewer) {
  return viewer?.role === "owner" || viewer?.role === "pastor";
}

export function viewerCanAccessCell(viewer, cellId) {
  if (!viewer) return false;
  if (viewerHasGlobalScope(viewer)) return true;
  return viewer.cellIds.includes(clean(cellId));
}

export function viewerCanEdit(viewer) {
  return Boolean(viewer?.canEdit) && viewer?.role !== "viewer";
}

export function viewerCanViewSensitive(viewer) {
  return Boolean(viewer?.canViewSensitive) || viewer?.role === "owner";
}

export function viewerCanManageUsers(viewer) {
  return viewer?.role === "owner";
}

export function viewerCanDeleteMembers(viewer) {
  return viewer?.role === "owner" || viewer?.role === "pastor";
}

export function viewerCanUseMemos(viewer) {
  return viewer?.role === "owner" || viewer?.role === "pastor";
}

export function filterMembersForViewer(rows, viewer) {
  const values = Array.isArray(rows) ? rows : [];
  return viewerHasGlobalScope(viewer)
    ? values
    : values.filter((member) => viewerCanAccessCell(viewer, member.cellId || member.cell_id));
}

export function maskMemberForViewer(member, viewer) {
  if (!member || viewerCanViewSensitive(viewer)) return member;
  return {
    ...member,
    phone: "",
    homePhone: "",
    birth: "",
    address: "",
    memo: "",
    prayerRequests: ""
  };
}

export function maskVisitForViewer(visit, viewer) {
  if (!visit || viewerCanViewSensitive(viewer)) return visit;
  return { ...visit, summary: "보호된 심방 기록", prayer: "", action: "", rawPayload: "" };
}

export function maskPrayerForViewer(topic, viewer) {
  if (!topic || viewerCanViewSensitive(viewer)) return topic;
  return { ...topic, content: "보호된 기도제목", answeredNote: "" };
}

export function maskTaskForViewer(task, viewer) {
  if (!task || viewerCanViewSensitive(viewer)) return task;
  return { ...task, note: "" };
}

export async function assertViewerMemberAccess(env, viewer, memberId) {
  const row = await env.DB.prepare("SELECT id, cell_id AS cellId FROM members WHERE id = ?")
    .bind(clean(memberId))
    .first();
  if (!row || !viewerCanAccessCell(viewer, row.cellId)) {
    throw accessError("성도 자료에 접근할 권한이 없습니다", 403, "MEMBER_SCOPE_DENIED");
  }
  return row;
}

export function assertViewerCellAccess(viewer, cellId) {
  if (!viewerCanAccessCell(viewer, cellId)) {
    throw accessError("해당 셀을 관리할 권한이 없습니다", 403, "CELL_SCOPE_DENIED");
  }
}

export function requireViewer(viewer) {
  if (!viewer) throw accessError("로그인이 필요합니다", 401, "LOGIN_REQUIRED");
  return viewer;
}

export function requireViewerEdit(viewer) {
  requireViewer(viewer);
  if (!viewerCanEdit(viewer)) {
    throw accessError("수정 권한이 없습니다", 403, "EDIT_PERMISSION_REQUIRED");
  }
  return viewer;
}

export function requireOwner(viewer) {
  requireViewer(viewer);
  if (!viewerCanManageUsers(viewer)) {
    throw accessError("소유자 권한이 필요합니다", 403, "OWNER_REQUIRED");
  }
  return viewer;
}

export function viewerAuditActor(viewer) {
  const normalized = normalizeTrustedViewer(viewer) || ownerViewer();
  return normalized.id === OWNER_USER_ID
    ? "owner"
    : `user:${normalized.id}:${normalized.displayName || normalized.username}`.slice(0, 180);
}

export function normalizeUsername(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 40);
}

function accessError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function truthy(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function clean(value) {
  return String(value || "").trim();
}
