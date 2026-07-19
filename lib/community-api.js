import {
  OWNER_USER_ID,
  USER_ROLES,
  assertViewerCellAccess,
  assertViewerMemberAccess,
  filterMembersForViewer,
  normalizeUsername,
  ownerViewer,
  publicViewer,
  readViewerById,
  requireChurchAdmin,
  requireOwner,
  requireViewer,
  requireViewerEdit,
  viewerAuditActor,
  viewerCanAccessCell,
  viewerCanManageUsers,
  viewerCanViewSensitive,
  viewerHasGlobalScope,
  viewerRoleLabel
} from "./community-access.js";

const PASSWORD_ALGORITHM = "pbkdf2-sha256";
const PASSWORD_ITERATIONS = 100000;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_BYTES = 128;
const ASSIGNMENT_STATUSES = new Set(["waiting", "contacted", "visit_planned", "completed", "cancelled"]);
const ASSIGNMENT_SOURCE_KINDS = new Set(["manual", "birthday", "new_family", "attendance", "care_gap", "task", "prayer"]);
const USER_STATUSES = new Set(["pending", "active", "disabled"]);
const NEWCOMER_STATUSES = new Set(["pending", "approved", "rejected"]);
const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function handleCommunityApi({ request, env, path, viewer }) {
  try {
    requireViewer(viewer);
    const section = clean(path[1]);
    if (!section || section === "overview") return communityOverview(env, viewer);
    if (section === "users") return handleUsers(request, env, path.slice(2), viewer);
    if (section === "assignments") return handleAssignments(request, env, path.slice(2), viewer);
    if (section === "newcomers") return handleNewcomers(request, env, path.slice(2), viewer);
    if (section === "families") return handleFamilies(request, env, path.slice(2), viewer);
    if (section === "reports") return handleReports(request, env, viewer);
    return json({ error: "Not found" }, 404);
  } catch (error) {
    return apiError(error);
  }
}

export async function handlePublicNewcomerApi({ request, env, path }) {
  try {
    if (path[0] !== "public" || path[1] !== "newcomer") return json({ error: "Not found" }, 404);
    const token = clean(path[2]);
    if (!INVITE_TOKEN_PATTERN.test(token)) throw httpError("유효하지 않은 등록 링크입니다", 404, "INVITE_INVALID");
    const invite = await readActiveInviteByToken(env, token);
    if (!invite) throw httpError("등록 링크가 만료되었거나 사용할 수 없습니다", 410, "INVITE_UNAVAILABLE");
    if (request.method === "GET") {
      return json({
        active: true,
        label: invite.label,
        churchName: invite.churchName,
        expiresAt: invite.expiresAt,
        privacyNotice: "입력한 정보는 교회 공동체 등록과 목양을 위해서만 사용됩니다."
      });
    }
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    return createNewcomerSubmission(request, env, invite);
  } catch (error) {
    return apiError(error);
  }
}

async function communityOverview(env, viewer) {
  const [cellsResult, membersResult, assignments, families, users] = await Promise.all([
    env.DB.prepare("SELECT id, name, meta, gender, sort_order AS sortOrder FROM cells ORDER BY sort_order, name").all(),
    env.DB.prepare(
      `SELECT id, cell_id AS cellId, name, title, photo_key AS photoKey,
        archived_at AS archivedAt, trashed_at AS trashedAt
       FROM members WHERE COALESCE(trashed_at, '') = '' ORDER BY name`
    ).all(),
    listAssignments(env, viewer),
    listFamilies(env, viewer),
    listAssignableUsers(env, viewer)
  ]);
  const members = filterMembersForViewer(membersResult.results || [], viewer)
    .filter((member) => !member.archivedAt)
    .map(publicMemberReference);
  const cells = (cellsResult.results || []).filter((cell) => viewerCanAccessCell(viewer, cell.id));
  const payload = {
    viewer: publicViewer(viewer),
    cells,
    members,
    users,
    assignments,
    families
  };
  if (viewerCanManageUsers(viewer)) {
    const [invites, submissions, managedUsers] = await Promise.all([
      listNewcomerInvites(env, viewer),
      listNewcomerSubmissions(env, viewer),
      listManagedUsers(env, viewer)
    ]);
    payload.invites = invites;
    payload.submissions = submissions;
    payload.managedUsers = managedUsers;
  }
  return json(payload);
}

async function handleUsers(request, env, path, viewer) {
  requireChurchAdmin(viewer);
  const id = clean(path[0]);
  if (request.method === "GET" && !id) return json({ users: await listManagedUsers(env, viewer) });
  if (request.method === "POST" && !id) return createUser(request, env, viewer);
  if (request.method === "PATCH" && id) return updateUser(request, env, viewer, id);
  return json({ error: "Method not allowed" }, 405);
}

async function listManagedUsers(env, viewer) {
  const churchId = currentChurchId(viewer);
  const rows = await env.DB.prepare(
    `SELECT user.id, user.username, user.display_name AS displayName,
      membership.role, membership.can_view_sensitive AS canViewSensitive,
      membership.can_edit AS canEdit,
      membership.can_manage_members AS canManageMembers,
      membership.status, membership.requested_at AS requestedAt,
      membership.approved_at AS approvedAt,
      user.last_login_at AS lastLoginAt,
      membership.created_at AS createdAt, membership.updated_at AS updatedAt
     FROM church_memberships membership
     JOIN app_users user ON user.id = membership.user_id
     WHERE membership.church_id = ? AND user.status = 'active'
     ORDER BY CASE membership.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
       membership.role, user.display_name`
  ).bind(churchId).all();
  const cells = await env.DB.prepare(
    `SELECT user_id AS userId, cell_id AS cellId
     FROM church_membership_cells WHERE church_id = ? ORDER BY user_id, cell_id`
  ).bind(churchId).all();
  const cellsByUser = groupValues(cells.results || [], "userId", "cellId");
  const owner = ownerViewer({
    churchId,
    churchName: viewer.churchName,
    churches: viewer.churches,
    churchCellIds: viewer.churchCellIds,
    scopeReady: true
  });
  return [
    {
      ...publicViewer(owner),
      status: "active",
      lastLoginAt: "",
      createdAt: "",
      updatedAt: ""
    },
    ...(rows.results || []).map((row) => ({
      id: clean(row.id),
      username: clean(row.username),
      displayName: clean(row.displayName),
      role: USER_ROLES.has(row.role) ? row.role : "viewer",
      roleLabel: viewerRoleLabel(row.role),
      canViewSensitive: truthy(row.canViewSensitive),
      canEdit: truthy(row.canEdit) && row.role !== "viewer",
      canManageUsers: truthy(row.canManageMembers),
      canManageMembers: truthy(row.canManageMembers),
      canManageSettings: false,
      canUseMemos: row.role === "pastor",
      hasGlobalScope: false,
      cellIds: cellsByUser.get(row.id) || [],
      status: USER_STATUSES.has(row.status) ? row.status : "disabled",
      requestedAt: clean(row.requestedAt),
      approvedAt: clean(row.approvedAt),
      lastLoginAt: clean(row.lastLoginAt),
      createdAt: clean(row.createdAt),
      updatedAt: clean(row.updatedAt),
      churchId
    }))
  ].filter((user) => user.id === OWNER_USER_ID || viewerCanManageAccount(viewer, user));
}

function viewerCanManageAccount(viewer, user) {
  if (viewer.role === "owner" || user.status === "pending") return true;
  return user.cellIds.length > 0
    && user.cellIds.every((cellId) => viewerCanAccessCell(viewer, cellId));
}

async function listAssignableUsers(env, viewer) {
  const users = await listManagedUsers(env, viewer);
  return users
    .filter((user) => user.status === "active" && user.canEdit)
    .map(({ id, displayName, role, roleLabel, cellIds, hasGlobalScope }) => ({
      id, displayName, role, roleLabel, cellIds, hasGlobalScope
    }));
}

async function createUser(request, env, viewer) {
  const body = await safeJson(request);
  const username = normalizeUsername(body.username);
  const displayName = clean(body.displayName).slice(0, 80);
  const role = USER_ROLES.has(body.role) ? body.role : "";
  validateNewUser(username, displayName, role, body.password);
  if (viewer.role !== "owner" && role === "pastor") {
    throw httpError("교역자 권한은 소유자만 부여할 수 있습니다", 403, "ROLE_GRANT_DENIED");
  }
  const churchId = currentChurchId(viewer);
  const cellIds = await normalizeUserCellIds(env, body.cellIds, viewer);
  const now = new Date().toISOString();
  const user = {
    id: crypto.randomUUID(),
    username,
    displayName,
    role,
    canViewSensitive: body.canViewSensitive === true,
    canEdit: role !== "viewer" && body.canEdit !== false,
    canManageMembers: viewer.role === "owner" && body.canManageMembers === true,
    status: "active",
    cellIds,
    createdAt: now,
    updatedAt: now
  };
  const passwordHash = await createPasswordHash(body.password);
  const statements = [
    env.DB.prepare(
      `INSERT INTO app_users (
        id, username, display_name, role, password_hash, can_view_sensitive,
        can_edit, status, last_church_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
    ).bind(
      user.id, user.username, user.displayName, user.role, passwordHash,
      user.canViewSensitive ? 1 : 0, user.canEdit ? 1 : 0, churchId, now, now
    ),
    env.DB.prepare(
      `INSERT INTO church_memberships (
        church_id, user_id, role, can_view_sensitive, can_edit, can_manage_members,
        status, requested_at, approved_at, approved_by_user_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
    ).bind(
      churchId, user.id, user.role, user.canViewSensitive ? 1 : 0,
      user.canEdit ? 1 : 0, user.canManageMembers ? 1 : 0,
      now, now, viewer.id, now, now
    ),
    ...cellIds.map((cellId) => env.DB.prepare(
      `INSERT INTO church_membership_cells (church_id, user_id, cell_id, created_at)
       VALUES (?, ?, ?, ?)`
    ).bind(churchId, user.id, cellId, now)),
    ...cellIds.map((cellId) => env.DB.prepare(
      "INSERT OR IGNORE INTO app_user_cells (user_id, cell_id, created_at) VALUES (?, ?, ?)"
    ).bind(user.id, cellId, now)),
    auditStatement(env, viewer, "user.create", "app_user", user.id, "", publicUserAudit(user))
  ];
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (/unique/i.test(String(error?.message || ""))) {
      throw httpError("이미 사용 중인 아이디입니다", 409, "USERNAME_EXISTS");
    }
    throw error;
  }
  return json({ user: { ...user, roleLabel: viewerRoleLabel(role) } }, 201);
}

async function updateUser(request, env, viewer, id) {
  if (id === OWNER_USER_ID) throw httpError("기본 소유자 계정은 여기서 변경할 수 없습니다", 400, "OWNER_IMMUTABLE");
  const churchId = currentChurchId(viewer);
  const previous = await readManagedUser(env, id, churchId);
  if (!previous) throw httpError("사용자를 찾을 수 없습니다", 404, "USER_NOT_FOUND");
  if (!viewerCanManageAccount(viewer, previous)) {
    throw httpError("이 사용자의 권한을 관리할 수 없습니다", 403, "USER_SCOPE_DENIED");
  }
  const body = await safeJson(request);
  const role = body.role === undefined ? previous.role : (USER_ROLES.has(body.role) ? body.role : "");
  if (!role) throw httpError("올바른 역할을 선택하세요", 400, "USER_ROLE_INVALID");
  if (viewer.role !== "owner" && role === "pastor") {
    throw httpError("교역자 권한은 소유자만 부여할 수 있습니다", 403, "ROLE_GRANT_DENIED");
  }
  const displayName = body.displayName === undefined
    ? previous.displayName
    : clean(body.displayName).slice(0, 80);
  if (!displayName) throw httpError("표시 이름을 입력하세요", 400, "DISPLAY_NAME_REQUIRED");
  const status = body.status === undefined
    ? previous.status
    : (USER_STATUSES.has(body.status) ? body.status : "");
  if (!status) throw httpError("사용자 상태가 올바르지 않습니다", 400, "USER_STATUS_INVALID");
  const requestedCellIds = body.cellIds === undefined ? previous.cellIds : body.cellIds;
  const cellIds = status === "active"
    ? await normalizeUserCellIds(env, requestedCellIds, viewer)
    : await normalizeOptionalUserCellIds(env, requestedCellIds, viewer);
  const password = body.password === undefined ? "" : String(body.password || "");
  if (password) validatePassword(password);
  const updatedAt = nextIso(previous.updatedAt);
  const passwordHash = password ? await createPasswordHash(password) : previous.passwordHash;
  const updated = {
    ...previous,
    displayName,
    role,
    canViewSensitive: body.canViewSensitive === undefined
      ? previous.canViewSensitive
      : body.canViewSensitive === true,
    canEdit: role !== "viewer" && (body.canEdit === undefined ? previous.canEdit : body.canEdit === true),
    canManageMembers: viewer.role === "owner"
      ? (body.canManageMembers === undefined ? previous.canManageMembers : body.canManageMembers === true)
      : previous.canManageMembers,
    status,
    cellIds,
    updatedAt
  };
  const statements = [
    env.DB.prepare(
      `UPDATE app_users SET display_name = ?, role = ?, password_hash = ?,
        can_view_sensitive = ?, can_edit = ?, updated_at = ?
       WHERE id = ?`
    ).bind(
      updated.displayName, updated.role, passwordHash, updated.canViewSensitive ? 1 : 0,
      updated.canEdit ? 1 : 0, updatedAt, id
    ),
    env.DB.prepare(
      `UPDATE church_memberships SET role = ?, can_view_sensitive = ?, can_edit = ?,
        can_manage_members = ?, status = ?,
        approved_at = CASE WHEN ? = 'active' AND approved_at = '' THEN ? ELSE approved_at END,
        approved_by_user_id = CASE WHEN ? = 'active' THEN ? ELSE approved_by_user_id END,
        updated_at = ?
       WHERE church_id = ? AND user_id = ?`
    ).bind(
      updated.role, updated.canViewSensitive ? 1 : 0, updated.canEdit ? 1 : 0,
      updated.canManageMembers ? 1 : 0, updated.status,
      updated.status, updatedAt, updated.status, viewer.id, updatedAt, churchId, id
    ),
    env.DB.prepare(
      "DELETE FROM church_membership_cells WHERE church_id = ? AND user_id = ?"
    ).bind(churchId, id),
    env.DB.prepare(
      `DELETE FROM app_user_cells
       WHERE user_id = ? AND cell_id IN (SELECT id FROM cells WHERE church_id = ?)`
    ).bind(id, churchId),
    ...cellIds.map((cellId) => env.DB.prepare(
      `INSERT INTO church_membership_cells (church_id, user_id, cell_id, created_at)
       VALUES (?, ?, ?, ?)`
    ).bind(churchId, id, cellId, updatedAt)),
    ...cellIds.map((cellId) => env.DB.prepare(
      "INSERT OR IGNORE INTO app_user_cells (user_id, cell_id, created_at) VALUES (?, ?, ?)"
    ).bind(id, cellId, updatedAt))
  ];
  if (status === "disabled") {
    statements.push(
      env.DB.prepare(
        "DELETE FROM auth_auto_login_tokens WHERE user_id = ? AND church_id = ?"
      ).bind(id, churchId),
      env.DB.prepare(
        `UPDATE call_note_devices SET status = 'revoked', revoked_at = ?,
          revoke_reason = 'user_disabled', updated_at = ?
         WHERE user_id = ? AND church_id = ?
           AND status IN ('active', 'pending', 'unregistered')`
      ).bind(updatedAt, updatedAt, id, churchId),
      env.DB.prepare(
        `UPDATE call_note_push_deliveries SET send_state = 'cancelled',
          last_error_code = 'ASSIGNEE_DISABLED', failed_at = ?, updated_at = ?
         WHERE target_user_id = ? AND church_id = ?
           AND send_state NOT IN ('accepted', 'cancelled', 'dead')`
      ).bind(updatedAt, updatedAt, id, churchId)
    );
  }
  statements.push(auditStatement(
    env,
    viewer,
    "user.update",
    "app_user",
    id,
    publicUserAudit(previous),
    publicUserAudit(updated)
  ));
  await env.DB.batch(statements);
  return json({ user: { ...publicUserAudit(updated), roleLabel: viewerRoleLabel(role) } });
}

async function readManagedUser(env, id, churchId) {
  const row = await env.DB.prepare(
    `SELECT user.id, user.username, user.display_name AS displayName,
      membership.role, user.password_hash AS passwordHash,
      membership.can_view_sensitive AS canViewSensitive,
      membership.can_edit AS canEdit,
      membership.can_manage_members AS canManageMembers,
      membership.status, user.last_login_at AS lastLoginAt,
      membership.created_at AS createdAt, membership.updated_at AS updatedAt
     FROM church_memberships membership
     JOIN app_users user ON user.id = membership.user_id
     WHERE membership.church_id = ? AND membership.user_id = ?`
  ).bind(churchId, id).first();
  if (!row) return null;
  const cells = await env.DB.prepare(
    `SELECT cell_id AS cellId FROM church_membership_cells
     WHERE church_id = ? AND user_id = ? ORDER BY cell_id`
  ).bind(churchId, id).all();
  return {
    ...row,
    canViewSensitive: truthy(row.canViewSensitive),
    canEdit: truthy(row.canEdit),
    canManageMembers: truthy(row.canManageMembers),
    cellIds: (cells.results || []).map((item) => item.cellId)
  };
}

async function normalizeUserCellIds(env, values, viewer) {
  const requested = [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))].slice(0, 100);
  if (!requested.length) throw httpError("담당 셀을 하나 이상 선택하세요", 400, "USER_CELL_REQUIRED");
  const rows = await env.DB.prepare("SELECT id FROM cells WHERE church_id = ?")
    .bind(currentChurchId(viewer)).all();
  const valid = new Set((rows.results || []).map((row) => row.id));
  if (requested.some((id) => !valid.has(id))) throw httpError("담당 셀 정보가 올바르지 않습니다", 400, "USER_CELL_INVALID");
  if (viewer.role !== "owner" && requested.some((id) => !viewerCanAccessCell(viewer, id))) {
    throw httpError("본인이 담당하지 않은 셀은 권한을 줄 수 없습니다", 403, "USER_CELL_GRANT_DENIED");
  }
  return requested;
}

async function normalizeOptionalUserCellIds(env, values, viewer) {
  const requested = [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))].slice(0, 100);
  if (!requested.length) return [];
  return normalizeUserCellIds(env, requested, viewer);
}

function validateNewUser(username, displayName, role, password) {
  if (!username || username.length < 3) throw httpError("아이디는 영문·숫자로 3자 이상 입력하세요", 400, "USERNAME_INVALID");
  if (username === "admin" || username === "owner") throw httpError("사용할 수 없는 아이디입니다", 400, "USERNAME_RESERVED");
  if (!displayName) throw httpError("표시 이름을 입력하세요", 400, "DISPLAY_NAME_REQUIRED");
  if (!role) throw httpError("역할을 선택하세요", 400, "USER_ROLE_INVALID");
  validatePassword(password);
}

function validatePassword(password) {
  const value = String(password || "");
  if (value.length < MIN_PASSWORD_LENGTH) throw httpError("비밀번호는 12자 이상이어야 합니다", 400, "PASSWORD_TOO_SHORT");
  if (new TextEncoder().encode(value).byteLength > MAX_PASSWORD_BYTES) {
    throw httpError("비밀번호가 너무 깁니다", 400, "PASSWORD_TOO_LONG");
  }
}

async function handleAssignments(request, env, path, viewer) {
  const id = clean(path[0]);
  if (request.method === "GET" && !id) return json({ assignments: await listAssignments(env, viewer) });
  if (request.method === "POST" && !id) return createAssignment(request, env, viewer);
  if (request.method === "PATCH" && id) return updateAssignment(request, env, viewer, id);
  return json({ error: "Method not allowed" }, 405);
}

async function listAssignments(env, viewer) {
  const rows = await env.DB.prepare(
    `SELECT assignment.id, assignment.member_id AS memberId, assignment.source_kind AS sourceKind,
      assignment.source_key AS sourceKey, assignment.title,
      assignment.assignee_user_id AS assigneeUserId, assignment.status,
      assignment.due_date AS dueDate, assignment.note,
      assignment.completed_at AS completedAt, assignment.created_by_user_id AS createdByUserId,
      assignment.created_at AS createdAt, assignment.updated_at AS updatedAt,
      member.name AS memberName, member.cell_id AS cellId, cell.name AS cellName,
      user.display_name AS assigneeDisplayName
     FROM pastoral_assignments assignment
     JOIN members member ON member.id = assignment.member_id
     JOIN cells cell ON cell.id = member.cell_id
     LEFT JOIN app_users user ON user.id = assignment.assignee_user_id
     WHERE assignment.church_id = ? AND cell.church_id = ?
     ORDER BY CASE assignment.status WHEN 'waiting' THEN 0 WHEN 'contacted' THEN 1
       WHEN 'visit_planned' THEN 2 WHEN 'completed' THEN 3 ELSE 4 END,
       assignment.due_date, assignment.updated_at DESC`
  ).bind(currentChurchId(viewer), currentChurchId(viewer)).all();
  return (rows.results || [])
    .filter((row) => viewerCanAccessCell(viewer, row.cellId))
    .map((row) => ({
      ...row,
      note: viewerCanViewSensitive(viewer) ? clean(row.note) : "",
      assigneeDisplayName: row.assigneeUserId === OWNER_USER_ID
        ? "관리자"
        : clean(row.assigneeDisplayName) || "사용 중지된 담당자"
    }));
}

async function createAssignment(request, env, viewer) {
  requireViewerEdit(viewer);
  const body = await safeJson(request);
  const memberId = clean(body.memberId);
  const member = await assertViewerMemberAccess(env, viewer, memberId);
  const assignment = normalizeAssignment(body, {
    id: crypto.randomUUID(),
    memberId,
    createdByUserId: viewer.id,
    createdAt: new Date().toISOString(),
    churchId: currentChurchId(viewer)
  });
  await assertAssigneeAccess(env, assignment.assigneeUserId, member.cellId, assignment.churchId);
  const statements = [assignmentInsertStatement(env, assignment)];
  if (assignment.status !== "completed" && assignment.status !== "cancelled") {
    statements.push(assignmentDeliveryStatement(env, assignment));
  }
  statements.push(auditStatement(env, viewer, "pastoral_assignment.create", "pastoral_assignment", assignment.id, "", assignment));
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (/unique/i.test(String(error?.message || ""))) {
      throw httpError("이 목양 항목에는 이미 진행 중인 담당 업무가 있습니다", 409, "ASSIGNMENT_EXISTS");
    }
    throw error;
  }
  return json(assignment, 201);
}

async function updateAssignment(request, env, viewer, id) {
  requireViewerEdit(viewer);
  const previous = await readAssignment(env, id, currentChurchId(viewer));
  if (!previous) throw httpError("목양 업무를 찾을 수 없습니다", 404, "ASSIGNMENT_NOT_FOUND");
  const member = await assertViewerMemberAccess(env, viewer, previous.memberId);
  const body = await safeJson(request);
  const assignment = normalizeAssignment({ ...previous, ...body }, {
    ...previous,
    id,
    memberId: previous.memberId,
    createdAt: previous.createdAt,
    createdByUserId: previous.createdByUserId
  });
  await assertAssigneeAccess(env, assignment.assigneeUserId, member.cellId, currentChurchId(viewer));
  const changedAssignee = assignment.assigneeUserId !== previous.assigneeUserId;
  const reopened = ["completed", "cancelled"].includes(previous.status)
    && !["completed", "cancelled"].includes(assignment.status);
  const statements = [env.DB.prepare(
    `UPDATE pastoral_assignments SET title = ?, assignee_user_id = ?, status = ?,
      due_date = ?, note = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND church_id = ?`
  ).bind(
    assignment.title, assignment.assigneeUserId, assignment.status, assignment.dueDate,
    assignment.note, assignment.completedAt, assignment.updatedAt, id, currentChurchId(viewer)
  )];
  if ((changedAssignee || reopened) && !["completed", "cancelled"].includes(assignment.status)) {
    statements.push(assignmentDeliveryStatement(env, assignment));
  }
  if (["completed", "cancelled"].includes(assignment.status)) {
    statements.push(env.DB.prepare(
      `UPDATE call_note_push_deliveries SET send_state = 'cancelled',
        last_error_code = 'ASSIGNMENT_CLOSED', failed_at = ?, updated_at = ?
       WHERE kind = 'pastoral_assignment' AND reminder_id = ?
         AND church_id = ?
         AND send_state NOT IN ('accepted', 'cancelled', 'dead')`
    ).bind(assignment.updatedAt, assignment.updatedAt, id, currentChurchId(viewer)));
  }
  statements.push(auditStatement(
    env,
    viewer,
    "pastoral_assignment.update",
    "pastoral_assignment",
    id,
    previous,
    assignment
  ));
  await env.DB.batch(statements);
  return json(assignment);
}

function normalizeAssignment(body, base) {
  const now = nextIso(base.updatedAt || base.createdAt || "");
  const status = ASSIGNMENT_STATUSES.has(body.status) ? body.status : "waiting";
  const sourceKind = ASSIGNMENT_SOURCE_KINDS.has(body.sourceKind) ? body.sourceKind : "manual";
  const title = clean(body.title).slice(0, 160);
  const dueDate = normalizeDate(body.dueDate || koreaDateString());
  if (!title) throw httpError("목양 업무 제목을 입력하세요", 400, "ASSIGNMENT_TITLE_REQUIRED");
  return {
    id: base.id,
    memberId: base.memberId,
    sourceKind,
    sourceKey: clean(body.sourceKey).slice(0, 180),
    title,
    assigneeUserId: clean(body.assigneeUserId) || OWNER_USER_ID,
    status,
    dueDate,
    note: clean(body.note).slice(0, 4000),
    completedAt: status === "completed" ? clean(body.completedAt) || now : "",
    createdByUserId: base.createdByUserId || OWNER_USER_ID,
    churchId: clean(base.churchId) || "church-seosan",
    createdAt: base.createdAt || now,
    updatedAt: now
  };
}

function assignmentInsertStatement(env, assignment) {
  return env.DB.prepare(
    `INSERT INTO pastoral_assignments (
      id, member_id, source_kind, source_key, title, assignee_user_id, status,
      due_date, note, completed_at, created_by_user_id, created_at, updated_at, church_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    assignment.id, assignment.memberId, assignment.sourceKind, assignment.sourceKey,
    assignment.title, assignment.assigneeUserId, assignment.status, assignment.dueDate,
    assignment.note, assignment.completedAt, assignment.createdByUserId,
    assignment.createdAt, assignment.updatedAt, assignment.churchId
  );
}

function assignmentDeliveryStatement(env, assignment) {
  const notificationId = crypto.randomUUID();
  return env.DB.prepare(
    `INSERT OR IGNORE INTO call_note_push_deliveries (
      notification_id, dedupe_key, kind, reminder_id, note_id, visit_id,
      target_user_id, device_id, device_generation, scheduled_at, send_state,
      attempt_count, next_attempt_at, created_at, updated_at, church_id
     ) VALUES (?, ?, 'pastoral_assignment', ?, '', '', ?, NULL, 0, ?, 'pending', 0, ?, ?, ?, ?)`
  ).bind(
    notificationId,
    `pastoral-assignment:${assignment.id}:${assignment.updatedAt}`,
    assignment.id,
    assignment.assigneeUserId,
    assignment.updatedAt,
    assignment.updatedAt,
    assignment.updatedAt,
    assignment.updatedAt,
    assignment.churchId
  );
}

async function readAssignment(env, id, churchId = "church-seosan") {
  return env.DB.prepare(
    `SELECT id, member_id AS memberId, source_kind AS sourceKind, source_key AS sourceKey,
      title, assignee_user_id AS assigneeUserId, status, due_date AS dueDate, note,
      completed_at AS completedAt, created_by_user_id AS createdByUserId,
      created_at AS createdAt, updated_at AS updatedAt, church_id AS churchId
     FROM pastoral_assignments WHERE id = ? AND church_id = ?`
  ).bind(id, churchId).first();
}

async function assertAssigneeAccess(env, userId, cellId, churchId) {
  const assignee = await readViewerById(env, userId, churchId);
  if (!assignee || !assignee.canEdit) throw httpError("활성 상태의 담당자를 선택하세요", 400, "ASSIGNEE_INVALID");
  if (!viewerCanAccessCell(assignee, cellId)) {
    throw httpError("선택한 담당자에게 해당 셀 권한이 없습니다", 400, "ASSIGNEE_CELL_DENIED");
  }
  return assignee;
}

async function handleNewcomers(request, env, path, viewer) {
  requireChurchAdmin(viewer);
  const section = clean(path[0]);
  const id = clean(path[1]);
  if (section === "invites") {
    if (request.method === "GET" && !id) return json({ invites: await listNewcomerInvites(env, viewer) });
    if (request.method === "POST" && !id) return createNewcomerInvite(request, env, viewer);
    if (request.method === "PATCH" && id) return updateNewcomerInvite(request, env, viewer, id);
  }
  if (section === "submissions") {
    if (request.method === "GET" && !id) return json({ submissions: await listNewcomerSubmissions(env, viewer) });
    if (request.method === "PATCH" && id) return reviewNewcomerSubmission(request, env, viewer, id);
  }
  return json({ error: "Method not allowed" }, 405);
}

async function listNewcomerInvites(env, viewer) {
  const rows = await env.DB.prepare(
    `SELECT id, label, expires_at AS expiresAt, max_submissions AS maxSubmissions,
      submission_count AS submissionCount, active, created_at AS createdAt,
      updated_at AS updatedAt
     FROM newcomer_invites WHERE church_id = ?
     ORDER BY active DESC, expires_at DESC, created_at DESC`
  ).bind(currentChurchId(viewer)).all();
  return (rows.results || []).map((row) => ({ ...row, active: truthy(row.active) }));
}

async function createNewcomerInvite(request, env, viewer) {
  const body = await safeJson(request);
  const token = randomBase64Url(32);
  const now = new Date();
  const expiresAt = normalizeFutureDateTime(body.expiresAt, new Date(now.getTime() + 30 * 86400000));
  const maxSubmissions = clampInteger(body.maxSubmissions, 1, 500, 20);
  const invite = {
    id: crypto.randomUUID(),
    label: clean(body.label).slice(0, 100) || "새가족 등록",
    expiresAt,
    maxSubmissions,
    submissionCount: 0,
    active: true,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
  const tokenHash = await sha256Base64Url(token);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO newcomer_invites (
        id, token_hash, label, expires_at, max_submissions, submission_count,
        active, created_by_user_id, created_at, updated_at, church_id
       ) VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?)`
    ).bind(
      invite.id, tokenHash, invite.label, invite.expiresAt, invite.maxSubmissions,
      viewer.id, invite.createdAt, invite.updatedAt, currentChurchId(viewer)
    ),
    auditStatement(env, viewer, "newcomer.invite.create", "newcomer_invite", invite.id, "", invite)
  ]);
  const origin = new URL(request.url).origin;
  return json({
    invite,
    token,
    url: `${origin}/new-family.html?invite=${encodeURIComponent(token)}`
  }, 201);
}

async function updateNewcomerInvite(request, env, viewer, id) {
  const previous = await env.DB.prepare(
    `SELECT id, label, expires_at AS expiresAt, max_submissions AS maxSubmissions,
      submission_count AS submissionCount, active, created_at AS createdAt,
      updated_at AS updatedAt FROM newcomer_invites WHERE id = ? AND church_id = ?`
  ).bind(id, currentChurchId(viewer)).first();
  if (!previous) throw httpError("등록 링크를 찾을 수 없습니다", 404, "INVITE_NOT_FOUND");
  const body = await safeJson(request);
  const updated = {
    ...previous,
    label: body.label === undefined ? previous.label : clean(body.label).slice(0, 100),
    expiresAt: body.expiresAt === undefined
      ? previous.expiresAt
      : normalizeFutureDateTime(body.expiresAt, new Date(previous.expiresAt)),
    maxSubmissions: body.maxSubmissions === undefined
      ? Number(previous.maxSubmissions)
      : clampInteger(body.maxSubmissions, Math.max(1, Number(previous.submissionCount || 0)), 500, 20),
    active: body.active === undefined ? truthy(previous.active) : body.active === true,
    updatedAt: nextIso(previous.updatedAt)
  };
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE newcomer_invites SET label = ?, expires_at = ?, max_submissions = ?,
        active = ?, updated_at = ? WHERE id = ? AND church_id = ?`
    ).bind(
      updated.label, updated.expiresAt, updated.maxSubmissions,
      updated.active ? 1 : 0, updated.updatedAt, id, currentChurchId(viewer)
    ),
    auditStatement(env, viewer, "newcomer.invite.update", "newcomer_invite", id, previous, updated)
  ]);
  return json({ invite: updated });
}

async function readActiveInviteByToken(env, token) {
  const hash = await sha256Base64Url(token);
  const now = new Date().toISOString();
  return env.DB.prepare(
    `SELECT invite.id, invite.label, invite.expires_at AS expiresAt,
      invite.max_submissions AS maxSubmissions,
      invite.submission_count AS submissionCount, invite.church_id AS churchId,
      church.name AS churchName
     FROM newcomer_invites invite
     JOIN churches church ON church.id = invite.church_id
     WHERE token_hash = ? AND active = 1 AND expires_at > ?
       AND submission_count < max_submissions`
  ).bind(hash, now).first();
}

async function createNewcomerSubmission(request, env, invite) {
  const body = await safeJson(request);
  const name = clean(body.name).slice(0, 80);
  const phone = normalizePhone(body.phone);
  const birth = normalizeOptionalDate(body.birth);
  const address = clean(body.address).slice(0, 300);
  const familyDetails = clean(body.familyDetails).slice(0, 2000);
  if (!name) throw httpError("이름을 입력하세요", 400, "NEWCOMER_NAME_REQUIRED");
  if (body.consent !== true) throw httpError("개인정보 수집 및 이용에 동의해야 등록할 수 있습니다", 400, "CONSENT_REQUIRED");
  const duplicates = await findDuplicateMembers(env, name, phone, invite.churchId);
  const now = new Date().toISOString();
  const submission = {
    id: crypto.randomUUID(),
    inviteId: invite.id,
    name,
    phone,
    birth,
    address,
    familyDetails,
    consentAt: now,
    status: "pending",
    duplicateMemberIds: duplicates.map((member) => member.id),
    createdAt: now,
    updatedAt: now
  };
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO newcomer_submissions (
        id, invite_id, name, phone, birth, address, family_details, consent_at,
        status, duplicate_member_ids, created_at, updated_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM newcomer_invites
         WHERE id = ? AND active = 1 AND expires_at > ?
           AND submission_count < max_submissions
       )`
    ).bind(
      submission.id, submission.inviteId, submission.name, submission.phone,
      submission.birth, submission.address, submission.familyDetails,
      submission.consentAt, JSON.stringify(submission.duplicateMemberIds), now, now,
      invite.id, now
    ),
    env.DB.prepare(
      `UPDATE newcomer_invites SET submission_count = submission_count + 1, updated_at = ?
       WHERE id = ? AND EXISTS (SELECT 1 FROM newcomer_submissions WHERE id = ?)`
    ).bind(now, invite.id, submission.id)
  ]);
  if (Number(results[0]?.meta?.changes || 0) !== 1) {
    throw httpError("등록 링크 사용 한도가 끝났습니다", 410, "INVITE_UNAVAILABLE");
  }
  return json({ ok: true, submissionId: submission.id, receivedAt: now }, 201);
}

async function listNewcomerSubmissions(env, viewer) {
  const rows = await env.DB.prepare(
    `SELECT submission.id, submission.invite_id AS inviteId, invite.label AS inviteLabel,
      submission.name, submission.phone, submission.birth, submission.address,
      submission.family_details AS familyDetails, submission.consent_at AS consentAt,
      submission.status, submission.duplicate_member_ids AS duplicateMemberIds,
      submission.desired_cell_id AS desiredCellId,
      submission.approved_member_id AS approvedMemberId,
      submission.reviewer_user_id AS reviewerUserId,
      submission.reviewed_at AS reviewedAt, submission.created_at AS createdAt,
      submission.updated_at AS updatedAt
     FROM newcomer_submissions submission
     JOIN newcomer_invites invite ON invite.id = submission.invite_id
     WHERE invite.church_id = ?
     ORDER BY CASE submission.status WHEN 'pending' THEN 0 ELSE 1 END,
       submission.created_at DESC`
  ).bind(currentChurchId(viewer)).all();
  const memberRows = await env.DB.prepare(
    `SELECT member.id, member.name, member.phone, member.cell_id AS cellId
     FROM members member JOIN cells cell ON cell.id = member.cell_id
     WHERE cell.church_id = ?`
  ).bind(currentChurchId(viewer)).all();
  const members = new Map((memberRows.results || []).map((member) => [member.id, member]));
  return (rows.results || []).map((row) => {
    const ids = parseStringArray(row.duplicateMemberIds);
    return {
      ...row,
      duplicateMemberIds: ids,
      duplicates: ids.map((id) => members.get(id)).filter(Boolean)
    };
  });
}

async function reviewNewcomerSubmission(request, env, viewer, id) {
  const submission = await readNewcomerSubmission(env, id, currentChurchId(viewer));
  if (!submission) throw httpError("새가족 신청을 찾을 수 없습니다", 404, "SUBMISSION_NOT_FOUND");
  if (submission.status !== "pending") throw httpError("이미 처리된 신청입니다", 409, "SUBMISSION_ALREADY_REVIEWED");
  const body = await safeJson(request);
  const action = clean(body.action);
  const now = new Date().toISOString();
  if (action === "reject") {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE newcomer_submissions SET status = 'rejected', reviewer_user_id = ?,
          reviewed_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`
      ).bind(viewer.id, now, now, id),
      auditStatement(env, viewer, "newcomer.submission.reject", "newcomer_submission", id, submission, { status: "rejected", reviewedAt: now })
    ]);
    return json({ ok: true, status: "rejected" });
  }
  if (action !== "approve") throw httpError("처리 방법을 선택하세요", 400, "REVIEW_ACTION_INVALID");
  const cellId = clean(body.cellId);
  assertViewerCellAccess(viewer, cellId);
  const cell = await env.DB.prepare(
    "SELECT id FROM cells WHERE id = ? AND church_id = ?"
  ).bind(cellId, currentChurchId(viewer)).first();
  if (!cell) throw httpError("등록할 셀을 찾을 수 없습니다", 404, "CELL_NOT_FOUND");
  const useExistingMemberId = clean(body.useExistingMemberId);
  if (useExistingMemberId) {
    const existing = await assertViewerMemberAccess(env, viewer, useExistingMemberId).catch(() => null);
    if (!existing) throw httpError("연결할 기존 성도를 찾을 수 없습니다", 404, "MEMBER_NOT_FOUND");
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE newcomer_submissions SET status = 'approved', desired_cell_id = ?,
          approved_member_id = ?, reviewer_user_id = ?, reviewed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`
      ).bind(cellId, useExistingMemberId, viewer.id, now, now, id),
      auditStatement(env, viewer, "newcomer.submission.link", "newcomer_submission", id, submission, {
        status: "approved", memberId: useExistingMemberId, reviewedAt: now
      })
    ]);
    return json({ ok: true, status: "approved", memberId: useExistingMemberId });
  }
  const duplicates = await findDuplicateMembers(
    env, submission.name, submission.phone, currentChurchId(viewer)
  );
  if (duplicates.length && body.force !== true) {
    throw httpError("같은 이름이나 전화번호의 성도가 있습니다. 기존 성도 연결 또는 새로 등록을 선택하세요", 409, "DUPLICATE_MEMBER_REVIEW_REQUIRED", {
      duplicates: duplicates.map(publicMemberReference)
    });
  }
  const memberId = crypto.randomUUID();
  const registeredAt = koreaDateString();
  const memo = submission.familyDetails
    ? `새가족 자가입력 가족사항: ${submission.familyDetails}`.slice(0, 5000)
    : "";
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO members (
        id, cell_id, name, title, role, phone, home_phone, birth, registered_at,
        address, memo, prayer_requests, baptized, long_absent, photo_key,
        archived_at, trashed_at, created_at, updated_at
       ) VALUES (?, ?, ?, '청년', '', ?, '', ?, ?, ?, ?, '', 0, 0, '', '', '', ?, ?)`
    ).bind(
      memberId, cellId, submission.name, submission.phone, submission.birth,
      registeredAt, submission.address, memo, now, now
    ),
    env.DB.prepare(
      `UPDATE newcomer_submissions SET status = 'approved', desired_cell_id = ?,
        approved_member_id = ?, reviewer_user_id = ?, reviewed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`
    ).bind(cellId, memberId, viewer.id, now, now, id),
    auditStatement(env, viewer, "newcomer.submission.approve", "newcomer_submission", id, submission, {
      status: "approved", memberId, cellId, reviewedAt: now
    }),
    auditStatement(env, viewer, "member.create.newcomer", "member", memberId, "", {
      id: memberId, cellId, name: submission.name, registeredAt
    })
  ]);
  return json({ ok: true, status: "approved", memberId }, 201);
}

async function readNewcomerSubmission(env, id, churchId) {
  const row = await env.DB.prepare(
    `SELECT submission.id, submission.invite_id AS inviteId, submission.name,
      submission.phone, submission.birth, submission.address,
      submission.family_details AS familyDetails,
      submission.consent_at AS consentAt, submission.status,
      submission.duplicate_member_ids AS duplicateMemberIds,
      submission.created_at AS createdAt, submission.updated_at AS updatedAt
     FROM newcomer_submissions submission
     JOIN newcomer_invites invite ON invite.id = submission.invite_id
     WHERE submission.id = ? AND invite.church_id = ?`
  ).bind(id, churchId).first();
  return row ? { ...row, duplicateMemberIds: parseStringArray(row.duplicateMemberIds) } : null;
}

async function findDuplicateMembers(env, name, phone, churchId = "church-seosan") {
  const rows = await env.DB.prepare(
    `SELECT member.id, member.name, member.phone, member.cell_id AS cellId, member.title
     FROM members member JOIN cells cell ON cell.id = member.cell_id
     WHERE cell.church_id = ? AND COALESCE(member.trashed_at, '') = ''`
  ).bind(churchId).all();
  const normalizedName = clean(name).replace(/\s+/g, "");
  const normalizedPhone = normalizePhone(phone);
  return (rows.results || []).filter((member) => {
    const sameName = normalizedName && clean(member.name).replace(/\s+/g, "") === normalizedName;
    const samePhone = normalizedPhone && normalizePhone(member.phone) === normalizedPhone;
    return sameName || samePhone;
  }).slice(0, 20);
}

async function handleFamilies(request, env, path, viewer) {
  const id = clean(path[0]);
  const child = clean(path[1]);
  if (request.method === "GET" && !id) return json({ families: await listFamilies(env, viewer) });
  if (request.method === "POST" && !id) return createFamily(request, env, viewer);
  if (request.method === "PATCH" && id && !child) return updateFamily(request, env, viewer, id);
  if (request.method === "PUT" && id && child === "members") return replaceFamilyMembers(request, env, viewer, id);
  if (request.method === "DELETE" && id && !child) return deleteFamily(env, viewer, id);
  return json({ error: "Method not allowed" }, 405);
}

async function listFamilies(env, viewer) {
  const [familyRows, memberRows, visitRows, prayerRows, attendanceRows] = await Promise.all([
    env.DB.prepare(
      `SELECT id, name, note, created_by_user_id AS createdByUserId,
        created_at AS createdAt, updated_at AS updatedAt
       FROM families WHERE church_id = ? ORDER BY name, updated_at DESC`
    ).bind(currentChurchId(viewer)).all(),
    env.DB.prepare(
      `SELECT link.family_id AS familyId, link.member_id AS memberId,
        link.relationship, link.is_primary AS isPrimary,
        member.name AS memberName, member.title, member.cell_id AS cellId,
        cell.name AS cellName, member.phone, member.photo_key AS photoKey
       FROM family_members link
       JOIN families family ON family.id = link.family_id
       JOIN members member ON member.id = link.member_id
       JOIN cells cell ON cell.id = member.cell_id
       WHERE family.church_id = ? AND cell.church_id = ?
         AND COALESCE(member.trashed_at, '') = ''
       ORDER BY link.is_primary DESC, member.name`
    ).bind(currentChurchId(viewer), currentChurchId(viewer)).all(),
    env.DB.prepare(
      `SELECT member_id AS memberId, MAX(visit_date) AS lastVisitDate
       FROM visit_notes GROUP BY member_id`
    ).all(),
    env.DB.prepare(
      `SELECT member_id AS memberId, COUNT(*) AS activePrayerCount
       FROM prayer_topics WHERE status = 'praying' GROUP BY member_id`
    ).all(),
    env.DB.prepare(
      `SELECT records.member_id AS memberId, records.attendance_status AS attendanceStatus,
        sessions.attendance_date AS attendanceDate
       FROM sunday_attendance_records records
       JOIN sunday_attendance_sessions sessions ON sessions.id = records.session_id
       WHERE sessions.church_id = ? AND sessions.id IN (
         SELECT id FROM sunday_attendance_sessions
         WHERE church_id = ? ORDER BY attendance_date DESC LIMIT 1
       )`
    ).bind(currentChurchId(viewer), currentChurchId(viewer)).all()
  ]);
  const visits = new Map((visitRows.results || []).map((row) => [row.memberId, row.lastVisitDate || ""]));
  const prayers = new Map((prayerRows.results || []).map((row) => [row.memberId, Number(row.activePrayerCount || 0)]));
  const attendance = new Map((attendanceRows.results || []).map((row) => [row.memberId, {
    status: row.attendanceStatus || "absent",
    date: row.attendanceDate || ""
  }]));
  const membersByFamily = new Map();
  for (const member of memberRows.results || []) {
    if (!viewerCanAccessCell(viewer, member.cellId)) continue;
    if (!membersByFamily.has(member.familyId)) membersByFamily.set(member.familyId, []);
    const reference = publicMemberReference(member);
    if (!viewerCanViewSensitive(viewer)) reference.phone = "";
    membersByFamily.get(member.familyId).push({
      ...reference,
      relationship: clean(member.relationship),
      isPrimary: truthy(member.isPrimary),
      lastVisitDate: viewerCanViewSensitive(viewer) ? visits.get(member.memberId) || "" : "",
      activePrayerCount: viewerCanViewSensitive(viewer) ? prayers.get(member.memberId) || 0 : 0,
      latestAttendance: attendance.get(member.memberId) || null
    });
  }
  return (familyRows.results || [])
    .map((family) => ({
      ...family,
      note: viewerCanViewSensitive(viewer) ? clean(family.note) : "",
      members: membersByFamily.get(family.id) || []
    }))
    .filter((family) => viewerHasGlobalScope(viewer) || family.members.length > 0);
}

async function createFamily(request, env, viewer) {
  requireViewerEdit(viewer);
  const body = await safeJson(request);
  const name = clean(body.name).slice(0, 100);
  if (!name) throw httpError("가족 이름을 입력하세요", 400, "FAMILY_NAME_REQUIRED");
  const now = new Date().toISOString();
  const family = {
    id: crypto.randomUUID(),
    name,
    note: clean(body.note).slice(0, 3000),
    createdByUserId: viewer.id,
    createdAt: now,
    updatedAt: now,
    members: []
  };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO families (
        id, name, note, created_by_user_id, created_at, updated_at, church_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      family.id, family.name, family.note, family.createdByUserId,
      now, now, currentChurchId(viewer)
    ),
    auditStatement(env, viewer, "family.create", "family", family.id, "", family)
  ]);
  return json(family, 201);
}

async function updateFamily(request, env, viewer, id) {
  requireViewerEdit(viewer);
  await assertFamilyAccess(env, viewer, id);
  const previous = await env.DB.prepare(
    `SELECT id, name, note, created_at AS createdAt, updated_at AS updatedAt
     FROM families WHERE id = ? AND church_id = ?`
  ).bind(id, currentChurchId(viewer)).first();
  if (!previous) throw httpError("가족을 찾을 수 없습니다", 404, "FAMILY_NOT_FOUND");
  const body = await safeJson(request);
  const name = body.name === undefined ? previous.name : clean(body.name).slice(0, 100);
  if (!name) throw httpError("가족 이름을 입력하세요", 400, "FAMILY_NAME_REQUIRED");
  const updated = {
    ...previous,
    name,
    note: body.note === undefined ? previous.note : clean(body.note).slice(0, 3000),
    updatedAt: nextIso(previous.updatedAt)
  };
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE families SET name = ?, note = ?, updated_at = ?
       WHERE id = ? AND church_id = ?`
    ).bind(updated.name, updated.note, updated.updatedAt, id, currentChurchId(viewer)),
    auditStatement(env, viewer, "family.update", "family", id, previous, updated)
  ]);
  return json(updated);
}

async function replaceFamilyMembers(request, env, viewer, id) {
  requireViewerEdit(viewer);
  await assertFamilyAccess(env, viewer, id);
  const family = await env.DB.prepare(
    `SELECT id, name, updated_at AS updatedAt
     FROM families WHERE id = ? AND church_id = ?`
  )
    .bind(id, currentChurchId(viewer))
    .first();
  if (!family) throw httpError("가족을 찾을 수 없습니다", 404, "FAMILY_NOT_FOUND");
  const body = await safeJson(request);
  const values = Array.isArray(body.members) ? body.members.slice(0, 50) : [];
  const memberIds = new Set();
  const members = [];
  for (const value of values) {
    const memberId = clean(value?.memberId);
    if (!memberId || memberIds.has(memberId)) continue;
    await assertViewerMemberAccess(env, viewer, memberId);
    memberIds.add(memberId);
    members.push({
      memberId,
      relationship: clean(value.relationship).slice(0, 50),
      isPrimary: value.isPrimary === true
    });
  }
  if (members.filter((member) => member.isPrimary).length > 1) {
    throw httpError("대표 가족 구성원은 한 명만 선택할 수 있습니다", 400, "FAMILY_PRIMARY_LIMIT");
  }
  const now = nextIso(family.updatedAt);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM family_members WHERE family_id = ?").bind(id),
    ...members.map((member) => env.DB.prepare(
      `INSERT INTO family_members (
        family_id, member_id, relationship, is_primary, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(id, member.memberId, member.relationship, member.isPrimary ? 1 : 0, now, now)),
    env.DB.prepare("UPDATE families SET updated_at = ? WHERE id = ?").bind(now, id),
    auditStatement(env, viewer, "family.members.replace", "family", id, "", { members, updatedAt: now })
  ]);
  return json({ id, members, updatedAt: now });
}

async function deleteFamily(env, viewer, id) {
  requireViewerEdit(viewer);
  await assertFamilyAccess(env, viewer, id);
  const previous = await env.DB.prepare(
    "SELECT id, name, note FROM families WHERE id = ? AND church_id = ?"
  ).bind(id, currentChurchId(viewer)).first();
  if (!previous) throw httpError("가족을 찾을 수 없습니다", 404, "FAMILY_NOT_FOUND");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM families WHERE id = ? AND church_id = ?")
      .bind(id, currentChurchId(viewer)),
    auditStatement(env, viewer, "family.delete", "family", id, previous, "")
  ]);
  return json({ ok: true });
}

async function assertFamilyAccess(env, viewer, familyId) {
  const family = await env.DB.prepare(
    `SELECT id, created_by_user_id AS createdByUserId
     FROM families WHERE id = ? AND church_id = ?`
  ).bind(familyId, currentChurchId(viewer)).first();
  if (!family) throw httpError("가족을 찾을 수 없습니다", 404, "FAMILY_NOT_FOUND");
  if (viewerHasGlobalScope(viewer)) return;
  const rows = await env.DB.prepare(
    `SELECT member.cell_id AS cellId
     FROM family_members link JOIN members member ON member.id = link.member_id
     WHERE link.family_id = ?`
  ).bind(familyId).all();
  const memberCells = rows.results || [];
  const fullyVisible = memberCells.length
    ? memberCells.every((row) => viewerCanAccessCell(viewer, row.cellId))
    : family.createdByUserId === viewer.id;
  if (!fullyVisible) {
    throw httpError("가족 자료에 접근할 권한이 없습니다", 403, "FAMILY_SCOPE_DENIED");
  }
}

async function handleReports(request, env, viewer) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const url = new URL(request.url);
  const period = url.searchParams.get("period") === "week" ? "week" : "month";
  const anchor = normalizeDate(url.searchParams.get("anchor") || koreaDateString());
  const range = reportRange(period, anchor);
  return json(await buildCommunityReport(env, viewer, range, period));
}

async function buildCommunityReport(env, viewer, range, period) {
  const [cellsResult, membersResult, visitsResult, attendanceResult, tasksResult, prayersResult, assignmentsResult] = await Promise.all([
    env.DB.prepare(
      `SELECT id, name, sort_order AS sortOrder FROM cells
       WHERE church_id = ? ORDER BY sort_order, name`
    ).bind(currentChurchId(viewer)).all(),
    env.DB.prepare(
      `SELECT member.id, member.cell_id AS cellId, member.name,
        member.registered_at AS registeredAt
       FROM members member JOIN cells cell ON cell.id = member.cell_id
       WHERE cell.church_id = ? AND COALESCE(member.archived_at, '') = ''
         AND COALESCE(member.trashed_at, '') = ''`
    ).bind(currentChurchId(viewer)).all(),
    env.DB.prepare(
      `SELECT member_id AS memberId, visit_date AS visitDate
       FROM visit_notes WHERE visit_date BETWEEN ? AND ?`
    ).bind(range.startDate, range.endDate).all(),
    env.DB.prepare(
      `SELECT record.member_id AS memberId, record.attendance_status AS attendanceStatus,
        session.attendance_date AS attendanceDate
       FROM sunday_attendance_records record
       JOIN sunday_attendance_sessions session ON session.id = record.session_id
       WHERE session.church_id = ? AND session.attendance_date BETWEEN ? AND ?`
    ).bind(currentChurchId(viewer), range.startDate, range.endDate).all(),
    env.DB.prepare(
      `SELECT member_id AS memberId, status, due_date AS dueDate,
        created_at AS createdAt, completed_at AS completedAt
       FROM care_tasks
       WHERE due_date BETWEEN ? AND ? OR created_at BETWEEN ? AND ? OR completed_at BETWEEN ? AND ?`
    ).bind(
      range.startDate, range.endDate, range.startIso, range.endIso,
      range.startIso, range.endIso
    ).all(),
    env.DB.prepare(
      `SELECT member_id AS memberId, status, started_at AS startedAt,
        answered_at AS answeredAt
       FROM prayer_topics
       WHERE started_at BETWEEN ? AND ? OR answered_at BETWEEN ? AND ?`
    ).bind(range.startIso, range.endIso, range.startIso, range.endIso).all(),
    env.DB.prepare(
      `SELECT member_id AS memberId, status, due_date AS dueDate,
        created_at AS createdAt, completed_at AS completedAt
       FROM pastoral_assignments
       WHERE church_id = ? AND (
         due_date BETWEEN ? AND ? OR created_at BETWEEN ? AND ? OR completed_at BETWEEN ? AND ?
       )`
    ).bind(
      currentChurchId(viewer),
      range.startDate, range.endDate, range.startIso, range.endIso,
      range.startIso, range.endIso
    ).all()
  ]);
  const members = filterMembersForViewer(membersResult.results || [], viewer);
  const memberIds = new Set(members.map((member) => member.id));
  const cells = (cellsResult.results || []).filter((cell) => viewerCanAccessCell(viewer, cell.id));
  const visits = (visitsResult.results || []).filter((row) => memberIds.has(row.memberId));
  const attendance = (attendanceResult.results || []).filter((row) => memberIds.has(row.memberId));
  const tasks = (tasksResult.results || []).filter((row) => memberIds.has(row.memberId));
  const prayers = (prayersResult.results || []).filter((row) => memberIds.has(row.memberId));
  const assignments = (assignmentsResult.results || []).filter((row) => memberIds.has(row.memberId));
  const sessionDates = new Set(attendance.map((row) => row.attendanceDate));
  const presentMemberIds = new Set(attendance
    .filter((row) => row.attendanceStatus === "present" || row.attendanceStatus === "online")
    .map((row) => row.memberId));
  const absentRecords = attendance.filter((row) => row.attendanceStatus === "absent");
  const cellBreakdown = cells.map((cell) => {
    const ids = new Set(members.filter((member) => member.cellId === cell.id).map((member) => member.id));
    return {
      cellId: cell.id,
      cellName: cell.name,
      memberCount: ids.size,
      visitCount: visits.filter((row) => ids.has(row.memberId)).length,
      presentMemberCount: new Set(attendance
        .filter((row) => ids.has(row.memberId) && ["present", "online"].includes(row.attendanceStatus))
        .map((row) => row.memberId)).size,
      assignmentCompletedCount: assignments.filter((row) => ids.has(row.memberId) && row.status === "completed").length,
      assignmentOpenCount: assignments.filter((row) => ids.has(row.memberId) && !["completed", "cancelled"].includes(row.status)).length
    };
  });
  return {
    period,
    periodLabel: period === "week" ? "주간" : "월간",
    startDate: range.startDate,
    endDate: range.endDate,
    generatedAt: new Date().toISOString(),
    viewer: publicViewer(viewer),
    summary: {
      memberCount: members.length,
      newMemberCount: members.filter((member) => dateInRange(member.registeredAt, range)).length,
      visitCount: visits.length,
      visitedMemberCount: new Set(visits.map((row) => row.memberId)).size,
      attendanceSessionCount: sessionDates.size,
      presentMemberCount: presentMemberIds.size,
      absenceRecordCount: absentRecords.length,
      taskCreatedCount: tasks.filter((row) => isoInRange(row.createdAt, range)).length,
      taskCompletedCount: tasks.filter((row) => row.status === "completed" && isoInRange(row.completedAt, range)).length,
      prayerStartedCount: prayers.filter((row) => isoInRange(row.startedAt, range)).length,
      prayerAnsweredCount: prayers.filter((row) => row.status === "answered" && isoInRange(row.answeredAt, range)).length,
      assignmentCreatedCount: assignments.filter((row) => isoInRange(row.createdAt, range)).length,
      assignmentCompletedCount: assignments.filter((row) => row.status === "completed" && isoInRange(row.completedAt, range)).length,
      assignmentOpenCount: assignments.filter((row) => !["completed", "cancelled"].includes(row.status)).length
    },
    cellBreakdown
  };
}

function reportRange(period, anchor) {
  const date = new Date(`${anchor}T00:00:00Z`);
  let start;
  let end;
  if (period === "week") {
    const day = date.getUTCDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    start = new Date(date.getTime() + mondayOffset * 86400000);
    end = new Date(start.getTime() + 6 * 86400000);
  } else {
    start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  }
  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);
  return {
    startDate,
    endDate,
    startIso: `${startDate}T00:00:00.000Z`,
    endIso: `${endDate}T23:59:59.999Z`
  };
}

function dateInRange(value, range) {
  const date = clean(value).slice(0, 10);
  return DATE_PATTERN.test(date) && date >= range.startDate && date <= range.endDate;
}

function isoInRange(value, range) {
  const iso = clean(value);
  return iso && iso >= range.startIso && iso <= range.endIso;
}

function publicMemberReference(member) {
  return {
    id: clean(member.id || member.memberId),
    name: clean(member.name || member.memberName),
    title: clean(member.title),
    cellId: clean(member.cellId),
    cellName: clean(member.cellName),
    phone: clean(member.phone),
    photoUrl: member.photoKey ? `/api/photos/${encodeURIComponent(member.photoKey)}` : ""
  };
}

function publicUserAudit(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    canViewSensitive: Boolean(user.canViewSensitive),
    canEdit: Boolean(user.canEdit),
    status: user.status,
    cellIds: user.cellIds || [],
    createdAt: user.createdAt || "",
    updatedAt: user.updatedAt || ""
  };
}

async function createPasswordHash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(password || "")),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PASSWORD_ITERATIONS },
    key,
    256
  );
  return [PASSWORD_ALGORITHM, PASSWORD_ITERATIONS, base64Url(salt), base64Url(bits)].join("$");
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value || "")));
  return base64Url(digest);
}

function randomBase64Url(byteLength) {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function base64Url(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function normalizeDate(value) {
  const date = clean(value);
  if (!DATE_PATTERN.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw httpError("날짜 형식이 올바르지 않습니다", 400, "DATE_INVALID");
  }
  return date;
}

function normalizeOptionalDate(value) {
  return clean(value) ? normalizeDate(value) : "";
}

function normalizeFutureDateTime(value, fallback) {
  const timestamp = value ? Date.parse(String(value)) : fallback.getTime();
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    throw httpError("만료일은 현재보다 이후여야 합니다", 400, "EXPIRY_INVALID");
  }
  return new Date(timestamp).toISOString();
}

function normalizePhone(value) {
  return clean(value).replace(/\D/g, "").slice(0, 20);
}

function koreaDateString(date = new Date()) {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function nextIso(previous = "") {
  const now = Date.now();
  const previousTime = Date.parse(previous);
  return new Date(Number.isFinite(previousTime) ? Math.max(now, previousTime + 1) : now).toISOString();
}

function groupValues(rows, keyField, valueField) {
  const result = new Map();
  for (const row of rows) {
    const key = row[keyField];
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(row[valueField]);
  }
  return result;
}

function parseStringArray(value) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed.map(clean).filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function safeJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body : {};
  } catch {
    return {};
  }
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function auditStatement(env, viewer, action, entityType, entityId, before, after) {
  return env.DB.prepare(
    `INSERT INTO audit_logs (
      id, actor, action, entity_type, entity_id, before_json, after_json, church_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(), viewerAuditActor(viewer), action, entityType, entityId,
    before ? JSON.stringify(before) : "", after ? JSON.stringify(after) : "",
    currentChurchId(viewer)
  );
}

function currentChurchId(viewer) {
  return clean(viewer?.churchId) || "church-seosan";
}

function apiError(error) {
  const payload = { error: error?.message || "요청을 처리하지 못했습니다" };
  if (error?.code) payload.code = error.code;
  if (error?.details && typeof error.details === "object") Object.assign(payload, error.details);
  return json(payload, Number(error?.status || 500));
}

function httpError(message, status, code, details = null) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function truthy(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function clean(value) {
  return String(value || "").trim();
}
