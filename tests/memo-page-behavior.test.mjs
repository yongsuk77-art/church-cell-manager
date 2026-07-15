import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appScript = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const memoScript = readFileSync(new URL("../public/memos.js", import.meta.url), "utf8");
const memoHtml = readFileSync(new URL("../public/memos.html", import.meta.url), "utf8");
const memoStyles = readFileSync(new URL("../public/memos.css", import.meta.url), "utf8");
const appHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const appStyles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const apiScript = readFileSync(new URL("../functions/api/[[path]].js", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/0019_keep_style_notes.sql", import.meta.url), "utf8");
const syncMigration = readFileSync(new URL("../migrations/0020_mobile_memo_sync.sql", import.meta.url), "utf8");
const trashMigration = readFileSync(new URL("../migrations/0021_note_trash_purge.sql", import.meta.url), "utf8");
const attachmentMigration = readFileSync(new URL("../migrations/0022_note_attachment_idempotency.sql", import.meta.url), "utf8");
const categoryMigration = readFileSync(new URL("../migrations/0023_persistent_note_categories.sql", import.meta.url), "utf8");
const notificationWorker = readFileSync(new URL("../workers/call-note-push/index.js", import.meta.url), "utf8");
const notificationConfig = readFileSync(new URL("../wrangler.notifications.jsonc", import.meta.url), "utf8");

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
  assert.match(apiScript, /SET deleted_at = \?, revision = \?, updated_at = \?/);
  assert.doesNotMatch(apiScript, /SET status = 'done'[^`]*deleted_at = \?/s);
  assert.match(memoScript, /NOTE_REFRESH_INTERVAL_MS = 60 \* 1000/);
  assert.match(memoScript, /refreshNotesQuietly/);
  assert.match(memoScript, /"If-Match": String\(note\.revision\)/);
});

test("memo trash preserves deleted notes for 30 days and supports conflict-safe restore", () => {
  assert.match(memoHtml, /data-filter="trash"/);
  assert.match(memoScript, /\/api\/notes\?view=trash/);
  assert.match(memoScript, /data-note-restore=/);
  assert.match(memoScript, /\/api\/notes\/\$\{encodeURIComponent\(note\.id\)\}\/restore/);
  assert.match(memoScript, /headers: \{ "If-Match": String\(note\.revision\) \}/);
  assert.match(apiScript, /path\[2\] === "restore"/);
  assert.match(apiScript, /async function listDeletedNotes/);
  assert.match(trashMigration, /ADD COLUMN purge_started_at/);
  assert.match(notificationWorker, /export async function purgeExpiredDeletedNotes/);
  assert.match(notificationWorker, /await env\.PHOTOS\.delete\(objectKeys\)/);
  assert.match(notificationConfig, /"binding": "PHOTOS"/);
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

test("memo member linking uses one-character live search instead of a long select drawer", () => {
  assert.match(memoHtml, /id="quickMemberId" type="hidden"/);
  assert.match(memoHtml, /id="editorMemberId" type="hidden"/);
  assert.equal((memoHtml.match(/placeholder="이름을 1글자부터 검색"/g) || []).length, 2);
  assert.match(memoScript, /function renderMemberSearchResults\(scope\)/);
  assert.match(memoScript, /\.includes\(query\)\)\.slice\(0, 50\)/);
  assert.match(memoScript, /이름을 1글자만 입력해도 바로 찾습니다/);
});

test("memo photos are resized before upload when over 2 MiB or 2048 pixels", () => {
  assert.match(memoScript, /PHOTO_RESIZE_THRESHOLD_BYTES = 2 \* 1024 \* 1024/);
  assert.match(memoScript, /PHOTO_MAX_EDGE = 2048/);
  assert.match(memoScript, /file\.size <= PHOTO_RESIZE_THRESHOLD_BYTES && longestEdge <= PHOTO_MAX_EDGE/);
  assert.match(memoScript, /PHOTO_RESIZE_MAX_PASSES = 10/);
  assert.match(memoScript, /Math\.sqrt\(PHOTO_TARGET_BYTES \/ blob\.size\)/);
  assert.match(memoScript, /if \(blob\.size > PHOTO_RESIZE_THRESHOLD_BYTES\)/);
  assert.match(memoScript, /prepared\.file\.size > PHOTO_RESIZE_THRESHOLD_BYTES/);
  assert.match(memoScript, /canvas\.toBlob/);
  assert.match(attachmentMigration, /client_attachment_id TEXT NOT NULL DEFAULT ''/);
  assert.match(attachmentMigration, /UNIQUE INDEX IF NOT EXISTS idx_note_attachments_note_client_id/);
  assert.match(memoScript, /자동 축소했습니다/);
});

test("quick memo photo retries continue the created note without duplicating completed uploads", () => {
  assert.match(memoScript, /quickPendingNoteId: ""/);
  assert.match(memoScript, /if \(state\.quickPendingNoteId\)/);
  assert.match(memoScript, /method: "PATCH"/);
  assert.match(memoScript, /state\.quickPendingNoteId = note\.id/);
  assert.match(memoScript, /while \(state\.quickFiles\.length\)/);
  assert.match(memoScript, /item\.clientAttachmentId !== pendingFile\.clientAttachmentId/);
  assert.match(memoScript, /state\.quickPendingNoteId = ""/);
});

test("web photo MIME fallback matches the server for unspecified browser types", () => {
  assert.match(memoScript, /PHOTO_UNSPECIFIED_TYPES = new Set\(\["", "application\/octet-stream", "text\/plain"\]\)/);
  assert.match(memoScript, /PHOTO_UNSPECIFIED_TYPES\.has\(declared\)/);
  assert.match(apiScript, /NOTE_ATTACHMENT_UNSPECIFIED_TYPES = new Set\(\["", "application\/octet-stream", "text\/plain"\]\)/);
});

test("persistent memo categories can be created, managed, and filtered immediately", () => {
  assert.match(memoHtml, /class="memo-nav-category-section"[\s\S]*id="categoryFilterBar"[\s\S]*data-filter="trash"/);
  assert.doesNotMatch(memoHtml, /<main class="memo-main">\s*<nav class="category-filter-bar"/);
  assert.equal((memoHtml.match(/>\+ 만들기<\/button>/g) || []).length, 2);
  assert.equal((memoHtml.match(/>더보기<\/button>/g) || []).length, 2);
  assert.match(memoScript, /apiRequest\("\/api\/note-categories"/);
  assert.match(memoScript, /data-delete-category=/);
  assert.match(memoScript, /NOTE_CATEGORY_IN_USE/);
  assert.match(memoScript, /note\.categoryId !== state\.categoryFilter/);
  assert.match(memoScript, /categoryId: el\.quickCategory\.value/);
  assert.match(memoScript, /categoryId: el\.editorCategory\.value/);
  assert.match(memoScript, /if \(state\.memberScopeId && note\.memberId !== state\.memberScopeId\) return false/);
  assert.match(memoScript, /if \(state\.categoryFilter && note\.categoryId !== state\.categoryFilter\) return false/);
  assert.match(memoScript, /state\.filter = "all";[\s\S]*renderNavigationState\(\)/);
  assert.match(memoScript, /state\.categoryFilter = "";[\s\S]*renderNavigationState\(\)/);
  assert.match(memoScript, /state\.noteCategories\.map\(\(category\) =>/);
  assert.match(memoScript, /renderPalettes\(\);\s*renderCategoryControls\(\);\s*updateQuickReminderControl\(\);/);
  assert.doesNotMatch(memoScript, /\[\{ id: "", name: "전체" \}, \.\.\.state\.noteCategories\]/);
  assert.match(memoStyles, /\.memo-nav-category-section \{[^}]*border-top:/);
  assert.match(memoStyles, /\.memo-nav-category-section, \.category-filter-bar \{ display: contents; \}/);
  assert.match(memoScript, /!state\.trashLoaded && !state\.trashRefreshing/);
  assert.match(memoScript, /category\.isSystem \|\| trashUnknown \|\| knownCount > 0/);
  assert.match(memoScript, /checkingTrash \? "확인 중"/);
  assert.match(categoryMigration, /CREATE TABLE IF NOT EXISTS note_categories/);
  assert.match(categoryMigration, /CREATE TRIGGER IF NOT EXISTS notes_category_id_before_insert/);
  assert.match(categoryMigration, /CREATE TRIGGER IF NOT EXISTS note_categories_in_use_before_delete/);
});

test("the quick photo control aligns with save and memo text areas have more writing room", () => {
  assert.match(memoHtml, /<div class="quick-actions">[\s\S]*id="quickPhotos"[\s\S]*id="quickSaveBtn"/);
  assert.match(memoStyles, /\.quick-actions \{ min-height: 44px; justify-content: space-between; \}/);
  assert.match(memoStyles, /\.quick-note\.expanded textarea \{ min-height: 220px; max-height: 420px; \}/);
  assert.match(memoStyles, /#editorBody \{[^}]*min-height: 300px/);
});

test("member search results show the saved profile photo with a safe initial fallback", () => {
  assert.match(memoScript, /function memoMemberPhotoUrl\(member\)/);
  assert.match(memoScript, /class="member-result-avatar"/);
  assert.match(memoScript, /data-member-photo src=/);
  assert.match(memoStyles, /\.member-result-avatar img \{[^}]*object-fit: cover/);
});

test("quick memo category and color controls share one row while reminder opens beside photos", () => {
  assert.match(memoHtml, /<div class="quick-style-row">[\s\S]*id="quickCategory"[\s\S]*id="quickPalette"/);
  assert.match(memoHtml, /id="quickPhotos"[\s\S]*id="quickReminderBtn"/);
  assert.match(memoHtml, /id="quickRemindAt" type="datetime-local"/);
  assert.match(memoScript, /function toggleQuickReminderPanel\(\)/);
  assert.match(memoScript, /showPicker\?\.\(\)/);
  assert.match(memoStyles, /\.quick-style-row \{[^}]*grid-template-columns:/);
});

test("saved reminders have a bell label and memo cards switch between grid and list layouts", () => {
  assert.match(memoScript, /class="meta-chip reminder-chip/);
  assert.match(memoScript, />알림 \$\{escapeHtml\(reminder\)\}<\/span>/);
  assert.match(memoHtml, /id="gridLayoutBtn"/);
  assert.match(memoHtml, /id="listLayoutBtn"/);
  assert.match(memoScript, /community\.memoLayout/);
  assert.match(memoScript, /classList\.toggle\("list-layout", list\)/);
  assert.match(memoStyles, /\.memo-grid\.list-layout \{[^}]*columns: 1/);
});
