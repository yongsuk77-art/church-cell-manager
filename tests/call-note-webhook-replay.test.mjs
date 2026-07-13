import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { onRequest } from "../functions/api/[[path]].js";

const TOKEN = "call-note-replay-test-token";

test("a message still waiting in the unclassified inbox remains a duplicate", async () => {
  const fixture = createFixture();
  try {
    const payload = unmatchedPayload("replay-needs-review");
    const first = await sendWebhook(fixture.env, payload);
    const second = await sendWebhook(fixture.env, payload);

    assert.equal(first.response.status, 202);
    assert.equal(second.response.status, 200);
    assert.equal(second.body.duplicate, true);
    assert.equal(second.body.status, "needs_review");
    assert.equal(second.body.importId, first.body.importId);
    assert.deepEqual(rowCounts(fixture.sqlite), { imports: 1, visits: 0 });
  } finally {
    fixture.sqlite.close();
  }
});

test("a message with an existing linked visit remains a duplicate", async () => {
  const fixture = createFixture();
  try {
    const payload = matchedPayload("replay-live-visit");
    const first = await sendWebhook(fixture.env, payload);
    const second = await sendWebhook(fixture.env, payload);

    assert.equal(first.response.status, 201);
    assert.equal(second.response.status, 200);
    assert.equal(second.body.duplicate, true);
    assert.equal(second.body.status, "attached");
    assert.equal(second.body.importId, first.body.importId);
    assert.equal(second.body.visitId, first.body.visitId);
    assert.deepEqual(rowCounts(fixture.sqlite), { imports: 1, visits: 1 });
  } finally {
    fixture.sqlite.close();
  }
});

test("an ignored message without a visit can be received and matched again", async () => {
  const fixture = createFixture();
  try {
    const payload = {
      name: "재수신권사(여 3셀)",
      phone: "01077778888",
      cellHint: "3셀",
      visitDate: "2026-07-14",
      calledAt: "2026-07-14T10:30:00+09:00",
      summary: "무시한 뒤 다시 전송하는 동일 메시지"
    };
    const first = await sendWebhook(fixture.env, payload);
    assert.equal(first.response.status, 202);
    const ignored = await ignoreImport(fixture.env, first.body.importId);
    assert.equal(ignored.response.status, 200);
    assert.equal(ignored.body.status, "ignored");

    fixture.sqlite.prepare(
      `INSERT INTO members (id, cell_id, name, title, phone)
       VALUES (?, ?, ?, ?, ?)`
    ).run("member-received-again", "female-3", "재수신", "권사", "010-7777-8888");

    const replayed = await sendWebhook(fixture.env, payload);
    assert.equal(replayed.response.status, 201);
    assert.equal(replayed.body.status, "attached");
    assert.equal(replayed.body.duplicate, undefined);
    assert.equal(replayed.body.importId, first.body.importId);
    assert.equal(replayed.body.memberId, "member-received-again");
    assert.deepEqual(rowCounts(fixture.sqlite), { imports: 1, visits: 1 });
    const stored = fixture.sqlite.prepare(
      "SELECT status, visit_id AS visitId FROM call_note_imports WHERE id = ?"
    ).get(first.body.importId);
    assert.equal(stored.status, "attached");
    assert.equal(stored.visitId, replayed.body.visitId);
  } finally {
    fixture.sqlite.close();
  }
});

test("an ignored message that is still unmatched returns to the unclassified inbox", async () => {
  const fixture = createFixture();
  try {
    const payload = unmatchedPayload("replay-ignored-unmatched");
    const first = await sendWebhook(fixture.env, payload);
    await ignoreImport(fixture.env, first.body.importId);

    const replayed = await sendWebhook(fixture.env, payload);
    assert.equal(replayed.response.status, 202);
    assert.equal(replayed.body.status, "needs_review");
    assert.equal(replayed.body.duplicate, undefined);
    assert.equal(replayed.body.importId, first.body.importId);
    assert.deepEqual(rowCounts(fixture.sqlite), { imports: 1, visits: 0 });
  } finally {
    fixture.sqlite.close();
  }
});

test("an attached message can be received again after its visit was deleted", async () => {
  const fixture = createFixture();
  try {
    const payload = matchedPayload("replay-deleted-visit");
    const first = await sendWebhook(fixture.env, payload);
    assert.equal(first.response.status, 201);
    fixture.sqlite.prepare("DELETE FROM visit_notes WHERE id = ?").run(first.body.visitId);
    assert.deepEqual(rowCounts(fixture.sqlite), { imports: 1, visits: 0 });

    const replayed = await sendWebhook(fixture.env, payload);
    assert.equal(replayed.response.status, 201);
    assert.equal(replayed.body.status, "attached");
    assert.notEqual(replayed.body.visitId, first.body.visitId);
    assert.equal(replayed.body.importId, first.body.importId);
    assert.deepEqual(rowCounts(fixture.sqlite), { imports: 1, visits: 1 });
  } finally {
    fixture.sqlite.close();
  }
});

test("a live visit blocks replay even if the import status was marked ignored", async () => {
  const fixture = createFixture();
  try {
    const payload = matchedPayload("replay-ignored-with-live-visit");
    const first = await sendWebhook(fixture.env, payload);
    assert.equal(first.response.status, 201);
    fixture.sqlite.prepare(
      "UPDATE call_note_imports SET status = 'ignored' WHERE id = ?"
    ).run(first.body.importId);

    const second = await sendWebhook(fixture.env, payload);
    assert.equal(second.response.status, 200);
    assert.equal(second.body.duplicate, true);
    assert.equal(second.body.visitId, first.body.visitId);
    assert.deepEqual(rowCounts(fixture.sqlite), { imports: 1, visits: 1 });
  } finally {
    fixture.sqlite.close();
  }
});

test("concurrent resends after a deleted visit create exactly one replacement", async () => {
  const fixture = createFixture();
  try {
    const payload = matchedPayload("replay-concurrent-deleted-visit");
    const first = await sendWebhook(fixture.env, payload);
    fixture.sqlite.prepare("DELETE FROM visit_notes WHERE id = ?").run(first.body.visitId);

    const results = await Promise.all([
      sendWebhook(fixture.env, payload),
      sendWebhook(fixture.env, payload)
    ]);
    assert.deepEqual(results.map((result) => result.response.status).sort(), [200, 201]);
    assert.equal(results.filter((result) => result.body.duplicate === true).length, 1);
    assert.deepEqual(rowCounts(fixture.sqlite), { imports: 1, visits: 1 });
    const active = fixture.sqlite.prepare(
      "SELECT visit_id AS visitId FROM call_note_imports WHERE source_id = ?"
    ).get(payload.sourceId);
    assert.ok(active.visitId);
    assert.equal(
      fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM visit_notes WHERE id = ?")
        .get(active.visitId).count,
      1
    );
  } finally {
    fixture.sqlite.close();
  }
});

test("concurrent first deliveries also create exactly one import and one visit", async () => {
  const fixture = createFixture();
  try {
    const payload = matchedPayload("replay-concurrent-first-delivery");
    const results = await Promise.all([
      sendWebhook(fixture.env, payload),
      sendWebhook(fixture.env, payload)
    ]);

    assert.deepEqual(results.map((result) => result.response.status).sort(), [200, 201]);
    assert.equal(results.filter((result) => result.body.duplicate === true).length, 1);
    assert.deepEqual(rowCounts(fixture.sqlite), { imports: 1, visits: 1 });
  } finally {
    fixture.sqlite.close();
  }
});

function matchedPayload(sourceId) {
  return {
    sourceId,
    name: "최춘화권사(여 3셀)",
    phone: "01024585837",
    cellHint: "3셀",
    visitDate: "2026-07-14",
    summary: "같은 심방콜 메시지 재전송 확인"
  };
}

function unmatchedPayload(sourceId) {
  return {
    sourceId,
    name: "등록되지않은사람",
    phone: "01099990000",
    cellHint: "3셀",
    visitDate: "2026-07-14",
    summary: "미분류함 중복 확인"
  };
}

async function sendWebhook(env, payload) {
  const response = await onRequest({
    request: new Request("https://example.test/api/webhook/call-note", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Call-Note-Token": TOKEN
      },
      body: JSON.stringify(payload)
    }),
    env,
    params: { path: ["webhook", "call-note"] },
    data: {}
  });
  return { response, body: await response.json() };
}

async function ignoreImport(env, importId) {
  const response = await onRequest({
    request: new Request(`https://example.test/api/call-note-imports/${importId}/ignore`, {
      method: "POST"
    }),
    env,
    params: { path: ["call-note-imports", importId, "ignore"] },
    data: { viewerRole: "admin" }
  });
  return { response, body: await response.json() };
}

function rowCounts(sqlite) {
  return {
    imports: sqlite.prepare("SELECT COUNT(*) AS count FROM call_note_imports").get().count,
    visits: sqlite.prepare("SELECT COUNT(*) AS count FROM visit_notes").get().count
  };
}

function createFixture() {
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
      source_id TEXT NOT NULL DEFAULT '',
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
    CREATE UNIQUE INDEX idx_call_note_imports_source_id
      ON call_note_imports(source_id) WHERE source_id <> '';
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
      ('male-3', '남 3셀', 103);
    INSERT INTO members (id, cell_id, name, title, phone) VALUES
      ('member-choi', 'female-3', '최춘화', '권사', '010-2458-5837');
  `);
  return {
    sqlite,
    env: { DB: d1Adapter(sqlite), CALL_NOTE_TOKEN: TOKEN }
  };
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
