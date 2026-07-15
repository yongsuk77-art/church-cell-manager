import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { onRequest } from "../functions/api/[[path]].js";
import { createMobileMemoAccessToken } from "../lib/mobile-memo-auth.js";

const SITE_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const NOTE_ID = "33333333-3333-4333-8333-333333333333";
const SECRET = "mobile-memo-test-secret-that-is-at-least-32-bytes";

test("mobile memo API supports secure CRUD, member lookup, photos, conflicts, and tombstone sync", async () => {
  const fixture = await createFixture();
  try {
    const directDeviceCredential = await apiRequest(fixture, ["notes"], "GET", undefined, {
      Authorization: "Bearer dvc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    });
    assert.equal(directDeviceCredential.status, 401);

    const createdResponse = await apiRequest(fixture, ["notes"], "POST", {
      id: NOTE_ID,
      body: "첫 줄 제목\n모바일에서 작성한 내용",
      color: "mint",
      memberId: "member-1"
    }, { "X-Actor": "spoofed-admin" });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.id, NOTE_ID);
    assert.equal(created.title, "첫 줄 제목");
    assert.equal(created.revision, 1);

    const actor = fixture.sqlite.prepare(
      "SELECT actor FROM audit_logs WHERE action = 'note.create' ORDER BY created_at DESC LIMIT 1"
    ).get().actor;
    assert.equal(actor, `device:${DEVICE_ID}`);

    const detail = await (await apiRequest(fixture, ["notes", NOTE_ID], "GET")).json();
    assert.equal(detail.body, created.body);
    assert.equal(detail.createdAt, created.createdAt);

    const updatedResponse = await apiRequest(fixture, ["notes", NOTE_ID], "PATCH", {
      expectedRevision: created.revision,
      body: "수정된 첫 줄\n최신 내용",
      color: "lavender"
    });
    assert.equal(updatedResponse.status, 200);
    const updated = await updatedResponse.json();
    assert.equal(updated.revision, 2);
    assert.equal(updated.createdAt, created.createdAt);

    const conflict = await apiRequest(fixture, ["notes", NOTE_ID], "PATCH", {
      expectedRevision: 1,
      body: "오래된 수정"
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).note.revision, 2);

    const memberSearch = await apiRequest(fixture, ["mobile", "members"], "GET", undefined, {}, "?query=소망&limit=20");
    assert.equal(memberSearch.status, 200);
    const memberPayload = await memberSearch.json();
    assert.equal(memberPayload.members.length, 1);
    assert.deepEqual(Object.keys(memberPayload.members[0]).sort(), [
      "cellId", "cellName", "groups", "id", "name", "photoUrl"
    ]);
    assert.deepEqual(memberPayload.members[0].groups, [{ id: "group-1", name: "소망구역" }]);

    const form = new FormData();
    form.append("photo", new File([new Uint8Array([9, 8, 7])], "memo.png", { type: "image/png" }));
    const uploadedResponse = await apiRequest(
      fixture,
      ["notes", NOTE_ID, "attachments"],
      "POST",
      form,
      { "If-Match": String(updated.revision) }
    );
    assert.equal(uploadedResponse.status, 201);
    const uploaded = await uploadedResponse.json();
    assert.equal(uploaded.revision, 3);
    assert.equal(uploaded.attachments.length, 1);

    const photoKey = uploaded.attachments[0].objectKey;
    const photoResponse = await apiRequest(
      fixture,
      ["photos", encodeURIComponent(photoKey)],
      "GET",
      undefined,
      {},
      `/api/photos/${encodeURIComponent(photoKey)}`
    );
    assert.equal(photoResponse.status, 200);
    assert.deepEqual([...new Uint8Array(await photoResponse.arrayBuffer())], [9, 8, 7]);

    const deletedResponse = await apiRequest(
      fixture,
      ["notes", NOTE_ID],
      "DELETE",
      undefined,
      { "If-Match": String(uploaded.revision) }
    );
    assert.equal(deletedResponse.status, 200);
    const deleted = await deletedResponse.json();
    assert.equal(deleted.revision, 4);
    assert.ok(deleted.deletedAt);
    assert.equal(fixture.r2.objects.size, 0);

    const retryDelete = await apiRequest(
      fixture,
      ["notes", NOTE_ID],
      "DELETE",
      undefined,
      { "If-Match": String(uploaded.revision) }
    );
    assert.equal(retryDelete.status, 200);
    assert.deepEqual(await retryDelete.json(), deleted);

    const list = await (await apiRequest(fixture, ["notes"], "GET")).json();
    assert.deepEqual(list.notes, []);
    assert.equal((await apiRequest(fixture, ["notes", NOTE_ID], "GET")).status, 404);

    const syncResponse = await apiRequest(
      fixture,
      ["mobile", "notes", "sync"],
      "GET",
      undefined,
      {},
      "?cursor=0&limit=100"
    );
    assert.equal(syncResponse.status, 200);
    const sync = await syncResponse.json();
    assert.equal(sync.hasMore, false);
    assert.equal(sync.changes.length, 4);
    assert.equal(sync.changes.at(-1).type, "delete");
    assert.deepEqual(sync.changes.at(-1).note, {
      id: NOTE_ID,
      revision: 4,
      updatedAt: deleted.updatedAt,
      deletedAt: deleted.deletedAt
    });
  } finally {
    fixture.sqlite.close();
  }
});

async function createFixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '');
    CREATE TABLE call_note_devices (id TEXT PRIMARY KEY, status TEXT NOT NULL, generation INTEGER NOT NULL);
    CREATE TABLE cells (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE members (
      id TEXT PRIMARY KEY,
      cell_id TEXT NOT NULL,
      name TEXT NOT NULL,
      photo_key TEXT NOT NULL DEFAULT '',
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
      member_id TEXT NOT NULL,
      PRIMARY KEY (group_id, member_id)
    );
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
      revision INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT NOT NULL DEFAULT '',
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
    CREATE TABLE note_sync_changes (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      change_type TEXT NOT NULL,
      changed_at TEXT NOT NULL
    );
    CREATE TRIGGER notes_sync_after_insert
    AFTER INSERT ON notes
    BEGIN
      INSERT INTO note_sync_changes (note_id, revision, change_type, changed_at)
      VALUES (NEW.id, NEW.revision, CASE WHEN NEW.deleted_at = '' THEN 'upsert' ELSE 'delete' END, NEW.updated_at);
    END;
    CREATE TRIGGER notes_sync_after_revision_update
    AFTER UPDATE OF revision ON notes
    WHEN NEW.revision <> OLD.revision
    BEGIN
      INSERT INTO note_sync_changes (note_id, revision, change_type, changed_at)
      VALUES (NEW.id, NEW.revision, CASE WHEN NEW.deleted_at = '' THEN 'upsert' ELSE 'delete' END, NEW.updated_at);
    END;
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
    INSERT INTO app_settings (key, value) VALUES ('notification.siteId', '${SITE_ID}');
    INSERT INTO call_note_devices (id, status, generation) VALUES ('${DEVICE_ID}', 'active', 1);
    INSERT INTO cells (id, name) VALUES ('cell-1', '사랑셀');
    INSERT INTO members (id, cell_id, name) VALUES ('member-1', 'cell-1', '김사랑');
    INSERT INTO managed_groups (id, name, sort_order) VALUES ('group-1', '소망구역', 1);
    INSERT INTO managed_group_members (group_id, member_id) VALUES ('group-1', 'member-1');
  `);
  const r2 = new MockR2Bucket();
  const env = { DB: d1Adapter(sqlite), PHOTOS: r2, NOTIFICATION_SECRET: SECRET };
  const token = await createMobileMemoAccessToken({
    env,
    siteId: SITE_ID,
    deviceId: DEVICE_ID,
    generation: 1
  });
  return { sqlite, r2, env, accessToken: token.accessToken };
}

async function apiRequest(fixture, path, method, body, headers = {}, suffix = "") {
  const isForm = body instanceof FormData;
  const pathname = suffix.startsWith("/api/") ? suffix : `/api/${path.join("/")}${suffix}`;
  const request = new Request(`https://example.test${pathname}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${fixture.accessToken}`,
      ...(body === undefined || isForm ? {} : { "Content-Type": "application/json" }),
      ...headers
    },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body)
  });
  return onRequest({ request, env: fixture.env, params: { path }, data: {} });
}

class MockR2Bucket {
  constructor() {
    this.objects = new Map();
  }

  async put(key, value, options) {
    const bytes = new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, { bytes, options });
  }

  async get(key) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      body: new Response(stored.bytes).body,
      httpEtag: '"test-etag"',
      writeHttpMetadata(headers) {
        headers.set("Content-Type", stored.options?.httpMetadata?.contentType || "application/octet-stream");
      }
    };
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
