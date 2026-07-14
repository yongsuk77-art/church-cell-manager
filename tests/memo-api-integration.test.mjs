import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { onRequest } from "../functions/api/[[path]].js";

test("content-only notes derive titles and persist color, person, and reminder data", async () => {
  const fixture = createFixture();
  try {
    const createdResponse = await apiRequest(fixture.env, ["notes"], "POST", {
      body: "첫 줄이 제목입니다\n두 번째 줄은 메모 내용입니다.",
      color: "sage",
      memberId: "member-1",
      remindAt: "2026-07-20T09:30:00+09:00",
      reminderState: "scheduled"
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.title, "첫 줄이 제목입니다");
    assert.equal(created.body, "첫 줄이 제목입니다\n두 번째 줄은 메모 내용입니다.");
    assert.equal(created.color, "sage");
    assert.equal(created.memberId, "member-1");
    assert.equal(created.remindAt, "2026-07-20T00:30:00.000Z");
    assert.equal(created.reminderState, "scheduled");
    assert.deepEqual(created.attachments, []);

    const updatedResponse = await apiRequest(fixture.env, ["notes", created.id], "PATCH", {
      expectedUpdatedAt: created.updatedAt,
      body: "바뀐 첫 줄\n새 내용",
      color: "lavender"
    });
    assert.equal(updatedResponse.status, 200);
    const updated = await updatedResponse.json();
    assert.equal(updated.title, "바뀐 첫 줄");
    assert.equal(updated.color, "lavender");
  } finally {
    fixture.sqlite.close();
  }
});

test("note photos stream through R2 and can be listed and removed", async () => {
  const fixture = createFixture();
  try {
    const created = await (await apiRequest(fixture.env, ["notes"], "POST", {
      body: "사진이 있는 메모",
      color: "blue"
    })).json();

    const form = new FormData();
    form.append("photo", new File([new Uint8Array([1, 2, 3, 4])], "방문 사진.png", { type: "image/png" }));
    const uploadedResponse = await apiRequest(fixture.env, ["notes", created.id, "attachments"], "POST", form);
    assert.equal(uploadedResponse.status, 201);
    const uploaded = await uploadedResponse.json();
    assert.equal(uploaded.attachments.length, 1);
    assert.equal(uploaded.attachments[0].contentType, "image/png");
    assert.equal(uploaded.attachments[0].byteSize, 4);
    assert.match(uploaded.attachments[0].url, /^\/api\/photos\//);
    assert.equal(fixture.r2.objects.size, 1);

    const listed = await (await apiRequest(fixture.env, ["notes"], "GET")).json();
    assert.equal(listed.notes[0].attachments.length, 1);

    const attachmentId = uploaded.attachments[0].id;
    const deletedResponse = await apiRequest(
      fixture.env,
      ["notes", created.id, "attachments", attachmentId],
      "DELETE"
    );
    assert.equal(deletedResponse.status, 200);
    assert.deepEqual((await deletedResponse.json()).attachments, []);
    assert.equal(fixture.r2.objects.size, 0);
  } finally {
    fixture.sqlite.close();
  }
});

test("deleting a note also removes its R2 photo objects", async () => {
  const fixture = createFixture();
  try {
    const created = await (await apiRequest(fixture.env, ["notes"], "POST", { body: "삭제할 메모" })).json();
    const form = new FormData();
    form.append("photo", new File(["image"], "photo.webp", { type: "image/webp" }));
    await apiRequest(fixture.env, ["notes", created.id, "attachments"], "POST", form);
    assert.equal(fixture.r2.objects.size, 1);

    const deleted = await apiRequest(fixture.env, ["notes", created.id], "DELETE");
    assert.equal(deleted.status, 200);
    assert.equal(fixture.r2.objects.size, 0);
    assert.equal(fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM notes").get().count, 0);
    assert.equal(fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM note_attachments").get().count, 0);
  } finally {
    fixture.sqlite.close();
  }
});

async function apiRequest(env, path, method, body) {
  const isForm = body instanceof FormData;
  const request = new Request(`https://example.test/api/${path.join("/")}`, {
    method,
    headers: body === undefined || isForm ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body)
  });
  return onRequest({ request, env, params: { path }, data: { viewerRole: "admin" } });
}

function createFixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE members (id TEXT PRIMARY KEY);
    CREATE TABLE managed_groups (id TEXT PRIMARY KEY);
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT 'default',
      pinned INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
      group_id TEXT REFERENCES managed_groups(id) ON DELETE SET NULL,
      remind_at TEXT NOT NULL DEFAULT '',
      reminder_state TEXT NOT NULL DEFAULT 'none',
      reminder_id TEXT NOT NULL DEFAULT '',
      dismissed_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE note_attachments (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      object_key TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL DEFAULT '',
      content_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
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
    INSERT INTO members (id) VALUES ('member-1');
    INSERT INTO managed_groups (id) VALUES ('group-1');
  `);
  const r2 = new MockR2Bucket();
  return { sqlite, r2, env: { DB: d1Adapter(sqlite), PHOTOS: r2 } };
}

class MockR2Bucket {
  constructor() {
    this.objects = new Map();
  }

  async put(key, value, options) {
    const bytes = new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, { bytes, options });
  }

  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
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
