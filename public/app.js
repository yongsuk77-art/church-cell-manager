const ROLES = [
  { value: "", label: "일반" },
  { value: "cell_leader", label: "셀장" },
  { value: "assistant_leader", label: "부셀장" },
  { value: "prayer_leader", label: "기도장" }
];

const INITIAL_CELLS = [
  { id: "male-8", name: "남자 8셀", meta: "66~68년생", gender: "남자", sortOrder: 10 },
  { id: "male-16", name: "남자 16셀", meta: "90년생이하", gender: "남자", sortOrder: 20 },
  { id: "female-3", name: "여자 3셀", meta: "47~48년생", gender: "여자", sortOrder: 30 },
  { id: "female-9", name: "여자 9셀", meta: "58년생", gender: "여자", sortOrder: 40 },
  { id: "female-15", name: "여자 15셀", meta: "66년생", gender: "여자", sortOrder: 50 },
  { id: "female-25", name: "여자 25셀", meta: "77년생", gender: "여자", sortOrder: 60 },
  { id: "female-33", name: "여자 33셀", meta: "86~87년생", gender: "여자", sortOrder: 70 }
];

const PHOTO_VERSION = "20260704-photo-fix-2";

const seedRows = [];

const INITIAL_MEMBERS = seedRows.map((row, index) => ({
  id: `seed-${String(index + 1).padStart(3, "0")}`,
  cellId: row[0],
  name: row[1],
  title: row[2] || "",
  role: row[3] || "",
  phone: "",
  homePhone: "",
  birth: "",
  registeredAt: "",
  baptized: true,
  address: "",
  memo: "",
  photoUrl: `photos/seed-${String(index + 1).padStart(3, "0")}.jpg?v=${PHOTO_VERSION}`,
  photoKey: "",
  photoRemoved: false,
  archivedAt: "",
  createdAt: "2026-07-04T00:00:00.000Z",
  updatedAt: "2026-07-04T00:00:00.000Z"
}));

const STORE_KEY = "seosanch-cell:v1";
const DEFAULT_COMMUNITY_TITLE = "남아메리카 공동체";

const state = {
  settings: {
    communityTitle: DEFAULT_COMMUNITY_TITLE
  },
  cells: [],
  members: [],
  visits: [],
  selectedCellId: "",
  selectedMemberId: "",
  query: "",
  showArchived: false,
  mode: "view",
  pendingPhotoData: null,
  selectedVisitDate: "",
  selectedVisitMonth: "",
  attendanceSessions: [],
  attendanceDate: "",
  attendanceRecords: [],
  attendancePresentIds: [],
  callNoteImports: [],
  editingVisitId: "",
  apiOnline: false
};

const el = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindElements();
  bindEvents();
  el.memberBirth.maxLength = 10;
  populateRoleOptions();
  await loadState();
  state.selectedCellId = state.selectedCellId || state.cells[0]?.id || "";
  render();
}

function bindElements() {
  [
    "workspace", "cellTabs", "searchInput", "showArchived", "memberGrid", "cellTitle", "cellMeta",
    "activeCount", "archivedCount", "addMemberBtn", "visitDatesBtn", "attendanceBtn", "attendanceModal", "attendanceCloseBtn", "attendancePrevBtn", "attendanceNextBtn",
    "attendanceDate", "attendanceDateLabel", "attendanceHistory", "attendanceSummary", "attendanceCellStats", "attendanceMemberGrid", "attendanceResults",
    "attendanceSaveBtn", "attendanceClearBtn", "settingsBtn", "settingsModal", "settingsForm", "settingsCloseBtn", "settingsCancelBtn", "logoutBtn",
    "communityTitleText", "communityTitleInput", "saveCommunityTitleBtn", "currentPassword", "newPassword", "confirmPassword", "callNoteRefreshBtn", "callNoteWebhookUrl", "callNoteTokenBtn", "callNoteTokenReissueBtn", "callNoteTokenOutput", "callNoteStatus", "callNoteInbox", "visitDatesModal", "visitDatesCloseBtn", "visitMonthPrevBtn", "visitMonthNextBtn", "visitMonthLabel", "visitCalendar", "visitDateSelectedLabel", "visitDateEntries", "visitRecordModal", "visitRecordCloseBtn", "detailPanel", "emptyDetail",
    "memberForm", "formMode", "formTitle", "backToListBtn", "basicInfoJumpBtn", "bottomBackToListBtn", "closePanelBtn", "photoPreview", "profileDetails", "openVisitRecordBtn",
    "photoInput", "memberName", "memberTitle", "memberCell",
    "memberRole", "memberBaptismStatus", "memberPhone", "memberHomePhone", "memberBirth", "memberBirthCalendar", "memberRegisteredAt", "memberRegisteredAtPicker", "memberRegisteredAtPickerBtn", "memberAge", "memberCalendar", "memberAddress", "memberLongAbsent", "memberMemo", "memberPrayer",
    "archiveBtn", "restoreBtn", "deleteBtn", "visitCount", "visitDate",
    "visitType", "visitSummary", "addVisitBtn", "visitSubmitLabel", "cancelVisitEditBtn", "visitList",
    "toast"
  ].forEach((id) => {
    el[id] = document.getElementById(id);
  });
}

function bindEvents() {
  el.searchInput.addEventListener("input", () => {
    state.query = el.searchInput.value.trim();
    renderMembers();
  });

  el.showArchived.addEventListener("change", () => setShowArchived(el.showArchived.checked));
  el.archivedCount.addEventListener("click", toggleShowArchived);

  el.addMemberBtn.addEventListener("click", startNewMember);
  el.visitDatesBtn.addEventListener("click", openVisitDates);
  el.attendanceBtn.addEventListener("click", openSundayAttendance);
  el.attendanceCloseBtn.addEventListener("click", closeSundayAttendance);
  el.attendancePrevBtn.addEventListener("click", () => shiftSundayAttendanceDate(-7));
  el.attendanceNextBtn.addEventListener("click", () => shiftSundayAttendanceDate(7));
  el.attendanceDate.addEventListener("change", () => loadSundayAttendanceDate(el.attendanceDate.value));
  el.attendanceSaveBtn.addEventListener("click", saveSundayAttendance);
  el.attendanceClearBtn.addEventListener("click", clearSundayAttendance);
  el.attendanceSummary.addEventListener("click", scrollToAttendanceResults);
  el.attendanceSummary.addEventListener("keydown", handleAttendanceSummaryKeydown);
  el.attendanceResults.addEventListener("click", (event) => {
    const button = closestElement(event.target, "[data-attendance-scroll-top]");
    if (button) {
      scrollToAttendanceChecklist();
      return;
    }
    const detailButton = closestElement(event.target, "[data-attendance-member-detail]");
    if (detailButton) {
      closeSundayAttendance();
      selectMember(detailButton.dataset.attendanceMemberDetail);
    }
  });
  el.attendanceMemberGrid.addEventListener("click", (event) => {
    const button = closestElement(event.target, "[data-attendance-member-id]");
    if (button) toggleSundayAttendanceMember(button.dataset.attendanceMemberId);
  });
  el.attendanceHistory.addEventListener("click", (event) => {
    const button = closestElement(event.target, "[data-attendance-date]");
    if (button) loadSundayAttendanceDate(button.dataset.attendanceDate);
  });
  el.attendanceModal.addEventListener("click", (event) => {
    if (event.target === el.attendanceModal) closeSundayAttendance();
  });
  el.visitDatesCloseBtn.addEventListener("click", closeVisitDates);
  el.visitDatesModal.addEventListener("click", (event) => {
    if (event.target === el.visitDatesModal) closeVisitDates();
  });
  el.visitMonthPrevBtn.addEventListener("click", () => shiftVisitCalendarMonth(-1));
  el.visitMonthNextBtn.addEventListener("click", () => shiftVisitCalendarMonth(1));
  el.openVisitRecordBtn.addEventListener("click", openVisitRecord);
  el.visitRecordCloseBtn.addEventListener("click", closeVisitRecord);
  el.visitRecordModal.addEventListener("click", (event) => {
    if (event.target === el.visitRecordModal) closeVisitRecord();
  });
  el.backToListBtn.addEventListener("click", closeDetail);
  el.basicInfoJumpBtn.addEventListener("click", jumpToBasicInfo);
  el.bottomBackToListBtn.addEventListener("click", closeDetail);
  el.settingsBtn.addEventListener("click", openSettings);
  el.settingsCloseBtn.addEventListener("click", closeSettings);
  el.settingsCancelBtn.addEventListener("click", closeSettings);
  el.settingsModal.addEventListener("click", (event) => {
    if (event.target === el.settingsModal) closeSettings();
  });
  el.settingsForm.addEventListener("submit", changePassword);
  el.saveCommunityTitleBtn.addEventListener("click", saveCommunityTitle);
  el.callNoteRefreshBtn.addEventListener("click", loadCallNoteImports);
  el.callNoteTokenBtn.addEventListener("click", viewCallNoteToken);
  el.callNoteTokenReissueBtn.addEventListener("click", reissueCallNoteToken);
  el.callNoteInbox.addEventListener("click", handleCallNoteInboxClick);
  el.logoutBtn.addEventListener("click", () => {
    window.location.href = "/__auth/logout";
  });
  el.closePanelBtn.addEventListener("click", closeDetail);
  el.memberForm.addEventListener("submit", saveMember);
  el.photoInput.addEventListener("change", handlePhotoPick);
  el.memberPhone.addEventListener("input", () => formatPhoneField(el.memberPhone, "mobile"));
  el.memberHomePhone.addEventListener("input", () => formatPhoneField(el.memberHomePhone, "landline"));
  el.memberBirth.addEventListener("input", formatBirthField);
  el.memberBirth.addEventListener("change", formatBirthField);
  el.memberBirthCalendar.addEventListener("change", updateBirthAge);
  el.memberRegisteredAt.addEventListener("input", formatRegisteredAtField);
  el.memberRegisteredAt.addEventListener("change", formatRegisteredAtField);
  el.memberRegisteredAtPicker.addEventListener("change", () => {
    el.memberRegisteredAt.value = el.memberRegisteredAtPicker.value;
  });
  el.memberRegisteredAtPickerBtn.addEventListener("click", openRegisteredAtPicker);
  el.archiveBtn.addEventListener("click", archiveSelected);
  el.restoreBtn.addEventListener("click", restoreSelected);
  el.deleteBtn.addEventListener("click", deleteSelected);
  el.addVisitBtn.addEventListener("click", addVisit);
  el.cancelVisitEditBtn.addEventListener("click", cancelVisitEdit);
}

function setShowArchived(value) {
  state.showArchived = Boolean(value);
  updateArchiveVisibilityControls();
  persist();
  renderMembers();
}

function toggleShowArchived() {
  setShowArchived(!state.showArchived);
}

function updateArchiveVisibilityControls() {
  el.showArchived.checked = state.showArchived;
  el.archivedCount.classList.toggle("active", state.showArchived);
  el.archivedCount.setAttribute("aria-pressed", state.showArchived ? "true" : "false");
  el.archivedCount.title = state.showArchived ? "제적처리 숨기기" : "제적처리 포함해서 보기";
}

function populateRoleOptions() {
  el.memberRole.innerHTML = ROLES.map((role) => `<option value="${role.value}">${role.label}</option>`).join("");
}

async function loadState() {
  const local = readLocal();
  state.settings = local.settings || { communityTitle: DEFAULT_COMMUNITY_TITLE };
  state.cells = local.cells;
  state.members = local.members;
  state.visits = local.visits;
  state.attendanceSessions = local.attendanceSessions;
  state.selectedCellId = local.selectedCellId || "";
  state.showArchived = Boolean(local.showArchived);
  el.showArchived.checked = state.showArchived;

  try {
    const response = await fetch("/api/bootstrap", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("api unavailable");
    const data = await response.json();
    if (Array.isArray(data.cells) && data.cells.length) {
      state.settings = {
        ...state.settings,
        ...(data.settings || {})
      };
      state.cells = data.cells;
      state.members = data.members || [];
      hydrateSeedPhotoUrls(state.members);
      applyMemberDetails(state.members);
      state.visits = data.visits || [];
      state.apiOnline = true;
    }
  } catch {
    state.apiOnline = false;
  }
}

function readLocal() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (saved?.cells?.length && Array.isArray(saved.members)) {
      hydrateSeedPhotoUrls(saved.members);
      applyMemberDetails(saved.members);
      return {
        settings: saved.settings || { communityTitle: DEFAULT_COMMUNITY_TITLE },
        cells: saved.cells,
        members: saved.members,
        visits: saved.visits || [],
        attendanceSessions: saved.attendanceSessions || [],
        selectedCellId: saved.selectedCellId || "",
        showArchived: saved.showArchived || false
      };
    }
  } catch {
    localStorage.removeItem(STORE_KEY);
  }
  const initialMembers = structuredClone(INITIAL_MEMBERS);
  hydrateSeedPhotoUrls(initialMembers);
  applyMemberDetails(initialMembers);
  return {
    settings: { communityTitle: DEFAULT_COMMUNITY_TITLE },
    cells: structuredClone(INITIAL_CELLS),
    members: initialMembers,
    visits: [],
    attendanceSessions: [],
    selectedCellId: INITIAL_CELLS[0]?.id || "",
    showArchived: false
  };
}

function hydrateSeedPhotoUrls(members) {
  members.forEach((member) => {
    if (member.id?.startsWith("seed-") && !member.photoRemoved && !member.photoKey) {
      const isSeedPhoto = !member.photoUrl || member.photoUrl.includes(`photos/${member.id}.jpg`);
      if (isSeedPhoto) member.photoUrl = `photos/${member.id}.jpg?v=${PHOTO_VERSION}`;
    }
  });
}

function applyMemberDetails(members) {
  const details = window.MEMBER_DETAILS || {};
  members.forEach((member) => {
    const detail = details[member.id];
    if (!detail) return;
    if (member.id?.startsWith("seed-")) {
      member.phone = member.phone || detail.phone || "";
      member.homePhone = member.homePhone || detail.homePhone || "";
      member.birth = mergeBirthDetail(member.birth, detail.birth);
      member.registeredAt = member.registeredAt || detail.registeredAt || "";
      member.address = member.address || detail.address || "";
      member.memo = mergeDetailMemo(member.memo, detail.memo);
      return;
    }
    if (!member.phone && detail.phone) member.phone = detail.phone;
    if (!member.homePhone && detail.homePhone) member.homePhone = detail.homePhone;
    member.birth = mergeBirthDetail(member.birth, detail.birth);
    if (!member.registeredAt && detail.registeredAt) member.registeredAt = detail.registeredAt;
    if (!member.address && detail.address) member.address = detail.address;
    member.memo = mergeDetailMemo(member.memo, detail.memo);
  });
}

function mergeBirthDetail(currentBirth, detailBirth) {
  const current = String(currentBirth || "").trim();
  const detail = String(detailBirth || "").trim();
  if (!current) return detail;
  if (!detail) return current;

  const currentParsed = parseBirthValue(current);
  const detailParsed = parseBirthValue(detail);
  if (detailParsed.marker !== "\uC74C" || currentParsed.marker === "\uC74C") return current;

  const date = currentParsed.date || detailParsed.date;
  if (!date) return current;
  const age = calculateAge(date);
  return [date, "\uC74C", Number.isFinite(age) ? "(" + age + "\uC138)" : ""].filter(Boolean).join(" ");
}

function mergeDetailMemo(currentMemo, detailMemo) {
  const current = String(currentMemo || "").trim();
  const detail = String(detailMemo || "").trim();
  if (!current) return detail;
  if (!detail) return current;

  const childPrefix = "\uC790\uB140:";
  const currentLines = current.split("\n").map((line) => line.trim()).filter(Boolean);
  const hasChildLine = currentLines.some((line) => line.startsWith(childPrefix));
  if (hasChildLine) return current;

  const childLines = detail.split("\n").map((line) => line.trim()).filter((line) => line.startsWith(childPrefix));
  if (!childLines.length) return current;
  return [...currentLines, ...childLines].join("\n");
}

function persist() {
  localStorage.setItem(STORE_KEY, JSON.stringify({
    settings: state.settings,
    cells: state.cells,
    members: state.members,
    visits: state.visits,
    attendanceSessions: state.attendanceSessions,
    selectedCellId: state.selectedCellId,
    showArchived: state.showArchived
  }));
}

function render() {
  renderCommunityTitle();
  renderCellTabs();
  renderCellSelect();
  renderMembers();
  renderDetail();
  updateMobileDetailState();
}

function renderCellTabs() {
  el.cellTabs.innerHTML = state.cells
    .slice()
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
    .map((cell) => {
      const count = state.members.filter((member) => member.cellId === cell.id && !member.archivedAt && !member.trashedAt).length;
      return `<button class="cell-tab ${cellGenderClass(cell)} ${cell.id === state.selectedCellId ? "active" : ""}" data-cell-id="${cell.id}" type="button">
        <strong>${cellNameHtml(cell.name)}</strong>
        <span class="cell-tab-count">${count}명</span>
      </button>`;
    })
    .join("");

  el.cellTabs.querySelectorAll("[data-cell-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedCellId = button.dataset.cellId;
      state.selectedMemberId = "";
      persist();
      render();
    });
  });
}

function cellNameHtml(name) {
  const text = String(name || "").trim();
  const match = /^(남자|여자)\s*(\d+)셀$/.exec(text);
  if (!match) return escapeHtml(text);
  return '<span class="cell-tab-gender">' + escapeHtml(match[1]) + '</span><span class="cell-tab-number">' + escapeHtml(match[2]) + '셀</span>';
}

function cellGenderClass(cell) {
  const text = `${cell?.id || ""} ${cell?.name || ""} ${cell?.gender || ""}`;
  if (/female|여자/.test(text)) return "gender-female";
  if (/male|남자/.test(text)) return "gender-male";
  return "";
}

function renderCellSelect() {
  el.memberCell.innerHTML = state.cells
    .map((cell) => `<option value="${cell.id}">${escapeHtml(cell.name)} ${escapeHtml(cell.meta || "")}</option>`)
    .join("");
}


function renderMembers() {
  const cell = currentCell();
  if (!cell) return;

  const rawQuery = state.query.trim();
  const isSearching = Boolean(rawQuery);
  const availableMembers = state.members.filter((member) => !member.trashedAt);
  const allInCell = availableMembers.filter((member) => member.cellId === cell.id);
  const active = allInCell.filter((member) => !member.archivedAt);
  const archived = allInCell.filter((member) => member.archivedAt);

  const baseMembers = isSearching ? availableMembers : allInCell;
  const visible = baseMembers
    .filter((member) => state.showArchived || !member.archivedAt)
    .filter((member) => !isSearching || memberMatchesSearch(member, rawQuery))
    .sort((a, b) => compareMembersForDisplay(a, b, isSearching));

  if (isSearching) {
    const archivedMatches = availableMembers.filter((member) => member.archivedAt && memberMatchesSearch(member, rawQuery)).length;
    el.cellTitle.textContent = "\uC804\uCCB4 \uAC80\uC0C9 \uACB0\uACFC";
    el.cellMeta.textContent = rawQuery;
    el.activeCount.textContent = `\uAC80\uC0C9 ${visible.length}\uBA85`;
    el.archivedCount.textContent = state.showArchived ? "제적처리 포함" : (archivedMatches ? `제적처리 ${archivedMatches}명 숨김` : "제적처리 제외");
  } else {
    el.cellTitle.textContent = cell.name;
    el.cellMeta.textContent = cell.meta || cell.gender || "";
    el.activeCount.textContent = `${active.length}\uBA85`;
    el.archivedCount.textContent = `제적처리 ${archived.length}명`;
  }
  updateArchiveVisibilityControls();

  if (!visible.length) {
    const emptyTitle = isSearching ? "\uAC80\uC0C9 \uACB0\uACFC \uC5C6\uC74C" : "\uACB0\uACFC \uC5C6\uC74C";
    const emptyHint = isSearching ? "\uC774\uB984, \uC804\uD654, \uC9D1\uC804\uD654, \uAC00\uC871/\uC790\uB140\uBA54\uBAA8\uB97C \uD655\uC778\uD558\uC138\uC694" : "\uAC80\uC0C9 \uC870\uAC74\uC744 \uC870\uC815\uD558\uC138\uC694";
    el.memberGrid.classList.remove("sectioned");
    el.memberGrid.innerHTML = `<div class="member-card"><span class="member-name">${emptyTitle}</span><span class="member-sub">${emptyHint}</span></div>`;
    return;
  }

  el.memberGrid.classList.toggle("sectioned", !isSearching && visible.some((member) => member.longAbsent));
  el.memberGrid.innerHTML = memberGridHtml(visible, isSearching);
  el.memberGrid.querySelectorAll("[data-member-id]").forEach((button) => {
    button.addEventListener("click", () => selectMember(button.dataset.memberId));
  });
}

function renderCommunityTitle() {
  const title = cleanTitle(state.settings?.communityTitle);
  if (el.communityTitleText) el.communityTitleText.textContent = title;
  document.title = `${title} 교구관리`;
}

function memberGridHtml(members, isSearching) {
  if (isSearching) return members.map((member) => memberCardHtml(member, true)).join("");

  const regularMembers = members.filter((member) => !member.longAbsent);
  const longAbsentMembers = members.filter((member) => member.longAbsent);
  if (!longAbsentMembers.length) return regularMembers.map((member) => memberCardHtml(member)).join("");

  return [
    regularMembers.length ? memberSectionHtml("셀원", regularMembers) : "",
    memberSectionHtml("장기결석자", longAbsentMembers, "long-absent")
  ].join("");
}

function memberSectionHtml(title, members, extraClass = "") {
  return `<section class="member-section ${extraClass}">
    <div class="member-section-head">
      <strong>${escapeHtml(title)}</strong>
      <span>${members.length}명</span>
    </div>
    <div class="member-section-grid">
      ${members.map((member) => memberCardHtml(member)).join("")}
    </div>
  </section>`;
}

function compareMembersForDisplay(a, b, isSearching = false) {
  if (isSearching) {
    const cellDiff = cellSortRank(a.cellId) - cellSortRank(b.cellId);
    if (cellDiff) return cellDiff;
  }

  const roleDiff = roleSortRank(a.role) - roleSortRank(b.role);
  if (roleDiff) return roleDiff;

  const nameDiff = compareKoreanNames(a.name, b.name);
  if (nameDiff) return nameDiff;

  return String(a.id || "").localeCompare(String(b.id || ""), "ko-KR", { numeric: true });
}

function roleSortRank(role) {
  const ranks = {
    cell_leader: 0,
    assistant_leader: 1,
    prayer_leader: 2
  };
  return Object.prototype.hasOwnProperty.call(ranks, role) ? ranks[role] : 10;
}

function cellSortRank(cellId) {
  const cell = state.cells.find((item) => item.id === cellId);
  return cell?.sortOrder ?? 9999;
}

function compareKoreanNames(a, b) {
  return String(a || "").localeCompare(String(b || ""), "ko-KR", {
    sensitivity: "base",
    numeric: true
  });
}

function memberMatchesSearch(member, rawQuery) {
  const textQuery = normalizeSearchText(rawQuery);
  const phoneQuery = normalizePhoneSearch(rawQuery);
  const fields = [
    member.name,
    member.title,
    member.phone,
    member.homePhone,
    member.birth,
    member.registeredAt,
    member.baptized ? "세례" : "미세례",
    member.address,
    member.memo,
    memberCellLabel(member),
    memberRoleLabel(member),
    member.longAbsent ? "장기결석자 장기결석" : ""
  ];
  const searchText = normalizeSearchText(fields.join(" "));
  if (textQuery && searchText.includes(textQuery)) return true;
  if (phoneQuery) {
    return [member.phone, member.homePhone]
      .filter(Boolean)
      .some((value) => normalizePhoneSearch(value).includes(phoneQuery));
  }
  return false;
}

function normalizeSearchText(value) {
  return String(value ?? "").toLocaleLowerCase("ko-KR").replace(/\s+/g, " ").trim();
}

function normalizePhoneSearch(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function formatPhoneNumber(value, kind = "mobile") {
  const digits = normalizePhoneSearch(value).slice(0, 11);
  if (!digits) return "";

  if (kind === "landline") {
    if (digits.startsWith("02")) {
      if (digits.length <= 2) return digits;
      if (digits.length <= 5) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
      if (digits.length <= 9) return `${digits.slice(0, 2)}-${digits.slice(2, 5)}-${digits.slice(5)}`;
      return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6, 10)}`;
    }
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
    if (digits.length <= 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
    return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7, 11)}`;
  }

  if (digits.length <= 3) return digits;
  if (digits.length <= 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7, 11)}`;
}

function formatPhoneField(field, kind) {
  field.value = formatPhoneNumber(field.value, kind);
}

function memberCellLabel(member) {
  const cell = state.cells.find((item) => item.id === member.cellId);
  return cell ? `${cell.name} ${cell.meta || ""}`.trim() : "";
}

function memberRoleLabel(member) {
  return ROLES.find((item) => item.value === member.role)?.label || "";
}

function memberNameHtml(member, fallback = "이름 없음") {
  return escapeHtml(member.name || fallback);
}

function newMemberBadgeHtml(member) {
  return isNewMember(member) ? '<span class="new-member-badge">새신자</span>' : "";
}

function memberCardHtml(member, showCell = false) {
  const role = memberRoleLabel(member);
  const cellLabel = showCell ? memberCellLabel(member) : "";
  return `<button class="member-card ${member.id === state.selectedMemberId ? "selected" : ""} ${member.archivedAt ? "archived" : ""} ${member.longAbsent ? "long-absent" : ""}" data-member-id="${member.id}" type="button">
    ${portraitHtml(member)}
    <span>
      <span class="member-name">${memberNameHtml(member)}</span>
      <span class="member-sub">${escapeHtml(member.title || "\uC9C1\uBD84 \uC5C6\uC74C")}</span>
      ${cellLabel ? `<span class="member-cell">${escapeHtml(cellLabel)}</span>` : ""}
      ${role && member.role ? `<span class="role-chip">${escapeHtml(role)}</span>` : ""}
      ${newMemberBadgeHtml(member)}
      ${member.longAbsent ? '<span class="long-absent-chip">장기결석</span>' : ""}
    </span>
  </button>`;
}

function portraitHtml(member, large = false) {
  const classes = `portrait ${large ? "large" : ""}`;
  const src = member.photoUrl || (member.photoKey ? `/api/photos/${encodeURIComponent(member.photoKey)}` : "");
  if (src) {
    return `<span class="${classes}"><img src="${escapeAttribute(src)}" alt="${escapeAttribute(member.name)}"></span>`;
  }
  return `<span class="${classes}" aria-hidden="true">${escapeHtml(initials(member.name))}</span>`;
}

function updatePhotoPreview(member) {
  el.photoPreview.outerHTML = portraitHtml(member, true)
    .replace("<span", "<div id=\"photoPreview\"")
    .replace("</span>", "</div>");
  el.photoPreview = document.getElementById("photoPreview");
}

function selectMember(memberId) {
  const member = state.members.find((item) => item.id === memberId);
  if (member?.cellId) state.selectedCellId = member.cellId;
  state.selectedMemberId = memberId;
  state.mode = "view";
  state.pendingPhotoData = null;
  state.editingVisitId = "";
  persist();
  renderCellTabs();
  renderMembers();
  renderDetail();
  scrollToSelectedDetail();
}

function renderDetail() {
  const member = selectedMember();
  if (!member) {
    hideVisitRecord();
    el.emptyDetail.classList.remove("hidden");
    el.memberForm.classList.add("hidden");
    return;
  }

  el.emptyDetail.classList.add("hidden");
  el.memberForm.classList.remove("hidden");
  el.formMode.textContent = isDraftMember(member) ? "신규" : "상세";
  el.formTitle.innerHTML = member.name
    ? `<span>${memberNameHtml(member)}</span>${newMemberBadgeHtml(member)}`
    : "성도 정보";
  updatePhotoPreview(member);

  el.memberName.value = member.name || "";
  el.memberTitle.value = member.title || "";
  el.memberCell.value = member.cellId || state.selectedCellId;
  el.memberRole.value = member.role || "";
  el.memberBaptismStatus.value = member.baptized ? "1" : "0";
  el.memberPhone.value = formatPhoneNumber(member.phone || "", "mobile");
  el.memberHomePhone.value = formatPhoneNumber(member.homePhone || "", "landline");
  const birth = parseBirthValue(member.birth);
  el.memberBirth.value = birth.date || "";
  el.memberBirthCalendar.value = birth.marker === "\uC74C" ? "lunar" : "solar";
  el.memberRegisteredAt.value = formatDateInputValue(member.registeredAt || "");
  el.memberRegisteredAtPicker.value = parseDateValue(el.memberRegisteredAt.value) ? el.memberRegisteredAt.value : "";
  el.memberAge.value = birth.date ? ageLabel(birth.date) : (birth.age ? birth.age + "\uC138" : "");
  renderLunarMarker(birth.marker);
  el.memberAddress.value = member.address || "";
  el.memberLongAbsent.checked = Boolean(member.longAbsent);
  el.memberMemo.value = member.memo || "";
  el.memberPrayer.value = member.prayerRequests || "";
  el.profileDetails.open = false;
  hideVisitRecord();
  el.archiveBtn.classList.toggle("hidden", Boolean(member.archivedAt));
  el.restoreBtn.classList.toggle("hidden", !member.archivedAt);
  el.deleteBtn.classList.toggle("hidden", isDraftMember(member));
  renderVisits(member.id);
  updateMobileDetailState();
}

function startNewMember() {
  const draft = state.members.find(isDraftMember);
  if (draft) {
    state.selectedCellId = draft.cellId || state.selectedCellId;
    state.selectedMemberId = draft.id;
    render();
    scrollToSelectedDetail();
    el.memberName.focus();
    return;
  }

  const now = new Date().toISOString();
  const member = {
    id: `new-${crypto.randomUUID()}`,
    localDraft: true,
    cellId: state.selectedCellId,
    name: "",
    title: "",
    role: "",
    phone: "",
    homePhone: "",
    birth: "",
    registeredAt: "",
    baptized: true,
    address: "",
    memo: "",
    prayerRequests: "",
    longAbsent: false,
    photoUrl: "",
    photoKey: "",
    archivedAt: "",
    trashedAt: "",
    createdAt: now,
    updatedAt: now
  };
  state.members.push(member);
  state.selectedMemberId = member.id;
  state.pendingPhotoData = null;
  render();
  scrollToSelectedDetail();
  el.memberName.focus();
}

async function saveMember(event) {
  event.preventDefault();
  const member = selectedMember();
  if (!member) return;

  const wasNew = isDraftMember(member);
  const birthDate = formatBirthDateInput(el.memberBirth.value);
  const registeredAt = formatDateInputValue(el.memberRegisteredAt.value);
  el.memberBirth.value = birthDate;
  if (birthDate && !parseDateValue(birthDate)) {
    toast("생년월일은 1950-01-01 형식으로 입력하세요");
    el.memberBirth.focus();
    return;
  }
  el.memberRegisteredAt.value = registeredAt;
  if (registeredAt && !parseDateValue(registeredAt)) {
    toast("교회등록일은 2026-01-01 형식으로 입력하세요");
    el.memberRegisteredAt.focus();
    return;
  }
  const payload = {
    name: el.memberName.value.trim(),
    title: el.memberTitle.value.trim(),
    cellId: el.memberCell.value,
    role: el.memberRole.value,
    phone: formatPhoneNumber(el.memberPhone.value, "mobile"),
    homePhone: formatPhoneNumber(el.memberHomePhone.value, "landline"),
    birth: buildBirthValue(birthDate, el.memberBirthCalendar.value === "lunar", member.birth),
    registeredAt,
    baptized: el.memberBaptismStatus.value === "1",
    address: el.memberAddress.value.trim(),
    longAbsent: el.memberLongAbsent.checked,
    memo: el.memberMemo.value.trim(),
    prayerRequests: el.memberPrayer.value.trim()
  };

  if (!payload.name) {
    toast("이름을 입력하세요");
    el.memberName.focus();
    return;
  }

  Object.assign(member, payload, { updatedAt: new Date().toISOString() });
  if (state.pendingPhotoData) {
    member.photoUrl = state.pendingPhotoData;
    member.photoKey = "";
  }

  if (state.apiOnline) {
    try {
      const saved = await saveMemberToApi(member, wasNew);
      Object.assign(member, saved);
      delete member.localDraft;
      if (state.pendingPhotoFile) await uploadPhotoToApi(member.id, state.pendingPhotoFile);
    } catch {
      state.apiOnline = false;
      toast("로컬에 저장되었습니다");
    }
  }

  if (wasNew && isDraftMember(member)) {
    member.id = `local-${crypto.randomUUID()}`;
  }

  state.selectedCellId = member.cellId;
  state.selectedMemberId = member.id;
  state.pendingPhotoData = null;
  state.pendingPhotoFile = null;
  persist();
  render();
  toast("저장되었습니다");
}

async function saveMemberToApi(member, wasNew) {
  const method = wasNew ? "POST" : "PATCH";
  const url = wasNew ? "/api/members" : `/api/members/${encodeURIComponent(member.id)}`;
  const response = await writeFetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(member)
  });
  if (!response.ok) throw new Error("save failed");
  return response.json();
}

async function handlePhotoPick(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    toast("이미지 파일을 선택하세요");
    return;
  }
  const dataUrl = await fileToDataUrl(file);
  state.pendingPhotoData = dataUrl;
  state.pendingPhotoFile = file;
  const member = selectedMember();
  if (member) {
    member.photoUrl = dataUrl;
    member.photoKey = "";
    member.photoRemoved = false;
    renderMembers();
    updatePhotoPreview(member);
  }
}

function removePhoto() {
  const member = selectedMember();
  if (!member) return;
  member.photoUrl = "";
  member.photoKey = "";
  member.photoRemoved = true;
  state.pendingPhotoData = null;
  state.pendingPhotoFile = null;
  persist();
  renderMembers();
  updatePhotoPreview(member);
}

async function uploadPhotoToApi(memberId, file) {
  const formData = new FormData();
  formData.append("photo", file);
  const response = await writeFetch(`/api/members/${encodeURIComponent(memberId)}/photo`, {
    method: "POST",
    body: formData
  });
  if (!response.ok) throw new Error("photo failed");
  const saved = await response.json();
  const member = state.members.find((item) => item.id === memberId);
  if (member) {
    member.photoKey = saved.photoKey || "";
    member.photoUrl = saved.photoUrl || "";
  }
}

function archiveSelected() {
  const member = selectedMember();
  if (!member) return;
  member.archivedAt = new Date().toISOString();
  member.updatedAt = member.archivedAt;
  callApi(`/api/members/${encodeURIComponent(member.id)}/archive`, { method: "POST" });
  persist();
  render();
  toast("제적처리했습니다");
}

function restoreSelected() {
  const member = selectedMember();
  if (!member) return;
  member.archivedAt = "";
  member.updatedAt = new Date().toISOString();
  callApi(`/api/members/${encodeURIComponent(member.id)}/restore`, { method: "POST" });
  persist();
  render();
  toast("제적처리 해제했습니다");
}

function deleteSelected() {
  const member = selectedMember();
  if (!member) return;
  const ok = confirm(`${member.name} 성도님을 휴지통으로 이동할까요?\n명단, 검색, 출석체크에서 보이지 않게 됩니다.`);
  if (!ok) return;
  member.trashedAt = new Date().toISOString();
  member.updatedAt = member.trashedAt;
  callApi(`/api/members/${encodeURIComponent(member.id)}/trash`, { method: "POST" });
  state.selectedMemberId = "";
  persist();
  render();
  toast("휴지통으로 이동했습니다");
}

function openVisitRecord() {
  const member = selectedMember();
  if (!member) return;
  if (!state.editingVisitId) resetVisitForm();
  showVisitRecord();
}

function showVisitRecord() {
  el.visitRecordModal.classList.remove("hidden");
  el.visitRecordModal.setAttribute("aria-hidden", "false");
  setTimeout(() => el.visitSummary.focus(), 0);
}

function hideVisitRecord() {
  el.visitRecordModal.classList.add("hidden");
  el.visitRecordModal.setAttribute("aria-hidden", "true");
}

function closeVisitRecord() {
  state.editingVisitId = "";
  resetVisitForm();
  hideVisitRecord();
  const member = selectedMember();
  if (member) renderVisits(member.id);
}

function addVisit() {
  const member = selectedMember();
  if (!member) return;
  const summary = el.visitSummary.value.trim();
  if (!summary) {
    toast("요약을 입력하세요");
    el.visitSummary.focus();
    return;
  }

  if (state.editingVisitId) {
    updateVisit(member, summary);
    return;
  }

  const visit = {
    id: `visit-${crypto.randomUUID()}`,
    memberId: member.id,
    visitDate: el.visitDate.value || today(),
    visitType: el.visitType.value,
    summary,
    source: "manual",
    createdAt: new Date().toISOString()
  };
  state.visits.unshift(visit);
  callApi("/api/visit-notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(visit)
  });
  resetVisitForm();
  persist();
  renderVisits(member.id);
  hideVisitRecord();
  if (!el.visitDatesModal.classList.contains("hidden")) renderVisitDates();
  toast("심방내역이 추가되었습니다");
}

function updateVisit(member, summary) {
  const visit = state.visits.find((item) => item.id === state.editingVisitId && item.memberId === member.id);
  if (!visit) {
    cancelVisitEdit();
    return;
  }

  const updated = {
    ...visit,
    visitDate: el.visitDate.value || today(),
    visitType: el.visitType.value,
    summary,
    prayer: ""
  };
  state.visits = state.visits.map((item) => item.id === updated.id ? updated : item);
  callApi(`/api/visit-notes/${encodeURIComponent(updated.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updated)
  });
  state.editingVisitId = "";
  resetVisitForm();
  persist();
  renderVisits(member.id);
  hideVisitRecord();
  if (!el.visitDatesModal.classList.contains("hidden")) renderVisitDates();
  toast("심방내역을 수정했습니다");
}

function startVisitEdit(visitId) {
  const visit = state.visits.find((item) => item.id === visitId);
  const member = selectedMember();
  if (!visit || !member || visit.memberId !== member.id) return;
  state.editingVisitId = visit.id;
  renderVisits(member.id);
  el.visitDate.value = visit.visitDate || today();
  el.visitType.value = visit.visitType || el.visitType.options[0]?.value || "";
  el.visitSummary.value = visitSummaryText(visit);
  setVisitFormMode();
  showVisitRecord();
}

function cancelVisitEdit() {
  state.editingVisitId = "";
  resetVisitForm();
  hideVisitRecord();
  const member = selectedMember();
  if (member) renderVisits(member.id);
}

function resetVisitForm() {
  el.visitDate.value = today();
  el.visitSummary.value = "";
  setVisitFormMode();
}

function setVisitFormMode() {
  const editing = Boolean(state.editingVisitId);
  el.visitSubmitLabel.textContent = editing ? "\uC800\uC7A5" : "\uCD94\uAC00";
  el.cancelVisitEditBtn.classList.toggle("hidden", !editing);
}

function renderVisits(memberId) {
  const visits = state.visits
    .filter((visit) => visit.memberId === memberId)
    .sort((a, b) => `${b.visitDate || ""}${b.createdAt || ""}`.localeCompare(`${a.visitDate || ""}${a.createdAt || ""}`));
  el.visitCount.textContent = `${visits.length}건`;
  if (!state.editingVisitId) resetVisitForm();
  el.visitList.innerHTML = visits.length
    ? visits.map((visit) => `<article class="visit-item ${visit.id === state.editingVisitId ? "editing" : ""}">
        <div class="visit-item-head">
          <strong>${escapeHtml(visit.visitDate || "")} · ${escapeHtml(visit.visitType || "심방")}</strong>
          <button class="icon-button subtle visit-edit-button" data-visit-edit-id="${escapeAttribute(visit.id)}" type="button" title="수정" aria-label="심방내역 수정">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 20h9"></path>
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path>
            </svg>
          </button>
        </div>
        <p>${escapeHtml(visitSummaryText(visit))}</p>
      </article>`).join("")
    : `<article class="visit-item"><small>기록 없음</small></article>`;
  el.visitList.querySelectorAll("[data-visit-edit-id]").forEach((button) => {
    button.addEventListener("click", () => startVisitEdit(button.dataset.visitEditId));
  });
}

async function callApi(url, options) {
  if (!state.apiOnline) return;
  try {
    const response = await writeFetch(url, options);
    if (!response.ok) throw new Error("api failed");
  } catch {
    state.apiOnline = false;
  }
}

async function writeFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    localStorage.removeItem("seosanch-cell:admin-token");
    window.location.href = "/__auth/login";
  }
  return response;
}

async function openSundayAttendance() {
  state.attendanceDate = state.attendanceDate || nearestSundayDate();
  el.attendanceDate.value = state.attendanceDate;
  el.attendanceModal.classList.remove("hidden");
  el.attendanceModal.setAttribute("aria-hidden", "false");
  renderSundayAttendance();
  await loadSundayAttendanceSessions();
  await loadSundayAttendanceDate(state.attendanceDate);
}

function closeSundayAttendance() {
  el.attendanceModal.classList.add("hidden");
  el.attendanceModal.setAttribute("aria-hidden", "true");
}

async function loadSundayAttendanceSessions() {
  if (state.apiOnline) {
    try {
      const response = await fetch("/api/sunday-attendance", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("attendance history failed");
      const data = await response.json();
      state.attendanceSessions = Array.isArray(data.sessions) ? data.sessions : [];
      renderAttendanceHistory();
      return;
    } catch {
      state.apiOnline = false;
    }
  }
  renderAttendanceHistory();
}

async function loadSundayAttendanceDate(dateValue) {
  const date = normalizeDateInput(dateValue) || nearestSundayDate();
  state.attendanceDate = date;
  el.attendanceDate.value = date;

  if (state.apiOnline) {
    try {
      const response = await fetch(`/api/sunday-attendance?date=${encodeURIComponent(date)}`, {
        headers: { Accept: "application/json" }
      });
      if (!response.ok) throw new Error("attendance detail failed");
      const data = await response.json();
      state.attendanceRecords = Array.isArray(data.records) ? data.records : [];
      state.attendancePresentIds = state.attendanceRecords
        .filter((record) => record.present)
        .map((record) => record.memberId);
      renderSundayAttendance();
      return;
    } catch {
      state.apiOnline = false;
    }
  }

  const localSession = state.attendanceSessions.find((session) => session.attendanceDate === date);
  state.attendanceRecords = Array.isArray(localSession?.records) ? localSession.records : [];
  state.attendancePresentIds = state.attendanceRecords
    .filter((record) => record.present)
    .map((record) => record.memberId);
  renderSundayAttendance();
}

function renderSundayAttendance() {
  const date = state.attendanceDate || nearestSundayDate();
  const members = attendanceMembersForSelectedDate();
  const presentIds = new Set(state.attendancePresentIds);
  const presentCount = members.filter((member) => presentIds.has(member.id)).length;
  const totalCount = members.length;

  el.attendanceDate.value = date;
  el.attendanceDateLabel.textContent = formatKoreanDateLabel(date);
  el.attendanceSummary.innerHTML = `
    <span class="attendance-summary-counts">
      <strong>출석 ${presentCount}명</strong>
      <span>전체 ${totalCount}명 · 결석 ${Math.max(totalCount - presentCount, 0)}명</span>
    </span>
    <span class="attendance-summary-action">명단보기</span>`;
  renderAttendanceHistory();
  renderAttendanceCellStats(members, presentIds);
  renderAttendanceMemberGrid(members, presentIds);
  renderAttendanceResults(members, presentIds);
}

function renderAttendanceHistory() {
  const sessions = (state.attendanceSessions || [])
    .slice()
    .sort((a, b) => String(b.attendanceDate || "").localeCompare(String(a.attendanceDate || "")))
    .slice(0, 12);

  if (!sessions.length) {
    el.attendanceHistory.innerHTML = '<p class="attendance-empty">저장된 주일출석 기록이 없습니다.</p>';
    return;
  }

  el.attendanceHistory.innerHTML = sessions.map((session) => {
    const active = session.attendanceDate === state.attendanceDate ? "active" : "";
    return `<button class="attendance-history-chip ${active}" data-attendance-date="${escapeAttribute(session.attendanceDate)}" type="button">
      <strong>${escapeHtml(formatShortDateLabel(session.attendanceDate))}</strong>
      <span>${Number(session.presentCount || 0)}/${Number(session.totalCount || 0)}명</span>
    </button>`;
  }).join("");
}

function renderAttendanceCellStats(members, presentIds) {
  const groups = groupedAttendanceMembers(members, presentIds);
  if (!groups.length) {
    el.attendanceCellStats.innerHTML = "";
    return;
  }

  el.attendanceCellStats.innerHTML = groups.map((group) => `<span class="attendance-cell-stat">
    <strong>${escapeHtml(group.cellName)}</strong>
    ${group.present}/${group.total}명
  </span>`).join("");
}

function renderAttendanceMemberGrid(members, presentIds) {
  if (!members.length) {
    el.attendanceMemberGrid.innerHTML = '<p class="attendance-empty">출석 체크할 성도가 없습니다.</p>';
    return;
  }

  el.attendanceMemberGrid.innerHTML = groupedAttendanceMembers(members, presentIds).map((group) => `
    <section class="attendance-cell-section">
      <div class="attendance-cell-section-head">
        <strong>${escapeHtml(group.cellName)}</strong>
        <span>${group.present}/${group.total}명</span>
      </div>
      <div class="attendance-cell-members">
        ${attendanceCellMembersHtml(group.members, presentIds)}
      </div>
    </section>`).join("");
}

function attendanceCellMembersHtml(members, presentIds) {
  const regularMembers = members.filter((member) => !member.longAbsent);
  const longAbsentMembers = members.filter((member) => member.longAbsent);
  const sections = [];
  if (regularMembers.length) sections.push(`<div class="attendance-member-subsection">
    <div class="attendance-member-subsection-grid">
      ${regularMembers.map((member) => attendanceMemberCardHtml(member, presentIds)).join("")}
    </div>
  </div>`);
  if (longAbsentMembers.length) sections.push(`<div class="attendance-member-subsection long-absent">
    <div class="attendance-member-subsection-title">
      <strong>장기결석자</strong>
      <span>${longAbsentMembers.length}명</span>
    </div>
    <div class="attendance-member-subsection-grid">
      ${longAbsentMembers.map((member) => attendanceMemberCardHtml(member, presentIds)).join("")}
    </div>
  </div>`);
  return sections.join("");
}

function attendanceMemberCardHtml(member, presentIds) {
  const present = presentIds.has(member.id);
  return `<button class="attendance-member-card ${present ? "present" : ""} ${member.longAbsent ? "long-absent" : ""}" data-attendance-member-id="${escapeAttribute(member.id)}" type="button" aria-pressed="${present ? "true" : "false"}">
    ${portraitHtml(member)}
    <span>
      <strong>${memberNameHtml(member)}</strong>
      <small>${escapeHtml([member.title, member.longAbsent ? "장기결석" : ""].filter(Boolean).join(" · "))}</small>
      ${newMemberBadgeHtml(member)}
    </span>
    <em>${present ? "출석" : "결석"}</em>
  </button>`;
}

function renderAttendanceResults(members, presentIds) {
  const presentMembers = members.filter((member) => presentIds.has(member.id));
  const absentMembers = members.filter((member) => !presentIds.has(member.id));

  el.attendanceResults.innerHTML = `
    <div class="attendance-results-toolbar">
      <button class="icon-button text-button subtle attendance-results-top-button" data-attendance-scroll-top type="button">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 19V5M5 12l7-7 7 7"></path>
        </svg>
        <span>출석체크로</span>
      </button>
    </div>
    <section class="attendance-result-column">
      <h3>출석 ${presentMembers.length}명</h3>
      ${attendanceNamesByCellHtml(presentMembers)}
    </section>
    <section class="attendance-result-column">
      <h3>결석 ${absentMembers.length}명</h3>
      ${attendanceNamesByCellHtml(absentMembers, { linkPhones: isMobileView(), linkDetails: !isMobileView() })}
    </section>`;
}

function attendanceNamesByCellHtml(members, options = {}) {
  if (!members.length) return '<p class="attendance-empty">명단 없음</p>';
  return groupedAttendanceMembers(members, new Set(members.map((member) => member.id)))
    .map((group) => {
      const regularMembers = group.members.filter((member) => !member.longAbsent);
      const longAbsentMembers = group.members.filter((member) => member.longAbsent);
      return `<div class="attendance-name-group">
        <strong>${escapeHtml(group.cellName)}</strong>
        ${regularMembers.length ? `<span>${attendanceNameListHtml(regularMembers, options)}</span>` : ""}
        ${longAbsentMembers.length ? `<span class="attendance-long-absent-names">장기결석: ${attendanceNameListHtml(longAbsentMembers, options)}</span>` : ""}
      </div>`;
    })
    .join("");
}

function attendanceNameListHtml(members, options = {}) {
  return members.map((member) => attendanceNameHtml(member, options)).join(", ");
}

function attendanceNameHtml(member, options = {}) {
  const name = escapeHtml(member.name);
  if (options.linkDetails && member.id) {
    return `<button class="attendance-name-link" data-attendance-member-detail="${escapeAttribute(member.id)}" type="button">${name}</button>`;
  }
  if (!options.linkPhones) return name;
  const phone = callablePhoneNumber(member);
  if (!phone) return name;
  return `<a href="tel:${escapeAttribute(phone)}">${name}</a>`;
}

function callablePhoneNumber(member) {
  return normalizePhoneSearch(member.phone || member.homePhone || "");
}

function groupedAttendanceMembers(members, presentIds) {
  const groups = new Map();
  members.forEach((member) => {
    const key = member.cellId || member.cellName || "unknown";
    if (!groups.has(key)) {
      groups.set(key, {
        cellId: member.cellId || key,
        cellName: member.cellName || memberCellLabel(member) || "셀 없음",
        sortOrder: Number.isFinite(member.cellSortOrder) ? member.cellSortOrder : cellSortRank(member.cellId),
        total: 0,
        present: 0,
        members: []
      });
    }
    const group = groups.get(key);
    group.total += 1;
    group.present += presentIds.has(member.id) ? 1 : 0;
    group.members.push(member);
  });
  return Array.from(groups.values()).sort((a, b) => {
    const sortDiff = a.sortOrder - b.sortOrder;
    if (sortDiff) return sortDiff;
    return a.cellName.localeCompare(b.cellName, "ko-KR", { numeric: true });
  });
}

function attendanceMembersForSelectedDate() {
  if (state.attendanceRecords.length) {
    const recordMembers = state.attendanceRecords.map(attendanceRecordToMember);
    const recordedIds = new Set(recordMembers.map((member) => member.id));
    const missingActiveMembers = activeMembersForAttendance()
      .filter((member) => !recordedIds.has(member.id));
    return recordMembers
      .concat(missingActiveMembers)
      .sort(compareAttendanceMembers);
  }
  return activeMembersForAttendance();
}

function activeMembersForAttendance() {
  return state.members
    .filter((member) => !member.archivedAt && !member.trashedAt)
    .map((member) => ({
      ...member,
      longAbsent: Boolean(member.longAbsent),
      cellName: state.cells.find((cell) => cell.id === member.cellId)?.name || memberCellLabel(member),
      cellSortOrder: cellSortRank(member.cellId)
    }))
    .sort(compareAttendanceMembers);
}

function attendanceRecordToMember(record) {
  const current = state.members.find((member) => member.id === record.memberId);
  return {
    id: record.memberId,
    cellId: record.cellId,
    cellName: record.cellName,
    name: record.memberName,
    title: record.memberTitle || "",
    role: record.memberRole || "",
    phone: current?.phone || "",
    homePhone: current?.homePhone || "",
    registeredAt: current?.registeredAt || "",
    longAbsent: Boolean(record.memberLongAbsent),
    cellSortOrder: Number(record.cellSortOrder || cellSortRank(record.cellId)),
    photoUrl: current?.photoUrl || record.photoUrl || "",
    photoKey: current?.photoKey || record.photoKey || "",
    archivedAt: ""
  };
}

function compareAttendanceMembers(a, b) {
  const aCellSort = Number.isFinite(a.cellSortOrder) ? a.cellSortOrder : cellSortRank(a.cellId);
  const bCellSort = Number.isFinite(b.cellSortOrder) ? b.cellSortOrder : cellSortRank(b.cellId);
  const cellDiff = aCellSort - bCellSort;
  if (cellDiff) return cellDiff;
  const roleDiff = roleSortRank(a.role) - roleSortRank(b.role);
  if (roleDiff) return roleDiff;
  return compareKoreanNames(a.name, b.name);
}

function toggleSundayAttendanceMember(memberId) {
  const scrollState = captureAttendanceScroll();
  const presentIds = new Set(state.attendancePresentIds);
  if (presentIds.has(memberId)) presentIds.delete(memberId);
  else presentIds.add(memberId);
  state.attendancePresentIds = Array.from(presentIds);
  renderSundayAttendance();
  restoreAttendanceScroll(scrollState);
}

function clearSundayAttendance() {
  state.attendancePresentIds = [];
  renderSundayAttendance();
}

function scrollToAttendanceResults() {
  el.attendanceResults.scrollIntoView({ behavior: "smooth", block: "start" });
}

function scrollToAttendanceChecklist() {
  el.attendanceSummary.scrollIntoView({ behavior: "smooth", block: "start" });
}

function handleAttendanceSummaryKeydown(event) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  scrollToAttendanceResults();
}

function captureAttendanceScroll() {
  const dialog = el.attendanceModal.querySelector(".attendance-dialog");
  return {
    dialog,
    dialogTop: dialog?.scrollTop || 0,
    modalTop: el.attendanceModal.scrollTop || 0,
    windowTop: window.scrollY || 0
  };
}

function restoreAttendanceScroll(stateToRestore) {
  const restore = () => {
    if (stateToRestore.dialog) stateToRestore.dialog.scrollTop = stateToRestore.dialogTop;
    el.attendanceModal.scrollTop = stateToRestore.modalTop;
    window.scrollTo(window.scrollX, stateToRestore.windowTop);
  };
  restore();
  requestAnimationFrame(restore);
}

function shiftSundayAttendanceDate(dayOffset) {
  const current = parseDateValue(state.attendanceDate) || parseDateValue(nearestSundayDate());
  current.setDate(current.getDate() + dayOffset);
  loadSundayAttendanceDate(localDateString(current));
}

async function saveSundayAttendance() {
  const attendanceDate = normalizeDateInput(el.attendanceDate.value) || state.attendanceDate || nearestSundayDate();
  if (!isSundayDate(attendanceDate)) {
    const ok = confirm("선택한 날짜가 주일이 아닙니다. 그래도 저장할까요?");
    if (!ok) return;
  }

  const presentMemberIds = Array.from(new Set(state.attendancePresentIds));
  el.attendanceSaveBtn.disabled = true;
  try {
    if (state.apiOnline) {
      const response = await writeFetch("/api/sunday-attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attendanceDate,
          label: formatKoreanDateLabel(attendanceDate),
          presentMemberIds
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "attendance save failed");
      state.attendanceRecords = Array.isArray(data.records) ? data.records : [];
      state.attendancePresentIds = state.attendanceRecords
        .filter((record) => record.present)
        .map((record) => record.memberId);
      upsertAttendanceSession(data.session, state.attendanceRecords);
    } else {
      saveSundayAttendanceLocally(attendanceDate, presentMemberIds);
    }
    persist();
    renderSundayAttendance();
    toast("주일출석이 저장되었습니다");
  } catch (error) {
    toast(error.message || "주일출석을 저장하지 못했습니다");
  } finally {
    el.attendanceSaveBtn.disabled = false;
  }
}

function saveSundayAttendanceLocally(attendanceDate, presentMemberIds) {
  const presentSet = new Set(presentMemberIds);
  const now = new Date().toISOString();
  const members = activeMembersForAttendance();
  const records = members.map((member) => ({
    sessionId: `local-attendance-${attendanceDate}`,
    memberId: member.id,
    memberName: member.name,
    memberTitle: member.title || "",
    memberRole: member.role || "",
    memberLongAbsent: Boolean(member.longAbsent),
    cellId: member.cellId,
    cellName: member.cellName || memberCellLabel(member),
    cellSortOrder: member.cellSortOrder || cellSortRank(member.cellId),
    photoKey: member.photoKey || "",
    photoUrl: member.photoUrl || "",
    present: presentSet.has(member.id),
    createdAt: now,
    updatedAt: now
  }));
  const session = {
    id: `local-attendance-${attendanceDate}`,
    attendanceDate,
    label: formatKoreanDateLabel(attendanceDate),
    totalCount: records.length,
    presentCount: records.filter((record) => record.present).length,
    absentCount: records.filter((record) => !record.present).length,
    createdAt: now,
    updatedAt: now
  };
  state.attendanceRecords = records;
  state.attendancePresentIds = records.filter((record) => record.present).map((record) => record.memberId);
  upsertAttendanceSession(session, records);
}

function upsertAttendanceSession(session, records = []) {
  if (!session?.attendanceDate) return;
  const savedSession = {
    ...session,
    records,
    totalCount: Number(session.totalCount || records.length || 0),
    presentCount: Number(session.presentCount || records.filter((record) => record.present).length || 0)
  };
  savedSession.absentCount = Math.max(savedSession.totalCount - savedSession.presentCount, 0);
  state.attendanceSessions = [
    savedSession,
    ...state.attendanceSessions.filter((item) => item.attendanceDate !== session.attendanceDate)
  ].sort((a, b) => String(b.attendanceDate || "").localeCompare(String(a.attendanceDate || "")));
}

function openVisitDates() {
  const latestDate = latestVisitDate() || today();
  state.selectedVisitDate = state.selectedVisitDate || latestDate;
  state.selectedVisitMonth = state.selectedVisitMonth || visitMonthKey(state.selectedVisitDate);
  renderVisitDates();
  el.visitDatesModal.classList.remove("hidden");
  el.visitDatesModal.setAttribute("aria-hidden", "false");
}

function closeVisitDates() {
  el.visitDatesModal.classList.add("hidden");
  el.visitDatesModal.setAttribute("aria-hidden", "true");
}

function renderVisitDates() {
  const grouped = groupVisitsByDate();
  const dates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));
  const selectedMonth = state.selectedVisitMonth || visitMonthKey(state.selectedVisitDate || dates[0] || today());
  state.selectedVisitMonth = selectedMonth;

  if (!dates.length) {
    state.selectedVisitDate = `${selectedMonth}-01`;
    el.visitMonthLabel.textContent = formatMonthLabel(selectedMonth);
    el.visitCalendar.innerHTML = visitCalendarHtml({}, selectedMonth);
    el.visitDateSelectedLabel.textContent = "아직 심방내역이 없습니다.";
    el.visitDateEntries.innerHTML = "";
    return;
  }

  const datesInMonth = dates.filter((date) => date.startsWith(selectedMonth));
  if (!state.selectedVisitDate || !state.selectedVisitDate.startsWith(selectedMonth) || (!grouped[state.selectedVisitDate] && datesInMonth.length)) {
    state.selectedVisitDate = datesInMonth[0] || `${selectedMonth}-01`;
  }

  el.visitMonthLabel.textContent = formatMonthLabel(selectedMonth);
  el.visitCalendar.innerHTML = visitCalendarHtml(grouped, selectedMonth);
  el.visitCalendar.querySelectorAll("[data-visit-date]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedVisitDate = button.dataset.visitDate;
      renderVisitDates();
    });
  });

  const visits = (grouped[state.selectedVisitDate] || [])
    .slice()
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  el.visitDateSelectedLabel.textContent = `${formatDateLabel(state.selectedVisitDate)} · ${visits.length}건`;
  el.visitDateEntries.innerHTML = visits.length
    ? visits.map((visit) => visitDateEntryHtml(visit)).join("")
    : '<p class="visit-date-empty">선택한 날짜의 심방내역이 없습니다.</p>';
  el.visitDateEntries.querySelectorAll("[data-member-id]").forEach((button) => {
    button.addEventListener("click", () => {
      closeVisitDates();
      selectMember(button.dataset.memberId);
    });
  });
}

function shiftVisitCalendarMonth(delta) {
  const month = state.selectedVisitMonth || visitMonthKey(state.selectedVisitDate || latestVisitDate() || today());
  state.selectedVisitMonth = shiftMonthKey(month, delta);
  const monthDates = Object.keys(groupVisitsByDate())
    .filter((date) => date.startsWith(state.selectedVisitMonth))
    .sort((a, b) => b.localeCompare(a));
  state.selectedVisitDate = monthDates[0] || `${state.selectedVisitMonth}-01`;
  renderVisitDates();
}

function visitCalendarHtml(grouped, monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  const firstDay = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const cells = [];

  for (let index = 0; index < firstDay; index += 1) {
    cells.push('<div class="visit-calendar-empty-cell"></div>');
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${monthKey}-${String(day).padStart(2, "0")}`;
    const count = grouped[date]?.length || 0;
    const active = date === state.selectedVisitDate;
    const todayClass = date === today() ? "today" : "";
    const countHtml = count ? `<strong>${count}</strong>` : "";
    cells.push(`<button class="visit-calendar-day ${count ? "has-visits" : "empty"} ${active ? "active" : ""} ${todayClass}" ${count ? `data-visit-date="${escapeAttribute(date)}"` : "disabled"} type="button">
      <span>${day}</span>
      ${countHtml}
    </button>`);
  }

  return cells.join("");
}

function groupVisitsByDate() {
  return state.visits.reduce((groups, visit) => {
    const date = visitDateKey(visit);
    if (!date) return groups;
    groups[date] = groups[date] || [];
    groups[date].push(visit);
    return groups;
  }, {});
}

function latestVisitDate() {
  return Object.keys(groupVisitsByDate()).sort((a, b) => b.localeCompare(a))[0] || "";
}

function visitMonthKey(dateValue) {
  const match = /^(\d{4})-(\d{2})/.exec(String(dateValue || ""));
  return match ? `${match[1]}-${match[2]}` : today().slice(0, 7);
}

function shiftMonthKey(monthKey, delta) {
  const [year, month] = monthKey.split("-").map(Number);
  const date = new Date(year, month - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function visitDateKey(visit) {
  return String(visit.visitDate || visit.createdAt || "").slice(0, 10);
}

function visitSummaryText(visit) {
  const summary = String(visit.summary || "").trim();
  const prayer = String(visit.prayer || "").trim();
  if (!prayer) return summary;
  if (summary.includes(prayer) || summary.includes(`기도제목: ${prayer}`)) return summary;
  return [summary, `기도제목: ${prayer}`].filter(Boolean).join("\n");
}

function visitDateEntryHtml(visit) {
  const member = state.members.find((item) => item.id === visit.memberId);
  const memberName = member?.name || "이름 없음";
  const cellLabel = member ? memberCellLabel(member) : "";
  const title = member?.title || "";
  const memberId = member?.id || "";
  return `<article class="visit-date-entry">
    <button class="visit-date-member" type="button" ${memberId ? `data-member-id="${escapeAttribute(memberId)}"` : "disabled"}>
      <strong>${escapeHtml(memberName)}</strong>
      <span>${escapeHtml([cellLabel, title].filter(Boolean).join(" · "))}</span>
    </button>
    <div class="visit-date-body">
      <small>${escapeHtml(visit.visitType || "심방")}</small>
      <p>${escapeHtml(visitSummaryText(visit))}</p>
    </div>
  </article>`;
}

function formatDateLabel(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  return match ? match[1] + ". " + match[2] + ". " + match[3] + "." : date;
}

function formatMonthLabel(monthKey) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(monthKey || ""));
  return match ? `${match[1]}년 ${Number(match[2])}월` : monthKey;
}

function updateMobileDetailState() {
  el.workspace.classList.toggle("detail-active", Boolean(selectedMember()));
}

function isMobileView() {
  return window.matchMedia("(max-width: 760px)").matches;
}

function isStackedDetailView() {
  return window.matchMedia("(max-width: 1180px)").matches;
}

function scrollToSelectedDetail() {
  el.detailPanel.scrollTo({ top: 0, behavior: "smooth" });
  if (isMobileView()) window.scrollTo({ top: 0, behavior: "smooth" });
  else if (isStackedDetailView()) el.detailPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function jumpToBasicInfo() {
  const member = selectedMember();
  if (!member) return;
  el.profileDetails.open = true;
  document.getElementById("basicInfoSection")?.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
}

function openSettings() {
  el.settingsForm.reset();
  el.communityTitleInput.value = cleanTitle(state.settings?.communityTitle);
  el.callNoteWebhookUrl.value = `${window.location.origin}/api/webhook/call-note`;
  el.callNoteTokenOutput.value = "";
  renderCallNoteImports();
  el.settingsModal.classList.remove("hidden");
  el.settingsModal.setAttribute("aria-hidden", "false");
  loadCallNoteTokenStatus();
  loadCallNoteImports();
  setTimeout(() => el.currentPassword.focus(), 0);
}

function closeSettings() {
  el.settingsModal.classList.add("hidden");
  el.settingsModal.setAttribute("aria-hidden", "true");
}

async function saveCommunityTitle() {
  const communityTitle = cleanTitle(el.communityTitleInput.value);
  if (!communityTitle) {
    toast("상단 제목을 입력하세요");
    el.communityTitleInput.focus();
    return;
  }
  el.saveCommunityTitleBtn.disabled = true;
  try {
    const response = await writeFetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ communityTitle })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "settings failed");
    state.settings = {
      ...state.settings,
      communityTitle: result.communityTitle || communityTitle
    };
    persist();
    renderCommunityTitle();
    toast("상단 제목을 저장했습니다");
  } catch (error) {
    toast(error.message || "상단 제목을 저장하지 못했습니다");
  } finally {
    el.saveCommunityTitleBtn.disabled = false;
  }
}

async function loadCallNoteTokenStatus() {
  if (!state.apiOnline) return;
  try {
    const response = await writeFetch("/api/call-note-token", {
      headers: { Accept: "application/json" }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "token status failed");
    updateCallNoteTokenStatus(result);
  } catch {
    el.callNoteStatus.textContent = "웹훅 토큰 상태를 확인하지 못했습니다.";
  }
}

async function viewCallNoteToken() {
  if (!state.apiOnline) {
    toast("서버 연결 상태에서 사용할 수 있습니다.");
    return;
  }
  el.callNoteTokenBtn.disabled = true;
  el.callNoteStatus.textContent = "웹훅 토큰을 조회하는 중입니다.";
  try {
    const response = await writeFetch("/api/call-note-token", {
      headers: { Accept: "application/json" }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "token failed");
    if (result.token) {
      showCallNoteToken(result.token, "발급된 웹훅 토큰입니다. 앱의 Webhook Token에 입력하세요.");
    } else if (result.legacyOnly) {
      el.callNoteStatus.textContent = "이전에 발급된 토큰은 작동하지만 조회할 수 없습니다. 조회 가능한 토큰이 필요하면 재발급하세요.";
    } else if (result.source === "environment") {
      el.callNoteStatus.textContent = "환경변수로 설정된 토큰은 화면에서 조회하지 않습니다.";
    } else {
      el.callNoteStatus.textContent = "아직 발급된 웹훅 토큰이 없습니다. 재발급 버튼으로 새 토큰을 만들 수 있습니다.";
    }
  } catch (error) {
    el.callNoteStatus.textContent = error.message || "웹훅 토큰을 조회하지 못했습니다.";
  } finally {
    el.callNoteTokenBtn.disabled = false;
  }
}

async function reissueCallNoteToken() {
  if (!state.apiOnline) {
    toast("서버 연결 상태에서 사용할 수 있습니다.");
    return;
  }
  const ok = confirm("웹훅 토큰을 재발급하면 기존 앱에 입력된 토큰은 더 이상 작동하지 않습니다.\n그래도 재발급할까요?");
  if (!ok) return;
  el.callNoteTokenReissueBtn.disabled = true;
  el.callNoteStatus.textContent = "웹훅 토큰을 재발급하는 중입니다.";
  try {
    const response = await writeFetch("/api/call-note-token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ action: "rotate" })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "token failed");
    showCallNoteToken(result.token || "", "새 웹훅 토큰이 재발급되었습니다. 앱의 Webhook Token에 다시 입력하세요.");
  } catch (error) {
    el.callNoteStatus.textContent = error.message || "웹훅 토큰을 재발급하지 못했습니다.";
  } finally {
    el.callNoteTokenReissueBtn.disabled = false;
  }
}

function updateCallNoteTokenStatus(result) {
  if (result.viewable) {
    el.callNoteStatus.textContent = "웹훅 토큰이 발급되어 있습니다. 토큰 조회 버튼으로 확인할 수 있습니다.";
  } else if (result.legacyOnly) {
    el.callNoteStatus.textContent = "이전에 발급된 토큰이 있습니다. 기존 앱 토큰은 작동하지만 화면 조회는 재발급 후 가능합니다.";
  } else if (result.source === "environment") {
    el.callNoteStatus.textContent = "웹훅 토큰이 환경변수로 설정되어 있습니다.";
  } else {
    el.callNoteStatus.textContent = "아직 발급된 웹훅 토큰이 없습니다.";
  }
}

function showCallNoteToken(token, message) {
  el.callNoteTokenOutput.value = token;
  el.callNoteTokenOutput.focus();
  el.callNoteTokenOutput.select();
  el.callNoteStatus.textContent = message;
}

async function loadCallNoteImports() {
  if (!state.apiOnline) {
    el.callNoteStatus.textContent = "서버 연결 상태에서 사용할 수 있습니다.";
    renderCallNoteImports();
    return;
  }
  el.callNoteStatus.textContent = "검토함을 불러오는 중입니다.";
  try {
    const response = await writeFetch("/api/call-note-imports?status=needs_review", {
      headers: { Accept: "application/json" }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "load failed");
    state.callNoteImports = Array.isArray(result.imports) ? result.imports : [];
    el.callNoteStatus.textContent = state.callNoteImports.length
      ? `확인 필요한 기록 ${state.callNoteImports.length}건`
      : "확인 필요한 콜노트 기록이 없습니다.";
  } catch (error) {
    el.callNoteStatus.textContent = error.message || "검토함을 불러오지 못했습니다.";
  }
  renderCallNoteImports();
}

function renderCallNoteImports() {
  const imports = state.callNoteImports || [];
  if (!el.callNoteInbox) return;
  if (!imports.length) {
    el.callNoteInbox.innerHTML = '<p class="call-note-empty">검토할 기록이 없습니다.</p>';
    return;
  }
  el.callNoteInbox.innerHTML = imports.map(callNoteImportHtml).join("");
}

function callNoteImportHtml(item) {
  const candidates = Array.isArray(item.candidates) ? item.candidates : [];
  const title = [item.name || item.payload?.name || "이름 없음", item.cellHint || ""].filter(Boolean).join(" · ");
  const date = item.visitDate || today();
  const type = item.visitType || "전화";
  const summary = item.summary || item.payload?.summary || item.payload?.note || "";
  const reason = callNoteReasonLabel(item.matchReason);
  return `<article class="call-note-card" data-call-note-id="${escapeAttribute(item.id)}">
    <div class="call-note-card-head">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(reason)}</span>
    </div>
    <div class="call-note-card-grid">
      <label>성도
        <select data-call-note-member>
          ${callNoteMemberOptions(candidates)}
        </select>
      </label>
      <label>날짜<input data-call-note-date type="date" value="${escapeAttribute(date)}"></label>
      <label>방식
        <select data-call-note-type>
          ${["전화", "심방", "상담", "기도"].map((option) => `<option ${option === type ? "selected" : ""}>${option}</option>`).join("")}
        </select>
      </label>
      <label class="wide">요약<textarea data-call-note-summary rows="4">${escapeHtml(summary)}</textarea></label>
    </div>
    <div class="call-note-meta">${escapeHtml([item.phone, item.sourceId].filter(Boolean).join(" · "))}</div>
    <div class="button-row call-note-actions">
      <button class="icon-button text-button primary" data-call-note-action="attach" type="button">심방내역 저장</button>
      <button class="icon-button text-button subtle" data-call-note-action="ignore" type="button">무시</button>
    </div>
  </article>`;
}

function callNoteMemberOptions(candidates) {
  const byId = new Set();
  const options = [];
  [...candidates, ...activeMembers()].forEach((member) => {
    if (!member?.id || byId.has(member.id)) return;
    byId.add(member.id);
    const label = `${member.name}${member.title || ""} · ${member.cellName || memberCellLabel(member)}`;
    options.push(`<option value="${escapeAttribute(member.id)}">${escapeHtml(label)}</option>`);
  });
  return options.length ? options.join("") : '<option value="">성도 없음</option>';
}

function callNoteReasonLabel(reason) {
  const labels = {
    "missing-name-phone": "이름/전화 없음",
    "ambiguous-phone": "전화번호 중복",
    "ambiguous-name": "동명이인",
    "ambiguous-name-cell": "동명이인",
    "no-match": "매칭 없음"
  };
  return labels[reason] || "확인 필요";
}

function activeMembers() {
  return state.members
    .filter((member) => !member.archivedAt && !member.trashedAt)
    .map((member) => ({
      ...member,
      cellName: memberCellLabel(member)
    }))
    .sort((a, b) => compareMembersForDisplay(a, b, true));
}

async function handleCallNoteInboxClick(event) {
  const button = closestElement(event.target, "[data-call-note-action]");
  if (!button) return;
  const card = closestElement(button, "[data-call-note-id]");
  if (!card) return;
  const id = card.dataset.callNoteId;
  const action = button.dataset.callNoteAction;
  if (action === "attach") {
    await attachCallNoteImportFromCard(card, id, button);
    return;
  }
  if (action === "ignore") {
    await ignoreCallNoteImport(id, button);
  }
}

async function attachCallNoteImportFromCard(card, id, button) {
  const memberId = card.querySelector("[data-call-note-member]")?.value || "";
  const summary = card.querySelector("[data-call-note-summary]")?.value.trim() || "";
  const visitDate = card.querySelector("[data-call-note-date]")?.value || today();
  const visitType = card.querySelector("[data-call-note-type]")?.value || "전화";
  if (!memberId) {
    toast("성도를 선택하세요");
    return;
  }
  if (!summary) {
    toast("요약을 입력하세요");
    return;
  }
  button.disabled = true;
  try {
    const response = await writeFetch(`/api/call-note-imports/${encodeURIComponent(id)}/attach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId, summary, visitDate, visitType })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "save failed");
    if (result.visit) state.visits.unshift(result.visit);
    state.callNoteImports = state.callNoteImports.filter((item) => item.id !== id);
    persist();
    renderCallNoteImports();
    renderMembers();
    if (selectedMember()?.id === memberId) renderVisits(memberId);
    toast("콜노트 기록을 심방내역에 저장했습니다");
  } catch (error) {
    toast(error.message || "저장하지 못했습니다");
  } finally {
    button.disabled = false;
  }
}

async function ignoreCallNoteImport(id, button) {
  const ok = confirm("이 콜노트 기록을 검토함에서 제외할까요?");
  if (!ok) return;
  button.disabled = true;
  try {
    const response = await writeFetch(`/api/call-note-imports/${encodeURIComponent(id)}/ignore`, {
      method: "POST"
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "ignore failed");
    state.callNoteImports = state.callNoteImports.filter((item) => item.id !== id);
    renderCallNoteImports();
    toast("콜노트 기록을 무시했습니다");
  } catch (error) {
    toast(error.message || "처리하지 못했습니다");
  } finally {
    button.disabled = false;
  }
}

async function changePassword(event) {
  event.preventDefault();
  const currentPassword = el.currentPassword.value.trim();
  const newPassword = el.newPassword.value.trim();
  const confirmPassword = el.confirmPassword.value.trim();

  if (!currentPassword || !newPassword || !confirmPassword) {
    toast("\uBE44\uBC00\uBC88\uD638\uB97C \uBAA8\uB450 \uC785\uB825\uD558\uC138\uC694");
    return;
  }
  if (newPassword.length < 8) {
    toast("\uC0C8 \uBE44\uBC00\uBC88\uD638\uB294 8\uC790 \uC774\uC0C1\uC73C\uB85C \uC785\uB825\uD558\uC138\uC694");
    el.newPassword.focus();
    return;
  }
  if (newPassword !== confirmPassword) {
    toast("\uC0C8 \uBE44\uBC00\uBC88\uD638\uAC00 \uC11C\uB85C \uB2E4\uB985\uB2C8\uB2E4");
    el.confirmPassword.focus();
    return;
  }

  const submitButton = el.settingsForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const response = await fetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "password update failed");
    closeSettings();
    toast("\uBE44\uBC00\uBC88\uD638\uAC00 \uBCC0\uACBD\uB418\uC5C8\uC2B5\uB2C8\uB2E4");
  } catch (error) {
    toast(error.message || "\uBE44\uBC00\uBC88\uD638\uB97C \uBCC0\uACBD\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4");
  } finally {
    submitButton.disabled = false;
  }
}
function closeDetail() {
  const member = selectedMember();
  if (isDraftMember(member)) {
    const ok = confirm("\uC0C8 \uC131\uB3C4 \uC785\uB825\uC744 \uB2EB\uC73C\uBA74 \uC800\uC7A5\uD558\uC9C0 \uC54A\uC740 \uB0B4\uC6A9\uC774 \uC0AC\uB77C\uC9D1\uB2C8\uB2E4.\n\uADF8\uB798\uB3C4 \uB2EB\uC744\uAE4C\uC694?");
    if (!ok) return;
    state.members = state.members.filter((item) => item.id !== member.id);
  }
  state.selectedMemberId = "";
  state.pendingPhotoData = null;
  persist();
  render();
}

function currentCell() {
  return state.cells.find((cell) => cell.id === state.selectedCellId) || state.cells[0];
}

function selectedMember() {
  return state.members.find((member) => member.id === state.selectedMemberId);
}

function isDraftMember(member) {
  return Boolean(member?.localDraft);
}

function initials(name) {
  const compact = String(name || "?").trim();
  if (!compact) return "?";
  return Array.from(compact.replace(/\s/g, "")).slice(-2).join("");
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}


function parseBirthValue(value) {
  const text = String(value || "").trim();
  const date = text.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1] || "";
  const parts = text.split(/\s+/);
  const marker = ["\uC591", "\uC74C"].find((item) => parts.includes(item)) || "";
  const age = text.match(/\((\d+)\uC138\)/)?.[1] || "";
  return { date, marker, age };
}

function buildBirthValue(dateValue, isLunar = false, previousValue = "") {
  const date = formatBirthDateInput(dateValue);
  const previous = parseBirthValue(previousValue);
  if (!date) return previous.date ? "" : String(previousValue || "").trim();
  const marker = isLunar ? "\uC74C" : "";
  const age = calculateAge(date);
  return [date, marker, Number.isFinite(age) ? "(" + age + "\uC138)" : ""].filter(Boolean).join(" ");
}

function renderLunarMarker(marker) {
  const isLunar = marker === "\uC74C";
  el.memberCalendar.textContent = isLunar ? "\uC74C\uB825" : "";
  el.memberCalendar.classList.toggle("hidden", !isLunar);
}

function updateBirthAge() {
  const date = formatBirthDateInput(el.memberBirth.value);
  el.memberAge.value = ageLabel(date);
  renderLunarMarker(el.memberBirthCalendar.value === "lunar" ? "\uC74C" : "");
}

function formatBirthField() {
  el.memberBirth.value = formatBirthDateInput(el.memberBirth.value);
  updateBirthAge();
}

function formatBirthDateInput(value) {
  return formatDateInputValue(value);
}

function formatRegisteredAtField() {
  el.memberRegisteredAt.value = formatDateInputValue(el.memberRegisteredAt.value);
  el.memberRegisteredAtPicker.value = parseDateValue(el.memberRegisteredAt.value) ? el.memberRegisteredAt.value : "";
}

function formatDateInputValue(value) {
  const digits = String(value || "").replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 4) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 4)}-${digits.slice(4)}`;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
}

function openRegisteredAtPicker() {
  el.memberRegisteredAtPicker.value = parseDateValue(el.memberRegisteredAt.value) ? el.memberRegisteredAt.value : "";
  if (typeof el.memberRegisteredAtPicker.showPicker === "function") {
    el.memberRegisteredAtPicker.showPicker();
    return;
  }
  el.memberRegisteredAtPicker.focus();
  el.memberRegisteredAtPicker.click();
}

function ageLabel(dateValue) {
  const age = calculateAge(dateValue);
  return Number.isFinite(age) ? age + "\uC138" : "";
}

function isNewMember(member) {
  const registeredDate = parseDateValue(member?.registeredAt);
  if (!registeredDate) return false;

  const todayDate = parseDateValue(localDateString(new Date()));
  if (!todayDate || registeredDate > todayDate) return false;

  const oneYearLater = new Date(registeredDate);
  oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);
  return todayDate < oneYearLater;
}

function calculateAge(dateValue) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateValue || ""));
  if (!match) return NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const birthDate = new Date(year, month - 1, day);
  if (birthDate.getFullYear() !== year || birthDate.getMonth() !== month - 1 || birthDate.getDate() !== day) return NaN;
  const now = new Date();
  let age = now.getFullYear() - year;
  const birthdayThisYear = new Date(now.getFullYear(), month - 1, day);
  if (now < birthdayThisYear) age -= 1;
  return age >= 0 ? age : NaN;
}

function nearestSundayDate() {
  const date = new Date();
  const day = date.getDay();
  const offset = day === 0 ? 0 : (day <= 3 ? -day : 7 - day);
  date.setDate(date.getDate() + offset);
  return localDateString(date);
}

function normalizeDateInput(value) {
  const date = parseDateValue(value);
  return date ? localDateString(date) : "";
}

function parseDateValue(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

function localDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatKoreanDateLabel(dateValue) {
  const date = parseDateValue(dateValue);
  if (!date) return "";
  const weekdays = ["주일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];
  return `${date.getFullYear()}년 ${date.getMonth() + 1}월 ${date.getDate()}일 ${weekdays[date.getDay()]}`;
}

function formatShortDateLabel(dateValue) {
  const date = parseDateValue(dateValue);
  if (!date) return dateValue || "";
  return `${date.getMonth() + 1}/${date.getDate()} 주일`;
}

function isSundayDate(dateValue) {
  const date = parseDateValue(dateValue);
  return Boolean(date && date.getDay() === 0);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function cleanTitle(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 40) || DEFAULT_COMMUNITY_TITLE;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

function closestElement(target, selector) {
  return target instanceof Element ? target.closest(selector) : null;
}

function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.toast.classList.remove("show"), 1800);
}
