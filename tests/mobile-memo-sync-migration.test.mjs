import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migration = readFileSync(new URL("../migrations/0021_mobile_memo_sync.sql", import.meta.url), "utf8");
const trashMigration = readFileSync(new URL("../migrations/0022_note_trash_purge.sql", import.meta.url), "utf8");
const attachmentMigration = readFileSync(
  new URL("../migrations/0023_note_attachment_idempotency.sql", import.meta.url), "utf8"
);
const categoryMigration = readFileSync(
  new URL("../migrations/0024_persistent_note_categories.sql", import.meta.url), "utf8"
);
const editableCategoryMigration = readFileSync(
  new URL("../migrations/0025_editable_optional_note_categories.sql", import.meta.url), "utf8"
);

test("mobile memo sync migration backfills revisions and records upserts, soft deletes, and hard deletes", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL DEFAULT 'personal',
        pinned INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        remind_at TEXT NOT NULL DEFAULT '',
        reminder_state TEXT NOT NULL DEFAULT 'none',
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_notes_scheduled_reminders
        ON notes(remind_at)
        WHERE reminder_state = 'scheduled' AND status = 'active';
      INSERT INTO notes (id, updated_at) VALUES ('note-existing', '2026-07-01T00:00:00.000Z');
    `);

    sqlite.exec(migration);
    sqlite.exec(trashMigration);
    sqlite.exec(`
      CREATE TABLE note_attachments (
        id TEXT PRIMARY KEY,
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        object_key TEXT NOT NULL UNIQUE,
        file_name TEXT NOT NULL DEFAULT '',
        content_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);
    sqlite.exec(attachmentMigration);
    sqlite.exec(categoryMigration);
    sqlite.exec(editableCategoryMigration);

    const existing = { ...sqlite.prepare(
      "SELECT revision, deleted_at AS deletedAt FROM notes WHERE id = 'note-existing'"
    ).get() };
    assert.deepEqual(existing, { revision: 1, deletedAt: "" });
    assert.deepEqual(sqlite.prepare(
      "SELECT note_id AS noteId, revision, change_type AS type FROM note_sync_changes ORDER BY sequence"
    ).all().map((row) => ({ ...row })), [{ noteId: "note-existing", revision: 1, type: "upsert" }]);

    sqlite.prepare("INSERT INTO notes (id, category_id, updated_at) VALUES (?, 'personal', ?)")
      .run("note-live", "2026-07-02T00:00:00.000Z");
    sqlite.prepare("UPDATE notes SET revision = 2, deleted_at = ?, updated_at = ? WHERE id = ?")
      .run("2026-07-03T00:00:00.000Z", "2026-07-03T00:00:00.000Z", "note-existing");
    sqlite.prepare("DELETE FROM notes WHERE id = ?").run("note-live");

    const changes = sqlite.prepare(
      "SELECT note_id AS noteId, revision, change_type AS type FROM note_sync_changes ORDER BY sequence"
    ).all().map((row) => ({ ...row }));
    assert.deepEqual(changes, [
      { noteId: "note-existing", revision: 1, type: "upsert" },
      { noteId: "note-live", revision: 1, type: "upsert" },
      { noteId: "note-existing", revision: 2, type: "delete" },
      { noteId: "note-live", revision: 2, type: "delete" }
    ]);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM note_sync_changes WHERE note_id = 'note-live'").get().count, 2);

    const scheduledIndexSql = sqlite.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_notes_scheduled_reminders'"
    ).get().sql;
    assert.match(scheduledIndexSql, /deleted_at\s*=\s*''/i);
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('notes') WHERE name = 'purge_started_at'").get().count,
      1
    );
    const purgeIndexSql = sqlite.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_notes_trash_purge'"
    ).get().sql;
    assert.match(purgeIndexSql, /WHERE deleted_at <> ''/i);
    assert.equal(
      sqlite.prepare(
        "SELECT COUNT(*) AS count FROM pragma_table_info('note_attachments') WHERE name = 'client_attachment_id'"
      ).get().count,
      1
    );
    const attachmentIndexSql = sqlite.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_note_attachments_note_client_id'"
    ).get().sql;
    assert.match(attachmentIndexSql, /UNIQUE INDEX/i);
    assert.match(attachmentIndexSql, /WHERE client_attachment_id <> ''/i);
    assert.deepEqual(
      sqlite.prepare("SELECT id, name, is_system AS isSystem FROM note_categories ORDER BY rowid")
        .all().map((row) => ({ ...row })),
      [
        { id: "personal", name: "개인", isSystem: 1 },
        { id: "visitation", name: "심방", isSystem: 1 },
        { id: "admin", name: "행정", isSystem: 1 }
      ]
    );
    assert.equal(
      sqlite.prepare("SELECT category_id AS categoryId FROM notes WHERE id = 'note-existing'").get().categoryId,
      "personal"
    );
    assert.throws(
      () => sqlite.prepare("INSERT INTO notes (id, category_id, updated_at) VALUES ('invalid-category-note', 'missing', '2026-07-04T00:00:00.000Z')").run(),
      /NOTE_CATEGORY_INVALID/
    );
    const customCategoryId = "77777777-7777-4777-8777-777777777777";
    sqlite.prepare(
      `INSERT INTO note_categories (id, name, normalized_name, is_system, created_at, updated_at)
       VALUES (?, '기도', '기도', 0, '2026-07-04T00:00:00.000Z', '2026-07-04T00:00:00.000Z')`
    ).run(customCategoryId);
    sqlite.prepare(
      "INSERT INTO notes (id, category_id, updated_at) VALUES ('custom-category-note', ?, '2026-07-04T00:00:00.000Z')"
    ).run(customCategoryId);
    assert.throws(
      () => sqlite.prepare("DELETE FROM note_categories WHERE id = ?").run(customCategoryId),
      /NOTE_CATEGORY_IN_USE/
    );
    assert.throws(
      () => sqlite.prepare("DELETE FROM note_categories WHERE id = 'personal'").run(),
      /NOTE_CATEGORY_IN_USE/
    );
    sqlite.prepare("UPDATE notes SET category_id = '' WHERE category_id = 'personal'").run();
    sqlite.prepare("INSERT INTO notes (id, category_id, updated_at) VALUES ('uncategorized-note', '', '2026-07-05T00:00:00.000Z')").run();
    sqlite.prepare("UPDATE note_categories SET name = '개인 관리', normalized_name = '개인 관리' WHERE id = 'personal'").run();
    assert.equal(sqlite.prepare("SELECT name FROM note_categories WHERE id = 'personal'").get().name, "개인 관리");
    sqlite.prepare("DELETE FROM note_categories WHERE id = 'personal'").run();
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM note_categories WHERE id = 'personal'").get().count, 0);
    const optionalInsertTriggerSql = sqlite.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'notes_category_id_before_insert'"
    ).get().sql;
    assert.match(optionalInsertTriggerSql, /NEW\.category_id <> ''/i);
  } finally {
    sqlite.close();
  }
});
