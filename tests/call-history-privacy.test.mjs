import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { onRequest as apiRequest } from "../functions/api/[[path]].js";
import { DEFAULT_CHURCH_ID, readViewerById } from "../lib/community-access.js";

const USER_PASSWORD = "call-history-privacy-password-1234";

function koreaToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", dateStyle: "short" }).format(new Date());
}

test("visit history stays owner-only: leaders get empty visits and 403 on writes", async () => {
  const sqlite = createDatabase();
  const env = createEnv(sqlite);
  try {
    const owner = await readViewerById(env, "owner", DEFAULT_CHURCH_ID);
    const cell = sqlite.prepare(
      "SELECT id FROM cells WHERE church_id = ? ORDER BY sort_order, name LIMIT 1"
    ).get(DEFAULT_CHURCH_ID);
    assert.ok(cell?.id);
    sqlite.prepare("INSERT INTO members (id, cell_id, name, phone) VALUES (?, ?, ?, ?)")
      .run("privacy-member", cell.id, "최통화", "010-0000-0011");

    const joinResponse = await callApi(env, ["public", "join"], "POST", {
      churchId: DEFAULT_CHURCH_ID,
      username: "leader.one",
      displayName: "Leader One",
      password: USER_PASSWORD
    }, null);
    assert.equal(joinResponse.status, 201);
    const user = sqlite.prepare("SELECT id FROM app_users WHERE username = 'leader.one'").get();
    assert.ok(user?.id);
    const approvalResponse = await callApi(env, ["community", "users", user.id], "PATCH", {
      status: "active",
      role: "cell_leader",
      canViewSensitive: true,
      canEdit: true,
      cellIds: [cell.id]
    }, owner);
    assert.equal(approvalResponse.status, 200);

    // Owner records a call note and can read it back everywhere.
    const ownerCreate = await callApi(env, ["visit-notes"], "POST", {
      memberId: "privacy-member",
      visitDate: koreaToday(),
      visitType: "전화",
      summary: "통화내역 공개 범위 테스트"
    }, owner);
    assert.equal(ownerCreate.status, 201);
    const createdVisit = await ownerCreate.json();
    assert.ok(createdVisit?.id);

    const ownerBootstrap = await callApi(env, ["bootstrap"], "GET", undefined, owner);
    assert.equal(ownerBootstrap.status, 200);
    const ownerData = await ownerBootstrap.json();
    assert.ok(ownerData.visits.some((visit) => visit.id === createdVisit.id));

    const ownerTimeline = await callApi(env, ["members", "privacy-member", "timeline"], "GET", undefined, owner);
    assert.equal(ownerTimeline.status, 200);
    const ownerEvents = (await ownerTimeline.json()).events || [];
    assert.ok(ownerEvents.some((event) => event.kind === "visit"));

    const ownerDashboard = await callApi(env, ["dashboard"], "GET", undefined, owner);
    assert.equal(ownerDashboard.status, 200);
    const ownerCareGaps = (await ownerDashboard.json()).careGaps || [];
    assert.ok(!ownerCareGaps.some((member) => member.id === "privacy-member"));

    // The leader sees no visits even with full sensitive-data permissions.
    const leader = await readViewerById(env, user.id, DEFAULT_CHURCH_ID);
    assert.equal(leader.role, "cell_leader");
    assert.equal(leader.canViewSensitive, true);

    const leaderBootstrap = await callApi(env, ["bootstrap"], "GET", undefined, leader);
    assert.equal(leaderBootstrap.status, 200);
    const leaderData = await leaderBootstrap.json();
    assert.deepEqual(leaderData.visits, []);
    assert.ok(leaderData.members.some((member) => member.id === "privacy-member"));

    const leaderTimeline = await callApi(env, ["members", "privacy-member", "timeline"], "GET", undefined, leader);
    assert.equal(leaderTimeline.status, 200);
    const leaderEvents = (await leaderTimeline.json()).events || [];
    assert.ok(!leaderEvents.some((event) => event.kind === "visit"));

    const leaderDashboard = await callApi(env, ["dashboard"], "GET", undefined, leader);
    assert.equal(leaderDashboard.status, 200);
    const leaderDashboardData = await leaderDashboard.json();
    assert.deepEqual(leaderDashboardData.careGaps, []);

    const leaderCreate = await callApi(env, ["visit-notes"], "POST", {
      memberId: "privacy-member",
      visitDate: koreaToday(),
      visitType: "전화",
      summary: "리더의 통화 기록"
    }, leader);
    assert.equal(leaderCreate.status, 403);
    assert.equal((await leaderCreate.json()).code, "VISIT_OWNER_ONLY");

    const leaderPatch = await callApi(env, ["visit-notes", createdVisit.id], "PATCH", {
      summary: "리더가 고친 기록",
      expectedUpdatedAt: createdVisit.updatedAt
    }, leader);
    assert.equal(leaderPatch.status, 403);
    assert.equal((await leaderPatch.json()).code, "VISIT_OWNER_ONLY");

    const leaderDelete = await callApi(env, ["visit-notes", createdVisit.id], "DELETE", undefined, leader);
    assert.equal(leaderDelete.status, 403);
    assert.equal((await leaderDelete.json()).code, "VISIT_OWNER_ONLY");

    assert.equal(
      sqlite.prepare("SELECT summary FROM visit_notes WHERE id = ?").get(createdVisit.id).summary,
      "통화내역 공개 범위 테스트"
    );
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
    SESSION_SECRET: "call-history-privacy-session-secret-at-least-32-chars"
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
