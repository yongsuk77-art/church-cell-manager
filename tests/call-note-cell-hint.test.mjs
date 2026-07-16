import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { onRequest } from "../functions/api/[[path]].js";

test("a genderless numeric cell hint is intersected with exact name and phone matches", async () => {
  const sqlite = createDatabase();
  const env = { DB: d1Adapter(sqlite), CALL_NOTE_TOKEN: "call-note-test-token" };
  try {
    const request = new Request("https://example.test/api/webhook/call-note", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Call-Note-Token": "call-note-test-token"
      },
      body: JSON.stringify({
        sourceId: "numeric-cell-hint-regression",
        name: "최춘화권사(여 3셀)",
        phone: "01024585837",
        cellHint: "3셀",
        summary: "안부 전화"
      })
    });
    const response = await onRequest({
      request,
      env,
      params: { path: ["webhook", "call-note"] },
      data: {}
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.status, "attached");
    assert.equal(body.memberId, "member-choi");
    assert.equal(body.matchReason, "name-cell");
    assert.equal(sqlite.prepare(
      "SELECT member_id AS memberId FROM visit_notes WHERE id = ?"
    ).get(body.visitId).memberId, "member-choi");
  } finally {
    sqlite.close();
  }
});

test("a genderless numeric cell hint never auto-attaches when every signal still matches two people", async () => {
  const sqlite = createDatabase();
  const env = { DB: d1Adapter(sqlite), CALL_NOTE_TOKEN: "call-note-test-token" };
  try {
    sqlite.prepare(
      `INSERT INTO members (id, cell_id, name, title, phone)
       VALUES (?, ?, ?, ?, ?)`
    ).run("member-duplicate", "male-3", "최춘화", "권사", "010-2458-5837");

    const request = new Request("https://example.test/api/webhook/call-note", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Call-Note-Token": "call-note-test-token"
      },
      body: JSON.stringify({
        sourceId: "numeric-cell-hint-ambiguous",
        name: "최춘화권사(3셀)",
        phone: "01024585837",
        cellHint: "3셀",
        summary: "동명이인 안전 확인"
      })
    });
    const response = await onRequest({
      request,
      env,
      params: { path: ["webhook", "call-note"] },
      data: {}
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.status, "needs_review");
    assert.equal(body.reason, "ambiguous-name-affiliation");
    assert.deepEqual(body.candidates.map((candidate) => candidate.id).sort(), [
      "member-choi",
      "member-duplicate"
    ]);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM visit_notes").get().count, 0);
  } finally {
    sqlite.close();
  }
});

function createDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE cells (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE members (
      id TEXT PRIMARY KEY,
      cell_id TEXT NOT NULL,
      name TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      home_phone TEXT NOT NULL DEFAULT '',
      archived_at TEXT NOT NULL DEFAULT '',
      trashed_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE managed_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE managed_group_members (
      group_id TEXT NOT NULL,
      member_id TEXT NOT NULL
    );
    CREATE TABLE call_note_imports (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL UNIQUE,
      member_id TEXT NOT NULL DEFAULT '',
      visit_id TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      cell_hint TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      candidate_members TEXT NOT NULL DEFAULT '[]',
      match_reason TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      resolved_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE visit_notes (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      visit_date TEXT NOT NULL,
      visit_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      prayer TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      raw_payload TEXT NOT NULL DEFAULT '',
      alarm_at TEXT NOT NULL DEFAULT '',
      alarm_state TEXT NOT NULL DEFAULT 'none',
      alarm_id TEXT NOT NULL DEFAULT '',
      dismissed_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY,
      actor TEXT DEFAULT '',
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      before_json TEXT DEFAULT '',
      after_json TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    INSERT INTO cells (id, name, sort_order) VALUES
      ('female-3', '여 3셀', 3),
      ('male-3', '남 3셀', 103),
      ('female-13', '여 13셀', 13);
    INSERT INTO members (id, cell_id, name, title, phone) VALUES
      ('member-choi', 'female-3', '최춘화', '권사', '010-2458-5837'),
      ('member-male-3', 'male-3', '다른사람', '집사', '010-3333-3333'),
      ('member-female-13', 'female-13', '최춘화', '권사', '010-1313-1313');
  `);
  return sqlite;
}

function d1Adapter(sqlite) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      const bound = [];
      return {
        bind(...values) {
          bound.splice(0, bound.length, ...values);
          return this;
        },
        async first() {
          return statement.get(...bound) || null;
        },
        async all() {
          return { results: statement.all(...bound) };
        },
        async run() {
          const result = statement.run(...bound);
          return { meta: { changes: Number(result.changes || 0) } };
        }
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
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
