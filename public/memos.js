const NOTE_COLORS = [
  { id: "default", label: "기본", css: "#ffffff" },
  { id: "coral", label: "산호", css: "#ffd8d2" },
  { id: "peach", label: "복숭아", css: "#ffe3c3" },
  { id: "yellow", label: "노랑", css: "#fff3ad" },
  { id: "sage", label: "연두", css: "#dcecc8" },
  { id: "mint", label: "민트", css: "#cceee4" },
  { id: "blue", label: "하늘", css: "#d7e8fb" },
  { id: "lavender", label: "라벤더", css: "#e8ddf8" },
  { id: "pink", label: "분홍", css: "#f6dcec" },
  { id: "gray", label: "회색", css: "#e8e8e5" }
];
const NOTE_COLOR_IDS = new Set(NOTE_COLORS.map((color) => color.id));
const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
const PHOTO_LIMIT = 8;
const SESSION_REFRESH_INTERVAL_MS = 4 * 60 * 1000;

const state = {
  notes: [],
  members: [],
  groups: [],
  filter: "all",
  query: "",
  memberScopeId: "",
  quickColor: "default",
  quickFiles: [],
  editingId: "",
  editorColor: "default",
  editorFiles: [],
  editorDirty: false,
  editorReminderDirty: false,
  editorSaving: false,
  loading: true,
  lastSessionRefreshAt: 0,
  toastTimer: 0
};

const el = {};
[
  "communityLabel", "searchInput", "refreshBtn", "topNewBtn", "memberScope", "memberScopeLabel",
  "memberScopeClearBtn", "quickNote", "quickBody", "quickExpanded", "quickMemberId", "quickRemindAt",
  "quickPalette", "quickPhotos", "quickFileSummary", "quickCancelBtn", "quickSaveBtn", "loadingState",
  "pinnedSection", "pinnedGrid", "notesSection", "notesHeading", "notesGrid", "emptyState",
  "editorDialog", "editorForm", "editorHeading", "editorCloseBtn", "editorPinned", "editorPhotoGrid",
  "editorBody", "editorMemberId", "editorGroupId", "editorRemindAt", "editorCategory", "editorPalette",
  "editorFileSummary", "editorPhotos", "editorArchiveBtn", "editorDeleteBtn", "editorSaveBtn", "toast"
].forEach((id) => { el[id] = document.getElementById(id); });

bindEvents();
renderPalettes();
loadWorkspace();

function bindEvents() {
  el.searchInput.addEventListener("input", () => {
    state.query = el.searchInput.value.trim().toLocaleLowerCase("ko-KR");
    renderNotes();
  });
  el.refreshBtn.addEventListener("click", () => loadWorkspace(true));
  el.topNewBtn.addEventListener("click", () => openQuickComposer(true));
  el.quickNote.addEventListener("click", () => openQuickComposer(false));
  el.quickBody.addEventListener("focus", () => openQuickComposer(false));
  el.quickBody.addEventListener("input", () => autoResize(el.quickBody));
  el.quickCancelBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    resetQuickComposer();
  });
  el.quickSaveBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    saveQuickNote();
  });
  el.quickPhotos.addEventListener("change", () => {
    state.quickFiles = validSelectedPhotos(el.quickPhotos.files, 0);
    renderFileSummary(el.quickFileSummary, state.quickFiles);
  });
  el.quickPalette.addEventListener("click", (event) => {
    const button = event.target.closest("[data-note-color]");
    if (!button) return;
    event.stopPropagation();
    state.quickColor = button.dataset.noteColor;
    applyQuickColor();
  });

  document.querySelector(".memo-nav").addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) return;
    state.filter = button.dataset.filter;
    state.memberScopeId = "";
    document.querySelectorAll("[data-filter]").forEach((item) => item.classList.toggle("active", item === button));
    renderMemberScope();
    renderNotes();
  });
  el.memberScopeClearBtn.addEventListener("click", () => {
    state.memberScopeId = "";
    renderMemberScope();
    renderNotes();
  });
  el.pinnedGrid.addEventListener("click", handleGridClick);
  el.notesGrid.addEventListener("click", handleGridClick);

  el.editorForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveEditor({ close: true });
  });
  el.editorCloseBtn.addEventListener("click", closeEditorSafely);
  el.editorDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeEditorSafely();
  });
  el.editorDialog.addEventListener("click", (event) => event.stopPropagation());
  [el.editorBody, el.editorPinned, el.editorMemberId, el.editorGroupId, el.editorCategory].forEach((control) => {
    control.addEventListener("input", markEditorDirty);
    control.addEventListener("change", markEditorDirty);
  });
  el.editorBody.addEventListener("input", () => autoResize(el.editorBody));
  el.editorRemindAt.addEventListener("change", () => {
    state.editorDirty = true;
    state.editorReminderDirty = true;
  });
  el.editorPalette.addEventListener("click", (event) => {
    const button = event.target.closest("[data-note-color]");
    if (!button) return;
    state.editorColor = button.dataset.noteColor;
    state.editorDirty = true;
    applyEditorColor();
  });
  el.editorPhotos.addEventListener("change", () => {
    const note = editingNote();
    state.editorFiles = validSelectedPhotos(el.editorPhotos.files, note?.attachments?.length || 0);
    state.editorDirty = state.editorDirty || state.editorFiles.length > 0;
    renderFileSummary(el.editorFileSummary, state.editorFiles);
  });
  el.editorPhotoGrid.addEventListener("click", handleEditorPhotoClick);
  el.editorArchiveBtn.addEventListener("click", toggleEditorArchive);
  el.editorDeleteBtn.addEventListener("click", deleteEditorNote);

  const recordActivity = () => refreshSessionForActivity();
  window.addEventListener("pointerdown", recordActivity, { passive: true });
  window.addEventListener("keydown", recordActivity, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshSessionForActivity();
  });
}

async function loadWorkspace(announce = false) {
  state.loading = true;
  renderLoading();
  el.refreshBtn.disabled = true;
  try {
    const data = await apiRequest("/api/bootstrap", { cache: "no-store" });
    if (data.viewerRole !== "admin") {
      window.location.replace("/");
      return;
    }
    state.notes = Array.isArray(data.notes) ? data.notes.map(normalizeNote) : [];
    state.members = (Array.isArray(data.members) ? data.members : [])
      .filter((member) => !member.trashedAt)
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "ko"));
    state.groups = (Array.isArray(data.groups) ? data.groups : [])
      .slice().sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
    el.communityLabel.textContent = data.settings?.communityTitle || "공동체관리";
    populateAssociationOptions();
    applyInitialUrlState();
    state.loading = false;
    renderMemberScope();
    renderNotes();
    if (announce) toast("메모를 새로 불러왔습니다");
  } catch (error) {
    state.loading = false;
    el.loadingState.textContent = error.message || "메모를 불러오지 못했습니다";
    el.loadingState.classList.remove("hidden");
    toast(error.message || "메모를 불러오지 못했습니다");
  } finally {
    el.refreshBtn.disabled = false;
  }
}

function applyInitialUrlState() {
  const params = new URLSearchParams(window.location.search);
  const memberId = params.get("member") || "";
  if (memberId && state.members.some((member) => member.id === memberId)) {
    state.memberScopeId = memberId;
    el.quickMemberId.value = memberId;
  }
  const noteId = params.get("note") || "";
  if (noteId && state.notes.some((note) => note.id === noteId)) {
    window.setTimeout(() => openEditor(noteId), 0);
  } else if (params.get("compose") === "1") {
    window.setTimeout(() => openQuickComposer(true), 0);
  }
}

function populateAssociationOptions() {
  const memberOptions = state.members.map((member) => {
    const suffix = member.archivedAt ? " (보관됨)" : "";
    return `<option value="${escapeAttribute(member.id)}">${escapeHtml(member.name || "이름 없음")}${suffix}</option>`;
  }).join("");
  const groupOptions = state.groups.map((group) =>
    `<option value="${escapeAttribute(group.id)}">${escapeHtml(group.name || "이름 없음")}</option>`
  ).join("");
  el.quickMemberId.innerHTML = `<option value="">연결 안 함</option>${memberOptions}`;
  el.editorMemberId.innerHTML = `<option value="">연결 안 함</option>${memberOptions}`;
  el.editorGroupId.innerHTML = `<option value="">연결 안 함</option>${groupOptions}`;
}

function renderPalettes() {
  const paletteHtml = NOTE_COLORS.map((color) =>
    `<button class="color-swatch" data-note-color="${color.id}" type="button" style="--swatch:${color.css}" aria-label="${color.label}" title="${color.label}"></button>`
  ).join("");
  el.quickPalette.innerHTML = paletteHtml;
  el.editorPalette.innerHTML = paletteHtml;
  applyQuickColor();
}

function openQuickComposer(focus) {
  el.quickExpanded.classList.remove("hidden");
  if (state.memberScopeId) el.quickMemberId.value = state.memberScopeId;
  if (focus) window.setTimeout(() => el.quickBody.focus(), 0);
}

function resetQuickComposer() {
  el.quickBody.value = "";
  el.quickRemindAt.value = "";
  el.quickPhotos.value = "";
  state.quickFiles = [];
  state.quickColor = "default";
  el.quickMemberId.value = state.memberScopeId || "";
  el.quickExpanded.classList.add("hidden");
  el.quickBody.style.height = "";
  renderFileSummary(el.quickFileSummary, []);
  applyQuickColor();
}

async function saveQuickNote() {
  const body = el.quickBody.value.trim();
  if (!body) {
    toast("메모 내용을 입력해주세요");
    el.quickBody.focus();
    return;
  }
  el.quickSaveBtn.disabled = true;
  const photoCount = state.quickFiles.length;
  try {
    const remindAt = localDateTimeToIso(el.quickRemindAt.value);
    let note = normalizeNote(await apiRequest("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body,
        color: state.quickColor,
        memberId: el.quickMemberId.value,
        remindAt,
        reminderState: remindAt ? "scheduled" : "none"
      })
    }));
    upsertNote(note);
    renderNotes();
    for (const file of state.quickFiles) {
      note = await uploadPhoto(note.id, file);
      upsertNote(note);
      renderNotes();
    }
    resetQuickComposer();
    toast(photoCount ? "메모와 사진을 저장했습니다" : "메모를 저장했습니다");
  } catch (error) {
    toast(error.message || "메모를 저장하지 못했습니다");
  } finally {
    el.quickSaveBtn.disabled = false;
  }
}

function renderNotes() {
  renderLoading();
  if (state.loading) return;
  const notes = filteredNotes();
  const pinned = notes.filter((note) => note.pinned && note.status === "active");
  const others = notes.filter((note) => !pinned.includes(note));
  el.pinnedGrid.innerHTML = pinned.map(noteCardHtml).join("");
  el.notesGrid.innerHTML = others.map(noteCardHtml).join("");
  el.pinnedSection.classList.toggle("hidden", pinned.length === 0);
  el.notesSection.classList.toggle("hidden", others.length === 0);
  el.emptyState.classList.toggle("hidden", notes.length > 0);
  el.notesHeading.textContent = state.filter === "done" ? "보관된 메모" : state.memberScopeId ? "연결된 메모" : "메모";
}

function renderLoading() {
  el.loadingState.classList.toggle("hidden", !state.loading);
  if (state.loading) {
    el.pinnedSection.classList.add("hidden");
    el.notesSection.classList.add("hidden");
    el.emptyState.classList.add("hidden");
  }
}

function filteredNotes() {
  return state.notes.filter((note) => {
    if (state.memberScopeId && note.memberId !== state.memberScopeId) return false;
    if (state.filter === "done") {
      if (note.status !== "done") return false;
    } else if (note.status !== "active") {
      return false;
    }
    if (state.filter === "reminders" && !note.remindAt) return false;
    if (state.filter === "people" && !note.memberId) return false;
    if (!state.query) return true;
    const member = memberById(note.memberId);
    const group = groupById(note.groupId);
    const attachmentText = (note.attachments || []).map((item) => item.fileName).join(" ");
    return [note.title, note.body, member?.name, group?.name, attachmentText]
      .join(" ").toLocaleLowerCase("ko-KR").includes(state.query);
  }).sort(compareNotes);
}

function compareNotes(a, b) {
  if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
  return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
}

function noteCardHtml(note) {
  const lines = String(note.body || "").split(/\r?\n/);
  const title = note.title || lines.find((line) => line.trim()) || "메모";
  const firstContentIndex = lines.findIndex((line) => line.trim());
  const remainder = firstContentIndex >= 0 ? lines.slice(firstContentIndex + 1).join("\n").trim() : "";
  const attachments = Array.isArray(note.attachments) ? note.attachments.slice(0, 4) : [];
  const images = attachments.length
    ? `<div class="note-card-images ${attachments.length === 1 ? "one-image" : ""}">${attachments.map((attachment) =>
      `<img src="${escapeAttribute(attachment.url)}" alt="${escapeAttribute(attachment.fileName || "메모 사진")}" loading="lazy">`
    ).join("")}</div>`
    : "";
  const member = memberById(note.memberId);
  const group = groupById(note.groupId);
  const reminder = note.remindAt ? formatReminder(note.remindAt) : "";
  const reminderClass = note.remindAt && Date.parse(note.remindAt) <= Date.now() && note.reminderState === "scheduled" ? " overdue" : "";
  return `<article class="note-card color-${escapeAttribute(validColor(note.color))}" data-note-card="${escapeAttribute(note.id)}">
    <button class="note-card-pin ${note.pinned ? "active" : ""}" data-note-pin="${escapeAttribute(note.id)}" type="button" aria-label="${note.pinned ? "고정 해제" : "상단 고정"}" title="${note.pinned ? "고정 해제" : "상단 고정"}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 4 6 6-3 1-4 4-1 5-3-3-3-3 5-1 4-4 1-3Z"></path></svg>
    </button>
    <a class="note-card-open" data-note-open="${escapeAttribute(note.id)}" href="/memos.html?note=${encodeURIComponent(note.id)}" aria-label="${escapeAttribute(title)} 열기">
      ${images}
      <div class="note-card-button">
        <h3>${escapeHtml(title)}</h3>
        ${remainder ? `<p>${escapeHtml(truncate(remainder, 700))}</p>` : ""}
      </div>
      <div class="note-meta">
        ${member ? `<span class="meta-chip">${escapeHtml(member.name)} 님</span>` : ""}
        ${group ? `<span class="meta-chip">${escapeHtml(group.name)}</span>` : ""}
        ${reminder ? `<span class="meta-chip${reminderClass}">${escapeHtml(reminder)}</span>` : ""}
        ${note.status === "done" ? '<span class="meta-chip">보관됨</span>' : ""}
        <span class="card-date">${escapeHtml(formatUpdatedAt(note.updatedAt))}</span>
      </div>
    </a>
  </article>`;
}

function handleGridClick(event) {
  const pinButton = event.target.closest("[data-note-pin]");
  if (pinButton) {
    event.stopPropagation();
    toggleNotePin(pinButton.dataset.notePin, pinButton);
    return;
  }
  const openLink = event.target.closest("[data-note-open]");
  if (!openLink) return;
  event.preventDefault();
  openEditor(openLink.dataset.noteOpen);
}

async function toggleNotePin(noteId, button) {
  const note = noteById(noteId);
  if (!note) return;
  button.disabled = true;
  try {
    const updated = normalizeNote(await apiRequest(`/api/notes/${encodeURIComponent(noteId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedUpdatedAt: note.updatedAt, pinned: !note.pinned })
    }));
    upsertNote(updated);
    renderNotes();
  } catch (error) {
    handleWriteError(error);
  } finally {
    button.disabled = false;
  }
}

function openEditor(noteId) {
  const note = noteById(noteId);
  if (!note) return;
  state.editingId = noteId;
  state.editorColor = validColor(note.color);
  state.editorFiles = [];
  state.editorDirty = false;
  state.editorReminderDirty = false;
  el.editorBody.value = note.body || note.title || "";
  el.editorPinned.checked = Boolean(note.pinned);
  el.editorMemberId.value = note.memberId || "";
  el.editorGroupId.value = note.groupId || "";
  el.editorRemindAt.value = isoToLocalDateTime(note.remindAt);
  el.editorCategory.value = note.category || "personal";
  el.editorPhotos.value = "";
  el.editorFileSummary.textContent = "";
  el.editorArchiveBtn.textContent = note.status === "done" ? "보관 해제" : "보관";
  el.editorHeading.textContent = memberById(note.memberId)?.name
    ? `${memberById(note.memberId).name} 님의 메모`
    : "메모 편집";
  renderEditorPhotos(note);
  applyEditorColor();
  updateNoteUrl(note.id);
  if (!el.editorDialog.open) el.editorDialog.showModal();
  window.setTimeout(() => {
    autoResize(el.editorBody);
    el.editorBody.focus();
    el.editorBody.setSelectionRange(el.editorBody.value.length, el.editorBody.value.length);
  }, 0);
}

function renderEditorPhotos(note) {
  const attachments = Array.isArray(note?.attachments) ? note.attachments : [];
  el.editorPhotoGrid.innerHTML = attachments.map((attachment) => `<figure class="editor-photo">
    <img src="${escapeAttribute(attachment.url)}" alt="${escapeAttribute(attachment.fileName || "메모 사진")}">
    <button data-delete-attachment="${escapeAttribute(attachment.id)}" type="button" aria-label="사진 삭제" title="사진 삭제">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"></path></svg>
    </button>
  </figure>`).join("");
  el.editorPhotoGrid.classList.toggle("hidden", attachments.length === 0);
}

async function saveEditor({ close = false, status = "" } = {}) {
  if (state.editorSaving) return;
  const note = editingNote();
  if (!note) return;
  const body = el.editorBody.value.trim();
  if (!body) {
    toast("메모 내용을 입력해주세요");
    el.editorBody.focus();
    return;
  }
  if (!state.editorDirty && !state.editorFiles.length && !status) {
    if (close) closeEditor();
    return;
  }
  state.editorSaving = true;
  el.editorSaveBtn.disabled = true;
  el.editorCloseBtn.disabled = true;
  try {
    const remindAt = state.editorReminderDirty ? localDateTimeToIso(el.editorRemindAt.value) : note.remindAt;
    const payload = {
      expectedUpdatedAt: note.updatedAt,
      body,
      color: state.editorColor,
      pinned: el.editorPinned.checked,
      memberId: el.editorMemberId.value,
      groupId: el.editorGroupId.value,
      category: el.editorCategory.value,
      status: status || note.status,
      remindAt
    };
    if (state.editorReminderDirty) payload.reminderState = remindAt ? "scheduled" : "none";
    let updated = normalizeNote(await apiRequest(`/api/notes/${encodeURIComponent(note.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }));
    upsertNote(updated);
    for (const file of state.editorFiles) {
      updated = await uploadPhoto(note.id, file);
      upsertNote(updated);
    }
    state.editorDirty = false;
    state.editorFiles = [];
    state.editorReminderDirty = false;
    renderNotes();
    if (close) closeEditor();
    else openEditor(note.id);
    toast("메모를 저장했습니다");
  } catch (error) {
    handleWriteError(error);
  } finally {
    state.editorSaving = false;
    el.editorSaveBtn.disabled = false;
    el.editorCloseBtn.disabled = false;
  }
}

function closeEditorSafely() {
  if (state.editorDirty || state.editorFiles.length) {
    saveEditor({ close: true });
  } else {
    closeEditor();
  }
}

function closeEditor() {
  if (el.editorDialog.open) el.editorDialog.close();
  state.editingId = "";
  state.editorFiles = [];
  state.editorDirty = false;
  updateNoteUrl("");
}

async function toggleEditorArchive() {
  const note = editingNote();
  if (!note) return;
  await saveEditor({ close: true, status: note.status === "done" ? "active" : "done" });
}

async function deleteEditorNote() {
  const note = editingNote();
  if (!note || !window.confirm("이 메모와 첨부 사진을 삭제할까요?")) return;
  el.editorDeleteBtn.disabled = true;
  try {
    await apiRequest(`/api/notes/${encodeURIComponent(note.id)}`, { method: "DELETE" });
    state.notes = state.notes.filter((item) => item.id !== note.id);
    closeEditor();
    renderNotes();
    toast("메모를 삭제했습니다");
  } catch (error) {
    toast(error.message || "메모를 삭제하지 못했습니다");
  } finally {
    el.editorDeleteBtn.disabled = false;
  }
}

async function handleEditorPhotoClick(event) {
  const button = event.target.closest("[data-delete-attachment]");
  if (!button) return;
  const note = editingNote();
  if (!note || !window.confirm("이 사진을 메모에서 삭제할까요?")) return;
  button.disabled = true;
  try {
    const updated = normalizeNote(await apiRequest(
      `/api/notes/${encodeURIComponent(note.id)}/attachments/${encodeURIComponent(button.dataset.deleteAttachment)}`,
      { method: "DELETE" }
    ));
    upsertNote(updated);
    renderEditorPhotos(updated);
    renderNotes();
    toast("사진을 삭제했습니다");
  } catch (error) {
    toast(error.message || "사진을 삭제하지 못했습니다");
    button.disabled = false;
  }
}

async function uploadPhoto(noteId, file) {
  const form = new FormData();
  form.append("photo", file, file.name);
  return normalizeNote(await apiRequest(`/api/notes/${encodeURIComponent(noteId)}/attachments`, {
    method: "POST",
    body: form
  }));
}

function validSelectedPhotos(fileList, existingCount) {
  const files = Array.from(fileList || []);
  const remaining = Math.max(0, PHOTO_LIMIT - existingCount);
  if (files.length > remaining) toast(`메모 하나에는 사진을 최대 ${PHOTO_LIMIT}장까지 넣을 수 있습니다`);
  const selected = files.slice(0, remaining).filter((file) => {
    if (!file.type.startsWith("image/")) {
      toast(`${file.name}: 이미지 파일만 첨부할 수 있습니다`);
      return false;
    }
    if (!file.size || file.size > PHOTO_MAX_BYTES) {
      toast(`${file.name}: 사진 한 장은 8MB 이하여야 합니다`);
      return false;
    }
    return true;
  });
  return selected;
}

function renderFileSummary(target, files) {
  target.textContent = files.length ? `사진 ${files.length}장 선택됨 · 저장할 때 함께 업로드됩니다` : "";
}

function renderMemberScope() {
  const member = memberById(state.memberScopeId);
  el.memberScope.classList.toggle("hidden", !member);
  el.memberScopeLabel.textContent = member ? `${member.name} 님과 연결된 메모` : "";
}

function applyQuickColor() {
  setColorClass(el.quickNote, state.quickColor);
  el.quickPalette.querySelectorAll("[data-note-color]").forEach((button) => {
    const active = button.dataset.noteColor === state.quickColor;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function applyEditorColor() {
  setColorClass(el.editorDialog, state.editorColor);
  el.editorPalette.querySelectorAll("[data-note-color]").forEach((button) => {
    const active = button.dataset.noteColor === state.editorColor;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function setColorClass(target, color) {
  for (const item of NOTE_COLORS) target.classList.remove(`color-${item.id}`);
  target.classList.add(`color-${validColor(color)}`);
}

function markEditorDirty() {
  state.editorDirty = true;
}

function normalizeNote(note) {
  return {
    ...note,
    color: validColor(note?.color),
    attachments: Array.isArray(note?.attachments) ? note.attachments : []
  };
}

function validColor(value) {
  return NOTE_COLOR_IDS.has(value) ? value : "default";
}

function upsertNote(note) {
  const index = state.notes.findIndex((item) => item.id === note.id);
  if (index >= 0) state.notes.splice(index, 1, normalizeNote(note));
  else state.notes.unshift(normalizeNote(note));
}

function noteById(id) { return state.notes.find((note) => note.id === id); }
function editingNote() { return noteById(state.editingId); }
function memberById(id) { return state.members.find((member) => member.id === id); }
function groupById(id) { return state.groups.find((group) => group.id === id); }

function updateNoteUrl(noteId) {
  const url = new URL(window.location.href);
  if (noteId) url.searchParams.set("note", noteId);
  else url.searchParams.delete("note");
  url.searchParams.delete("compose");
  window.history.replaceState({}, "", `${url.pathname}${url.search}`);
}

function localDateTimeToIso(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function isoToLocalDateTime(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "";
  const date = new Date(timestamp);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

function formatReminder(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "";
  const date = new Date(timestamp);
  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"
  }).format(date);
}

function formatUpdatedAt(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "";
  const diff = Date.now() - timestamp;
  if (diff < 60 * 1000) return "방금";
  if (diff < 24 * 60 * 60 * 1000) return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" }).format(timestamp);
  return new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric" }).format(timestamp);
}

function autoResize(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, textarea === el.editorBody ? 480 : 280)}px`;
}

function truncate(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}…` : text;
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Accept: "application/json", ...(options.headers || {}) }
  });
  if (response.status === 401) {
    window.location.replace("/__auth/login");
    throw new Error("로그인이 필요합니다");
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "요청을 처리하지 못했습니다");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function handleWriteError(error) {
  if (error.status === 409 && error.payload?.note) {
    const current = normalizeNote(error.payload.note);
    upsertNote(current);
    renderNotes();
    openEditor(current.id);
    toast("다른 곳에서 메모가 변경되어 최신 내용을 불러왔습니다");
    return;
  }
  toast(error.message || "메모를 저장하지 못했습니다");
}

async function refreshSessionForActivity() {
  const now = Date.now();
  if (now - state.lastSessionRefreshAt < SESSION_REFRESH_INTERVAL_MS) return;
  state.lastSessionRefreshAt = now;
  try {
    const response = await fetch("/__auth/refresh", {
      method: "POST",
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    if (response.status === 401) window.location.replace("/__auth/login");
  } catch {
    // A later API request will surface an expired or unavailable session.
  }
}

function toast(message) {
  window.clearTimeout(state.toastTimer);
  el.toast.textContent = message;
  el.toast.classList.add("show");
  state.toastTimer = window.setTimeout(() => el.toast.classList.remove("show"), 2600);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[character]);
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
