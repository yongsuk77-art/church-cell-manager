import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { onRequest as apiRequest } from "../functions/api/[[path]].js";
import { DEFAULT_CHURCH_ID, readViewerById } from "../lib/community-access.js";

const USER_PASSWORD = "cell-manager-password-1234";

test("owner creates a cell, edits the birth-year label, and deletes an empty cell", async () => {
  const sqlite = createDatabase();
  const env = createEnv(sqlite);
  try {
    const owner = await readViewerById(env, "owner", DEFAULT_CHURCH_ID);
    const highest = sqlite.prepare(
      "SELECT COALESCE(MAX(sort_order), 0) AS maxOrder FROM cells WHERE church_id = ?"
    ).get(DEFAULT_CHURCH_ID).maxOrder;

    const createResponse = await callApi(env, ["cells"], "POST", {
      name: "청년 9셀",
      meta: "96-99년생",
      gender: "여자"
    }, owner);
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    const cellId = created.cell.id;
    assert.ok(cellId);
    assert.equal(created.cell.name, "청년 9셀");
    assert.equal(created.cell.meta, "96-99년생");
    assert.equal(created.cell.sortOrder, Number(highest) + 10);

    // The middleware rebuilds the viewer per request, so churchCellIds now include the new cell.
    const ownerAfterCreate = await readViewerById(env, "owner", DEFAULT_CHURCH_ID);
    const listResponse = await callApi(env, ["cells"], "GET", undefined, ownerAfterCreate);
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json();
    assert.equal(list.canManage, true);
    const listed = list.cells.find((cell) => cell.id === cellId);
    assert.ok(listed);
    assert.equal(listed.memberCount, 0);
    assert.equal(listed.protected, false);

    const patchResponse = await callApi(env, ["cells", cellId], "PATCH", {
      meta: "00-02년생",
      gender: ""
    }, owner);
    assert.equal(patchResponse.status, 200);
    const patched = (await patchResponse.json()).cell;
    assert.equal(patched.meta, "00-02년생");
    assert.equal(patched.gender, "");
    assert.equal(patched.name, "청년 9셀");
    assert.equal(
      sqlite.prepare("SELECT meta FROM cells WHERE id = ?").get(cellId).meta,
      "00-02년생"
    );

    const blankName = await callApi(env, ["cells", cellId], "PATCH", { name: "   " }, owner);
    assert.equal(blankName.status, 400);
    assert.equal((await blankName.json()).code, "CELL_NAME_REQUIRED");

    const deleteResponse = await callApi(env, ["cells", cellId], "DELETE", undefined, owner);
    assert.equal(deleteResponse.status, 200);
    assert.equal((await deleteResponse.json()).deleted, true);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM cells WHERE id = ?").get(cellId).count, 0);
  } finally {
    sqlite.close();
  }
});

test("bulk member move updates cells and keeps non-empty or system cells undeletable", async () => {
  const sqlite = createDatabase();
  const env = createEnv(sqlite);
  try {
    const owner = await readViewerById(env, "owner", DEFAULT_CHURCH_ID);
    const sourceCell = sqlite.prepare(
      "SELECT id FROM cells WHERE church_id = ? ORDER BY sort_order, name LIMIT 1"
    ).get(DEFAULT_CHURCH_ID);
    assert.ok(sourceCell?.id);
    sqlite.prepare("INSERT INTO members (id, cell_id, name, phone) VALUES (?, ?, ?, ?)")
      .run("cell-move-1", sourceCell.id, "김이동", "010-0000-0001");
    sqlite.prepare("INSERT INTO members (id, cell_id, name, phone) VALUES (?, ?, ?, ?)")
      .run("cell-move-2", sourceCell.id, "라이동", "010-0000-0002");

    const createResponse = await callApi(env, ["cells"], "POST", { name: "새 편성 셀" }, owner);
    assert.equal(createResponse.status, 201);
    const targetCellId = (await createResponse.json()).cell.id;

    const ownerAfterCreate = await readViewerById(env, "owner", DEFAULT_CHURCH_ID);

    const busyDelete = await callApi(env, ["cells", sourceCell.id], "DELETE", undefined, ownerAfterCreate);
    assert.equal(busyDelete.status, 409);
    assert.equal((await busyDelete.json()).code, "CELL_NOT_EMPTY");

    const moveResponse = await callApi(env, ["cells", "move-members"], "POST", {
      cellId: targetCellId,
      memberIds: ["cell-move-1", "cell-move-2", "cell-move-2"]
    }, ownerAfterCreate);
    assert.equal(moveResponse.status, 200);
    const moved = await moveResponse.json();
    assert.equal(moved.moved, 2);
    assert.equal(moved.cellId, targetCellId);
    assert.deepEqual(
      sqlite.prepare("SELECT cell_id AS cellId FROM members WHERE id IN ('cell-move-1', 'cell-move-2') ORDER BY id")
        .all()
        .map((row) => row.cellId),
      [targetCellId, targetCellId]
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'member.cell_move'").get().count,
      2
    );

    const repeatResponse = await callApi(env, ["cells", "move-members"], "POST", {
      cellId: targetCellId,
      memberIds: ["cell-move-1", "cell-move-2"]
    }, ownerAfterCreate);
    assert.equal(repeatResponse.status, 200);
    assert.equal((await repeatResponse.json()).moved, 0);

    const emptyBody = await callApi(env, ["cells", "move-members"], "POST", { cellId: targetCellId }, ownerAfterCreate);
    assert.equal(emptyBody.status, 400);
    assert.equal((await emptyBody.json()).code, "MEMBERS_REQUIRED");

    sqlite.prepare("UPDATE cells SET is_system = 1 WHERE id = ?").run(targetCellId);
    const systemDelete = await callApi(env, ["cells", targetCellId], "DELETE", undefined, ownerAfterCreate);
    assert.equal(systemDelete.status, 400);
    assert.equal((await systemDelete.json()).code, "PROTECTED_CELL");

    sqlite.prepare("DELETE FROM members WHERE id IN ('cell-move-1', 'cell-move-2')").run();
    sqlite.prepare("UPDATE cells SET is_system = 0 WHERE id = ?").run(targetCellId);
    const emptyDelete = await callApi(env, ["cells", targetCellId], "DELETE", undefined, ownerAfterCreate);
    assert.equal(emptyDelete.status, 200);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM cells WHERE id = ?").get(targetCellId).count, 0);
  } finally {
    sqlite.close();
  }
});

test("a cell leader without member management cannot create, edit, or delete cells", async () => {
  const sqlite = createDatabase();
  const env = createEnv(sqlite);
  try {
    const seosanOwner = await readViewerById(env, "owner", DEFAULT_CHURCH_ID);
    const createResponse = await callApi(env, ["churches"], "POST", {
      name: "Cell Management Church",
      firstCellName: "1셀"
    }, seosanOwner);
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    const churchId = created.church.id;
    const firstCellId = created.cells[0].id;

    sqlite.prepare("INSERT INTO members (id, cell_id, name, phone) VALUES (?, ?, ?, ?)")
      .run("leader-member", firstCellId, "박신도", "010-0000-0003");

    const joinResponse = await callApi(env, ["public", "join"], "POST", {
      churchId,
      username: "cell.leader",
      displayName: "Cell Leader",
      password: USER_PASSWORD
    }, null);
    assert.equal(joinResponse.status, 201);
    const user = sqlite.prepare("SELECT id FROM app_users WHERE username = 'cell.leader'").get();
    assert.ok(user?.id);

    const owner = await readViewerById(env, "owner", churchId);
    const approvalResponse = await callApi(env, ["community", "users", user.id], "PATCH", {
      status: "active",
      role: "cell_leader",
      canViewSensitive: false,
      canEdit: true,
      cellIds: [firstCellId]
    }, owner);
    assert.equal(approvalResponse.status, 200);

    const leader = await readViewerById(env, user.id, churchId);
    assert.equal(leader.canManageMembers, false);

    const listResponse = await callApi(env, ["cells"], "GET", undefined, leader);
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json();
    assert.equal(list.canManage, false);
    assert.deepEqual(list.cells.map((cell) => cell.id), [firstCellId]);

    const deniedCreate = await callApi(env, ["cells"], "POST", { name: "리더 셀" }, leader);
    assert.equal(deniedCreate.status, 403);
    assert.equal((await deniedCreate.json()).code, "CELL_MANAGEMENT_REQUIRED");

    const deniedPatch = await callApi(env, ["cells", firstCellId], "PATCH", { meta: "96-99년생" }, leader);
    assert.equal(deniedPatch.status, 403);
    assert.equal((await deniedPatch.json()).code, "CELL_MANAGEMENT_REQUIRED");

    const deniedDelete = await callApi(env, ["cells", firstCellId], "DELETE", undefined, leader);
    assert.equal(deniedDelete.status, 403);
    assert.equal((await deniedDelete.json()).code, "CELL_MANAGEMENT_REQUIRED");

    const newcomerCell = sqlite.prepare(
      "SELECT id FROM cells WHERE church_id = ? AND is_system = 1 ORDER BY sort_order LIMIT 1"
    ).get(churchId);
    assert.ok(newcomerCell?.id);
    const deniedMove = await callApi(env, ["cells", "move-members"], "POST", {
      cellId: newcomerCell.id,
      memberIds: ["leader-member"]
    }, leader);
    assert.equal(deniedMove.status, 403);
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
    SESSION_SECRET: "cell-management-session-secret-at-least-32-characters"
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

function request(path, method = "GET", body) {
  const headers = new Headers();
  headers.set("CF-IPCountry", "KR");
  headers.set("CF-Connecting-IP", "203.0.113.89");
  let requestBody = body;
  if (body) {
    headers.set("Content-Type", "application/json");
    requestBody = JSON.stringify(body);
  }
  return new Request(`https://church-cell-manager.pages.dev${path}`, {
    method,
    headers,
    body: requestBody
  });
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
