import {
  DEFAULT_CHURCH_ID,
  normalizeUsername,
  requireOwner,
  requireViewer
} from "./community-access.js";

const PASSWORD_ALGORITHM = "pbkdf2-sha256";
const PASSWORD_ITERATIONS = 100000;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_BYTES = 128;
const CHURCH_NAME_MAX_LENGTH = 80;
const CELL_NAME_MAX_LENGTH = 80;

export async function handlePublicChurchApi({ request, env, path }) {
  try {
    if (request.method === "GET" && path[1] === "churches") {
      return json({ churches: await listJoinableChurches(env) });
    }
    if (request.method === "POST" && path[1] === "join") {
      return createJoinRequest(request, env);
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    return apiError(error);
  }
}

export async function handleChurchApi({ request, env, path, viewer }) {
  try {
    requireViewer(viewer);
    if (request.method === "GET" && path.length === 1) {
      return json({
        churchId: viewer.churchId,
        churchName: viewer.churchName,
        churches: viewer.churches || []
      });
    }
    if (request.method === "POST" && path.length === 1) {
      requireOwner(viewer);
      return createChurch(request, env, viewer);
    }
    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    return apiError(error);
  }
}

async function listJoinableChurches(env) {
  const rows = await env.DB.prepare(
    `SELECT id, name FROM churches
     WHERE status = 'active' AND join_enabled = 1
     ORDER BY created_at, name`
  ).all();
  return (rows.results || []).map((row) => ({ id: clean(row.id), name: clean(row.name) }));
}

async function createJoinRequest(request, env) {
  const body = await safeJson(request);
  const churchId = clean(body.churchId);
  const username = normalizeUsername(body.username);
  const displayName = clean(body.displayName).slice(0, 80);
  const password = String(body.password || "");
  validateJoinRequest({ churchId, username, displayName, password });

  const church = await env.DB.prepare(
    `SELECT id, name FROM churches
     WHERE id = ? AND status = 'active' AND join_enabled = 1`
  ).bind(churchId).first();
  if (!church) throw httpError("가입할 교회를 찾을 수 없습니다", 404, "CHURCH_NOT_FOUND");
  const exists = await env.DB.prepare(
    "SELECT id FROM app_users WHERE username = ? COLLATE NOCASE"
  ).bind(username).first();
  if (exists) throw httpError("이미 사용 중인 아이디입니다", 409, "USERNAME_EXISTS");

  const now = new Date().toISOString();
  const userId = crypto.randomUUID();
  const passwordHash = await createPasswordHash(password);
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO app_users (
          id, username, display_name, role, password_hash, can_view_sensitive,
          can_edit, status, last_church_id, created_at, updated_at
         ) VALUES (?, ?, ?, 'viewer', ?, 0, 0, 'active', ?, ?, ?)`
      ).bind(userId, username, displayName, passwordHash, churchId, now, now),
      env.DB.prepare(
        `INSERT INTO church_memberships (
          church_id, user_id, role, can_view_sensitive, can_edit, can_manage_members,
          status, requested_at, approved_at, approved_by_user_id, created_at, updated_at
         ) VALUES (?, ?, 'viewer', 0, 0, 0, 'pending', ?, '', '', ?, ?)`
      ).bind(churchId, userId, now, now, now)
    ]);
  } catch (error) {
    if (/unique/i.test(String(error?.message || ""))) {
      throw httpError("이미 사용 중인 아이디입니다", 409, "USERNAME_EXISTS");
    }
    throw error;
  }
  return json({
    ok: true,
    status: "pending",
    church: { id: church.id, name: church.name },
    message: "가입 신청이 접수되었습니다. 관리자가 셀과 권한을 승인하면 로그인할 수 있습니다."
  }, 201);
}

async function createChurch(request, env, viewer) {
  const body = await safeJson(request);
  const name = clean(body.name).slice(0, CHURCH_NAME_MAX_LENGTH);
  const firstCellName = clean(body.firstCellName || "1셀").slice(0, CELL_NAME_MAX_LENGTH);
  if (name.length < 2) throw httpError("교회 이름을 2자 이상 입력하세요", 400, "CHURCH_NAME_REQUIRED");
  if (!firstCellName) throw httpError("첫 셀 이름을 입력하세요", 400, "CELL_NAME_REQUIRED");

  const now = new Date().toISOString();
  const churchId = `church-${crypto.randomUUID()}`;
  const cells = [
    { id: crypto.randomUUID(), name: firstCellName, meta: "", gender: "", sortOrder: 10, isSystem: 0 },
    { id: crypto.randomUUID(), name: "새가족", meta: "", gender: "", sortOrder: 900, isSystem: 1 },
    { id: crypto.randomUUID(), name: "기타", meta: "", gender: "", sortOrder: 910, isSystem: 1 }
  ];
  const noteCategories = ["개인", "심방", "행정"].map((categoryName) => ({
    id: crypto.randomUUID().toLowerCase(),
    name: categoryName,
    normalizedName: categoryName
  }));
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO churches (
          id, name, status, join_enabled, created_by_user_id, created_at, updated_at
         ) VALUES (?, ?, 'active', 1, ?, ?, ?)`
      ).bind(churchId, name, viewer.id, now, now),
      env.DB.prepare(
        `INSERT INTO church_settings (church_id, key, value, updated_at)
         VALUES (?, 'app.communityTitle', ?, ?)`
      ).bind(churchId, `${name} 목양웹`, now),
      ...cells.map((cell) => env.DB.prepare(
        `INSERT INTO cells (
          id, name, meta, gender, sort_order, created_at, updated_at, church_id, is_system
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        cell.id, cell.name, cell.meta, cell.gender, cell.sortOrder,
        now, now, churchId, cell.isSystem
      )),
      ...noteCategories.map((category) => env.DB.prepare(
        `INSERT INTO note_categories (
          id, church_id, name, normalized_name, is_system, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 1, ?, ?)`
      ).bind(
        category.id, churchId, category.name, category.normalizedName, now, now
      ))
    ]);
  } catch (error) {
    if (/unique/i.test(String(error?.message || ""))) {
      throw httpError("이미 등록된 교회 이름입니다", 409, "CHURCH_NAME_EXISTS");
    }
    throw error;
  }
  return json({
    church: { id: churchId, name },
    cells: cells.map(({ id, name: cellName }) => ({ id, name: cellName })),
    switchRequired: true
  }, 201);
}

function validateJoinRequest({ churchId, username, displayName, password }) {
  if (!churchId) throw httpError("가입할 교회를 선택하세요", 400, "CHURCH_REQUIRED");
  if (!username || username.length < 3) {
    throw httpError("아이디는 영문·숫자로 3자 이상 입력하세요", 400, "USERNAME_INVALID");
  }
  if (username === "admin" || username === "owner") {
    throw httpError("사용할 수 없는 아이디입니다", 400, "USERNAME_RESERVED");
  }
  if (!displayName) throw httpError("이름을 입력하세요", 400, "DISPLAY_NAME_REQUIRED");
  validatePassword(password);
}

function validatePassword(password) {
  const value = String(password || "");
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw httpError("비밀번호는 12자 이상이어야 합니다", 400, "PASSWORD_TOO_SHORT");
  }
  if (new TextEncoder().encode(value).byteLength > MAX_PASSWORD_BYTES) {
    throw httpError("비밀번호가 너무 깁니다", 400, "PASSWORD_TOO_LONG");
  }
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

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    throw httpError("요청 형식이 올바르지 않습니다", 400, "INVALID_JSON");
  }
}

function base64Url(value) {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function json(payload, status = 200) {
  return Response.json(payload, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

function apiError(error) {
  const payload = { error: error.message || "Server error" };
  if (error.code) payload.code = error.code;
  return json(payload, error.status || 500);
}

function httpError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function clean(value) {
  return String(value || "").trim();
}

export { DEFAULT_CHURCH_ID };
