import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migration = readFileSync(new URL("../migrations/0020_mobile_memo_sync.sql", import.meta.url), "utf8");

test("mobile memo sync migration backfills revisions and records upserts, soft deletes, and hard deletes", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
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

    const existing = { ...sqlite.prepare(
      "SELECT revision, deleted_at AS deletedAt FROM notes WHERE id = 'note-existing'"
    ).get() };
    assert.deepEqual(existing, { revision: 1, deletedAt: "" });
    assert.deepEqual(sqlite.prepare(
      "SELECT note_id AS noteId, revision, change_type AS type FROM note_sync_changes ORDER BY sequence"
    ).all().map((row) => ({ ...row })), [{ noteId: "note-existing", revision: 1, type: "upsert" }]);

    sqlite.prepare("INSERT INTO notes (id, updated_at) VALUES (?, ?)")
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
  } finally {
    sqlite.close();
  }
});
