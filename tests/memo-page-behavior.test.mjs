import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appScript = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const memoScript = readFileSync(new URL("../public/memos.js", import.meta.url), "utf8");
const memoHtml = readFileSync(new URL("../public/memos.html", import.meta.url), "utf8");
const appHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const appStyles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const apiScript = readFileSync(new URL("../functions/api/[[path]].js", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/0019_keep_style_notes.sql", import.meta.url), "utf8");
const syncMigration = readFileSync(new URL("../migrations/0020_mobile_memo_sync.sql", import.meta.url), "utf8");

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
  assert.match(apiScript, /FROM notes\s+WHERE deleted_at = ''\s+ORDER BY pinned DESC, updated_at DESC\s+LIMIT \?/s);
  assert.match(memoScript, /const \[field, direction\] = state\.sort\.split\("-"\)/);
  assert.match(memoScript, /field === "created" \? "createdAt" : "updatedAt"/);
  assert.match(memoHtml, /value="updated-desc">최근 수정순/);
  assert.match(memoHtml, /value="created-asc">오래된 작성순/);
});

test("memo changes use revisions, tombstones, incremental sync, and safe foreground refresh", () => {
  assert.match(syncMigration, /ADD COLUMN revision INTEGER NOT NULL DEFAULT 1/);
  assert.match(syncMigration, /ADD COLUMN deleted_at TEXT NOT NULL DEFAULT ''/);
  assert.match(syncMigration, /CREATE TABLE IF NOT EXISTS note_sync_changes/);
  assert.match(syncMigration, /notes_sync_after_revision_update/);
  assert.match(apiScript, /expectedRevision/);
  assert.match(apiScript, /handleMobileNoteSync/);
  assert.match(apiScript, /SET status = 'done'[^`]*deleted_at = \?/s);
  assert.match(memoScript, /NOTE_REFRESH_INTERVAL_MS = 60 \* 1000/);
  assert.match(memoScript, /refreshNotesQuietly/);
  assert.match(memoScript, /"If-Match": String\(note\.revision\)/);
});

test("notes expose an explicit edit action while keeping original and modified timestamps", () => {
  assert.match(memoScript, /data-note-edit=/);
  assert.match(memoScript, /작성 \$\{escapeHtml\(formatNoteTimestamp\(note\.createdAt\)\)\}/);
  assert.match(memoScript, /수정 \$\{escapeHtml\(formatNoteTimestamp\(note\.updatedAt\)\)\}/);
  assert.match(memoScript, /최초 작성/);
  assert.match(memoScript, /마지막 수정/);
});

test("the main memo navigation has a visually distinct new-page treatment", () => {
  assert.match(appHtml, /memo-center-copy"><strong>메모함<\/strong><small>새 페이지<\/small>/);
  assert.match(appStyles, /\.memo-center-button \{[\s\S]*linear-gradient\(135deg, #5e50c7/);
  assert.match(appStyles, /\.memo-center-arrow/);
});

test("memo member links consistently use church-member wording", () => {
  assert.match(memoHtml, /메모, 교인, 사진 검색/);
  assert.equal((memoHtml.match(/교인 연결/g) || []).length, 3);
  assert.doesNotMatch(memoHtml, /사람 연결/);
  assert.match(appHtml, /title="이 교인의 메모" aria-label="이 교인의 메모"/);
});
