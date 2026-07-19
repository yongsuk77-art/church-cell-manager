import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { onRequest as apiRequest } from "../functions/api/[[path]].js";
import { onRequest as middlewareRequest } from "../functions/_middleware.js";
import { DEFAULT_CHURCH_ID, readViewerById } from "../lib/community-access.js";

const USER_PASSWORD = "approved-user-password-1234";

test("existing data stays in Seosan while a new church starts empty", async () => {
  const sqlite = createDatabase();
  const env = createEnv(sqlite);
  try {
    const originalMemberCount = sqlite.prepare("SELECT COUNT(*) AS count FROM members").get().count;
    assert.ok(originalMemberCount > 0);
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS count FROM cells WHERE church_id <> ?").get(DEFAULT_CHURCH_ID).count,
      0
    );
    assert.equal(
      sqlite.prepare("SELECT name FROM churches WHERE id = ?").get(DEFAULT_CHURCH_ID).name,
      "\uC11C\uC0B0\uAD50\uD68C"
    );

    const owner = await readViewerById(env, "owner", DEFAULT_CHURCH_ID);
    const createResponse = await callApi(env, ["churches"], "POST", {
      name: "Integration Church",
      firstCellName: "Alpha Cell"
    }, owner);
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    assert.notEqual(created.church.id, DEFAULT_CHURCH_ID);
    assert.equal(created.cells.length, 3);

    const newChurchId = created.church.id;
    assert.equal(
      sqlite.prepare(
        `SELECT COUNT(*) AS count FROM members member
         JOIN cells cell ON cell.id = member.cell_id
         WHERE cell.church_id = ?`
      ).get(newChurchId).count,
      0
    );
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM members").get().count, originalMemberCount);

    const newChurchOwner = await readViewerById(env, "owner", newChurchId);
    const bootstrapResponse = await callApi(env, ["bootstrap"], "GET", undefined, newChurchOwner);
    assert.equal(bootstrapResponse.status, 200);
    const bootstrap = await bootstrapResponse.json();
    assert.equal(bootstrap.viewer.churchId, newChurchId);
    assert.equal(bootstrap.cells.length, 3);
    assert.deepEqual(bootstrap.members, []);
    assert.equal(bootstrap.noteCategories.length, 3);

    const seosanCategoryResponse = await callApi(env, ["note-categories"], "POST", {
      name: "Shared Category"
    }, owner);
    assert.equal(seosanCategoryResponse.status, 201);
    const seosanCategory = await seosanCategoryResponse.json();
    const newCategoryResponse = await callApi(env, ["note-categories"], "POST", {
      name: "Shared Category"
    }, newChurchOwner);
    assert.equal(newCategoryResponse.status, 201);
    const newCategory = await newCategoryResponse.json();
    assert.notEqual(newCategory.id, seosanCategory.id);

    const wrongCategoryNote = await callApi(env, ["notes"], "POST", {
      body: "Must remain in the selected church",
      categoryId: seosanCategory.id
    }, newChurchOwner);
    assert.equal(wrongCategoryNote.status, 400);
    assert.equal((await wrongCategoryNote.json()).code, "NOTE_CATEGORY_NOT_FOUND");
    const newChurchNote = await callApi(env, ["notes"], "POST", {
      body: "New church note",
      categoryId: newCategory.id
    }, newChurchOwner);
    assert.equal(newChurchNote.status, 201);
    assert.equal(
      sqlite.prepare("SELECT church_id AS churchId FROM notes WHERE id = ?").get((await newChurchNote.json()).id).churchId,
      newChurchId
    );
    assert.equal(
      sqlite.prepare("SELECT church_id AS churchId FROM audit_logs WHERE entity_id = ?").get(newCategory.id).churchId,
      newChurchId
    );

    sqlite.prepare(
      `INSERT INTO sunday_attendance_sessions
        (id, church_id, attendance_date, label, created_at, updated_at)
       VALUES (?, ?, '2026-07-19', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run("attendance-seosan", DEFAULT_CHURCH_ID);
    sqlite.prepare(
      `INSERT INTO sunday_attendance_sessions
        (id, church_id, attendance_date, label, created_at, updated_at)
       VALUES (?, ?, '2026-07-19', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run("attendance-new", newChurchId);
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS count FROM sunday_attendance_sessions WHERE attendance_date = '2026-07-19'").get().count,
      2
    );
  } finally {
    sqlite.close();
  }
});

test("a signup remains pending until an admin grants explicit cell access", async () => {
  const sqlite = createDatabase();
  const env = createEnv(sqlite);
  try {
    const seosanOwner = await readViewerById(env, "owner", DEFAULT_CHURCH_ID);
    const createResponse = await callApi(env, ["churches"], "POST", {
      name: "Permission Church",
      firstCellName: "Allowed Cell"
    }, seosanOwner);
    const created = await createResponse.json();
    const churchId = created.church.id;
    const cells = sqlite.prepare(
      "SELECT id, name FROM cells WHERE church_id = ? ORDER BY sort_order, name"
    ).all(churchId);
    assert.equal(cells.length, 3);

    sqlite.prepare(
      "INSERT INTO members (id, cell_id, name, phone) VALUES (?, ?, ?, ?)"
    ).run("allowed-member", cells[0].id, "Allowed Person", "010-1111-1111");
    sqlite.prepare(
      "INSERT INTO members (id, cell_id, name, phone) VALUES (?, ?, ?, ?)"
    ).run("blocked-member", cells[1].id, "Blocked Person", "010-2222-2222");

    const joinResponse = await callApi(env, ["public", "join"], "POST", {
      churchId,
      username: "shared.member",
      displayName: "Shared Member",
      password: USER_PASSWORD
    }, null);
    assert.equal(joinResponse.status, 201);
    assert.equal((await joinResponse.json()).status, "pending");

    const user = sqlite.prepare(
      "SELECT id FROM app_users WHERE username = 'shared.member'"
    ).get();
    assert.ok(user?.id);
    assert.equal(await readViewerById(env, user.id, churchId), null);

    const pendingLogin = await passwordLogin(env, "shared.member", USER_PASSWORD);
    assert.equal(pendingLogin.status, 401);

    const owner = await readViewerById(env, "owner", churchId);
    const usersResponse = await callApi(env, ["community", "users"], "GET", undefined, owner);
    assert.equal(usersResponse.status, 200);
    const managedUsers = (await usersResponse.json()).users;
    assert.equal(managedUsers.find((item) => item.id === user.id).status, "pending");

    const approvalResponse = await callApi(env, ["community", "users", user.id], "PATCH", {
      status: "active",
      role: "viewer",
      canViewSensitive: false,
      canEdit: false,
      cellIds: [cells[0].id]
    }, owner);
    assert.equal(approvalResponse.status, 200);

    const viewer = await readViewerById(env, user.id, churchId);
    assert.deepEqual(viewer.cellIds, [cells[0].id]);
    const approvedLogin = await passwordLogin(env, "shared.member", USER_PASSWORD);
    assert.equal(approvedLogin.status, 302);

    const bootstrapResponse = await callApi(env, ["bootstrap"], "GET", undefined, viewer);
    assert.equal(bootstrapResponse.status, 200);
    const bootstrap = await bootstrapResponse.json();
    assert.deepEqual(bootstrap.cells.map((cell) => cell.id), [cells[0].id]);
    assert.deepEqual(bootstrap.members.map((member) => member.id), ["allowed-member"]);
    assert.equal(bootstrap.members[0].phone, "");

    const blockedTimeline = await callApi(
      env, ["members", "blocked-member", "timeline"], "GET", undefined, viewer
    );
    assert.equal(blockedTimeline.status, 403);
    assert.equal((await blockedTimeline.json()).code, "MEMBER_SCOPE_DENIED");

    const switchData = {};
    const ownerLogin = await passwordLogin(env, "admin", env.SITE_PASSWORD);
    const ownerCookie = cookiePair(ownerLogin, "__Host-seosanch_cell_session");
    const switchResponse = await middlewareRequest({
      request: request("/__auth/church", "POST", { churchId }, { Cookie: ownerCookie }),
      env,
      data: switchData,
      next: async () => new Response("unused")
    });
    assert.equal(switchResponse.status, 200);
    assert.equal((await switchResponse.json()).churchId, churchId);
    assert.match(cookiePair(switchResponse, "__Host-seosanch_cell_session"), new RegExp(`:${churchId}:`));
  } finally {
    sqlite.close();
  }
});

function createDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  const directory = new URL("../migrations/", import.meta.url);
  const files = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) sqlite.exec(readFileSync(new URL(file, directory), "utf8"));
  return sqlite;
}

function createEnv(sqlite) {
  return {
    DB: d1Adapter(sqlite),
    SITE_PASSWORD: "owner-password-1234",
    SESSION_SECRET: "multi-church-session-secret-at-least-32-characters"
  };
}

function callApi(env, path, method, body, viewer) {
  return apiRequest({
    request: request(`/api/${path.join("/")}`, method, body),
    env,
    params: { path },
    data: {
      viewer,
      viewerRole: viewer?.role === "owner" || viewer?.role === "pastor" ? "admin" : undefined
    }
  });
}

function passwordLogin(env, username, password) {
  const form = new URLSearchParams({ username, password });
  return middlewareRequest({
    request: request("/__auth/login", "POST", form, {
      "Content-Type": "application/x-www-form-urlencoded"
    }),
    env,
    data: {},
    next: async () => new Response("unused")
  });
}

function request(path, method = "GET", body, extraHeaders = {}) {
  const headers = new Headers(extraHeaders);
  headers.set("CF-IPCountry", "KR");
  headers.set("CF-Connecting-IP", "203.0.113.89");
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
  const match = values.flatMap((value) => value.split(/,(?=\s*__Host-)/))
    .find((value) => value.trim().startsWith(`${name}=`));
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
