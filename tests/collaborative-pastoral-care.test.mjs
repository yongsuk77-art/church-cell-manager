import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { onRequest as apiRequest } from "../functions/api/[[path]].js";
import { onRequest as middlewareRequest } from "../functions/_middleware.js";
import { readViewerById } from "../lib/community-access.js";

const PASSWORD = "staff-password-1234";

test("0030 preserves notification rows and adds collaborative care storage", () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  applyMigrations(sqlite, (name) => name < "0030");
  sqlite.prepare(
    `INSERT INTO call_note_devices (
      id, status, generation, credential_hmac, target_kind, target_ciphertext,
      target_fingerprint, target_revision, crypto_version, device_name,
      notification_permission, notifications_enabled, pair_code_id, paired_at,
      activated_at, last_registered_at, last_seen_at, updated_at, transport
     ) VALUES ('device-before', 'active', 1, 'h', 'registration_token', 'c', 'f', 1,
       1, 'phone', 'granted', 1, 'pair', '2026-07-01', '2026-07-01',
       '2026-07-01', '2026-07-01', '2026-07-01', 'webpush')`
  ).run();
  sqlite.prepare(
    `INSERT INTO call_note_push_deliveries (
      notification_id, dedupe_key, kind, reminder_id, note_id, visit_id,
      device_id, device_generation, scheduled_at, send_state, attempt_count,
      next_attempt_at, created_at, updated_at
     ) VALUES ('delivery-before', 'test-before', 'connection_test', '', '', '',
       'device-before', 1, '2026-07-01', 'accepted', 1, '2026-07-01',
       '2026-07-01', '2026-07-01')`
  ).run();

  sqlite.exec(readFileSync(new URL("../migrations/0030_collaborative_pastoral_care.sql", import.meta.url), "utf8"));
  const device = sqlite.prepare("SELECT user_id AS userId FROM call_note_devices WHERE id = 'device-before'").get();
  const delivery = sqlite.prepare("SELECT target_user_id AS userId, kind FROM call_note_push_deliveries WHERE notification_id = 'delivery-before'").get();
  assert.equal(device.userId, "owner");
  assert.deepEqual({ ...delivery }, { userId: "owner", kind: "connection_test" });
  for (const table of ["app_users", "pastoral_assignments", "newcomer_invites", "newcomer_submissions", "families", "family_members"]) {
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).count, 1);
  }
  sqlite.close();
});

test("staff scope, newcomer intake, family links, assignments, and reports work end to end", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  applyMigrations(sqlite);
  const env = {
    DB: d1Adapter(sqlite),
    SITE_PASSWORD: "owner-password-1234",
    SESSION_SECRET: "collaborative-care-session-secret-at-least-32"
  };
  const owner = { id: "owner", role: "owner", username: "admin", displayName: "관리자", canViewSensitive: true, canEdit: true, cellIds: [], status: "active" };
  const cell = sqlite.prepare("SELECT id, name FROM cells ORDER BY sort_order LIMIT 1").get();
  const member = sqlite.prepare("SELECT id, name FROM members WHERE cell_id = ? ORDER BY name LIMIT 1").get(cell.id);
  assert.ok(member);

  const createdUserResponse = await callApi(env, ["community", "users"], "POST", {
    username: "leader.one",
    displayName: "테스트 셀리더",
    password: PASSWORD,
    role: "cell_leader",
    canViewSensitive: false,
    canEdit: true,
    cellIds: [cell.id]
  }, owner);
  assert.equal(createdUserResponse.status, 201);
  const createdUser = (await createdUserResponse.json()).user;
  const viewer = await readViewerById(env, createdUser.id);
  assert.deepEqual(viewer.cellIds, [cell.id]);

  const bootstrapResponse = await callApi(env, ["bootstrap"], "GET", undefined, viewer);
  assert.equal(bootstrapResponse.status, 200);
  const bootstrap = await bootstrapResponse.json();
  assert.deepEqual(bootstrap.cells.map((item) => item.id), [cell.id]);
  assert.ok(bootstrap.members.length > 0);
  assert.ok(bootstrap.members.every((item) => item.cellId === cell.id));
  assert.ok(bootstrap.members.every((item) => item.phone === "" && item.address === ""));

  let forwardedViewer = null;
  const form = new URLSearchParams({ username: "leader.one", password: PASSWORD });
  const login = await middlewareRequest({
    request: request("/__auth/login", "POST", form, { "Content-Type": "application/x-www-form-urlencoded" }),
    env,
    data: {},
    next: async () => new Response("unused")
  });
  assert.equal(login.status, 302);
  const sessionCookie = cookiePair(login, "__Host-seosanch_cell_session");
  assert.ok(sessionCookie);
  const data = {};
  const forwarded = await middlewareRequest({
    request: request("/api/bootstrap", "GET", undefined, { Cookie: sessionCookie }),
    env,
    data,
    next: async () => {
      forwardedViewer = data.viewer;
      return Response.json({ ok: true });
    }
  });
  assert.equal(forwarded.status, 200);
  assert.equal(forwardedViewer.id, createdUser.id);
  assert.equal(data.viewerRole, undefined);

  const inviteResponse = await callApi(env, ["community", "newcomers", "invites"], "POST", {
    label: "통합 테스트 등록",
    maxSubmissions: 5
  }, owner);
  assert.equal(inviteResponse.status, 201);
  const invite = await inviteResponse.json();
  const publicGet = await callPublicApi(env, invite.token, "GET");
  assert.equal(publicGet.status, 200);
  const submissionResponse = await callPublicApi(env, invite.token, "POST", {
    name: "새가족 통합테스트",
    phone: "010-1234-5678",
    familyDetails: "가족 연결 테스트",
    consent: true
  });
  assert.equal(submissionResponse.status, 201);
  const submission = await submissionResponse.json();
  const approval = await callApi(env, ["community", "newcomers", "submissions", submission.submissionId], "PATCH", {
    action: "approve",
    cellId: cell.id,
    force: true
  }, owner);
  assert.equal(approval.status, 201);
  const approvedMemberId = (await approval.json()).memberId;
  assert.ok(sqlite.prepare("SELECT id FROM members WHERE id = ?").get(approvedMemberId));

  const familyResponse = await callApi(env, ["community", "families"], "POST", {
    name: "통합 테스트 가정",
    note: "가정 단위 돌봄"
  }, owner);
  assert.equal(familyResponse.status, 201);
  const family = await familyResponse.json();
  const familyMembers = await callApi(env, ["community", "families", family.id, "members"], "PUT", {
    members: [
      { memberId: member.id, relationship: "가족", isPrimary: true },
      { memberId: approvedMemberId, relationship: "가족", isPrimary: false }
    ]
  }, owner);
  assert.equal(familyMembers.status, 200);

  const assignmentResponse = await callApi(env, ["community", "assignments"], "POST", {
    memberId: member.id,
    assigneeUserId: createdUser.id,
    sourceKind: "manual",
    title: "안부 연락",
    dueDate: "2026-07-20"
  }, owner);
  assert.equal(assignmentResponse.status, 201);
  const assignment = await assignmentResponse.json();
  const delivery = sqlite.prepare(
    "SELECT kind, target_user_id AS targetUserId FROM call_note_push_deliveries WHERE reminder_id = ?"
  ).get(assignment.id);
  assert.deepEqual({ ...delivery }, { kind: "pastoral_assignment", targetUserId: createdUser.id });

  const reportResponse = await callApi(env, ["community", "reports"], "GET", undefined, owner, "?period=month&anchor=2026-07-19");
  assert.equal(reportResponse.status, 200);
  const report = await reportResponse.json();
  assert.equal(report.period, "month");
  assert.ok(report.summary.memberCount > 0);
  assert.ok(report.cellBreakdown.some((item) => item.cellId === cell.id));
  sqlite.close();
});

function applyMigrations(sqlite, predicate = () => true) {
  const directory = new URL("../migrations/", import.meta.url);
  const files = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort().filter(predicate);
  for (const file of files) sqlite.exec(readFileSync(new URL(file, directory), "utf8"));
}

function callApi(env, path, method, body, viewer, suffix = "") {
  const req = request(`/api/${path.join("/")}${suffix}`, method, body);
  return apiRequest({ request: req, env, params: { path }, data: { viewer } });
}

function callPublicApi(env, token, method, body) {
  return callApi(env, ["public", "newcomer", token], method, body, null);
}

function request(path, method = "GET", body, extraHeaders = {}) {
  const headers = new Headers(extraHeaders);
  headers.set("CF-IPCountry", "KR");
  headers.set("CF-Connecting-IP", "203.0.113.40");
  let requestBody = body;
  if (body && !(body instanceof URLSearchParams)) {
    headers.set("Content-Type", "application/json");
    requestBody = JSON.stringify(body);
  }
  return new Request(`https://church-cell-manager.pages.dev${path}`, {
    method,
    headers,
    body: requestBody
  });
}

function cookiePair(response, name) {
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("Set-Cookie") || ""];
  const match = values.flatMap((value) => value.split(/,(?=\s*__Host-)/)).find((value) => value.trim().startsWith(`${name}=`));
  return match ? match.trim().split(";", 1)[0] : "";
}

function d1Adapter(sqlite) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      const bound = [];
      const api = {
        bind(...values) {
          bound.splice(0, bound.length, ...values);
          return api;
        },
        async first() {
          return statement.get(...bound) || null;
        },
        async all() {
          return { results: statement.all(...bound) };
        },
        async run() {
          const result = statement.run(...bound);
          return { meta: { changes: Number(result.changes || 0), last_row_id: result.lastInsertRowid } };
        }
      };
      return api;
    },
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  };
}
