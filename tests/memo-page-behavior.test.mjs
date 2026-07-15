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
const editableCategoryMigration = readFileSync(new URL("../migrations/0024_editable_optional_note_categories.sql", import.meta.url), "utf8");
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

test("pin controls use a clear upright pushpin icon in cards and the editor", () => {
  const uprightPinPath = /M9 3v6l-3 4v2h12v-2l-3-4V3/;
  assert.match(memoHtml, uprightPinPath);
  assert.match(memoScript, uprightPinPath);
  assert.doesNotMatch(memoHtml, /m14 4 6 6-3 1/);
  assert.doesNotMatch(memoScript, /m14 4 6 6-3 1/);
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
  assert.match(memoHtml, /id="trashEmptyBtn"[^>]*>전체 휴지통 비우기<\/button>/);
  assert.match(memoScript, /data-note-purge=/);
  assert.match(memoScript, /\/api\/notes\/\$\{encodeURIComponent\(note\.id\)\}\/permanent/);
  assert.match(memoScript, /apiRequest\("\/api\/notes\/trash", \{ method: "DELETE" \}\)/);
  assert.match(apiScript, /path\[1\] === "trash"/);
  assert.match(apiScript, /path\[2\] === "permanent"/);
  assert.match(apiScript, /async function permanentlyDeleteStoredNote/);
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

test("unclassified call notes appear below member links as a memo-style inbox", () => {
  const peoplePosition = memoHtml.indexOf('data-filter="people"');
  const callNotePosition = memoHtml.indexOf('data-filter="call-notes"');
  const categoryPosition = memoHtml.indexOf('class="memo-nav-category-section"');
  assert.ok(peoplePosition >= 0 && peoplePosition < callNotePosition && callNotePosition < categoryPosition);
  assert.match(memoHtml, /id="callNoteNavCount"/);
  assert.match(memoHtml, /id="callNoteSection"[\s\S]*id="callNoteGrid"/);
  assert.match(apiScript, /status: "needs_review"[\s\S]*candidates: match\.candidates/);
  assert.match(memoScript, /apiRequest\("\/api\/call-note-imports\?status=needs_review"/);
  assert.match(memoScript, /function renderCallNoteImports\(\)/);
  assert.match(memoScript, /data-call-note-action="attach"/);
  assert.doesNotMatch(memoScript, /<select data-call-note-member>/);
  assert.match(memoScript, /data-call-note-member-query/);
  assert.match(memoScript, /function renderCallNoteMemberSearchResults\(picker\)/);
  assert.match(memoScript, /data-call-note-member-result=/);
  assert.match(memoScript, /memoMemberPhotoUrl\(member\)/);
  assert.match(memoScript, /\/api\/call-note-imports\/\$\{encodeURIComponent\(id\)\}\/attach/);
  assert.match(memoScript, /\/api\/call-note-imports\/\$\{encodeURIComponent\(id\)\}\/ignore/);
  assert.match(memoScript, /새 미분류 콜노트가 들어오면 이곳에 자동으로 표시됩니다/);
  assert.match(memoStyles, /\.call-note-grid \{[^}]*grid-template-columns:/);
});

test("the memo header removes duplicate labels and uses a balanced refresh icon", () => {
  assert.doesNotMatch(memoHtml, /id="communityLabel"/);
  assert.doesNotMatch(memoHtml, /id="notesHeading"/);
  assert.match(memoHtml, /class="icon-action refresh-action"/);
  assert.match(memoHtml, /M21 12a9 9 0 0 0-15\.3-6\.4L3 8/);
  assert.match(memoStyles, /\.refresh-action \{[^}]*background: #edf4ef/);
  assert.match(memoStyles, /#notesSection \{ margin-top: 0; \}/);
});

test("memo member linking uses one-character live search instead of a long select drawer", () => {
  assert.match(memoHtml, /id="quickMemberId" type="hidden"/);
  assert.match(memoHtml, /id="editorMemberId" type="hidden"/);
  assert.equal((memoHtml.match(/aria-label="교인 이름 검색"/g) || []).length, 2);
  assert.doesNotMatch(memoHtml, /이름을 1글자부터 검색/);
  assert.match(memoScript, /function renderMemberSearchResults\(scope\)/);
  assert.match(memoScript, /\.includes\(query\)\)\.slice\(0, 50\)/);
  assert.doesNotMatch(memoScript, /이름을 1글자만 입력해도 바로 찾습니다/);
  assert.match(memoScript, /picker\.results\.replaceChildren\(\)/);
});

test("a linked member is shown in the search control with title and a clear action", () => {
  assert.doesNotMatch(memoHtml, /class="member-selection"/);
  assert.equal((memoHtml.match(/MemberClearBtn" type="button">해제/g) || []).length, 2);
  assert.match(memoScript, /member\?\.title \|\| ""/);
  assert.match(memoScript, /\$\{name\}\$\{memberTitle \? ` · \$\{memberTitle\}` : ""\}/);
  assert.match(memoScript, /searchButton\.classList\.toggle\("connected", Boolean\(member\)\)/);
  assert.match(memoScript, /searchButton\.disabled = Boolean\(member\)/);
  assert.match(memoStyles, /\.member-search-toggle\.connected/);
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
  assert.equal((memoHtml.match(/>분류 관리<\/button>/g) || []).length, 2);
  assert.doesNotMatch(memoHtml, />\+ 만들기<\/button>|>더보기<\/button>/);
  assert.match(memoScript, /apiRequest\("\/api\/note-categories"/);
  assert.match(memoScript, /data-update-category=/);
  assert.match(memoScript, /data-delete-category=/);
  assert.match(memoScript, /NOTE_CATEGORY_IN_USE/);
  assert.match(memoScript, /note\.categoryId !== state\.categoryFilter/);
  assert.match(memoScript, /categoryId: el\.quickCategory\.value,/);
  assert.match(memoScript, /categoryId: el\.editorCategory\.value,/);
  assert.match(memoScript, /<option value="">미분류<\/option>/);
  assert.match(memoScript, /el\.quickCategory\.value = ""/);
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
  assert.match(memoScript, /const protectedCategory = trashUnknown \|\| knownCount > 0/);
  assert.doesNotMatch(memoScript, /if \(!category \|\| category\.isSystem\) return/);
  assert.match(memoScript, /checkingTrash \? "확인 중"/);
  assert.match(categoryMigration, /CREATE TABLE IF NOT EXISTS note_categories/);
  assert.match(categoryMigration, /CREATE TRIGGER IF NOT EXISTS notes_category_id_before_insert/);
  assert.match(categoryMigration, /CREATE TRIGGER IF NOT EXISTS note_categories_in_use_before_delete/);
  assert.match(editableCategoryMigration, /DROP TRIGGER IF EXISTS note_categories_system_before_delete/);
  assert.match(editableCategoryMigration, /WHEN NEW\.category_id <> ''/);
  assert.match(apiScript, /request\.method === "PATCH" && path\.length === 2/);
  assert.match(apiScript, /function normalizeOptionalNoteCategoryId\(value\)/);
});

test("the quick photo control aligns with save and memo text areas have more writing room", () => {
  assert.match(memoHtml, /<div class="quick-actions">[\s\S]*id="quickPhotos"[\s\S]*id="quickSaveBtn"/);
  assert.match(memoStyles, /\.quick-actions \{[^}]*justify-content: space-between;[^}]*margin-top: 18px/);
  assert.match(memoStyles, /\.quick-note\.expanded textarea \{ min-height: 220px; max-height: 420px; \}/);
  assert.match(memoStyles, /@media \(max-width: 820px\)[\s\S]*?\.quick-note\.expanded textarea \{ min-height: 124px; max-height: 280px; \}/);
  assert.match(memoStyles, /#editorBody \{[^}]*min-height: 120px;[^}]*resize: none;[^}]*overflow-y: hidden/);
  assert.match(memoScript, /const naturalHeight = textarea\.scrollHeight;[\s\S]*naturalHeight > maxHeight \? "auto" : "hidden"/);
});

test("the retired group connection control is absent from the memo editor", () => {
  assert.doesNotMatch(memoHtml, /그룹 연결|editorGroupId/);
  assert.doesNotMatch(memoScript, /editorGroupId|groupById\(/);
});

test("the old main-page call-note envelope and modal are removed", () => {
  assert.doesNotMatch(appHtml, /callNoteInboxBtn|callNoteModal|call-note-inbox-button/);
  assert.doesNotMatch(appScript, /callNoteInboxBtn|callNoteModal|loadCallNoteImports/);
});

test("the editor uses a natural content height and the requested desktop and mobile action rows", () => {
  assert.doesNotMatch(memoHtml, /<label class="field"><span>알림<\/span>/);
  assert.match(memoHtml, /class="editor-tools editor-media-tools">[\s\S]*id="editorPhotos"[\s\S]*id="editorReminderBtn"[\s\S]*id="editorMemberPicker"/);
  assert.match(memoHtml, /id="editorReminderBtn"[^>]*aria-label="알림 설정"[\s\S]*id="editorReminderPanel"[\s\S]*id="editorRemindAt"/);
  assert.match(memoHtml, /class="editor-style-row">[\s\S]*id="editorCategory"[\s\S]*id="editorPalette"/);
  assert.match(memoHtml, /class="editor-commit-row">[\s\S]*id="editorDeleteBtn"[\s\S]*id="editorSaveBtn"/);
  assert.doesNotMatch(memoHtml, /class="editor-commit-row">[\s\S]*id="editorMemberPicker"/);
  assert.match(memoScript, /function toggleEditorReminderPanel\(\)/);
  assert.match(memoScript, /function updateEditorReminderControl\(\)/);
  assert.match(memoStyles, /\.editor-scroll-area \{[^}]*overflow-y: auto/);
  assert.match(memoStyles, /\.editor-footer \{[^}]*flex: 0 0 auto/);
  assert.match(memoStyles, /\.note-editor \{[^}]*height: auto;[^}]*max-height: min\(860px, calc\(100dvh - 30px\)\)/);
  assert.match(memoStyles, /\.editor-footer \{[^}]*align-items: center;[^}]*gap: 8px/);
  assert.match(memoStyles, /\.editor-media-tools \{[^}]*flex: 1 1 auto/);
  assert.match(memoStyles, /\.editor-commit-row \{[^}]*width: auto;[^}]*justify-content: flex-end/);
  assert.match(memoStyles, /\.editor-photo-action \{[^}]*background: #dff1f8/);
  assert.match(memoStyles, /\.editor-reminder-action \{[^}]*background: #eceeef/);
  assert.match(memoStyles, /\.editor-reminder-action\.active \{[^}]*background: #ffe79a/);
  assert.match(memoStyles, /\.editor-footer-member \{[^}]*flex: 1 1 260px/);
  assert.match(memoStyles, /@media \(max-width: 820px\)[\s\S]*?\.editor-footer \{[^}]*flex-direction: column/);
  assert.match(memoStyles, /@media \(max-width: 820px\)[\s\S]*?\.editor-media-tools \{[^}]*width: 100%/);
  assert.match(memoStyles, /@media \(max-width: 820px\)[\s\S]*?\.editor-commit-row \{[^}]*width: 100%;[^}]*justify-content: flex-end/);
  assert.match(memoStyles, /\.editor-file-summary:empty \{ display: none; \}/);
});

test("member search popovers match their controls and completion returns to the list", () => {
  assert.match(memoStyles, /\.quick-member-inline \.member-search-panel \{[^}]*left: 0;[^}]*right: 0;[^}]*width: 100%;[^}]*max-width: 100%/);
  assert.match(memoStyles, /\.editor-footer-member \.member-search-panel \{[^}]*left: 0;[^}]*right: 0;[^}]*width: 100%;[^}]*max-width: 100%/);
  assert.match(memoStyles, /\.editor-footer-member \.member-search-results \{[^}]*max-height: min\(190px, 32dvh\)/);
  assert.match(memoHtml, /id="editorSaveBtn" type="button">완료<\/button>/);
  assert.match(memoScript, /editorSaveBtn\.addEventListener\("click", \(\) => void saveEditor\(\{ close: true \}\)\)/);
  assert.match(memoScript, /if \(close\) closeEditor\(\)/);
});

test("the desktop memo sidebar is wide enough for the unclassified call-note label", () => {
  assert.match(memoStyles, /\.memo-layout \{[^}]*grid-template-columns: 250px minmax\(0, 1fr\)/);
  assert.match(memoStyles, /@media \(max-width: 820px\)[\s\S]*?\.memo-layout \{ display: block; \}/);
});

test("member search results show the saved profile photo with a safe initial fallback", () => {
  assert.match(memoScript, /function memoMemberPhotoUrl\(member\)/);
  assert.match(memoScript, /class="member-result-avatar"/);
  assert.match(memoScript, /data-member-photo src=/);
  assert.match(memoStyles, /\.member-result-avatar img \{[^}]*object-fit: cover/);
});

test("quick memo category and color controls share one row while reminder opens beside photos", () => {
  assert.match(memoHtml, /<div class="quick-style-row">[\s\S]*id="quickCategory"[\s\S]*id="quickPalette"/);
  assert.match(memoHtml, /id="quickPhotos"[\s\S]*id="quickReminderBtn"[\s\S]*id="quickMemberPicker"/);
  assert.match(memoHtml, /id="quickRemindAt" type="datetime-local"/);
  assert.match(memoScript, /function toggleQuickReminderPanel\(\)/);
  assert.match(memoScript, /showPicker\?\.\(\)/);
  assert.match(memoStyles, /\.quick-style-row \{[^}]*grid-template-columns:/);
  assert.match(memoStyles, /\.quick-member-inline \{[^}]*width: 33\.333%/);
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
