export const OWNER_USER_ID = "owner";
export const DEFAULT_CHURCH_ID = "church-seosan";
export const DEFAULT_CHURCH_NAME = "서산교회";
export const USER_ROLES = new Set(["pastor", "cell_leader", "viewer"]);

export function ownerViewer(options = {}) {
  const churches = normalizeChurches(options.churches);
  const churchId = clean(options.churchId) || churches[0]?.id || DEFAULT_CHURCH_ID;
  const church = churches.find((item) => item.id === churchId);
  return {
    id: OWNER_USER_ID,
    username: "admin",
    displayName: "관리자",
    role: "owner",
    canViewSensitive: true,
    canEdit: true,
    canManageMembers: true,
    cellIds: [],
    churchCellIds: uniqueIds(options.churchCellIds),
    churchId,
    churchName: clean(options.churchName) || church?.name || DEFAULT_CHURCH_NAME,
    churches,
    scopeReady: Boolean(options.scopeReady),
    status: "active"
  };
}

export async function readViewerById(env, userId, requestedChurchId = "") {
  const id = clean(userId);
  if (!id) return null;
  if (!env?.DB) return id === OWNER_USER_ID ? ownerViewer() : null;

  try {
    if (id === OWNER_USER_ID) return await readOwnerViewer(env, requestedChurchId);
    const identity = await env.DB.prepare(
      `SELECT id, username, display_name AS displayName, last_church_id AS lastChurchId
       FROM app_users WHERE id = ? AND status = 'active'`
    ).bind(id).first();
    if (!identity) return null;
    return readMembershipViewer(env, identity, requestedChurchId || identity.lastChurchId);
  } catch {
    return readLegacyViewerById(env, id);
  }
}

export async function readViewerByUsername(env, username, requestedChurchId = "") {
  const normalized = normalizeUsername(username);
  if (!normalized || normalized === "admin" || normalized === "owner" || !env?.DB) return null;
  try {
    const identity = await env.DB.prepare(
      `SELECT id, username, display_name AS displayName, password_hash AS passwordHash,
        last_church_id AS lastChurchId
       FROM app_users WHERE username = ? COLLATE NOCASE AND status = 'active'`
    ).bind(normalized).first();
    if (!identity) return null;
    const viewer = await readMembershipViewer(env, identity, requestedChurchId || identity.lastChurchId);
    return viewer ? { ...viewer, passwordHash: clean(identity.passwordHash) } : null;
  } catch {
    return readLegacyViewerByUsername(env, normalized);
  }
}

async function readOwnerViewer(env, requestedChurchId) {
  const churchRows = await env.DB.prepare(
    `SELECT id, name FROM churches WHERE status = 'active' ORDER BY created_at, name`
  ).all();
  const churches = normalizeChurches(churchRows.results);
  const preferred = clean(requestedChurchId) || await readOwnerLastChurchId(env);
  const church = churches.find((item) => item.id === preferred) || churches[0]
    || { id: DEFAULT_CHURCH_ID, name: DEFAULT_CHURCH_NAME };
  const churchCellIds = await readChurchCellIds(env, church.id);
  return ownerViewer({
    churchId: church.id,
    churchName: church.name,
    churches,
    churchCellIds,
    scopeReady: true
  });
}

async function readOwnerLastChurchId(env) {
  try {
    const row = await env.DB.prepare(
      "SELECT value FROM app_settings WHERE key = 'owner.lastChurchId'"
    ).first();
    return clean(row?.value);
  } catch {
    return "";
  }
}

async function readMembershipViewer(env, identity, requestedChurchId) {
  const memberships = await env.DB.prepare(
    `SELECT cm.church_id AS churchId, c.name AS churchName, cm.role,
      cm.can_view_sensitive AS canViewSensitive, cm.can_edit AS canEdit,
      cm.can_manage_members AS canManageMembers
     FROM church_memberships cm
     JOIN churches c ON c.id = cm.church_id
     WHERE cm.user_id = ? AND cm.status = 'active' AND c.status = 'active'
     ORDER BY cm.approved_at, c.name`
  ).bind(identity.id).all();
  const rows = memberships.results || [];
  if (!rows.length) return null;
  const requested = clean(requestedChurchId);
  const membership = rows.find((item) => clean(item.churchId) === requested) || rows[0];
  const churchId = clean(membership.churchId);
  const [assigned, churchCellIds] = await Promise.all([
    env.DB.prepare(
      `SELECT cmc.cell_id AS cellId
       FROM church_membership_cells cmc
       JOIN cells c ON c.id = cmc.cell_id
       WHERE cmc.church_id = ? AND cmc.user_id = ? AND c.church_id = ?
       ORDER BY c.sort_order, c.name`
    ).bind(churchId, identity.id, churchId).all(),
    readChurchCellIds(env, churchId)
  ]);
  return normalizeTrustedViewer({
    ...identity,
    ...membership,
    churchId,
    churchName: membership.churchName,
    churches: rows.map((item) => ({ id: item.churchId, name: item.churchName })),
    cellIds: (assigned.results || []).map((item) => item.cellId),
    churchCellIds,
    scopeReady: true,
    status: "active"
  });
}

async function readChurchCellIds(env, churchId) {
  const rows = await env.DB.prepare(
    "SELECT id FROM cells WHERE church_id = ? ORDER BY sort_order, name"
  ).bind(churchId).all();
  return (rows.results || []).map((item) => clean(item.id)).filter(Boolean);
}

async function readLegacyViewerById(env, id) {
  if (id === OWNER_USER_ID) return ownerViewer();
  try {
    const row = await env.DB.prepare(
      `SELECT id, username, display_name AS displayName, role,
        can_view_sensitive AS canViewSensitive, can_edit AS canEdit, status
       FROM app_users WHERE id = ? AND status = 'active'`
    ).bind(id).first();
    return row ? hydrateLegacyViewer(env, row) : null;
  } catch {
    return null;
  }
}

async function readLegacyViewerByUsername(env, username) {
  try {
    const row = await env.DB.prepare(
      `SELECT id, username, display_name AS displayName, role, password_hash AS passwordHash,
        can_view_sensitive AS canViewSensitive, can_edit AS canEdit, status
       FROM app_users WHERE username = ? COLLATE NOCASE AND status = 'active'`
    ).bind(username).first();
    if (!row) return null;
    return { ...(await hydrateLegacyViewer(env, row)), passwordHash: clean(row.passwordHash) };
  } catch {
    return null;
  }
}

async function hydrateLegacyViewer(env, row) {
  const cells = await env.DB.prepare(
    "SELECT cell_id AS cellId FROM app_user_cells WHERE user_id = ? ORDER BY cell_id"
  ).bind(row.id).all();
  return normalizeTrustedViewer({
    ...row,
    cellIds: (cells.results || []).map((item) => item.cellId),
    churchId: DEFAULT_CHURCH_ID,
    churchName: DEFAULT_CHURCH_NAME,
    churches: [{ id: DEFAULT_CHURCH_ID, name: DEFAULT_CHURCH_NAME }],
    scopeReady: false
  });
}

export function normalizeTrustedViewer(value) {
  if (!value || typeof value !== "object") return null;
  if (value.id === OWNER_USER_ID || value.role === "owner") {
    return ownerViewer({
      churchId: value.churchId,
      churchName: value.churchName,
      churches: value.churches,
      churchCellIds: value.churchCellIds,
      scopeReady: value.scopeReady
    });
  }
  const role = USER_ROLES.has(value.role) ? value.role : "";
  const id = clean(value.id);
  if (!id || !role || value.status === "disabled" || value.status === "pending") return null;
  const churches = normalizeChurches(value.churches);
  const churchId = clean(value.churchId) || churches[0]?.id || DEFAULT_CHURCH_ID;
  const church = churches.find((item) => item.id === churchId);
  return {
    id,
    username: normalizeUsername(value.username),
    displayName: clean(value.displayName || value.display_name).slice(0, 80),
    role,
    canViewSensitive: truthy(value.canViewSensitive ?? value.can_view_sensitive),
    canEdit: truthy(value.canEdit ?? value.can_edit) && role !== "viewer",
    canManageMembers: truthy(value.canManageMembers ?? value.can_manage_members),
    cellIds: uniqueIds(value.cellIds),
    churchCellIds: uniqueIds(value.churchCellIds),
    churchId,
    churchName: clean(value.churchName) || church?.name || DEFAULT_CHURCH_NAME,
    churches,
    scopeReady: Boolean(value.scopeReady),
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
    canManageUsers: viewerCanManageUsers(normalized),
    canManageSettings: normalized.role === "owner",
    canUseMemos: viewerCanUseMemos(normalized),
    hasGlobalScope: viewerHasGlobalScope(normalized),
    cellIds: [...normalized.cellIds],
    accessibleCellIds: viewerAccessibleCellIds(normalized),
    churchId: normalized.churchId,
    churchName: normalized.churchName,
    churches: normalized.churches.map((church) => ({ ...church }))
  };
}

export function viewerRoleLabel(role) {
  return {
    owner: "소유자",
    pastor: "교역자",
    cell_leader: "셀리더",
    viewer: "조회자"
  }[role] || "조회자";
}

export function viewerHasGlobalScope(viewer) {
  return viewer?.role === "owner";
}

export function viewerAccessibleCellIds(viewer) {
  if (!viewer) return [];
  if (viewerHasGlobalScope(viewer) && viewer.scopeReady) return [...viewer.churchCellIds];
  return [...(viewer.cellIds || [])];
}

export function viewerCanAccessCell(viewer, cellId) {
  if (!viewer) return false;
  if (viewerHasGlobalScope(viewer) && !viewer.scopeReady) return true;
  return viewerAccessibleCellIds(viewer).includes(clean(cellId));
}

export function viewerCanEdit(viewer) {
  return Boolean(viewer?.canEdit) && viewer?.role !== "viewer";
}

export function viewerCanViewSensitive(viewer) {
  return Boolean(viewer?.canViewSensitive) || viewer?.role === "owner";
}

export function viewerCanManageUsers(viewer) {
  return viewer?.role === "owner" || Boolean(viewer?.canManageMembers);
}

export function viewerCanDeleteMembers(viewer) {
  return viewer?.role === "owner" || viewer?.role === "pastor";
}

export function viewerCanUseMemos(viewer) {
  return viewer?.role === "owner" || viewer?.role === "pastor";
}

export function filterMembersForViewer(rows, viewer) {
  const values = Array.isArray(rows) ? rows : [];
  if (viewerHasGlobalScope(viewer) && !viewer?.scopeReady) return values;
  return values.filter((member) => viewerCanAccessCell(viewer, member.cellId || member.cell_id));
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
  let row;
  try {
    row = await env.DB.prepare(
      `SELECT m.id, m.cell_id AS cellId, c.church_id AS churchId
       FROM members m JOIN cells c ON c.id = m.cell_id WHERE m.id = ?`
    ).bind(clean(memberId)).first();
  } catch {
    try {
      row = await env.DB.prepare("SELECT id, cell_id AS cellId FROM members WHERE id = ?")
        .bind(clean(memberId)).first();
    } catch (error) {
      // Legacy integration fixtures predate the member table. Production schemas always have it.
      if (viewerHasGlobalScope(viewer) && !viewer?.scopeReady) {
        return { id: clean(memberId), cellId: "", churchId: DEFAULT_CHURCH_ID };
      }
      throw error;
    }
  }
  if (!row || (viewer?.scopeReady && clean(row.churchId) !== clean(viewer.churchId))
    || !viewerCanAccessCell(viewer, row.cellId)) {
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

export function requireChurchAdmin(viewer) {
  requireViewer(viewer);
  if (!viewerCanManageUsers(viewer)) {
    throw accessError("공동 사용자 관리 권한이 필요합니다", 403, "CHURCH_ADMIN_REQUIRED");
  }
  return viewer;
}

export function requireOwner(viewer) {
  requireViewer(viewer);
  if (viewer?.role !== "owner") {
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

function normalizeChurches(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .map((value) => ({ id: clean(value?.id || value?.churchId), name: clean(value?.name || value?.churchName) }))
    .filter((value) => value.id && value.name && !seen.has(value.id) && seen.add(value.id));
}

function uniqueIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))];
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
