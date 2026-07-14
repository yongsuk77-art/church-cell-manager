import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appScript = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const memoScript = readFileSync(new URL("../public/memos.js", import.meta.url), "utf8");
const memoHtml = readFileSync(new URL("../public/memos.html", import.meta.url), "utf8");
const apiScript = readFileSync(new URL("../functions/api/[[path]].js", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/0019_keep_style_notes.sql", import.meta.url), "utf8");

test("the main page opens a dedicated memo page for toolbar, alarm, and member flows", () => {
  assert.match(appScript, /memoCenterBtn\.addEventListener\("click", \(\) => navigateToMemos\(\)\)/);
  assert.match(appScript, /navigateToMemos\(noteOpenButton\.dataset\.noteAlarmOpen\)/);
  assert.match(appScript, /navigateToMemos\("", member\.id, true\)/);
  assert.match(appScript, /new URL\("\/memos\.html", window\.location\.origin\)/);
});

test("the Keep-style page uses content-only editing and derives the title from the first line", () => {
  assert.match(memoHtml, /첫 줄이 제목이 됩니다/);
  assert.doesNotMatch(memoHtml, /id="(?:quick|editor)Title"/);
  assert.match(apiScript, /function deriveNoteTitle\(body\)/);
  assert.match(apiScript, /split\(\/\\r\?\\n\/\)\.find/);
  assert.match(apiScript, /const title = deriveNoteTitle\(noteBody\)/);
});

test("note colors, person links, reminders, and photo attachments are persisted features", () => {
  assert.match(migration, /ADD COLUMN color/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS note_attachments/);
  assert.match(memoScript, /const NOTE_COLORS = \[/);
  assert.match(memoScript, /memberScopeId/);
  assert.match(memoScript, /localDateTimeToIso/);
  assert.match(memoScript, /\/attachments/);
  assert.match(apiScript, /NOTE_ATTACHMENT_LIMIT = 8/);
  assert.match(apiScript, /color = \?/);
});

test("memo lists keep pinned notes first and otherwise sort newest updates first", () => {
  assert.match(apiScript, /FROM notes\s+ORDER BY pinned DESC, updated_at DESC\s+LIMIT \?/s);
  assert.match(
    memoScript,
    /function compareNotes\(a, b\) \{\s+if \(Boolean\(a\.pinned\) !== Boolean\(b\.pinned\)\) return a\.pinned \? -1 : 1;\s+return String\(b\.updatedAt \|\| ""\)\.localeCompare\(String\(a\.updatedAt \|\| ""\)\);\s+\}/s
  );
});
