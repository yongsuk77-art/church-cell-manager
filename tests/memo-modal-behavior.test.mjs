import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appScript = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const apiScript = readFileSync(new URL("../functions/api/[[path]].js", import.meta.url), "utf8");

test("memo lists keep pinned notes first and otherwise sort newest updates first", () => {
  assert.match(
    apiScript,
    /FROM notes\s+ORDER BY pinned DESC, updated_at DESC\s+LIMIT \?/s
  );
  assert.match(
    appScript,
    /function compareMemos\(a, b\) \{\s+if \(Boolean\(a\.pinned\) !== Boolean\(b\.pinned\)\) return a\.pinned \? -1 : 1;\s+return String\(b\.updatedAt \|\| ""\)\.localeCompare\(String\(a\.updatedAt \|\| ""\)\);\s+\}/s
  );
});

test("backdrop clicks never close data-entry dialogs", () => {
  const protectedModals = [
    "memoModal",
    "attendanceModal",
    "visitDatesModal",
    "visitRecordModal",
    "callNoteModal",
    "settingsModal",
    "groupMembersModal"
  ];
  for (const modal of protectedModals) {
    assert.doesNotMatch(appScript, new RegExp(`el\\.${modal}\\.addEventListener\\("click"`));
  }

  assert.match(appScript, /memoCloseBtn\.addEventListener\("click", closeMemoCenter\)/);
  assert.match(appScript, /settingsCloseBtn\.addEventListener\("click", closeSettings\)/);
  assert.match(appScript, /settingsCancelBtn\.addEventListener\("click", closeSettings\)/);
});

test("the memo dialog keeps keyboard focus trapped without treating Escape as an implicit close", () => {
  const handler = appScript.match(
    /function handleMemoModalKeydown\(event\) \{([\s\S]*?)\n\}/
  )?.[1] || "";
  assert.match(handler, /event\.key !== "Tab"/);
  assert.doesNotMatch(handler, /event\.key === "Escape"/);
  assert.doesNotMatch(handler, /closeMemoCenter\(\)/);
});
