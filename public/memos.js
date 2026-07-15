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
const DEFAULT_NOTE_CATEGORY_ORDER = new Map([
  ["personal", 0],
  ["visitation", 1],
  ["admin", 2]
]);
const PHOTO_RESIZE_THRESHOLD_BYTES = 2 * 1024 * 1024;
const PHOTO_TARGET_BYTES = Math.floor(1.5 * 1024 * 1024);
const PHOTO_SOURCE_MAX_BYTES = 40 * 1024 * 1024;
const PHOTO_MAX_EDGE = 2048;
const PHOTO_RESIZE_MAX_PASSES = 10;
const PHOTO_LIMIT = 8;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"]);
const PHOTO_UNSPECIFIED_TYPES = new Set(["", "application/octet-stream", "text/plain"]);
const PHOTO_TYPE_ALIASES = new Map([
  ["image/jpg", "image/jpeg"],
  ["image/pjpeg", "image/jpeg"],
  ["image/x-png", "image/png"]
]);
const PHOTO_EXTENSION_TYPES = new Map([
  ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["png", "image/png"],
  ["webp", "image/webp"], ["gif", "image/gif"], ["heic", "image/heic"], ["heif", "image/heif"]
]);
const SESSION_REFRESH_INTERVAL_MS = 4 * 60 * 1000;
const NOTE_REFRESH_INTERVAL_MS = 60 * 1000;
const NOTE_SORT_OPTIONS = new Set(["updated-desc", "updated-asc", "created-desc", "created-asc"]);
const MEMO_LAYOUT_OPTIONS = new Set(["grid", "list"]);

const state = {
  notes: [],
  trashNotes: [],
  trashLoaded: false,
  trashLoading: false,
  trashRefreshing: false,
  trashEmptying: false,
  callNoteImports: [],
  callNoteLoaded: false,
  callNoteLoading: false,
  callNoteRefreshing: false,
  members: [],
  noteCategories: [],
  filter: "all",
  categoryFilter: "",
  query: "",
  sort: readSavedSort(),
  layout: readSavedMemoLayout(),
  memberScopeId: "",
  quickColor: "default",
  quickFiles: [],
  quickPendingNoteId: "",
  editingId: "",
  editorColor: "default",
  editorFiles: [],
  categoryDialogSource: "quick",
  editorDirty: false,
  editorReminderDirty: false,
  editorSaving: false,
  loading: true,
  notesRefreshing: false,
  lastNotesRefreshAt: 0,
  lastTrashRefreshAt: 0,
  lastCallNoteRefreshAt: 0,
  lastSessionRefreshAt: 0,
  toastTimer: 0
};

const el = {};
[
  "searchInput", "refreshBtn", "topNewBtn", "memberScope", "memberScopeLabel",
  "memberScopeClearBtn", "categoryFilterBar", "quickNote", "quickBody", "quickExpanded", "quickMemberId",
  "quickMemberPicker", "quickMemberSearchBtn", "quickMemberClearBtn", "quickMemberSearchPanel",
  "quickMemberSearchInput", "quickMemberSearchResults", "quickReminderControl", "quickReminderBtn", "quickReminderButtonLabel",
  "quickReminderPanel", "quickReminderClearBtn", "quickReminderDoneBtn", "quickRemindAt", "quickCategory", "quickCategoryManageBtn",
  "quickPalette", "quickPhotos", "quickFileSummary", "quickCancelBtn", "quickSaveBtn", "noteCount", "trashEmptyBtn", "sortControl", "sortSelect", "loadingState",
  "gridLayoutBtn", "listLayoutBtn", "callNoteNavCount", "callNoteSection", "callNoteGrid", "pinnedSection", "pinnedGrid", "notesSection", "notesGrid", "emptyState", "emptyTitle", "emptyDescription",
  "editorDialog", "editorForm", "editorHeading", "editorTimestamps", "editorCloseBtn", "editorPinned", "editorPhotoGrid",
  "editorBody", "editorMemberId", "editorMemberPicker", "editorMemberSearchBtn", "editorMemberClearBtn",
  "editorMemberSearchPanel", "editorMemberSearchInput", "editorMemberSearchResults", "editorReminderControl", "editorReminderBtn",
  "editorReminderPanel", "editorReminderClearBtn", "editorReminderDoneBtn", "editorRemindAt",
  "editorCategory", "editorCategoryManageBtn", "editorPalette", "editorFileSummary", "editorPhotos",
  "editorDeleteBtn", "editorSaveBtn", "categoryDialog", "categoryDialogCloseBtn", "categoryCreateForm", "categoryNameInput",
  "categoryCreateSubmitBtn", "categoryManageList", "toast"
].forEach((id) => { el[id] = document.getElementById(id); });

bindEvents();
renderPalettes();
renderCategoryControls();
updateQuickReminderControl();
loadWorkspace();

function bindEvents() {
  el.sortSelect.value = state.sort;
  applyMemoLayout();
  el.searchInput.addEventListener("input", () => {
    state.query = el.searchInput.value.trim().toLocaleLowerCase("ko-KR");
    renderNotes();
  });
  el.refreshBtn.addEventListener("click", () => {
    if (state.filter === "call-notes") void refreshCallNoteImports(true, true);
    else if (state.filter === "trash") void refreshTrashNotes(true, true);
    else void loadWorkspace(true);
  });
  el.sortSelect.addEventListener("change", () => {
    state.sort = NOTE_SORT_OPTIONS.has(el.sortSelect.value) ? el.sortSelect.value : "updated-desc";
    saveSortPreference(state.sort);
    renderNotes();
  });
  el.gridLayoutBtn.addEventListener("click", () => setMemoLayout("grid"));
  el.listLayoutBtn.addEventListener("click", () => setMemoLayout("list"));
  el.trashEmptyBtn.addEventListener("click", emptyTrash);
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
  el.quickPhotos.addEventListener("change", async () => {
    el.quickPhotos.disabled = true;
    el.quickSaveBtn.disabled = true;
    try {
      state.quickFiles = await validSelectedPhotos(el.quickPhotos.files, 0);
      renderFileSummary(el.quickFileSummary, state.quickFiles);
    } finally {
      el.quickPhotos.disabled = false;
      el.quickSaveBtn.disabled = false;
    }
  });
  el.quickReminderControl.addEventListener("click", (event) => event.stopPropagation());
  el.quickReminderBtn.addEventListener("click", toggleQuickReminderPanel);
  el.quickRemindAt.addEventListener("change", updateQuickReminderControl);
  el.quickReminderClearBtn.addEventListener("click", () => {
    el.quickRemindAt.value = "";
    updateQuickReminderControl();
  });
  el.quickReminderDoneBtn.addEventListener("click", closeQuickReminderPanel);
  el.quickPalette.addEventListener("click", (event) => {
    const button = event.target.closest("[data-note-color]");
    if (!button) return;
    event.stopPropagation();
    state.quickColor = button.dataset.noteColor;
    applyQuickColor();
  });
  bindMemberPicker("quick");
  bindMemberPicker("editor");
  el.categoryFilterBar.addEventListener("click", (event) => {
    const button = event.target.closest("[data-category-filter]");
    if (!button) return;
    state.categoryFilter = button.dataset.categoryFilter;
    state.filter = "all";
    state.memberScopeId = "";
    renderNavigationState();
    renderCategoryFilters();
    renderViewControls();
    renderMemberScope();
    renderNotes();
  });
  el.quickCategoryManageBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    openCategoryDialog("quick", false);
  });
  el.editorCategoryManageBtn.addEventListener("click", () => openCategoryDialog("editor", false));

  document.querySelector(".memo-nav").addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) return;
    state.filter = button.dataset.filter;
    state.categoryFilter = "";
    state.memberScopeId = "";
    renderNavigationState();
    renderCategoryFilters();
    renderViewControls();
    renderMemberScope();
    renderNotes();
    if (state.filter === "trash") void refreshTrashNotes(false, !state.trashLoaded);
    if (state.filter === "call-notes") void refreshCallNoteImports(false, !state.callNoteLoaded);
  });
  el.memberScopeClearBtn.addEventListener("click", () => {
    state.memberScopeId = "";
    renderMemberScope();
    renderNotes();
  });
  el.pinnedGrid.addEventListener("click", handleGridClick);
  el.notesGrid.addEventListener("click", handleGridClick);
  el.callNoteGrid.addEventListener("click", handleCallNoteGridClick);
  el.callNoteGrid.addEventListener("input", handleCallNoteGridInput);
  el.callNoteGrid.addEventListener("error", (event) => {
    if (event.target instanceof HTMLImageElement && event.target.matches("[data-member-photo]")) {
      event.target.remove();
    }
  }, true);

  el.editorForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveEditor({ close: true });
  });
  el.editorSaveBtn.addEventListener("click", () => void saveEditor({ close: true }));
  el.editorCloseBtn.addEventListener("click", closeEditorSafely);
  el.editorDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeEditorSafely();
  });
  el.editorDialog.addEventListener("click", (event) => event.stopPropagation());
  [el.editorBody, el.editorPinned, el.editorMemberId, el.editorCategory].forEach((control) => {
    control.addEventListener("input", markEditorDirty);
    control.addEventListener("change", markEditorDirty);
  });
  el.editorBody.addEventListener("input", () => autoResize(el.editorBody));
  el.editorReminderControl.addEventListener("click", (event) => event.stopPropagation());
  el.editorReminderBtn.addEventListener("click", toggleEditorReminderPanel);
  el.editorRemindAt.addEventListener("change", () => {
    state.editorDirty = true;
    state.editorReminderDirty = true;
    updateEditorReminderControl();
  });
  el.editorReminderClearBtn.addEventListener("click", () => {
    el.editorRemindAt.value = "";
    state.editorDirty = true;
    state.editorReminderDirty = true;
    updateEditorReminderControl();
  });
  el.editorReminderDoneBtn.addEventListener("click", closeEditorReminderPanel);
  el.editorPalette.addEventListener("click", (event) => {
    const button = event.target.closest("[data-note-color]");
    if (!button) return;
    state.editorColor = button.dataset.noteColor;
    state.editorDirty = true;
    applyEditorColor();
  });
  el.editorPhotos.addEventListener("change", async () => {
    const note = editingNote();
    el.editorPhotos.disabled = true;
    el.editorSaveBtn.disabled = true;
    try {
      state.editorFiles = await validSelectedPhotos(el.editorPhotos.files, note?.attachments?.length || 0);
      state.editorDirty = state.editorDirty || state.editorFiles.length > 0;
      renderFileSummary(el.editorFileSummary, state.editorFiles);
    } finally {
      el.editorPhotos.disabled = false;
      el.editorSaveBtn.disabled = false;
    }
  });
  el.editorPhotoGrid.addEventListener("click", handleEditorPhotoClick);
  el.editorDeleteBtn.addEventListener("click", deleteEditorNote);
  el.categoryDialogCloseBtn.addEventListener("click", closeCategoryDialog);
  el.categoryDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeCategoryDialog();
  });
  el.categoryCreateForm.addEventListener("submit", createNoteCategory);
  el.categoryManageList.addEventListener("click", (event) => {
    const updateButton = event.target.closest("[data-update-category]");
    if (updateButton) {
      updateNoteCategory(updateButton.dataset.updateCategory, updateButton);
      return;
    }
    const button = event.target.closest("[data-delete-category]");
    if (button) deleteNoteCategory(button.dataset.deleteCategory, button);
  });
  document.addEventListener("click", (event) => {
    for (const scope of ["quick", "editor"]) {
      if (!memberPickerElements(scope).picker.contains(event.target)) closeMemberSearch(scope);
    }
    if (!el.quickReminderControl.contains(event.target)) closeQuickReminderPanel();
    document.querySelectorAll("[data-call-note-member-picker]").forEach((picker) => {
      if (!picker.contains(event.target)) closeCallNoteMemberSearch(picker);
    });
  });

  const recordActivity = () => refreshSessionForActivity();
  window.addEventListener("pointerdown", recordActivity, { passive: true });
  window.addEventListener("keydown", recordActivity, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      refreshSessionForActivity();
      refreshNotesQuietly(true);
    }
  });
  window.addEventListener("focus", () => refreshNotesQuietly(true));
  window.setInterval(() => refreshNotesQuietly(), NOTE_REFRESH_INTERVAL_MS);
}

async function loadWorkspace(announce = false) {
  state.loading = true;
  renderLoading();
  el.refreshBtn.disabled = true;
  try {
    const [data, callNoteData] = await Promise.all([
      apiRequest("/api/bootstrap", { cache: "no-store" }),
      apiRequest("/api/call-note-imports?status=needs_review", { cache: "no-store" }).catch(() => null)
    ]);
    if (data.viewerRole !== "admin") {
      window.location.replace("/");
      return;
    }
    state.notes = Array.isArray(data.notes) ? data.notes.map(normalizeNote) : [];
    state.lastNotesRefreshAt = Date.now();
    state.members = (Array.isArray(data.members) ? data.members : [])
      .filter((member) => !member.trashedAt)
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "ko"));
    state.noteCategories = normalizeNoteCategories(data.noteCategories);
    if (callNoteData) {
      state.callNoteImports = normalizeCallNoteImports(callNoteData.imports);
      state.callNoteLoaded = true;
      state.lastCallNoteRefreshAt = Date.now();
    }
    populateAssociationOptions();
    applyInitialUrlState();
    state.loading = false;
    renderViewControls();
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

async function refreshNotesQuietly(force = false) {
  const now = Date.now();
  if (state.loading || state.notesRefreshing || document.visibilityState !== "visible") return;
  if (el.editorDialog.open || state.editorDirty || state.editorSaving) return;
  if (state.filter === "call-notes") {
    await refreshCallNoteImports(false, force);
    return;
  }
  if (state.filter === "trash") {
    await refreshTrashNotes(false, force);
    return;
  }
  if (now - state.lastNotesRefreshAt < (force ? 5000 : NOTE_REFRESH_INTERVAL_MS)) return;
  state.notesRefreshing = true;
  try {
    const [data, categoryData, callNoteData] = await Promise.all([
      apiRequest("/api/notes", { cache: "no-store" }),
      apiRequest("/api/note-categories", { cache: "no-store" }),
      apiRequest("/api/call-note-imports?status=needs_review", { cache: "no-store" }).catch(() => null)
    ]);
    state.notes = Array.isArray(data.notes) ? data.notes.map(normalizeNote) : [];
    state.noteCategories = normalizeNoteCategories(categoryData.categories);
    if (callNoteData) {
      state.callNoteImports = normalizeCallNoteImports(callNoteData.imports);
      state.callNoteLoaded = true;
      state.lastCallNoteRefreshAt = Date.now();
    }
    if (state.categoryFilter && !categoryById(state.categoryFilter)) state.categoryFilter = "";
    state.lastNotesRefreshAt = Date.now();
    renderCategoryControls();
    renderNotes();
  } catch {
    // The next visible refresh or user action will retry without interrupting the memo draft.
  } finally {
    state.notesRefreshing = false;
  }
}

async function refreshCallNoteImports(announce = false, force = false) {
  const now = Date.now();
  if (state.callNoteRefreshing) return;
  if (state.callNoteLoaded && !force && now - state.lastCallNoteRefreshAt < NOTE_REFRESH_INTERVAL_MS) return;
  state.callNoteRefreshing = true;
  state.callNoteLoading = !state.callNoteLoaded;
  if (state.filter === "call-notes") renderNotes();
  el.refreshBtn.disabled = true;
  try {
    const data = await apiRequest("/api/call-note-imports?status=needs_review", { cache: "no-store" });
    state.callNoteImports = normalizeCallNoteImports(data.imports);
    state.callNoteLoaded = true;
    state.lastCallNoteRefreshAt = Date.now();
    renderCallNoteNavCount();
    if (state.filter === "call-notes") renderNotes();
    if (announce) toast("미분류 콜노트를 새로 불러왔습니다");
  } catch (error) {
    if (announce || !state.callNoteLoaded) toast(error.message || "미분류 콜노트를 불러오지 못했습니다");
  } finally {
    state.callNoteLoading = false;
    state.callNoteRefreshing = false;
    el.refreshBtn.disabled = false;
    if (state.filter === "call-notes") renderNotes();
  }
}

async function refreshTrashNotes(announce = false, force = false) {
  const now = Date.now();
  if (state.trashRefreshing) return;
  if (state.trashLoaded && !force && now - state.lastTrashRefreshAt < NOTE_REFRESH_INTERVAL_MS) return;
  state.trashRefreshing = true;
  state.trashLoading = !state.trashLoaded;
  if (state.filter === "trash") renderNotes();
  if (el.categoryDialog.open) renderCategoryManageList();
  el.refreshBtn.disabled = true;
  try {
    const data = await apiRequest("/api/notes?view=trash", { cache: "no-store" });
    state.trashNotes = Array.isArray(data.notes) ? data.notes.map(normalizeNote) : [];
    state.trashLoaded = true;
    state.lastTrashRefreshAt = Date.now();
    if (state.filter === "trash") renderNotes();
    if (announce) toast("휴지통을 새로 불러왔습니다");
  } catch (error) {
    if (announce || !state.trashLoaded) toast(error.message || "휴지통을 불러오지 못했습니다");
  } finally {
    state.trashLoading = false;
    state.trashRefreshing = false;
    el.refreshBtn.disabled = false;
    if (state.filter === "trash") renderNotes();
    if (el.categoryDialog.open) renderCategoryManageList();
  }
}

function applyInitialUrlState() {
  const params = new URLSearchParams(window.location.search);
  const memberId = params.get("member") || "";
  if (memberId && state.members.some((member) => member.id === memberId)) {
    state.memberScopeId = memberId;
    setMemberSelection("quick", memberId, { markDirty: false });
  }
  const noteId = params.get("note") || "";
  if (noteId && state.notes.some((note) => note.id === noteId)) {
    window.setTimeout(() => openEditor(noteId), 0);
  } else if (params.get("compose") === "1") {
    window.setTimeout(() => openQuickComposer(true), 0);
  }
}

function populateAssociationOptions() {
  setMemberSelection("quick", el.quickMemberId.value, { markDirty: false });
  setMemberSelection("editor", el.editorMemberId.value, { markDirty: false });
  renderCategoryControls();
}

function bindMemberPicker(scope) {
  const picker = memberPickerElements(scope);
  picker.picker.addEventListener("click", (event) => event.stopPropagation());
  picker.searchButton.addEventListener("click", () => toggleMemberSearch(scope));
  picker.clearButton.addEventListener("click", () => setMemberSelection(scope, ""));
  picker.searchInput.addEventListener("input", () => renderMemberSearchResults(scope));
  picker.results.addEventListener("click", (event) => {
    const button = event.target.closest("[data-member-result]");
    if (!button) return;
    setMemberSelection(scope, button.dataset.memberResult);
    picker.searchInput.value = "";
    closeMemberSearch(scope);
  });
  picker.results.addEventListener("error", (event) => {
    if (event.target instanceof HTMLImageElement && event.target.matches("[data-member-photo]")) {
      event.target.remove();
    }
  }, true);
}

function memberPickerElements(scope) {
  return {
    picker: el[`${scope}MemberPicker`],
    input: el[`${scope}MemberId`],
    searchButton: el[`${scope}MemberSearchBtn`],
    clearButton: el[`${scope}MemberClearBtn`],
    panel: el[`${scope}MemberSearchPanel`],
    searchInput: el[`${scope}MemberSearchInput`],
    results: el[`${scope}MemberSearchResults`]
  };
}

function toggleMemberSearch(scope) {
  const picker = memberPickerElements(scope);
  if (picker.input.value) return;
  const opening = picker.panel.classList.contains("hidden");
  for (const otherScope of ["quick", "editor"]) {
    if (otherScope !== scope) closeMemberSearch(otherScope);
  }
  picker.panel.classList.toggle("hidden", !opening);
  picker.searchButton.setAttribute("aria-expanded", opening ? "true" : "false");
  if (opening) {
    renderMemberSearchResults(scope);
    window.setTimeout(() => picker.searchInput.focus(), 0);
  }
}

function closeMemberSearch(scope) {
  const picker = memberPickerElements(scope);
  picker.panel.classList.add("hidden");
  picker.searchButton.setAttribute("aria-expanded", "false");
}

function setMemberSelection(scope, memberId, { markDirty = true } = {}) {
  const picker = memberPickerElements(scope);
  const member = memberById(memberId);
  picker.input.value = member?.id || "";
  const name = member?.name || "이름 없음";
  const memberTitle = String(member?.title || "").trim();
  const archivedLabel = member?.archivedAt ? " · 보관됨" : "";
  picker.searchButton.textContent = member
    ? `${name}${memberTitle ? ` · ${memberTitle}` : ""}${archivedLabel} 연결됨`
    : "교인 검색";
  picker.searchButton.title = picker.searchButton.textContent;
  picker.searchButton.classList.toggle("connected", Boolean(member));
  picker.searchButton.disabled = Boolean(member);
  picker.searchButton.setAttribute("aria-label", member
    ? `${name}${memberTitle ? ` ${memberTitle}` : ""} 교인과 연결됨`
    : "교인 검색");
  picker.clearButton.classList.toggle("hidden", !member);
  if (!member) {
    picker.searchInput.value = "";
    closeMemberSearch(scope);
  }
  if (scope === "editor" && markDirty) state.editorDirty = true;
}

function renderMemberSearchResults(scope) {
  const picker = memberPickerElements(scope);
  const query = picker.searchInput.value.normalize("NFKC").trim().toLocaleLowerCase("ko-KR");
  if (!query) {
    picker.results.replaceChildren();
    return;
  }
  const matches = state.members.filter((member) => [member.name, member.title]
    .join(" ").normalize("NFKC").toLocaleLowerCase("ko-KR").includes(query)).slice(0, 50);
  picker.results.innerHTML = matches.length ? matches.map((member) => {
    const description = [member.title, member.archivedAt ? "보관됨" : ""].filter(Boolean).join(" · ");
    const name = member.name || "이름 없음";
    const initial = Array.from(String(name).trim())[0] || "?";
    const photoUrl = memoMemberPhotoUrl(member);
    return `<button class="member-search-result" data-member-result="${escapeAttribute(member.id)}" type="button" role="option"><span class="member-result-person"><span class="member-result-avatar" aria-hidden="true"><span>${escapeHtml(initial)}</span>${photoUrl ? `<img data-member-photo src="${escapeAttribute(photoUrl)}" alt="" loading="lazy">` : ""}</span><span class="member-result-name">${escapeHtml(name)}</span></span>${description ? `<small>${escapeHtml(description)}</small>` : ""}</button>`;
  }).join("") : '<p class="member-search-empty">일치하는 교인이 없습니다.</p>';
}

function memoMemberPhotoUrl(member) {
  const photoUrl = String(member?.photoUrl || "").trim();
  if (photoUrl) return photoUrl;
  const photoKey = String(member?.photoKey || "").trim();
  return photoKey ? `/api/photos/${encodeURIComponent(photoKey)}` : "";
}

function normalizeNoteCategories(categories) {
  const incoming = Array.isArray(categories) ? categories : [];
  const normalized = [];
  const seen = new Set();
  for (const category of incoming) {
    const id = String(category?.id || "").trim().toLowerCase();
    const name = String(category?.name || "").trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    normalized.push({ ...category, id, name, isSystem: Boolean(category?.isSystem) });
  }
  return normalized.sort((left, right) => {
    const leftOrder = DEFAULT_NOTE_CATEGORY_ORDER.get(left.id) ?? 99;
    const rightOrder = DEFAULT_NOTE_CATEGORY_ORDER.get(right.id) ?? 99;
    return leftOrder - rightOrder || left.name.localeCompare(right.name, "ko");
  });
}

function normalizeCallNoteImports(imports) {
  return (Array.isArray(imports) ? imports : []).map((item) => {
    const payload = item?.payload && typeof item.payload === "object" ? item.payload : {};
    return {
      ...item,
      id: String(item?.id || "").trim(),
      payload,
      candidates: Array.isArray(item?.candidates) ? item.candidates : [],
      name: String(item?.name || payload.name || "").trim(),
      phone: String(item?.phone || payload.phone || "").trim(),
      cellHint: String(item?.cellHint || payload.cellHint || "").trim(),
      summary: String(item?.summary || payload.summary || payload.note || "").trim(),
      prayer: String(item?.prayer || payload.prayer || payload.prayerRequest || "").trim(),
      action: String(item?.action || payload.action || payload.nextAction || "").trim(),
      visitDate: String(item?.visitDate || "").trim(),
      visitType: String(item?.visitType || payload.visitType || payload.type || "전화").trim() || "전화",
      createdAt: String(item?.createdAt || "").trim()
    };
  }).filter((item) => item.id);
}

function renderCategoryControls() {
  const quickValue = el.quickCategory.value;
  const editorValue = el.editorCategory.value;
  const options = `<option value="">미분류</option>${state.noteCategories.map((category) =>
    `<option value="${escapeAttribute(category.id)}">${escapeHtml(category.name)}</option>`
  ).join("")}`;
  el.quickCategory.innerHTML = options;
  el.editorCategory.innerHTML = options;
  el.quickCategory.value = categoryById(quickValue) ? quickValue : "";
  el.editorCategory.value = categoryById(editorValue) ? editorValue : "";
  renderCategoryFilters();
  if (el.categoryDialog.open) renderCategoryManageList();
}

function renderCategoryFilters() {
  el.categoryFilterBar.innerHTML = state.noteCategories.map((category) => {
    const count = state.notes.filter((note) => note.categoryId === category.id).length;
    const active = state.filter === "all" && state.categoryFilter === category.id;
    return `<button class="nav-item category-filter-button${active ? " active" : ""}" data-category-filter="${escapeAttribute(category.id)}" type="button" aria-pressed="${active ? "true" : "false"}"><span>${escapeHtml(category.name)}</span><small class="category-count" aria-label="${count}개">${count}</small></button>`;
  }).join("");
  renderNavigationState();
}

function renderNavigationState() {
  document.querySelectorAll("[data-filter]").forEach((item) => {
    const active = !state.categoryFilter && state.filter === item.dataset.filter;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", active ? "true" : "false");
  });
  renderCallNoteNavCount();
}

function renderCallNoteNavCount() {
  const count = state.callNoteImports.length;
  el.callNoteNavCount.textContent = String(count);
  el.callNoteNavCount.setAttribute("aria-label", `${count}개`);
  el.callNoteNavCount.classList.toggle("hidden", count === 0);
}

function openCategoryDialog(source, focusCreate) {
  state.categoryDialogSource = source === "editor" ? "editor" : "quick";
  if (!el.categoryDialog.open) el.categoryDialog.showModal();
  if (!state.trashLoaded && !state.trashRefreshing) {
    void refreshTrashNotes(false, true);
  } else {
    renderCategoryManageList();
  }
  if (focusCreate) window.setTimeout(() => el.categoryNameInput.focus(), 0);
}

function closeCategoryDialog() {
  if (el.categoryDialog.open) el.categoryDialog.close();
  el.categoryNameInput.value = "";
}

async function createNoteCategory(event) {
  event.preventDefault();
  const name = el.categoryNameInput.value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!name) {
    toast("새 분류 이름을 입력해주세요");
    el.categoryNameInput.focus();
    return;
  }
  el.categoryCreateSubmitBtn.disabled = true;
  try {
    const category = await apiRequest("/api/note-categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
    state.noteCategories = normalizeNoteCategories([...state.noteCategories, category]);
    renderCategoryControls();
    const target = state.categoryDialogSource === "editor" ? el.editorCategory : el.quickCategory;
    target.value = category.id;
    if (state.categoryDialogSource === "editor") state.editorDirty = true;
    el.categoryNameInput.value = "";
    renderCategoryManageList();
    toast(`${category.name} 분류를 추가했습니다`);
  } catch (error) {
    toast(categoryErrorMessage(error));
  } finally {
    el.categoryCreateSubmitBtn.disabled = false;
  }
}

function renderCategoryManageList() {
  const checkingTrash = !state.trashLoaded && (state.trashLoading || state.trashRefreshing);
  const trashUnknown = !state.trashLoaded;
  el.categoryManageList.innerHTML = state.noteCategories.map((category) => {
    const activeCount = state.notes.filter((note) => note.categoryId === category.id).length;
    const trashCount = state.trashNotes.filter((note) => note.categoryId === category.id).length;
    const knownCount = activeCount + trashCount;
    const protectedCategory = trashUnknown || knownCount > 0;
    const description = checkingTrash ? "휴지통 사용 여부 확인 중"
      : trashUnknown ? "휴지통 사용 여부 확인 필요"
        : knownCount ? `메모 ${knownCount}개에서 사용 중` : "사용하지 않는 분류";
    const deleteLabel = checkingTrash ? "확인 중" : trashUnknown ? "확인 필요" : "삭제";
    return `<div class="category-manage-row"><div class="category-manage-copy"><input data-category-name="${escapeAttribute(category.id)}" value="${escapeAttribute(category.name)}" maxlength="80" aria-label="${escapeAttribute(category.name)} 분류 이름"><small>${escapeHtml(description)}</small></div><div class="category-manage-actions"><button class="category-update-button" data-update-category="${escapeAttribute(category.id)}" type="button">수정</button><button class="category-delete-button" data-delete-category="${escapeAttribute(category.id)}" type="button"${protectedCategory ? " disabled" : ""}>${deleteLabel}</button></div></div>`;
  }).join("");
}

async function updateNoteCategory(categoryId, button) {
  const category = categoryById(categoryId);
  const input = button.closest(".category-manage-row")?.querySelector("[data-category-name]");
  const name = input?.value.normalize("NFKC").trim().replace(/\s+/gu, " ") || "";
  if (!category || !input) return;
  if (!name) {
    toast("분류 이름을 입력해주세요");
    input.focus();
    return;
  }
  button.disabled = true;
  try {
    const updated = await apiRequest(`/api/note-categories/${encodeURIComponent(category.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
    state.noteCategories = normalizeNoteCategories(state.noteCategories.map((item) =>
      item.id === updated.id ? updated : item
    ));
    renderCategoryControls();
    renderCategoryManageList();
    renderNotes();
    toast(`${updated.name} 분류로 수정했습니다`);
  } catch (error) {
    toast(categoryErrorMessage(error));
    renderCategoryManageList();
  }
}

async function deleteNoteCategory(categoryId, button) {
  const category = categoryById(categoryId);
  if (!category) return;
  if (!state.trashLoaded) {
    toast("휴지통에서 사용 중인지 확인한 뒤 삭제할 수 있습니다");
    if (!state.trashRefreshing) void refreshTrashNotes(false, true);
    return;
  }
  if (!window.confirm(`${category.name} 분류를 삭제할까요?`)) return;
  button.disabled = true;
  try {
    await apiRequest(`/api/note-categories/${encodeURIComponent(category.id)}`, { method: "DELETE" });
    state.noteCategories = state.noteCategories.filter((item) => item.id !== category.id);
    if (state.categoryFilter === category.id) state.categoryFilter = "";
    renderCategoryControls();
    renderCategoryManageList();
    renderNotes();
    toast(`${category.name} 분류를 삭제했습니다`);
  } catch (error) {
    toast(categoryErrorMessage(error));
    renderCategoryManageList();
  }
}

function categoryErrorMessage(error) {
  switch (error?.payload?.code) {
    case "NOTE_CATEGORY_DUPLICATE": return "같은 이름의 분류가 이미 있습니다";
    case "NOTE_CATEGORY_IN_USE": return "이 분류를 사용하는 메모가 있어 삭제할 수 없습니다";
    case "NOTE_CATEGORY_NAME_TOO_LONG": return "분류 이름은 80자 이하로 입력해주세요";
    default: return error?.message || "분류를 처리하지 못했습니다";
  }
}

function renderPalettes() {
  const paletteHtml = NOTE_COLORS.map((color) =>
    `<button class="color-swatch" data-note-color="${color.id}" type="button" style="--swatch:${color.css}" aria-label="${color.label}" title="${color.label}"></button>`
  ).join("");
  el.quickPalette.innerHTML = paletteHtml;
  el.editorPalette.innerHTML = paletteHtml;
  applyQuickColor();
}

function toggleQuickReminderPanel() {
  const opening = el.quickReminderPanel.classList.contains("hidden");
  el.quickReminderPanel.classList.toggle("hidden", !opening);
  el.quickReminderBtn.setAttribute("aria-expanded", opening ? "true" : "false");
  if (!opening) return;
  el.quickRemindAt.focus();
  try {
    el.quickRemindAt.showPicker?.();
  } catch {
    // The visible date-time field remains usable when the native picker is unavailable.
  }
}

function closeQuickReminderPanel() {
  el.quickReminderPanel.classList.add("hidden");
  el.quickReminderBtn.setAttribute("aria-expanded", "false");
}

function updateQuickReminderControl() {
  const remindAt = localDateTimeToIso(el.quickRemindAt.value);
  el.quickReminderBtn.classList.toggle("active", Boolean(remindAt));
  el.quickReminderButtonLabel.textContent = remindAt ? `알림 ${formatReminder(remindAt)}` : "알림";
}

function toggleEditorReminderPanel() {
  const opening = el.editorReminderPanel.classList.contains("hidden");
  el.editorReminderPanel.classList.toggle("hidden", !opening);
  el.editorReminderBtn.setAttribute("aria-expanded", opening ? "true" : "false");
  if (!opening) return;
  el.editorRemindAt.focus();
  try {
    el.editorRemindAt.showPicker?.();
  } catch {
    // The visible date-time field remains usable when the native picker is unavailable.
  }
}

function closeEditorReminderPanel() {
  el.editorReminderPanel.classList.add("hidden");
  el.editorReminderBtn.setAttribute("aria-expanded", "false");
}

function updateEditorReminderControl() {
  const remindAt = localDateTimeToIso(el.editorRemindAt.value);
  const label = remindAt ? `알림 설정됨: ${formatReminder(remindAt)}` : "알림 설정";
  el.editorReminderBtn.classList.toggle("active", Boolean(remindAt));
  el.editorReminderBtn.setAttribute("aria-label", label);
  el.editorReminderBtn.title = label;
}

function openQuickComposer(focus) {
  if (state.filter === "trash" || state.filter === "call-notes") return;
  el.quickExpanded.classList.remove("hidden");
  el.quickNote.classList.add("expanded");
  if (state.memberScopeId) setMemberSelection("quick", state.memberScopeId, { markDirty: false });
  if (focus) window.setTimeout(() => el.quickBody.focus(), 0);
}

function resetQuickComposer() {
  el.quickBody.value = "";
  el.quickRemindAt.value = "";
  el.quickPhotos.value = "";
  state.quickFiles = [];
  state.quickPendingNoteId = "";
  state.quickColor = "default";
  setMemberSelection("quick", state.memberScopeId || "", { markDirty: false });
  el.quickCategory.value = "";
  el.quickExpanded.classList.add("hidden");
  el.quickNote.classList.remove("expanded");
  closeMemberSearch("quick");
  closeQuickReminderPanel();
  updateQuickReminderControl();
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
    const payload = {
      body,
      color: state.quickColor,
      memberId: el.quickMemberId.value,
      categoryId: el.quickCategory.value,
      remindAt,
      reminderState: remindAt ? "scheduled" : "none"
    };
    let note;
    if (state.quickPendingNoteId) {
      const pendingNote = noteById(state.quickPendingNoteId);
      if (!pendingNote) {
        throw new Error("이미 만든 메모를 다시 확인할 수 없습니다. 새로고침 후 메모함에서 확인해 주세요.");
      }
      note = normalizeNote(await apiRequest(`/api/notes/${encodeURIComponent(pendingNote.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          expectedRevision: pendingNote.revision,
          expectedUpdatedAt: pendingNote.updatedAt
        })
      }));
    } else {
      note = normalizeNote(await apiRequest("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }));
      state.quickPendingNoteId = note.id;
    }
    upsertNote(note);
    renderNotes();
    while (state.quickFiles.length) {
      const pendingFile = state.quickFiles[0];
      note = await uploadPhoto(note.id, pendingFile, note.revision);
      upsertNote(note);
      state.quickFiles = state.quickFiles.filter(
        (item) => item.clientAttachmentId !== pendingFile.clientAttachmentId
      );
      renderFileSummary(el.quickFileSummary, state.quickFiles);
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
  if (state.loading
    || (state.filter === "trash" && state.trashLoading)
    || (state.filter === "call-notes" && state.callNoteLoading)) return;
  renderCategoryFilters();
  if (state.filter === "call-notes") {
    renderCallNoteImports();
    return;
  }
  el.callNoteSection.classList.add("hidden");
  const notes = filteredNotes();
  const pinned = state.filter === "trash"
    ? []
    : notes.filter((note) => note.pinned && note.status === "active");
  const others = notes.filter((note) => !pinned.includes(note));
  el.pinnedGrid.innerHTML = pinned.map(noteCardHtml).join("");
  el.notesGrid.innerHTML = others.map(noteCardHtml).join("");
  el.pinnedSection.classList.toggle("hidden", pinned.length === 0);
  el.notesSection.classList.toggle("hidden", others.length === 0);
  el.emptyState.classList.toggle("hidden", notes.length > 0);
  const category = categoryById(state.categoryFilter);
  el.noteCount.textContent = state.filter === "trash"
    ? `휴지통 ${notes.length}개`
    : category ? `${category.name} ${notes.length}개` : `메모 ${notes.length}개`;
  el.trashEmptyBtn.classList.toggle("hidden", state.filter !== "trash" || state.trashNotes.length === 0);
  el.trashEmptyBtn.disabled = state.trashEmptying;
  el.emptyTitle.textContent = state.filter === "trash" ? "휴지통이 비어 있습니다" : "표시할 메모가 없습니다";
  el.emptyDescription.textContent = state.filter === "trash"
    ? "삭제한 메모는 30일 동안 이곳에 보관됩니다."
    : "위 입력창에서 첫 메모를 남겨보세요.";
}

function renderCallNoteImports() {
  const imports = filteredCallNoteImports();
  el.callNoteGrid.innerHTML = imports.length
    ? imports.map(callNoteCardHtml).join("")
    : `<div class="call-note-empty"><strong>${state.query ? "검색 결과가 없습니다" : "미분류 콜노트가 없습니다"}</strong><span>${state.query ? "다른 검색어를 입력해보세요." : "새 미분류 콜노트가 들어오면 이곳에 자동으로 표시됩니다."}</span></div>`;
  el.callNoteSection.classList.remove("hidden");
  el.pinnedSection.classList.add("hidden");
  el.notesSection.classList.add("hidden");
  el.emptyState.classList.add("hidden");
  el.noteCount.textContent = `미분류 콜노트 ${imports.length}개`;
  renderCallNoteNavCount();
}

function filteredCallNoteImports() {
  return state.callNoteImports.filter((item) => {
    if (!state.query) return true;
    return [item.name, item.phone, item.cellHint, item.summary, item.prayer, item.action, item.visitType]
      .join(" ").toLocaleLowerCase("ko-KR").includes(state.query);
  }).sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
}

function callNoteCardHtml(item) {
  const name = item.name || "이름 없음";
  const heading = [name, item.cellHint].filter(Boolean).join(" · ");
  const visitDate = item.visitDate || todayLocalDate();
  const visitType = ["전화", "심방", "상담", "기도"].includes(item.visitType) ? item.visitType : "전화";
  const details = [item.phone, item.createdAt ? `수신 ${formatNoteTimestamp(item.createdAt)}` : ""].filter(Boolean);
  return `<article class="call-note-card" data-call-note-id="${escapeAttribute(item.id)}">
    <div class="call-note-card-head">
      <strong>${escapeHtml(heading)}</strong>
      <span>${escapeHtml(callNoteReasonLabel(item.matchReason))}</span>
    </div>
    <div class="call-note-fields">
      <div class="call-note-member-field" data-call-note-member-picker>
        <span>연결할 교인</span>
        <input data-call-note-member type="hidden" value="">
        <div class="member-picker-row">
          <button class="member-search-toggle" data-call-note-member-toggle type="button" aria-expanded="false">교인 검색</button>
          <button class="member-clear-button hidden" data-call-note-member-clear type="button">해제</button>
        </div>
        <div class="member-search-panel hidden" data-call-note-member-panel>
          <input data-call-note-member-query type="search" autocomplete="off" aria-label="교인 이름 검색">
          <div class="member-search-results" data-call-note-member-results role="listbox" aria-label="연결할 교인 검색 결과"></div>
        </div>
      </div>
      <label><span>날짜</span><input data-call-note-date type="date" value="${escapeAttribute(visitDate)}"></label>
      <label><span>방식</span><select data-call-note-type>${["전화", "심방", "상담", "기도"].map((option) => `<option${option === visitType ? " selected" : ""}>${option}</option>`).join("")}</select></label>
      <label class="call-note-summary-field"><span>콜노트 내용</span><textarea data-call-note-summary rows="5">${escapeHtml(item.summary)}</textarea></label>
    </div>
    ${item.prayer ? `<p class="call-note-extra"><strong>기도</strong><span>${escapeHtml(item.prayer)}</span></p>` : ""}
    ${item.action ? `<p class="call-note-extra"><strong>후속 조치</strong><span>${escapeHtml(item.action)}</span></p>` : ""}
    ${details.length ? `<div class="call-note-meta">${escapeHtml(details.join(" · "))}</div>` : ""}
    <div class="call-note-actions">
      <button class="primary-action" data-call-note-action="attach" type="button">심방내역으로 저장</button>
      <button class="text-action call-note-ignore" data-call-note-action="ignore" type="button">제외</button>
    </div>
  </article>`;
}

function callNoteReasonLabel(reason) {
  const labels = {
    "missing-name-phone": "이름/전화 없음",
    "ambiguous-phone": "전화번호 중복",
    "ambiguous-name": "동명이인",
    "ambiguous-name-cell": "동명이인",
    "no-match": "매칭 없음"
  };
  return labels[String(reason || "")] || "확인 필요";
}

function renderLoading() {
  const loading = state.loading
    || (state.filter === "trash" && state.trashLoading)
    || (state.filter === "call-notes" && state.callNoteLoading);
  el.loadingState.textContent = state.filter === "trash"
    ? "휴지통을 불러오는 중입니다…"
    : state.filter === "call-notes" ? "미분류 콜노트를 불러오는 중입니다…" : "메모를 불러오는 중입니다…";
  el.loadingState.classList.toggle("hidden", !loading);
  if (loading) {
    el.pinnedSection.classList.add("hidden");
    el.notesSection.classList.add("hidden");
    el.callNoteSection.classList.add("hidden");
    el.emptyState.classList.add("hidden");
  }
}

function renderViewControls() {
  const trash = state.filter === "trash";
  const callNotes = state.filter === "call-notes";
  el.quickNote.classList.toggle("hidden", trash || callNotes);
  el.topNewBtn.classList.toggle("hidden", trash || callNotes);
  el.sortControl.classList.toggle("hidden", callNotes);
  el.searchInput.placeholder = callNotes ? "미분류 콜노트 검색" : "메모, 교인, 사진 검색";
}

function filteredNotes() {
  const source = state.filter === "trash" ? state.trashNotes : state.notes;
  return source.filter((note) => {
    if (state.filter === "trash" && !note.deletedAt) return false;
    if (state.memberScopeId && note.memberId !== state.memberScopeId) return false;
    if (state.categoryFilter && note.categoryId !== state.categoryFilter) return false;
    // Existing done-status notes stay visible in the ordinary list; the status is retained for sync compatibility.
    if (state.filter === "reminders" && !note.remindAt) return false;
    if (state.filter === "people" && !note.memberId) return false;
    if (!state.query) return true;
    const member = memberById(note.memberId);
    const attachmentText = (note.attachments || []).map((item) => item.fileName).join(" ");
    return [note.title, note.body, member?.name, note.categoryName, attachmentText]
      .join(" ").toLocaleLowerCase("ko-KR").includes(state.query);
  }).sort(compareNotes);
}

function compareNotes(a, b) {
  if (state.filter !== "trash" && Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
  const [field, direction] = state.sort.split("-");
  const property = field === "created" ? "createdAt" : "updatedAt";
  const left = String(a[property] || "");
  const right = String(b[property] || "");
  const dateOrder = direction === "asc" ? left.localeCompare(right) : right.localeCompare(left);
  return dateOrder || String(a.title || "").localeCompare(String(b.title || ""), "ko");
}

function noteCardHtml(note) {
  const isTrash = state.filter === "trash";
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
  const category = categoryById(note.categoryId);
  const reminder = note.remindAt ? formatReminder(note.remindAt) : "";
  const reminderClass = note.remindAt && Date.parse(note.remindAt) <= Date.now() && note.reminderState === "scheduled" ? " overdue" : "";
  const updated = noteWasUpdated(note);
  const cardBody = `
      ${images}
      <div class="note-card-button">
        <h3>${escapeHtml(title)}</h3>
        ${remainder ? `<p>${escapeHtml(truncate(remainder, 700))}</p>` : ""}
      </div>
      <div class="note-meta">
        ${category ? `<span class="meta-chip">${escapeHtml(category.name)}</span>` : ""}
        ${member ? `<span class="meta-chip">${escapeHtml(member.name)} 님</span>` : ""}
        ${reminder ? `<span class="meta-chip reminder-chip${reminderClass}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 7h18s-3 0-3-7"></path><path d="M13.7 21a2 2 0 0 1-3.4 0"></path></svg>알림 ${escapeHtml(reminder)}</span>` : ""}
        ${isTrash ? `<span class="meta-chip trash-retention">${escapeHtml(trashRetentionLabel(note))}</span>` : ""}
      </div>
    `;
  const content = isTrash
    ? `<div class="note-card-open trash-card-content">${cardBody}</div>`
    : `<a class="note-card-open" data-note-open="${escapeAttribute(note.id)}" href="/memos.html?note=${encodeURIComponent(note.id)}" aria-label="${escapeAttribute(title)} 열기">${cardBody}</a>`;
  const action = isTrash
    ? `<div class="trash-card-actions"><button class="note-restore-action" data-note-restore="${escapeAttribute(note.id)}" type="button" aria-label="${escapeAttribute(title)} 복원">복원</button><button class="note-purge-action" data-note-purge="${escapeAttribute(note.id)}" type="button" aria-label="${escapeAttribute(title)} 영구 삭제">영구 삭제</button></div>`
    : `<button class="note-edit-action" data-note-edit="${escapeAttribute(note.id)}" type="button" aria-label="${escapeAttribute(title)} 수정">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"></path></svg>
        <span>수정</span>
      </button>`;
  return `<article class="note-card ${isTrash ? "trash-note-card " : ""}color-${escapeAttribute(validColor(note.color))}" data-note-card="${escapeAttribute(note.id)}">
    ${isTrash ? "" : `<button class="note-card-pin ${note.pinned ? "active" : ""}" data-note-pin="${escapeAttribute(note.id)}" type="button" aria-label="${note.pinned ? "고정 해제" : "상단 고정"}" title="${note.pinned ? "고정 해제" : "상단 고정"}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3h8"></path><path d="M9 3v6l-3 4v2h12v-2l-3-4V3"></path><path d="M12 15v6"></path></svg>
    </button>`}
    ${content}
    <div class="note-card-footer">
      <div class="note-card-timestamps">
        ${isTrash ? `<span>삭제 ${escapeHtml(formatNoteTimestamp(note.deletedAt))}</span>` : `<span>작성 ${escapeHtml(formatNoteTimestamp(note.createdAt))}</span>`}
        ${isTrash ? `<span>${escapeHtml(trashRetentionLabel(note))}</span>` : updated ? `<span>수정 ${escapeHtml(formatNoteTimestamp(note.updatedAt))}</span>` : '<span>수정 이력 없음</span>'}
      </div>
      ${action}
    </div>
  </article>`;
}

function handleGridClick(event) {
  const purgeButton = event.target.closest("[data-note-purge]");
  if (purgeButton) {
    permanentlyDeleteTrashNote(purgeButton.dataset.notePurge, purgeButton);
    return;
  }
  const restoreButton = event.target.closest("[data-note-restore]");
  if (restoreButton) {
    restoreNote(restoreButton.dataset.noteRestore, restoreButton);
    return;
  }
  const editButton = event.target.closest("[data-note-edit]");
  if (editButton) {
    openEditor(editButton.dataset.noteEdit);
    return;
  }
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

function handleCallNoteGridClick(event) {
  const picker = event.target.closest("[data-call-note-member-picker]");
  if (picker) {
    const toggle = event.target.closest("[data-call-note-member-toggle]");
    if (toggle) {
      toggleCallNoteMemberSearch(picker);
      return;
    }
    const clear = event.target.closest("[data-call-note-member-clear]");
    if (clear) {
      setCallNoteMemberSelection(picker, "");
      return;
    }
    const result = event.target.closest("[data-call-note-member-result]");
    if (result) {
      setCallNoteMemberSelection(picker, result.dataset.callNoteMemberResult);
      return;
    }
  }
  const button = event.target.closest("[data-call-note-action]");
  if (!button) return;
  const card = button.closest("[data-call-note-id]");
  if (!card) return;
  const id = card.dataset.callNoteId;
  if (button.dataset.callNoteAction === "attach") {
    void attachCallNoteImportFromCard(card, id, button);
    return;
  }
  if (button.dataset.callNoteAction === "ignore") {
    void ignoreCallNoteImport(id, button);
  }
}

function handleCallNoteGridInput(event) {
  const queryInput = event.target.closest("[data-call-note-member-query]");
  if (!queryInput) return;
  const picker = queryInput.closest("[data-call-note-member-picker]");
  if (picker) renderCallNoteMemberSearchResults(picker);
}

function toggleCallNoteMemberSearch(picker) {
  const selectedId = picker.querySelector("[data-call-note-member]")?.value || "";
  if (selectedId) return;
  const panel = picker.querySelector("[data-call-note-member-panel]");
  const toggle = picker.querySelector("[data-call-note-member-toggle]");
  const opening = panel?.classList.contains("hidden");
  document.querySelectorAll("[data-call-note-member-picker]").forEach((other) => {
    if (other !== picker) closeCallNoteMemberSearch(other);
  });
  panel?.classList.toggle("hidden", !opening);
  toggle?.setAttribute("aria-expanded", opening ? "true" : "false");
  if (opening) {
    renderCallNoteMemberSearchResults(picker);
    window.setTimeout(() => picker.querySelector("[data-call-note-member-query]")?.focus(), 0);
  }
}

function closeCallNoteMemberSearch(picker) {
  picker.querySelector("[data-call-note-member-panel]")?.classList.add("hidden");
  picker.querySelector("[data-call-note-member-toggle]")?.setAttribute("aria-expanded", "false");
}

function setCallNoteMemberSelection(picker, memberId) {
  const member = memberById(memberId);
  const input = picker.querySelector("[data-call-note-member]");
  const toggle = picker.querySelector("[data-call-note-member-toggle]");
  const clear = picker.querySelector("[data-call-note-member-clear]");
  const queryInput = picker.querySelector("[data-call-note-member-query]");
  if (input) input.value = member?.id || "";
  if (toggle) {
    const label = member
      ? [member.name || "이름 없음", member.title || ""].filter(Boolean).join(" · ")
      : "교인 검색";
    toggle.textContent = label;
    toggle.title = member ? `${label} 연결됨` : "교인 검색";
    toggle.classList.toggle("connected", Boolean(member));
    toggle.disabled = Boolean(member);
  }
  clear?.classList.toggle("hidden", !member);
  if (queryInput) queryInput.value = "";
  closeCallNoteMemberSearch(picker);
}

function renderCallNoteMemberSearchResults(picker) {
  const query = picker.querySelector("[data-call-note-member-query]")?.value
    .normalize("NFKC").trim().toLocaleLowerCase("ko-KR") || "";
  const results = picker.querySelector("[data-call-note-member-results]");
  if (!results) return;
  if (!query) {
    results.replaceChildren();
    return;
  }
  const matches = state.members.filter((member) => !member.archivedAt && [member.name, member.title]
    .join(" ").normalize("NFKC").toLocaleLowerCase("ko-KR").includes(query)).slice(0, 50);
  results.innerHTML = matches.length ? matches.map((member) => {
    const name = member.name || "이름 없음";
    const initial = Array.from(String(name).trim())[0] || "?";
    const photoUrl = memoMemberPhotoUrl(member);
    return `<button class="member-search-result" data-call-note-member-result="${escapeAttribute(member.id)}" type="button" role="option"><span class="member-result-person"><span class="member-result-avatar" aria-hidden="true"><span>${escapeHtml(initial)}</span>${photoUrl ? `<img data-member-photo src="${escapeAttribute(photoUrl)}" alt="" loading="lazy">` : ""}</span><span class="member-result-name">${escapeHtml(name)}</span></span>${member.title ? `<small>${escapeHtml(member.title)}</small>` : ""}</button>`;
  }).join("") : '<p class="member-search-empty">일치하는 교인이 없습니다.</p>';
}

async function attachCallNoteImportFromCard(card, id, button) {
  const memberId = card.querySelector("[data-call-note-member]")?.value || "";
  const summary = card.querySelector("[data-call-note-summary]")?.value.trim() || "";
  const visitDate = card.querySelector("[data-call-note-date]")?.value || todayLocalDate();
  const visitType = card.querySelector("[data-call-note-type]")?.value || "전화";
  if (!memberId) {
    toast("연결할 교인을 선택해주세요");
    return;
  }
  if (!summary) {
    toast("콜노트 내용을 입력해주세요");
    return;
  }
  button.disabled = true;
  try {
    await apiRequest(`/api/call-note-imports/${encodeURIComponent(id)}/attach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId, summary, visitDate, visitType })
    });
    state.callNoteImports = state.callNoteImports.filter((item) => item.id !== id);
    renderNotes();
    toast("콜노트를 교인의 심방내역으로 저장했습니다");
  } catch (error) {
    toast(error.message || "콜노트를 저장하지 못했습니다");
  } finally {
    button.disabled = false;
  }
}

async function ignoreCallNoteImport(id, button) {
  if (!window.confirm("이 콜노트를 미분류 목록에서 제외할까요?")) return;
  button.disabled = true;
  try {
    await apiRequest(`/api/call-note-imports/${encodeURIComponent(id)}/ignore`, { method: "POST" });
    state.callNoteImports = state.callNoteImports.filter((item) => item.id !== id);
    renderNotes();
    toast("콜노트를 목록에서 제외했습니다");
  } catch (error) {
    toast(error.message || "콜노트를 처리하지 못했습니다");
  } finally {
    button.disabled = false;
  }
}

async function restoreNote(noteId, button) {
  const note = trashNoteById(noteId);
  if (!note) return;
  button.disabled = true;
  try {
    const restored = normalizeNote(await apiRequest(`/api/notes/${encodeURIComponent(note.id)}/restore`, {
      method: "POST",
      headers: { "If-Match": String(note.revision) }
    }));
    state.trashNotes = state.trashNotes.filter((item) => item.id !== note.id);
    upsertNote(restored);
    renderNotes();
    toast("메모를 복원했습니다");
  } catch (error) {
    if (error.status === 409) await refreshTrashNotes(false, true);
    toast(error.message || "메모를 복원하지 못했습니다");
  } finally {
    button.disabled = false;
  }
}

async function permanentlyDeleteTrashNote(noteId, button) {
  const note = trashNoteById(noteId);
  if (!note || !window.confirm("이 메모를 영구 삭제할까요? 첨부 사진까지 삭제되며 다시 복원할 수 없습니다.")) return;
  button.disabled = true;
  try {
    await apiRequest(`/api/notes/${encodeURIComponent(note.id)}/permanent`, {
      method: "DELETE",
      headers: { "If-Match": String(note.revision) }
    });
    state.trashNotes = state.trashNotes.filter((item) => item.id !== note.id);
    renderNotes();
    toast("메모를 영구 삭제했습니다");
  } catch (error) {
    if (error.status === 409) await refreshTrashNotes(false, true);
    toast(error.message || "메모를 영구 삭제하지 못했습니다");
  } finally {
    button.disabled = false;
  }
}

async function emptyTrash() {
  if (state.trashEmptying || !state.trashNotes.length) return;
  if (!window.confirm(`휴지통의 메모 ${state.trashNotes.length}개를 모두 영구 삭제할까요? 첨부 사진도 삭제되며 복원할 수 없습니다.`)) return;
  state.trashEmptying = true;
  el.trashEmptyBtn.disabled = true;
  let purgedCount = 0;
  let failed = 0;
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await apiRequest("/api/notes/trash", { method: "DELETE" });
      const purgedIds = new Set(Array.isArray(result?.purgedIds) ? result.purgedIds : []);
      purgedCount += purgedIds.size;
      failed += Math.max(0, Number(result?.failed || 0));
      state.trashNotes = state.trashNotes.filter((note) => !purgedIds.has(note.id));
      renderNotes();
      if (failed || Number(result?.remaining || 0) === 0 || purgedIds.size === 0) break;
    }
    await refreshTrashNotes(false, true);
    toast(failed
      ? `${purgedCount}개를 영구 삭제했고 ${failed}개는 삭제하지 못했습니다`
      : `휴지통 메모 ${purgedCount}개를 영구 삭제했습니다`);
  } catch (error) {
    await refreshTrashNotes(false, true);
    toast(error.message || "휴지통을 비우지 못했습니다");
  } finally {
    state.trashEmptying = false;
    renderNotes();
  }
}

async function toggleNotePin(noteId, button) {
  const note = noteById(noteId);
  if (!note) return;
  button.disabled = true;
  try {
    const updated = normalizeNote(await apiRequest(`/api/notes/${encodeURIComponent(noteId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: note.revision, expectedUpdatedAt: note.updatedAt, pinned: !note.pinned })
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
  setMemberSelection("editor", note.memberId || "", { markDirty: false });
  el.editorRemindAt.value = isoToLocalDateTime(note.remindAt);
  closeEditorReminderPanel();
  updateEditorReminderControl();
  el.editorCategory.value = categoryById(note.categoryId) ? note.categoryId : "";
  el.editorPhotos.value = "";
  el.editorFileSummary.textContent = "";
  el.editorHeading.textContent = memberById(note.memberId)?.name
    ? `${memberById(note.memberId).name} 님의 메모 수정`
    : "메모 수정";
  el.editorTimestamps.innerHTML = `<span>최초 작성 ${escapeHtml(formatNoteTimestamp(note.createdAt))}</span><span>${noteWasUpdated(note) ? `마지막 수정 ${escapeHtml(formatNoteTimestamp(note.updatedAt))}` : "아직 수정되지 않음"}</span>`;
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
      expectedRevision: note.revision,
      expectedUpdatedAt: note.updatedAt,
      body,
      color: state.editorColor,
      pinned: el.editorPinned.checked,
      memberId: el.editorMemberId.value,
      categoryId: el.editorCategory.value,
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
      updated = await uploadPhoto(note.id, file, updated.revision);
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
  closeMemberSearch("editor");
  closeEditorReminderPanel();
  updateNoteUrl("");
}

async function deleteEditorNote() {
  const note = editingNote();
  if (!note || !window.confirm("이 메모를 휴지통으로 옮길까요? 메모와 첨부 사진은 30일 동안 보관됩니다.")) return;
  el.editorDeleteBtn.disabled = true;
  try {
    const tombstone = await apiRequest(`/api/notes/${encodeURIComponent(note.id)}`, {
      method: "DELETE",
      headers: { "If-Match": String(note.revision) }
    });
    state.notes = state.notes.filter((item) => item.id !== note.id);
    if (state.trashLoaded) {
      state.trashNotes = [normalizeNote({ ...note, ...tombstone }), ...state.trashNotes
        .filter((item) => item.id !== note.id)];
    }
    closeEditor();
    renderNotes();
    toast("메모를 휴지통으로 옮겼습니다");
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
      { method: "DELETE", headers: { "If-Match": String(note.revision) } }
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

async function uploadPhoto(noteId, pending, revision) {
  const { file, clientAttachmentId } = pending;
  const form = new FormData();
  form.append("photo", file, file.name);
  return normalizeNote(await apiRequest(`/api/notes/${encodeURIComponent(noteId)}/attachments`, {
    method: "POST",
    headers: {
      "If-Match": String(revision),
      "X-Client-Attachment-Id": clientAttachmentId
    },
    body: form
  }));
}

async function validSelectedPhotos(fileList, existingCount) {
  const files = Array.from(fileList || []);
  const remaining = Math.max(0, PHOTO_LIMIT - existingCount);
  if (files.length > remaining) toast(`메모 하나에는 사진을 최대 ${PHOTO_LIMIT}장까지 넣을 수 있습니다`);
  const selected = [];
  for (const file of files.slice(0, remaining)) {
    const normalizedFile = normalizeSelectedPhotoFile(file);
    if (!normalizedFile) {
      toast(`${file.name}: JPEG, PNG, WebP, GIF, HEIC, HEIF 사진만 첨부할 수 있습니다`);
      continue;
    }
    if (!file.size) {
      toast(`${file.name}: 비어 있는 사진은 첨부할 수 없습니다`);
      continue;
    }
    if (file.size > PHOTO_SOURCE_MAX_BYTES) {
      toast(`${file.name}: 원본 사진이 40MB를 넘어 처리할 수 없습니다`);
      continue;
    }
    try {
      const prepared = await preparePhotoForUpload(normalizedFile);
      if (prepared.file.size > PHOTO_RESIZE_THRESHOLD_BYTES) {
        toast(`${file.name}: 자동 축소 후에도 2MB를 넘어 첨부할 수 없습니다`);
        continue;
      }
      selected.push({ ...prepared, clientAttachmentId: crypto.randomUUID() });
    } catch (error) {
      toast(`${file.name}: ${error.message || "사진을 줄이지 못했습니다"}`);
    }
  }
  const resizedCount = selected.filter((item) => item.wasResized).length;
  if (resizedCount) toast(`큰 사진 ${resizedCount}장을 업로드용으로 자동 축소했습니다`);
  return selected;
}

function normalizeSelectedPhotoFile(file) {
  const declared = String(file.type || "").trim().toLowerCase();
  let contentType = PHOTO_TYPES.has(declared) ? declared : PHOTO_TYPE_ALIASES.get(declared) || "";
  if (!contentType && PHOTO_UNSPECIFIED_TYPES.has(declared)) {
    const extension = String(file.name || "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
    contentType = PHOTO_EXTENSION_TYPES.get(extension) || "";
  }
  if (!contentType) return null;
  return file.type === contentType
    ? file
    : new File([file], file.name, { type: contentType, lastModified: file.lastModified });
}

async function preparePhotoForUpload(file) {
  let image;
  try {
    image = await decodePhoto(file);
  } catch {
    throw new Error("사진 크기를 확인하거나 줄일 수 없습니다. JPEG 또는 PNG 사진으로 선택해주세요");
  }
  try {
    const sourceWidth = Number(image.width || image.naturalWidth || 0);
    const sourceHeight = Number(image.height || image.naturalHeight || 0);
    const longestEdge = Math.max(sourceWidth, sourceHeight);
    if (!sourceWidth || !sourceHeight) throw new Error("사진 크기를 확인하지 못했습니다");
    if (file.size <= PHOTO_RESIZE_THRESHOLD_BYTES && longestEdge <= PHOTO_MAX_EDGE) {
      return { file, wasResized: false };
    }

    const initialScale = Math.min(1, PHOTO_MAX_EDGE / longestEdge);
    let width = Math.max(1, Math.round(sourceWidth * initialScale));
    let height = Math.max(1, Math.round(sourceHeight * initialScale));
    const canvas = document.createElement("canvas");
    let blob = null;
    for (let pass = 0; pass < PHOTO_RESIZE_MAX_PASSES; pass += 1) {
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("이 브라우저에서는 사진을 줄일 수 없습니다");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);

      for (const quality of [.88, .8, .72, .64, .56, .48]) {
        blob = await canvasToBlob(canvas, "image/jpeg", quality);
        if (blob.size <= PHOTO_TARGET_BYTES) break;
      }
      if (blob?.size <= PHOTO_RESIZE_THRESHOLD_BYTES) break;

      const sizeScale = Math.sqrt(PHOTO_TARGET_BYTES / blob.size) * .95;
      const nextScale = Math.min(.85, Math.max(.5, sizeScale));
      const nextWidth = Math.max(1, Math.floor(width * nextScale));
      const nextHeight = Math.max(1, Math.floor(height * nextScale));
      if (nextWidth === width && nextHeight === height) break;
      width = nextWidth;
      height = nextHeight;
    }
    if (!blob) throw new Error("사진 변환 결과를 만들지 못했습니다");
    if (blob.size > PHOTO_RESIZE_THRESHOLD_BYTES) {
      throw new Error("자동 축소 후에도 2MB를 넘어 첨부할 수 없습니다");
    }
    const baseName = String(file.name || "photo").replace(/\.[^.]+$/, "") || "photo";
    return {
      file: new File([blob], `${baseName}.jpg`, { type: "image/jpeg", lastModified: Date.now() }),
      wasResized: true
    };
  } finally {
    if (typeof image?.close === "function") image.close();
  }
}

async function decodePhoto(file) {
  if (typeof window.createImageBitmap === "function") {
    try {
      return await window.createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      try {
        return await window.createImageBitmap(file);
      } catch {
        // Fall through to the object URL image decoder for browser compatibility.
      }
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("사진을 읽지 못했습니다"));
    };
    image.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("사진을 변환하지 못했습니다"));
    }, type, quality);
  });
}

function renderFileSummary(target, files) {
  if (!files.length) {
    target.textContent = "";
    return;
  }
  const resizedCount = files.filter((item) => item.wasResized).length;
  target.textContent = `사진 ${files.length}장 선택됨${resizedCount ? ` · ${resizedCount}장 자동 축소` : ""}`;
}

function renderMemberScope() {
  const member = state.filter === "trash" ? null : memberById(state.memberScopeId);
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
  const deletedAt = String(note?.deletedAt || "");
  const deletedAtMs = Date.parse(deletedAt);
  const legacyCategory = ["personal", "visitation", "admin"].includes(note?.category) ? note.category : "personal";
  const categoryId = note?.categoryId === undefined || note?.categoryId === null
    ? legacyCategory
    : String(note.categoryId).trim().toLowerCase();
  const categoryName = String(note?.categoryName || categoryById(categoryId)?.name || "");
  const derivedTrashExpiresAt = Number.isFinite(deletedAtMs)
    ? new Date(deletedAtMs + 30 * 24 * 60 * 60 * 1000).toISOString()
    : "";
  return {
    ...note,
    revision: Math.max(1, Number(note?.revision || 1)),
    category: ["personal", "visitation", "admin"].includes(categoryId) ? categoryId : "personal",
    categoryId,
    categoryName,
    deletedAt,
    trashExpiresAt: String(note?.trashExpiresAt || derivedTrashExpiresAt),
    trashDaysRemaining: Math.max(0, Number(note?.trashDaysRemaining || 0)),
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
function trashNoteById(id) { return state.trashNotes.find((note) => note.id === id); }
function editingNote() { return noteById(state.editingId); }
function memberById(id) { return state.members.find((member) => member.id === id); }
function categoryById(id) { return state.noteCategories.find((category) => category.id === id); }

function todayLocalDate() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60 * 1000);
  return local.toISOString().slice(0, 10);
}

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

function formatNoteTimestamp(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "날짜 없음";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"
  }).format(timestamp);
}

function trashRetentionLabel(note) {
  const expiresAt = Date.parse(note?.trashExpiresAt || "");
  const days = Number.isFinite(expiresAt)
    ? Math.max(0, Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000)))
    : Math.max(0, Number(note?.trashDaysRemaining || 0));
  return days > 0 ? `영구 삭제까지 ${days}일` : "곧 영구 삭제 예정";
}

function noteWasUpdated(note) {
  const createdAt = Date.parse(note?.createdAt || "");
  const updatedAt = Date.parse(note?.updatedAt || "");
  return Number.isFinite(createdAt) && Number.isFinite(updatedAt) && updatedAt > createdAt;
}

function readSavedSort() {
  try {
    const value = window.localStorage.getItem("community.memoSort") || "";
    return NOTE_SORT_OPTIONS.has(value) ? value : "updated-desc";
  } catch {
    return "updated-desc";
  }
}

function saveSortPreference(value) {
  try {
    window.localStorage.setItem("community.memoSort", value);
  } catch {
    // Sorting still works for the current page when storage is unavailable.
  }
}

function readSavedMemoLayout() {
  try {
    const value = window.localStorage.getItem("community.memoLayout") || "grid";
    return MEMO_LAYOUT_OPTIONS.has(value) ? value : "grid";
  } catch {
    return "grid";
  }
}

function saveMemoLayoutPreference(value) {
  try {
    window.localStorage.setItem("community.memoLayout", value);
  } catch {
    // The chosen layout still works for the current page when storage is unavailable.
  }
}

function setMemoLayout(layout) {
  state.layout = MEMO_LAYOUT_OPTIONS.has(layout) ? layout : "grid";
  saveMemoLayoutPreference(state.layout);
  applyMemoLayout();
}

function applyMemoLayout() {
  const list = state.layout === "list";
  el.pinnedGrid.classList.toggle("list-layout", list);
  el.notesGrid.classList.toggle("list-layout", list);
  el.callNoteGrid.classList.toggle("list-layout", list);
  el.gridLayoutBtn.classList.toggle("active", !list);
  el.listLayoutBtn.classList.toggle("active", list);
  el.gridLayoutBtn.setAttribute("aria-pressed", list ? "false" : "true");
  el.listLayoutBtn.setAttribute("aria-pressed", list ? "true" : "false");
}

function autoResize(textarea) {
  textarea.style.height = "auto";
  const viewportHeight = window.visualViewport?.height || window.innerHeight || 800;
  const maxHeight = textarea === el.editorBody
    ? Math.max(180, Math.min(520, Math.floor(viewportHeight * 0.5)))
    : 420;
  const naturalHeight = textarea.scrollHeight;
  textarea.style.height = `${Math.min(naturalHeight, maxHeight)}px`;
  textarea.style.overflowY = naturalHeight > maxHeight ? "auto" : "hidden";
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
