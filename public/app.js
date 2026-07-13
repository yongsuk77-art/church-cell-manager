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
const DEFAULT_COMMUNITY_TITLE = "";
const MISSING_COMMUNITY_TITLE = "설정에서 제목을 입력하세요";
const VISIT_META_PREFIX = "visit-meta:";
const VISIT_TYPE_ALARM = "알람";
const ALARM_DISMISS_KEY = "seosanch-cell:alarm-dismissed:v1";
const UNASSIGNED_CELL_ID = "__unassigned__";
const SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const SESSION_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000;
const SESSION_REFRESH_RETRY_INTERVAL_MS = 15 * 1000;
const NOTE_CATEGORY_LABELS = {
  personal: "개인",
  visitation: "심방",
  admin: "교회행정"
};
const NOTE_STATUS_LABELS = {
  active: "진행 중",
  done: "완료"
};

const state = {
  settings: {
    communityTitle: DEFAULT_COMMUNITY_TITLE
  },
  cells: [],
  groups: [],
  members: [],
  visits: [],
  notes: [],
  viewerRole: "unknown",
  selectedCellId: "",
  selectedGroupId: "",
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
  returnToAttendanceDate: "",
  callNoteImports: [],
  editingVisitId: "",
  visitSavePending: false,
  visitListCollapsed: false,
  visitListPageOpen: false,
  expandedVisitId: "",
  showVisitTrash: false,
  dismissedAlarmKeys: new Set(),
  alarmTimerId: 0,
  callNoteTimerId: 0,
  editingGroupId: "",
  editingGroupMembersId: "",
  groupMemberDraftIds: new Set(),
  groupSavePending: false,
  pendingGroupId: "",
  editingNoteId: "",
  memoReturnFocus: null,
  guestPasswordEnabled: false,
  mobileNotificationStatus: null,
  mobilePairCode: "",
  mobilePairCodeExpiresAt: "",
  mobilePairPollTimerId: 0,
  mobilePairCountdownTimerId: 0,
  mobileNotificationLoading: false,
  lastSessionActivityAt: 0,
  lastSessionRefreshAt: 0,
  lastSessionRefreshAttemptAt: 0,
  sessionIdleTimerId: 0,
  sessionRefreshPending: false,
  apiOnline: false
};

const el = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindElements();
  applyViewerRole();
  bindEvents();
  bindSessionActivityRefresh();
  state.dismissedAlarmKeys = readDismissedAlarmKeys();
  el.memberBirth.maxLength = 10;
  populateRoleOptions();
  await loadState();
  applyViewerRole();
  const selectedCell = state.cells.find((cell) => cell.id === state.selectedCellId);
  if (!selectedCell || (isSystemCellId(selectedCell.id) && !unassignedMembers().length)) {
    state.selectedCellId = visibleCells()[0]?.id || "";
  }
  if (!state.groups.some((group) => group.id === state.selectedGroupId)) {
    state.selectedGroupId = "";
  }
  render();
  renderAlarmNotifications();
  renderCallNoteInboxIndicator();
  state.alarmTimerId = window.setInterval(renderAlarmNotifications, 30000);
  refreshCallNoteImportsForIndicator();
  state.callNoteTimerId = window.setInterval(refreshCallNoteImportsForIndicator, 60000);
}

function bindElements() {
  [
    "workspace", "cellTabs", "groupTabs", "groupTabsEmpty", "searchInput", "showArchived", "memberGrid", "cellTitle", "cellMeta",
    "activeCount", "archivedCount", "manageGroupMembersBtn", "addMemberBtn", "visitDatesBtn", "attendanceBtn", "memoCenterBtn", "memoDueCount", "attendanceModal", "attendanceCloseBtn", "attendancePrevBtn", "attendanceNextBtn",
    "attendanceDate", "attendanceDateLabel", "attendanceHistory", "attendanceSummary", "attendanceCellStats", "attendanceMemberGrid", "attendanceResults",
    "attendanceSaveBtn", "attendanceClearBtn", "settingsBtn", "settingsModal", "settingsForm", "settingsCategoryNav", "settingsCloseBtn", "settingsCancelBtn", "logoutBtn", "annualReportBtn", "railAnnualReportBtn",
    "groupNameInput", "groupDescriptionInput", "groupSaveBtn", "groupEditCancelBtn", "groupList", "groupListStatus",
    "groupMembersModal", "groupMembersTitle", "groupMembersCloseBtn", "groupMembersCancelBtn", "groupMembersSaveBtn", "groupMembersStatus", "groupMemberSearchInput", "groupMemberList", "groupNewMemberBtn",
    "communityTitleText", "communityTitleInput", "saveCommunityTitleBtn", "currentPassword", "newPassword", "confirmPassword", "adminPasswordSaveBtn", "resetNewPassword", "resetConfirmPassword", "passkeyPasswordResetBtn", "passkeyPasswordResetStatus", "passkeyStatusBadge", "passkeyStatus", "passkeyRegisterBtn", "passkeyClearBtn", "guestModeBadge", "guestLogoutBtn", "guestPasswordStatusBadge", "guestPasswordInput", "guestPasswordSaveBtn", "guestPasswordDisableBtn", "guestPasswordStatus", "callNoteInboxBtn", "callNoteInboxCount", "callNoteModal", "callNoteCloseBtn", "callNoteRefreshBtn", "callNoteWebhookUrl", "callNoteTokenBtn", "callNoteTokenReissueBtn", "callNoteTokenOutput", "callNoteStatus", "mobileNotificationStatusBadge", "mobilePairCodeOutput", "mobilePairCodeExpiry", "mobilePairCodeCreateBtn", "mobileDeviceList", "mobileNotificationRefreshBtn", "mobileDeliveryList", "mobileNotificationStatus", "callNoteInboxStatus", "callNoteInbox", "visitDatesModal", "visitDatesCloseBtn", "visitMonthPrevBtn", "visitMonthNextBtn", "visitMonthLabel", "visitCalendar", "visitDateSelectedLabel", "visitDateEntries", "visitRecordModal", "visitRecordCloseBtn", "detailPanel", "emptyDetail",
    "memberForm", "formMode", "formTitle", "backToListBtn", "basicInfoJumpBtn", "contactMemberBtn", "contactMemberActions", "contactCallLink", "contactSmsLink", "bottomBackToListBtn", "closePanelBtn", "photoPreview", "profileDetails", "openVisitRecordBtn",
    "photoInput", "memberName", "memberTitle", "memberCell",
    "memberRole", "memberBaptismStatus", "memberPhone", "memberHomePhone", "memberBirth", "memberBirthCalendar", "memberRegisteredAt", "memberRegisteredAtPicker", "memberRegisteredAtPickerBtn", "memberAge", "memberCalendar", "memberAddress", "memberLongAbsent", "memberMemo", "memberPrayer",
    "archiveBtn", "restoreBtn", "deleteBtn", "visitCount", "visitDate",
    "visitType", "visitAlarmFields", "visitAlarmDate", "visitAlarmTime", "visitSummary", "addVisitBtn", "visitSubmitLabel", "cancelVisitEditBtn", "deleteVisitEditBtn", "visitMemberSummary", "visitTrashToggleBtn", "visitListToggleBtn", "visitList",
    "alarmCenter", "alarmBellBtn", "alarmCount", "alarmPanel", "alarmCloseBtn", "alarmList", "memoModal", "memoCloseBtn", "memoSearchInput", "memoCategoryFilter", "memoStatusFilter", "memoNewBtn", "memoList", "memoEmpty", "memoForm", "memoEditorTitle", "memoTitle", "memoCategory", "memoBody", "memoPinned", "memoStatus", "memoMemberId", "memoGroupId", "memoRemindAt", "memoReminderStatus", "memoReminderResetBtn", "memoSaveBtn", "memoDeleteBtn", "memoCancelBtn",
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
  el.memoCenterBtn.addEventListener("click", () => openMemoCenter());
  el.memoCloseBtn.addEventListener("click", closeMemoCenter);
  el.memoModal.addEventListener("click", (event) => {
    if (event.target === el.memoModal) closeMemoCenter();
  });
  el.memoModal.addEventListener("keydown", handleMemoModalKeydown);
  el.memoSearchInput.addEventListener("input", renderMemoList);
  el.memoCategoryFilter.addEventListener("change", renderMemoList);
  el.memoStatusFilter.addEventListener("change", renderMemoList);
  el.memoNewBtn.addEventListener("click", startNewMemo);
  el.memoList.addEventListener("click", handleMemoListClick);
  el.memoForm.addEventListener("submit", saveMemo);
  el.memoDeleteBtn.addEventListener("click", deleteMemo);
  el.memoCancelBtn.addEventListener("click", cancelMemoEdit);
  el.memoReminderResetBtn.addEventListener("click", resetMemoReminder);
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
      state.returnToAttendanceDate = state.attendanceDate || nearestSundayDate();
      closeSundayAttendance();
      selectMember(detailButton.dataset.attendanceMemberDetail);
    }
  });
  el.attendanceMemberGrid.addEventListener("click", (event) => {
    const button = closestElement(event.target, "[data-attendance-member-id]");
    if (button) toggleSundayAttendanceMember(button.dataset.attendanceMemberId, button);
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
  el.visitMemberSummary.addEventListener("click", (event) => {
    const button = closestElement(event.target, "[data-open-visit-record]");
    if (button) openVisitRecord();
  });
  el.visitRecordCloseBtn.addEventListener("click", closeVisitRecord);
  el.visitRecordModal.addEventListener("click", (event) => {
    if (event.target === el.visitRecordModal) closeVisitRecord();
  });
  el.visitListToggleBtn.addEventListener("click", toggleVisitList);
  el.visitTrashToggleBtn.addEventListener("click", toggleVisitTrash);
  el.visitList.addEventListener("click", handleVisitListClick);
  el.visitType.addEventListener("change", updateVisitAlarmFields);
  el.visitDate.addEventListener("change", syncVisitAlarmDate);
  el.alarmBellBtn.addEventListener("click", toggleAlarmPanel);
  el.alarmCloseBtn.addEventListener("click", closeAlarmPanel);
  el.alarmList.addEventListener("click", handleAlarmListClick);
  el.backToListBtn.addEventListener("click", closeDetail);
  el.basicInfoJumpBtn.addEventListener("click", jumpToBasicInfo);
  el.contactMemberBtn.addEventListener("click", toggleContactActions);
  el.contactMemberActions.addEventListener("click", () => el.contactMemberActions.classList.add("hidden"));
  el.bottomBackToListBtn.addEventListener("click", closeDetail);
  el.callNoteInboxBtn.addEventListener("click", openCallNoteInbox);
  el.callNoteCloseBtn.addEventListener("click", closeCallNoteInbox);
  el.callNoteModal.addEventListener("click", (event) => {
    if (event.target === el.callNoteModal) closeCallNoteInbox();
  });
  el.settingsBtn.addEventListener("click", openSettings);
  el.settingsCategoryNav.addEventListener("click", handleSettingsCategoryNavigation);
  el.settingsCategoryNav.addEventListener("keydown", handleSettingsCategoryKeydown);
  el.settingsCloseBtn.addEventListener("click", closeSettings);
  el.settingsCancelBtn.addEventListener("click", closeSettings);
  el.settingsModal.addEventListener("click", (event) => {
    if (event.target === el.settingsModal) closeSettings();
  });
  el.settingsForm.addEventListener("submit", (event) => event.preventDefault());
  el.adminPasswordSaveBtn.addEventListener("click", changePassword);
  el.saveCommunityTitleBtn.addEventListener("click", saveCommunityTitle);
  el.groupSaveBtn.addEventListener("click", saveManagedGroup);
  el.groupEditCancelBtn.addEventListener("click", resetManagedGroupEditor);
  el.groupNameInput.addEventListener("keydown", handleManagedGroupEditorKeydown);
  el.groupDescriptionInput.addEventListener("keydown", handleManagedGroupEditorKeydown);
  el.groupList.addEventListener("click", handleManagedGroupListClick);
  el.manageGroupMembersBtn.addEventListener("click", () => {
    if (state.selectedGroupId) openGroupMembers(state.selectedGroupId);
  });
  el.groupMembersCloseBtn.addEventListener("click", closeGroupMembers);
  el.groupMembersCancelBtn.addEventListener("click", closeGroupMembers);
  el.groupMembersSaveBtn.addEventListener("click", saveGroupMembers);
  el.groupNewMemberBtn.addEventListener("click", startNewGroupMember);
  el.groupMemberSearchInput.addEventListener("input", renderGroupMemberList);
  el.groupMemberList.addEventListener("change", handleGroupMemberSelection);
  el.groupMembersModal.addEventListener("click", (event) => {
    if (event.target === el.groupMembersModal) closeGroupMembers();
  });
  el.passkeyRegisterBtn.addEventListener("click", registerPasskeyForDevice);
  el.passkeyClearBtn.addEventListener("click", clearRegisteredPasskeys);
  el.passkeyPasswordResetBtn.addEventListener("click", resetPasswordWithPasskey);
  el.callNoteRefreshBtn.addEventListener("click", loadCallNoteImports);
  el.callNoteTokenBtn.addEventListener("click", viewCallNoteToken);
  el.callNoteTokenReissueBtn.addEventListener("click", reissueCallNoteToken);
  el.guestPasswordSaveBtn.addEventListener("click", saveGuestPassword);
  el.guestPasswordDisableBtn.addEventListener("click", disableGuestPassword);
  el.mobilePairCodeCreateBtn.addEventListener("click", createMobilePairCode);
  el.mobileNotificationRefreshBtn.addEventListener("click", () => loadMobileNotificationStatus());
  el.mobileDeviceList.addEventListener("click", handleMobileDeviceAction);
  el.callNoteInbox.addEventListener("click", handleCallNoteInboxClick);
  el.annualReportBtn.addEventListener("click", openAnnualReport);
  el.railAnnualReportBtn.addEventListener("click", openAnnualReport);
  el.logoutBtn.addEventListener("click", () => {
    window.location.href = "/__auth/logout";
  });
  el.guestLogoutBtn.addEventListener("click", () => {
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
  el.deleteVisitEditBtn.addEventListener("click", trashEditingVisit);
}

function openAnnualReport() {
  if (!requireAdmin()) return;
  window.open("/annual-report.html", "_blank", "noopener");
}

function isAdminViewer() {
  return state.viewerRole === "admin";
}

function isGuestViewer() {
  return state.viewerRole === "guest";
}

function requireAdmin(message = "관리자 계정에서만 사용할 수 있습니다") {
  if (isAdminViewer()) return true;
  toast(message);
  return false;
}

function applyViewerRole() {
  const guest = isGuestViewer();
  const unknown = state.viewerRole === "unknown";
  document.body.classList.toggle("guest-mode", guest);
  document.body.classList.toggle("viewer-unknown", unknown);
  el.guestModeBadge?.classList.toggle("hidden", !guest);
  el.guestLogoutBtn?.classList.toggle("hidden", !guest);
  if (guest) {
    state.showArchived = false;
    state.visits = [];
    state.notes = [];
    state.attendanceSessions = [];
    state.callNoteImports = [];
    state.dismissedAlarmKeys = new Set();
    localStorage.removeItem(ALARM_DISMISS_KEY);
  }

  [el.memberName, el.memberTitle, el.memberPhone, el.memberHomePhone, el.memberAddress]
    .filter(Boolean)
    .forEach((field) => {
      field.readOnly = guest;
      field.tabIndex = 0;
    });
  [el.memberCell, el.memberRole]
    .filter(Boolean)
    .forEach((field) => {
      field.disabled = guest;
    });
  if (el.searchInput) {
    el.searchInput.placeholder = guest
      ? "이름, 전화번호, 주소 검색"
      : "전체 검색 · 이름, 전화, 자녀, 가족메모";
  }
}

function bindSessionActivityRefresh() {
  const recordActivity = (event) => {
    if (event && event.isTrusted === false) return;
    recordSessionActivity();
  };
  window.addEventListener("pointerdown", recordActivity, { passive: true });
  window.addEventListener("keydown", recordActivity, { passive: true });
  window.addEventListener("wheel", recordActivity, { passive: true });
  window.addEventListener("focus", recordActivity, { passive: true });
  document.addEventListener("scroll", recordActivity, { passive: true, capture: true });
  document.addEventListener("visibilitychange", (event) => {
    if (document.visibilityState === "visible") recordActivity(event);
  });
  recordSessionActivity();
}

function recordSessionActivity() {
  const now = Date.now();
  if (state.lastSessionActivityAt && now - state.lastSessionActivityAt >= SESSION_IDLE_TIMEOUT_MS) {
    redirectToLogin();
    return;
  }
  state.lastSessionActivityAt = now;
  scheduleSessionIdleLogout();
  refreshSessionForActivity();
}

function scheduleSessionIdleLogout() {
  if (state.sessionIdleTimerId) window.clearTimeout(state.sessionIdleTimerId);
  const remaining = Math.max(
    0,
    state.lastSessionActivityAt + SESSION_IDLE_TIMEOUT_MS - Date.now()
  );
  state.sessionIdleTimerId = window.setTimeout(handleSessionIdleTimeout, remaining);
}

function handleSessionIdleTimeout() {
  state.sessionIdleTimerId = 0;
  if (Date.now() - state.lastSessionActivityAt < SESSION_IDLE_TIMEOUT_MS) {
    scheduleSessionIdleLogout();
    return;
  }
  redirectToLogin();
}

function redirectToLogin() {
  if (state.sessionIdleTimerId) window.clearTimeout(state.sessionIdleTimerId);
  state.sessionIdleTimerId = 0;
  window.location.replace("/__auth/login");
}

async function refreshSessionForActivity() {
  const now = Date.now();
  if (state.sessionRefreshPending) return;
  if (now - state.lastSessionRefreshAt < SESSION_REFRESH_MIN_INTERVAL_MS) return;
  if (now - state.lastSessionRefreshAttemptAt < SESSION_REFRESH_RETRY_INTERVAL_MS) return;

  state.sessionRefreshPending = true;
  state.lastSessionRefreshAttemptAt = now;
  try {
    const response = await fetch("/__auth/refresh", {
      method: "POST",
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    if (response.status === 401) {
      redirectToLogin();
      return;
    }
    if (response.ok) state.lastSessionRefreshAt = Date.now();
  } catch {
    // A transient network failure must not force a logout and can retry shortly.
  } finally {
    state.sessionRefreshPending = false;
  }
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
  state.cells = local.cells?.length ? local.cells : structuredClone(INITIAL_CELLS);
  state.groups = local.groups || [];
  state.members = [];
  state.visits = [];
  state.notes = [];
  state.attendanceSessions = [];
  state.selectedCellId = local.selectedCellId || "";
  state.selectedGroupId = local.selectedGroupId || "";
  state.showArchived = Boolean(local.showArchived);
  el.showArchived.checked = state.showArchived;

  try {
    const response = await fetch("/api/bootstrap", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("api unavailable");
    const data = await response.json();
    if (Array.isArray(data.cells) && data.cells.length) {
      state.viewerRole = data.viewerRole === "guest" ? "guest" : "admin";
      state.settings = {
        ...state.settings,
        ...(data.settings || {})
      };
      state.cells = data.cells;
      state.groups = Array.isArray(data.groups) ? data.groups : [];
      state.members = data.members || [];
      hydrateSeedPhotoUrls(state.members);
      if (isAdminViewer()) applyMemberDetails(state.members);
      state.visits = isAdminViewer() && Array.isArray(data.visits) ? data.visits : [];
      state.notes = isAdminViewer() && Array.isArray(data.notes) ? data.notes : [];
      state.apiOnline = true;
      persist();
    }
  } catch {
    state.apiOnline = false;
    state.viewerRole = "unknown";
    state.members = [];
    state.visits = [];
    state.notes = [];
  }
}

function readLocal() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (saved && typeof saved === "object") {
      const safePreferences = {
        settings: safeLocalSettings(saved.settings),
        cells: safeLocalCells(saved.cells),
        groups: safeLocalGroups(saved.groups),
        selectedCellId: saved.selectedCellId || "",
        selectedGroupId: saved.selectedGroupId || "",
        showArchived: saved.showArchived || false
      };
      // Older builds cached member, visitation and attendance records in localStorage.
      // Keep only non-sensitive display preferences so a later guest session cannot read them.
      localStorage.setItem(STORE_KEY, JSON.stringify(safePreferences));
      return safePreferences;
    }
  } catch {
    localStorage.removeItem(STORE_KEY);
  }
  return {
    settings: { communityTitle: DEFAULT_COMMUNITY_TITLE },
    cells: structuredClone(INITIAL_CELLS),
    groups: [],
    selectedCellId: INITIAL_CELLS[0]?.id || "",
    selectedGroupId: "",
    showArchived: false
  };
}

function safeLocalSettings(settings) {
  return {
    communityTitle: cleanTitle(settings?.communityTitle)
  };
}

function safeLocalCells(cells) {
  if (!Array.isArray(cells)) return structuredClone(INITIAL_CELLS);
  return cells.map((cell) => ({
    id: String(cell?.id || ""),
    name: String(cell?.name || ""),
    gender: String(cell?.gender || ""),
    sortOrder: Number.isFinite(Number(cell?.sortOrder)) ? Number(cell.sortOrder) : 0,
    isSystem: Boolean(cell?.isSystem)
  })).filter((cell) => cell.id && cell.name);
}

function safeLocalGroups(groups) {
  if (!Array.isArray(groups)) return [];
  return groups.map((group) => ({
    id: String(group?.id || ""),
    name: String(group?.name || ""),
    sortOrder: Number.isFinite(Number(group?.sortOrder)) ? Number(group.sortOrder) : 0
  })).filter((group) => group.id && group.name);
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
    settings: safeLocalSettings(state.settings),
    cells: safeLocalCells(state.cells),
    groups: safeLocalGroups(state.groups),
    selectedCellId: state.selectedCellId,
    selectedGroupId: state.selectedGroupId,
    showArchived: state.showArchived
  }));
}

function render() {
  applyViewerRole();
  renderCommunityTitle();
  renderCellTabs();
  renderGroupTabs();
  renderCellSelect();
  renderMembers();
  renderDetail();
  updateMobileDetailState();
  renderAlarmNotifications();
  renderMemoDueCount();
}

function renderCellTabs() {
  el.cellTabs.innerHTML = visibleCells()
    .slice()
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
    .map((cell) => {
      const count = state.members.filter((member) => member.cellId === cell.id && !member.archivedAt && !member.trashedAt).length;
      return `<button class="cell-tab ${cellGenderClass(cell)} ${!state.selectedGroupId && cell.id === state.selectedCellId ? "active" : ""}" data-cell-id="${cell.id}" type="button">
        <strong>${cellNameHtml(cell.name)}</strong>
        <span class="cell-tab-count">${count}명</span>
      </button>`;
    })
    .join("");

  el.cellTabs.querySelectorAll("[data-cell-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedCellId = button.dataset.cellId;
      state.selectedGroupId = "";
      state.selectedMemberId = "";
      persist();
      render();
    });
  });
}

function renderGroupTabs() {
  const groups = state.groups
    .slice()
    .sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) || compareKoreanNames(a.name, b.name));
  const unassigned = unassignedMembers();
  const activeUnassignedCount = unassigned.filter((member) => !member.archivedAt).length;

  el.groupTabsEmpty.classList.toggle("hidden", groups.length > 0 || unassigned.length > 0);
  const groupTabsHtml = groups.map((group) => {
    const memberIds = new Set(group.memberIds || []);
    const count = state.members.filter((member) => memberIds.has(member.id) && !member.archivedAt && !member.trashedAt).length;
    return `<button class="cell-tab group-tab ${group.id === state.selectedGroupId ? "active" : ""}" data-group-id="${escapeAttribute(group.id)}" type="button" title="${escapeAttribute(group.description || group.name)}">
      <strong>${escapeHtml(group.name)}</strong>
      <span class="cell-tab-count">${count}명</span>
    </button>`;
  }).join("");
  const unassignedTabHtml = unassigned.length ? `<button class="cell-tab group-tab unassigned-tab ${!state.selectedGroupId && isSystemCellId(state.selectedCellId) ? "active" : ""}" data-unassigned-members type="button" title="셀과 기관이 모두 지정되지 않은 구성원">
    <strong>미지정 구성원</strong>
    <span class="cell-tab-count">${activeUnassignedCount}명</span>
  </button>` : "";
  el.groupTabs.innerHTML = groupTabsHtml + unassignedTabHtml;

  el.groupTabs.querySelectorAll("[data-group-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedGroupId = button.dataset.groupId;
      state.selectedMemberId = "";
      persist();
      render();
    });
  });
  el.groupTabs.querySelector("[data-unassigned-members]")?.addEventListener("click", () => {
    state.selectedCellId = UNASSIGNED_CELL_ID;
    state.selectedGroupId = "";
    state.selectedMemberId = "";
    persist();
    render();
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
  const cells = visibleCells();
  const systemCell = state.cells.find((cell) => cell.id === UNASSIGNED_CELL_ID || cell.isSystem);
  const needsSystemCell = Boolean(
    systemCell && (state.selectedGroupId || selectedMember()?.cellId === systemCell.id || state.pendingGroupId)
  );
  if (needsSystemCell) cells.push(systemCell);
  el.memberCell.innerHTML = cells
    .map((cell) => `<option value="${cell.id}">${escapeHtml(cell.name)} ${escapeHtml(cell.meta || "")}</option>`)
    .join("");
}


function renderMembers() {
  if (state.viewerRole === "unknown") {
    el.cellTitle.textContent = "\uC5F0\uACB0 \uC624\uB958";
    el.cellMeta.textContent = "\uC11C\uBC84 \uB370\uC774\uD130\uB97C \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4";
    el.activeCount.textContent = "";
    el.archivedCount.textContent = "";
    el.memberGrid.classList.remove("sectioned");
    el.memberGrid.innerHTML = `<div class="member-card bootstrap-error-card" role="alert">
      <span class="member-name">\uB370\uC774\uD130\uB97C \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4</span>
      <span class="member-sub">\uC778\uD130\uB137 \uC5F0\uACB0\uC744 \uD655\uC778\uD55C \uB4A4 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694.</span>
      <span class="bootstrap-error-actions">
        <button class="icon-button text-button primary" type="button" data-bootstrap-retry>\uB2E4\uC2DC \uC2DC\uB3C4</button>
        <button class="icon-button text-button subtle" type="button" data-bootstrap-logout>\uB85C\uADF8\uC544\uC6C3</button>
      </span>
    </div>`;
    el.memberGrid.querySelector("[data-bootstrap-retry]")?.addEventListener("click", () => window.location.reload());
    el.memberGrid.querySelector("[data-bootstrap-logout]")?.addEventListener("click", () => {
      window.location.href = "/__auth/logout";
    });
    return;
  }
  const group = currentGroup();
  const cell = currentCell();
  if (!group && !cell) return;

  const rawQuery = state.query.trim();
  const isSearching = Boolean(rawQuery);
  const availableMembers = state.members.filter((member) => !member.trashedAt);
  const groupMemberIds = new Set(group?.memberIds || []);
  const allInScope = group
    ? availableMembers.filter((member) => groupMemberIds.has(member.id))
    : availableMembers.filter((member) => member.cellId === cell.id);
  const active = allInScope.filter((member) => !member.archivedAt);
  const archived = allInScope.filter((member) => member.archivedAt);

  const baseMembers = isSearching ? availableMembers : allInScope;
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
    el.cellTitle.textContent = group?.name || cell.name;
    el.cellMeta.textContent = group ? (group.description || "기관/사역") : (cell.meta || cell.gender || "");
    el.activeCount.textContent = `${active.length}\uBA85`;
    el.archivedCount.textContent = `제적처리 ${archived.length}명`;
  }
  el.manageGroupMembersBtn.classList.toggle("hidden", !group);
  el.addMemberBtn.classList.toggle("hidden", !group && isSystemCellId(cell?.id));
  const addMemberLabel = el.addMemberBtn.querySelector("span");
  if (addMemberLabel) addMemberLabel.textContent = group ? "구성원 등록" : "새신자등록";
  updateArchiveVisibilityControls();

  if (!visible.length) {
    const emptyTitle = isSearching ? "\uAC80\uC0C9 \uACB0\uACFC \uC5C6\uC74C" : "\uACB0\uACFC \uC5C6\uC74C";
    const emptyHint = isSearching
      ? (isGuestViewer()
        ? "\uC774\uB984, \uC804\uD654\uBC88\uD638, \uC8FC\uC18C\uB97C \uD655\uC778\uD558\uC138\uC694"
        : "\uC774\uB984, \uC804\uD654, \uC9D1\uC804\uD654, \uAC00\uC871/\uC790\uB140\uBA54\uBAA8\uB97C \uD655\uC778\uD558\uC138\uC694")
      : "\uAC80\uC0C9 \uC870\uAC74\uC744 \uC870\uC815\uD558\uC138\uC694";
    el.memberGrid.classList.remove("sectioned");
    el.memberGrid.innerHTML = `<div class="member-card"><span class="member-name">${emptyTitle}</span><span class="member-sub">${emptyHint}</span></div>`;
    return;
  }

  el.memberGrid.classList.toggle("sectioned", !isSearching && visible.some((member) => member.longAbsent));
  el.memberGrid.innerHTML = memberGridHtml(visible, isSearching || Boolean(group));
  el.memberGrid.querySelectorAll("[data-member-id]").forEach((button) => {
    button.addEventListener("click", () => selectMember(button.dataset.memberId));
  });
}

function renderCommunityTitle() {
  const title = cleanTitle(state.settings?.communityTitle);
  const displayTitle = title || MISSING_COMMUNITY_TITLE;
  if (el.communityTitleText) {
    el.communityTitleText.textContent = displayTitle;
    el.communityTitleText.classList.toggle("missing-title", !title);
  }
  document.title = "공동체관리";
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
    memberGroupLabels(member),
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

function memberGroupLabels(member) {
  return state.groups
    .filter((group) => group.memberIds?.includes(member.id))
    .map((group) => group.name)
    .join(" ");
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

function renderVisitMemberSummary(member) {
  el.visitMemberSummary.innerHTML = `
    <div class="visit-member-summary-text">
      <strong>${memberNameHtml(member)}</strong>
      <span>${escapeHtml(member.title || "직분 없음")}</span>
    </div>
    <button class="icon-button text-button subtle visit-summary-record-button" type="button" data-open-visit-record title="심방기록" aria-label="심방기록">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 6h13M8 12h13M8 18h13"></path>
        <path d="M3 6h.01M3 12h.01M3 18h.01"></path>
      </svg>
      <span>심방기록</span>
    </button>`;
}

function renderContactActions(member) {
  const callPhone = callablePhoneNumber(member);
  const smsPhone = normalizePhoneSearch(member.phone || "");
  el.contactMemberBtn.disabled = !callPhone;
  el.contactMemberBtn.title = callPhone ? "연락하기" : "전화번호 없음";
  el.contactCallLink.href = callPhone ? `tel:${callPhone}` : "#";
  el.contactSmsLink.href = smsPhone ? `sms:${smsPhone}` : "#";
  el.contactSmsLink.classList.toggle("hidden", !smsPhone);
  el.contactMemberActions.classList.add("hidden");
}

function toggleContactActions() {
  const member = selectedMember();
  if (!callablePhoneNumber(member)) {
    toast("전화번호가 없습니다");
    return;
  }
  el.contactMemberActions.classList.toggle("hidden");
}

function updatePhotoPreview(member) {
  el.photoPreview.outerHTML = portraitHtml(member, true)
    .replace("<span", "<div id=\"photoPreview\"")
    .replace("</span>", "</div>");
  el.photoPreview = document.getElementById("photoPreview");
}

function selectMember(memberId) {
  const member = state.members.find((item) => item.id === memberId);
  const selectedGroup = currentGroup();
  const staysInGroup = Boolean(selectedGroup?.memberIds?.includes(memberId));
  if (!staysInGroup && member) {
    const memberGroup = state.groups.find((group) => group.memberIds?.includes(memberId));
    if (isSystemCellId(member.cellId) && memberGroup) {
      state.selectedGroupId = memberGroup.id;
    } else {
      state.selectedGroupId = "";
      if (member.cellId && !isSystemCellId(member.cellId)) state.selectedCellId = member.cellId;
    }
  }
  state.selectedMemberId = memberId;
  state.mode = "view";
  state.pendingPhotoData = null;
  state.editingVisitId = "";
  state.visitListCollapsed = isMobileView();
  state.visitListPageOpen = false;
  state.expandedVisitId = "";
  state.showVisitTrash = false;
  persist();
  renderCellTabs();
  renderGroupTabs();
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
    el.formTitle.classList.add("hidden-title");
    return;
  }

  el.emptyDetail.classList.add("hidden");
  el.memberForm.classList.remove("hidden");
  el.formMode.textContent = isDraftMember(member) ? "신규" : "상세";
  const returnButtonHtml = state.returnToAttendanceDate
    ? '<button class="detail-return-button" type="button" data-return-attendance>결석자명단으로</button>'
    : "";
  el.formTitle.classList.toggle("hidden-title", !state.returnToAttendanceDate);
  el.formTitle.innerHTML = `${member.name
    ? `<span>${memberNameHtml(member)}</span>${newMemberBadgeHtml(member)}`
    : "성도 정보"}${returnButtonHtml}`;
  el.formTitle.querySelector("[data-return-attendance]")?.addEventListener("click", returnToSundayAttendance);
  renderVisitMemberSummary(member);
  renderContactActions(member);
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
  el.profileDetails.open = isGuestViewer();
  hideVisitRecord();
  el.archiveBtn.classList.toggle("hidden", Boolean(member.archivedAt));
  el.restoreBtn.classList.toggle("hidden", !member.archivedAt);
  el.deleteBtn.classList.toggle("hidden", isDraftMember(member));
  if (isAdminViewer()) {
    renderVisits(member.id);
  } else {
    el.visitMemberSummary.innerHTML = "";
    el.visitList.innerHTML = "";
    el.visitCount.textContent = "0건";
  }
  applyViewerRole();
  updateMobileDetailState();
}

async function startNewMember() {
  if (!requireAdmin()) return;
  const targetGroupId = state.selectedGroupId || "";
  const draft = state.members.find(isDraftMember);
  if (draft) {
    state.pendingGroupId = targetGroupId;
    if (targetGroupId) {
      if (!draft.cellId || isSystemCellId(draft.cellId)) draft.cellId = UNASSIGNED_CELL_ID;
    } else if (!isSystemCellId(state.selectedCellId)) {
      draft.cellId = state.selectedCellId;
    }
    state.selectedMemberId = draft.id;
    state.visitListCollapsed = isMobileView();
    state.visitListPageOpen = false;
    state.expandedVisitId = "";
    state.showVisitTrash = false;
    render();
    scrollToSelectedDetail();
    el.memberName.focus();
    return;
  }

  if (!targetGroupId && isSystemCellId(state.selectedCellId)) {
    toast("새 구성원은 셀이나 기관을 선택한 뒤 등록하세요");
    return;
  }
  if (targetGroupId && !(await ensureManagedGroupOnline())) return;

  const now = new Date().toISOString();
  state.pendingGroupId = targetGroupId;
  const member = {
    id: `new-${crypto.randomUUID()}`,
    localDraft: true,
    cellId: targetGroupId ? UNASSIGNED_CELL_ID : state.selectedCellId,
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
  state.visitListCollapsed = isMobileView();
  state.visitListPageOpen = false;
  state.expandedVisitId = "";
  state.showVisitTrash = false;
  render();
  scrollToSelectedDetail();
  el.memberName.focus();
}

async function saveMember(event) {
  event.preventDefault();
  if (!requireAdmin()) return;
  const member = selectedMember();
  if (!member) return;

  const wasNew = isDraftMember(member);
  const targetGroupId = wasNew ? state.pendingGroupId : "";
  let savedRemotely = false;
  let savedGroupUpdatedAt = "";
  let photoUploadFailed = false;
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
  if (targetGroupId && !(await ensureManagedGroupOnline("기관 전용 신규 구성원은 온라인 연결에서만 저장할 수 있습니다"))) return;

  Object.assign(member, payload, { updatedAt: new Date().toISOString() });
  if (state.pendingPhotoData) {
    member.photoUrl = state.pendingPhotoData;
    member.photoKey = "";
  }

  if (state.apiOnline) {
    try {
      const saved = await saveMemberToApi(member, wasNew, targetGroupId);
      const savedMember = saved?.member && typeof saved.member === "object" ? saved.member : saved;
      savedGroupUpdatedAt = String(saved?.groupUpdatedAt || savedMember?.groupUpdatedAt || "");
      const normalizedSavedMember = { ...(savedMember || {}) };
      delete normalizedSavedMember.groupUpdatedAt;
      Object.assign(member, normalizedSavedMember);
      delete member.localDraft;
      savedRemotely = true;
    } catch (error) {
      if (targetGroupId && error.status === 409) {
        if (error.group) {
          const groupIndex = state.groups.findIndex((group) => group.id === error.group.id);
          if (groupIndex >= 0) state.groups[groupIndex] = error.group;
        }
        persist();
        toast("다른 화면에서 기관 구성원이 변경되었습니다. 입력 내용은 그대로 두었으니 다시 저장해 주세요.");
        return;
      }
      state.apiOnline = false;
      if (targetGroupId) {
        persist();
        toast("온라인 저장에 실패했습니다. 입력은 유지되며 연결 후 다시 저장할 수 있습니다");
        return;
      }
      toast("로컬에 저장되었습니다");
    }
  }

  if (savedRemotely && state.pendingPhotoFile) {
    try {
      await uploadPhotoToApi(member.id, state.pendingPhotoFile);
    } catch {
      photoUploadFailed = true;
    }
  }

  if (wasNew && isDraftMember(member)) {
    member.id = `local-${crypto.randomUUID()}`;
  }

  if (targetGroupId) {
    const group = state.groups.find((item) => item.id === targetGroupId);
    if (group) {
      const memberIds = [...new Set([...(group.memberIds || []), member.id])];
      group.memberIds = memberIds;
      if (savedGroupUpdatedAt) group.updatedAt = savedGroupUpdatedAt;
      state.selectedGroupId = targetGroupId;
    }
  } else if (!isSystemCellId(member.cellId)) {
    state.selectedCellId = member.cellId;
  }
  state.selectedMemberId = member.id;
  state.pendingGroupId = "";
  state.pendingPhotoData = null;
  state.pendingPhotoFile = null;
  persist();
  render();
  toast(photoUploadFailed ? "성도 정보는 저장됐지만 사진 업로드를 확인해 주세요" : "저장되었습니다");
}

async function saveMemberToApi(member, wasNew, managedGroupId = "") {
  const method = wasNew ? "POST" : "PATCH";
  const url = wasNew ? "/api/members" : `/api/members/${encodeURIComponent(member.id)}`;
  const managedGroup = wasNew && managedGroupId
    ? state.groups.find((group) => group.id === managedGroupId)
    : null;
  if (wasNew && managedGroupId && !managedGroup) {
    throw new Error("기관 정보가 변경되었습니다. 새로고침한 뒤 다시 등록해 주세요.");
  }
  const payload = {
    ...member,
    ...(managedGroup ? {
      managedGroupId,
      managedGroupExpectedUpdatedAt: managedGroup.updatedAt
    } : {})
  };
  const response = await writeFetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || "save failed");
    error.status = response.status;
    error.code = result.code || "";
    error.group = result.group || null;
    throw error;
  }
  return result;
}

async function handlePhotoPick(event) {
  if (!requireAdmin()) return;
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
  if (!requireAdmin()) return;
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
  if (!requireAdmin()) return;
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
  if (!requireAdmin()) return;
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
  if (!requireAdmin()) return;
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
  if (!requireAdmin()) return;
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

async function addVisit() {
  if (!requireAdmin()) return;
  if (state.visitSavePending) return;
  const member = selectedMember();
  if (!member) return;
  const summary = el.visitSummary.value.trim();
  if (!summary) {
    toast("요약을 입력하세요");
    el.visitSummary.focus();
    return;
  }
  if (!validateVisitAlarmForm()) return;

  setVisitSavePending(true);
  try {
    if (state.editingVisitId) {
      await updateVisit(member, summary);
      return;
    }

    const visit = {
      id: `visit-${crypto.randomUUID()}`,
      memberId: member.id,
      visitDate: visitDateFromForm(),
      visitType: el.visitType.value || "전화",
      summary,
      action: visitActionFromForm(),
      alarmAt: visitAlarmAtFromForm(),
      alarmState: el.visitType.value === VISIT_TYPE_ALARM ? "scheduled" : "none",
      source: "manual",
      createdAt: new Date().toISOString()
    };
    let savedVisit = visit;
    if (state.apiOnline) {
      const response = await writeFetch("/api/visit-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(visit)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "심방내역을 저장하지 못했습니다");
      savedVisit = result;
    } else if (visit.visitType === VISIT_TYPE_ALARM) {
      toast("휴대전화 알림은 인터넷에 연결된 상태에서 저장해야 합니다");
      return;
    }
    state.visits.unshift(savedVisit);
    resetVisitForm();
    persist();
    renderVisits(member.id);
    renderAlarmNotifications();
    hideVisitRecord();
    if (!el.visitDatesModal.classList.contains("hidden")) renderVisitDates();
    toast("심방내역이 추가되었습니다");
  } catch (error) {
    toast(error.message || "심방내역을 저장하지 못했습니다");
  } finally {
    setVisitSavePending(false);
  }
}

async function updateVisit(member, summary) {
  const visit = state.visits.find((item) => item.id === state.editingVisitId && item.memberId === member.id);
  if (!visit) {
    cancelVisitEdit();
    return;
  }

  const nextVisitType = el.visitType.value || "전화";
  const nextAlarmAt = visitAlarmAtFromForm();
  const updated = {
    ...visit,
    visitDate: visitDateFromForm(),
    visitType: nextVisitType,
    summary,
    prayer: "",
    action: visitActionFromForm(visit),
    alarmAt: nextAlarmAt,
    expectedUpdatedAt: visit.updatedAt || ""
  };
  if (nextVisitType !== VISIT_TYPE_ALARM) {
    updated.alarmState = "none";
  } else if (visit.visitType !== VISIT_TYPE_ALARM || nextAlarmAt !== visitAlarmAt(visit)) {
    updated.alarmState = "scheduled";
  } else {
    delete updated.alarmState;
  }
  let savedVisit = updated;
  if (state.apiOnline) {
    try {
      const response = await writeFetch(`/api/visit-notes/${encodeURIComponent(updated.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updated)
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 409 && result.visit) {
        state.visits = state.visits.map((item) => item.id === result.visit.id ? result.visit : item);
      }
      if (!response.ok) throw new Error(result.error || "심방내역을 수정하지 못했습니다");
      savedVisit = result;
    } catch (error) {
      toast(error.message || "심방내역을 수정하지 못했습니다");
      renderVisits(member.id);
      return;
    }
  } else if (visit.visitType === VISIT_TYPE_ALARM || updated.visitType === VISIT_TYPE_ALARM) {
    toast("휴대전화 알림은 인터넷에 연결된 상태에서 수정해야 합니다");
    return;
  }
  state.visits = state.visits.map((item) => item.id === savedVisit.id ? savedVisit : item);
  state.editingVisitId = "";
  resetVisitForm();
  persist();
  renderVisits(member.id);
  renderAlarmNotifications();
  hideVisitRecord();
  if (!el.visitDatesModal.classList.contains("hidden")) renderVisitDates();
  toast("심방내역을 수정했습니다");
}

function startVisitEdit(visitId) {
  const visit = state.visits.find((item) => item.id === visitId);
  const member = selectedMember();
  if (!visit || !member || visit.memberId !== member.id) return;
  state.editingVisitId = visit.id;
  state.visitListCollapsed = false;
  state.visitListPageOpen = isMobileView();
  state.expandedVisitId = "";
  renderVisits(member.id);
  el.visitDate.value = visit.visitDate || today();
  el.visitType.value = visit.visitType || el.visitType.options[0]?.value || "";
  setVisitAlarmFieldsFromVisit(visit);
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
  el.visitType.value = el.visitType.options[0]?.value || "전화";
  el.visitAlarmDate.value = "";
  el.visitAlarmTime.value = "";
  el.visitSummary.value = "";
  updateVisitAlarmFields();
  setVisitFormMode();
}

function setVisitFormMode() {
  const editing = Boolean(state.editingVisitId);
  el.visitSubmitLabel.textContent = editing ? "\uC800\uC7A5" : "\uCD94\uAC00";
  el.addVisitBtn.disabled = state.visitSavePending;
  el.cancelVisitEditBtn.classList.toggle("hidden", !editing);
  el.deleteVisitEditBtn.classList.toggle("hidden", !editing);
}

function setVisitSavePending(pending) {
  state.visitSavePending = Boolean(pending);
  setVisitFormMode();
}

function renderVisits(memberId) {
  const allVisits = state.visits
    .filter((visit) => visit.memberId === memberId)
    .sort((a, b) => `${b.visitDate || ""}${b.createdAt || ""}`.localeCompare(`${a.visitDate || ""}${a.createdAt || ""}`));
  const activeVisits = allVisits.filter((visit) => !visitTrashedAt(visit));
  const trashedVisits = allVisits.filter((visit) => visitTrashedAt(visit));
  if (!trashedVisits.length) state.showVisitTrash = false;
  const visibleVisits = state.showVisitTrash ? trashedVisits : activeVisits;
  el.visitCount.textContent = state.showVisitTrash ? `휴지통 ${trashedVisits.length}건` : `${activeVisits.length}건`;
  if (!state.editingVisitId) resetVisitForm();
  el.visitList.innerHTML = visibleVisits.length
    ? visibleVisits.map((visit) => visitItemHtml(visit)).join("")
    : `<article class="visit-item"><small>${state.showVisitTrash ? "휴지통이 비었습니다." : "기록 없음"}</small></article>`;
  el.visitList.querySelectorAll("[data-visit-edit-id]").forEach((button) => {
    button.addEventListener("click", () => startVisitEdit(button.dataset.visitEditId));
  });
  renderVisitListState({
    activeCount: activeVisits.length,
    trashCount: trashedVisits.length,
    visibleCount: visibleVisits.length
  });
}

function visitItemHtml(visit) {
  const trashed = Boolean(visitTrashedAt(visit));
  const alarmAt = visitAlarmAt(visit);
  const alarmHtml = alarmAt ? `<small class="visit-alarm-label">알림 ${escapeHtml(formatAlarmDateTime(alarmAt))}</small>` : "";
  const editButton = `<button class="icon-button subtle visit-edit-button" data-visit-edit-id="${escapeAttribute(visit.id)}" type="button" title="수정" aria-label="심방내역 수정">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 20h9"></path>
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path>
    </svg>
  </button>`;
  const restoreButton = `<button class="icon-button text-button subtle visit-restore-button" data-visit-restore-id="${escapeAttribute(visit.id)}" type="button" title="복구" aria-label="심방내역 복구">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7"></path>
      <path d="M3 4v7h7"></path>
    </svg>
    <span>복구</span>
  </button>`;
  const permanentDeleteButton = `<button class="icon-button text-button danger visit-delete-button" data-visit-delete-id="${escapeAttribute(visit.id)}" type="button" title="완전 삭제" aria-label="심방내역 완전 삭제">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 6h18"></path>
      <path d="M8 6V4h8v2"></path>
      <path d="m19 6-1 14H6L5 6"></path>
      <path d="M10 11v6M14 11v6"></path>
    </svg>
    <span>완전삭제</span>
  </button>`;
  return `<article class="visit-item ${visit.id === state.editingVisitId ? "editing" : ""} ${visit.id === state.expandedVisitId ? "expanded" : ""} ${trashed ? "trashed" : ""}" data-visit-id="${escapeAttribute(visit.id)}">
    <div class="visit-item-head">
      <div class="visit-item-title">
        <strong>${escapeHtml(visit.visitDate || "")} · ${escapeHtml(visit.visitType || "심방")}</strong>
        ${alarmHtml}
      </div>
      <div class="visit-item-actions">
        ${trashed ? `${restoreButton}${permanentDeleteButton}` : editButton}
      </div>
    </div>
    <p>${escapeHtml(visitSummaryText(visit))}</p>
  </article>`;
}

function toggleVisitList() {
  if (isMobileView()) {
    state.visitListPageOpen = !state.visitListPageOpen;
    state.visitListCollapsed = !state.visitListPageOpen;
    state.expandedVisitId = "";
  } else {
    state.visitListCollapsed = !state.visitListCollapsed;
    state.visitListPageOpen = false;
    state.expandedVisitId = "";
  }
  const member = selectedMember();
  if (member) renderVisits(member.id);
  else renderVisitListState();
  el.visitList.scrollTop = 0;
}

function toggleVisitTrash() {
  state.showVisitTrash = !state.showVisitTrash;
  state.editingVisitId = "";
  state.expandedVisitId = "";
  state.visitListPageOpen = false;
  const member = selectedMember();
  if (member) renderVisits(member.id);
}

function renderVisitListState(visitCount = state.visits.filter((visit) => visit.memberId === state.selectedMemberId).length) {
  const counts = typeof visitCount === "number"
    ? { activeCount: visitCount, trashCount: 0, visibleCount: visitCount }
    : visitCount;
  const activeCount = counts.activeCount || 0;
  const trashCount = counts.trashCount || 0;
  const visibleCount = counts.visibleCount || 0;
  const hasSection = activeCount + trashCount > 0;
  const hasVisibleVisits = visibleCount > 0;
  const fullPage = hasVisibleVisits && isMobileView() && state.visitListPageOpen;
  const collapsed = hasVisibleVisits && state.visitListCollapsed && !fullPage;
  const visitSection = el.visitList.closest(".visit-section");
  visitSection?.classList.toggle("empty", !hasSection);
  visitSection?.classList.toggle("showing-trash", state.showVisitTrash);
  visitSection?.classList.toggle("full-page", fullPage);
  el.visitList.classList.toggle("collapsed", collapsed);
  el.visitList.classList.toggle("scrollable", visibleCount > 4);
  el.visitTrashToggleBtn.classList.toggle("hidden", !trashCount);
  el.visitTrashToggleBtn.classList.toggle("active", state.showVisitTrash);
  el.visitTrashToggleBtn.textContent = state.showVisitTrash ? "휴지통 나가기" : `휴지통 ${trashCount}`;
  el.visitListToggleBtn.classList.toggle("hidden", !hasVisibleVisits);
  el.visitListToggleBtn.classList.toggle("collapsed", collapsed);
  el.visitListToggleBtn.setAttribute("aria-expanded", fullPage || !collapsed ? "true" : "false");
  el.visitListToggleBtn.querySelector("span").textContent = fullPage ? "접기" : (collapsed ? "전체 보기" : "접기");
  renderExpandedVisitItem();
}

function handleVisitListClick(event) {
  const restoreButton = closestElement(event.target, "[data-visit-restore-id]");
  if (restoreButton) {
    restoreVisit(restoreButton.dataset.visitRestoreId);
    return;
  }
  const deleteButton = closestElement(event.target, "[data-visit-delete-id]");
  if (deleteButton) {
    deleteVisitPermanently(deleteButton.dataset.visitDeleteId);
    return;
  }
  if (!isMobileView() || !state.visitListCollapsed || state.visitListPageOpen) return;
  if (closestElement(event.target, "[data-visit-edit-id]")) return;
  const item = closestElement(event.target, "[data-visit-id]");
  if (!item) return;
  state.expandedVisitId = state.expandedVisitId === item.dataset.visitId ? "" : item.dataset.visitId;
  renderExpandedVisitItem();
}

function renderExpandedVisitItem() {
  const allowExpanded = isMobileView() && state.visitListCollapsed && !state.visitListPageOpen;
  el.visitList.querySelectorAll("[data-visit-id]").forEach((visitItem) => {
    visitItem.classList.toggle("expanded", allowExpanded && visitItem.dataset.visitId === state.expandedVisitId);
  });
}

function updateVisitAlarmFields() {
  const isAlarm = el.visitType.value === VISIT_TYPE_ALARM;
  el.visitAlarmFields.classList.toggle("hidden", !isAlarm);
  el.visitAlarmDate.required = isAlarm;
  el.visitAlarmTime.required = isAlarm;
  if (!isAlarm) return;
  if (!el.visitAlarmDate.value && !el.visitAlarmTime.value) {
    const alarmDefault = defaultAlarmDateTime();
    el.visitAlarmDate.value = alarmDefault.date;
    el.visitAlarmTime.value = alarmDefault.time;
    return;
  }
  el.visitAlarmDate.value = el.visitAlarmDate.value || defaultAlarmDateTime().date;
  el.visitAlarmTime.value = el.visitAlarmTime.value || defaultAlarmDateTime().time;
}

function syncVisitAlarmDate() {
  if (el.visitType.value === VISIT_TYPE_ALARM && !el.visitAlarmDate.value) {
    el.visitAlarmDate.value = el.visitDate.value || today();
  }
}

function validateVisitAlarmForm() {
  if (el.visitType.value !== VISIT_TYPE_ALARM) return true;
  const editingVisit = state.visits.find((visit) => visit.id === state.editingVisitId);
  if (editingVisit?.source && editingVisit.source !== "manual") {
    toast("심방콜노트에서 가져온 내역은 알람으로 바꿀 수 없습니다. 새 알람 내역을 추가하세요");
    return false;
  }
  el.visitAlarmDate.value = el.visitAlarmDate.value || el.visitDate.value || today();
  if (!el.visitAlarmTime.value) {
    toast("알림 시간을 입력하세요");
    el.visitAlarmTime.focus();
    return false;
  }
  return true;
}

function setVisitAlarmFieldsFromVisit(visit) {
  const alarm = splitAlarmDateTime(visitAlarmAt(visit));
  el.visitAlarmDate.value = alarm.date || visit.visitDate || today();
  el.visitAlarmTime.value = alarm.time || "";
  updateVisitAlarmFields();
}

function visitDateFromForm() {
  return (el.visitType.value === VISIT_TYPE_ALARM ? el.visitAlarmDate.value : el.visitDate.value) || today();
}

function visitActionFromForm(existingVisit = {}) {
  if (el.visitType.value !== VISIT_TYPE_ALARM) {
    return visitActionWithMeta(existingVisit, { alarmAt: "" });
  }
  return visitActionWithMeta(existingVisit, {
    alarmAt: visitAlarmAtFromForm()
  });
}

function visitAlarmAtFromForm() {
  if (el.visitType.value !== VISIT_TYPE_ALARM) return "";
  const localValue = `${el.visitAlarmDate.value || el.visitDate.value || today()}T${el.visitAlarmTime.value}`;
  return dateTimeLocalToIso(localValue);
}

function defaultAlarmTime() {
  return defaultAlarmDateTime().time;
}

function defaultAlarmDateTime() {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  return {
    date: localDateString(date),
    time: `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
  };
}

async function trashEditingVisit() {
  if (!requireAdmin()) return;
  const visitId = state.editingVisitId;
  if (!visitId) return;
  const moved = await trashVisit(visitId);
  if (!moved) return;
  state.editingVisitId = "";
  resetVisitForm();
  hideVisitRecord();
}

async function trashVisit(visitId) {
  const visit = state.visits.find((item) => item.id === visitId);
  const member = selectedMember();
  if (!visit || !member || visit.memberId !== member.id) return false;
  const ok = confirm("이 심방내역을 휴지통으로 이동할까요?");
  if (!ok) return false;
  let updated = {
    ...visit,
    action: visitActionWithMeta(visit, { trashedAt: new Date().toISOString() })
  };
  if (state.apiOnline) {
    try {
      const response = await writeFetch(`/api/visit-notes/${encodeURIComponent(updated.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: updated.action, expectedUpdatedAt: visit.updatedAt || "" })
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 409 && result.visit) {
        state.visits = state.visits.map((item) => item.id === result.visit.id ? result.visit : item);
      }
      if (!response.ok) throw new Error(result.error || "심방내역을 휴지통으로 이동하지 못했습니다");
      updated = result;
    } catch (error) {
      toast(error.message || "심방내역을 휴지통으로 이동하지 못했습니다");
      return false;
    }
  } else if (visit.visitType === VISIT_TYPE_ALARM) {
    toast("알람이 있는 심방내역은 인터넷에 연결된 상태에서 이동해야 합니다");
    return false;
  }
  state.visits = state.visits.map((item) => item.id === updated.id ? updated : item);
  if (state.editingVisitId === updated.id) state.editingVisitId = "";
  persist();
  renderVisits(member.id);
  renderAlarmNotifications();
  if (!el.visitDatesModal.classList.contains("hidden")) renderVisitDates();
  toast("휴지통으로 이동했습니다");
  return true;
}

async function restoreVisit(visitId) {
  const visit = state.visits.find((item) => item.id === visitId);
  const member = selectedMember();
  if (!visit || !member || visit.memberId !== member.id) return;
  let updated = {
    ...visit,
    action: visitActionWithMeta(visit, { trashedAt: "" })
  };
  if (state.apiOnline) {
    try {
      const response = await writeFetch(`/api/visit-notes/${encodeURIComponent(updated.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: updated.action, expectedUpdatedAt: visit.updatedAt || "" })
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 409 && result.visit) {
        state.visits = state.visits.map((item) => item.id === result.visit.id ? result.visit : item);
      }
      if (!response.ok) throw new Error(result.error || "심방내역을 복구하지 못했습니다");
      updated = result;
    } catch (error) {
      toast(error.message || "심방내역을 복구하지 못했습니다");
      return;
    }
  } else if (visit.visitType === VISIT_TYPE_ALARM) {
    toast("알람이 있는 심방내역은 인터넷에 연결된 상태에서 복구해야 합니다");
    return;
  }
  state.visits = state.visits.map((item) => item.id === updated.id ? updated : item);
  persist();
  renderVisits(member.id);
  renderAlarmNotifications();
  if (!el.visitDatesModal.classList.contains("hidden")) renderVisitDates();
  toast("심방내역을 복구했습니다");
}

async function deleteVisitPermanently(visitId) {
  const visit = state.visits.find((item) => item.id === visitId);
  const member = selectedMember();
  if (!visit || !member || visit.memberId !== member.id) return;
  const ok = confirm("휴지통의 심방내역을 완전히 삭제할까요?\n이 작업은 되돌릴 수 없습니다.");
  if (!ok) return;
  if (state.apiOnline) {
    try {
      const response = await writeFetch(`/api/visit-notes/${encodeURIComponent(visit.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedUpdatedAt: visit.updatedAt || "" })
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 409 && result.visit) {
        state.visits = state.visits.map((item) => item.id === result.visit.id ? result.visit : item);
      }
      if (!response.ok) throw new Error(result.error || "심방내역을 완전히 삭제하지 못했습니다");
    } catch (error) {
      toast(error.message || "심방내역을 완전히 삭제하지 못했습니다");
      return;
    }
  } else if (visit.visitType === VISIT_TYPE_ALARM) {
    toast("알람이 있는 심방내역은 인터넷에 연결된 상태에서 삭제해야 합니다");
    return;
  }
  state.visits = state.visits.filter((item) => item.id !== visit.id);
  if (state.editingVisitId === visit.id) state.editingVisitId = "";
  persist();
  renderVisits(member.id);
  renderAlarmNotifications();
  if (!el.visitDatesModal.classList.contains("hidden")) renderVisitDates();
  toast("심방내역을 완전히 삭제했습니다");
}

function parseVisitMeta(source) {
  const action = typeof source === "string" ? source : source?.action || "";
  if (!action.startsWith(VISIT_META_PREFIX)) return {};
  try {
    const parsed = JSON.parse(action.slice(VISIT_META_PREFIX.length));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function visitActionNote(visit) {
  const action = String(visit?.action || "").trim();
  if (!action) return "";
  if (!action.startsWith(VISIT_META_PREFIX)) return action;
  return String(parseVisitMeta(visit).note || "").trim();
}

function visitActionWithMeta(visit, patch = {}) {
  const meta = { ...parseVisitMeta(visit), ...patch };
  const note = visitActionNote(visit);
  if (note) meta.note = note;
  ["alarmAt", "trashedAt", "note"].forEach((key) => {
    if (!meta[key]) delete meta[key];
  });
  return Object.keys(meta).length ? `${VISIT_META_PREFIX}${JSON.stringify(meta)}` : "";
}

function visitAlarmAt(visit) {
  return String(visit?.alarmAt || parseVisitMeta(visit).alarmAt || "").trim();
}

function visitTrashedAt(visit) {
  return String(parseVisitMeta(visit).trashedAt || "").trim();
}

function splitAlarmDateTime(alarmAt) {
  const localValue = toDateTimeLocalValue(alarmAt) || String(alarmAt || "");
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(localValue);
  return { date: match?.[1] || "", time: match?.[2] || "" };
}

function parseAlarmAt(alarmAt) {
  const parsed = new Date(String(alarmAt || ""));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatAlarmDateTime(alarmAt) {
  const parsed = parseAlarmAt(alarmAt);
  if (!parsed) return String(alarmAt || "").replace("T", " ");
  return `${parsed.getFullYear()}. ${parsed.getMonth() + 1}. ${parsed.getDate()}. ${String(parsed.getHours()).padStart(2, "0")}:${String(parsed.getMinutes()).padStart(2, "0")}`;
}

function alarmKey(visit) {
  return `${visit.id}:${visitAlarmAt(visit)}`;
}

function readDismissedAlarmKeys() {
  try {
    const saved = JSON.parse(localStorage.getItem(ALARM_DISMISS_KEY) || "[]");
    return new Set(Array.isArray(saved) ? saved : []);
  } catch {
    localStorage.removeItem(ALARM_DISMISS_KEY);
    return new Set();
  }
}

function saveDismissedAlarmKeys() {
  const keys = Array.from(state.dismissedAlarmKeys).slice(-300);
  localStorage.setItem(ALARM_DISMISS_KEY, JSON.stringify(keys));
}

function dueAlarmVisits() {
  const now = Date.now();
  return state.visits
    .filter((visit) => visit.visitType === VISIT_TYPE_ALARM)
    .filter((visit) => !visit.alarmState || visit.alarmState === "scheduled")
    .filter((visit) => !visitTrashedAt(visit))
    .filter((visit) => {
      const alarmAt = parseAlarmAt(visitAlarmAt(visit));
      return alarmAt && alarmAt.getTime() <= now && !state.dismissedAlarmKeys.has(alarmKey(visit));
    })
    .sort((a, b) => parseAlarmAt(visitAlarmAt(a)).getTime() - parseAlarmAt(visitAlarmAt(b)).getTime());
}

function dueReminderNotes() {
  if (!isAdminViewer()) return [];
  const now = Date.now();
  return state.notes
    .filter((note) => note.status === "active" && note.reminderState === "scheduled" && note.remindAt)
    .filter((note) => {
      const time = new Date(note.remindAt).getTime();
      return Number.isFinite(time) && time <= now;
    })
    .sort((a, b) => new Date(a.remindAt).getTime() - new Date(b.remindAt).getTime());
}

function renderMemoDueCount() {
  if (!el.memoDueCount) return;
  const count = dueReminderNotes().length;
  el.memoDueCount.textContent = String(count);
  el.memoDueCount.classList.toggle("hidden", !count);
}

function renderAlarmNotifications() {
  if (!el.alarmCenter) return;
  if (!isAdminViewer()) {
    el.alarmCenter.classList.add("hidden");
    el.alarmList.innerHTML = "";
    closeAlarmPanel();
    renderMemoDueCount();
    return;
  }
  const visitAlarms = dueAlarmVisits();
  const noteAlarms = dueReminderNotes();
  const alarmCount = visitAlarms.length + noteAlarms.length;
  el.alarmCenter.classList.toggle("hidden", !alarmCount);
  el.alarmCount.textContent = String(alarmCount);
  renderMemoDueCount();
  if (!alarmCount) {
    closeAlarmPanel();
    el.alarmList.innerHTML = "";
    return;
  }
  el.alarmList.innerHTML = [
    ...noteAlarms.map((note) => noteAlarmCardHtml(note)),
    ...visitAlarms.map((visit) => alarmCardHtml(visit))
  ].join("");
}

function alarmCardHtml(visit) {
  const member = state.members.find((item) => item.id === visit.memberId);
  const memberLabel = member ? [member.name || "이름 없음", member.title || ""].filter(Boolean).join(" ") : "성도 정보 없음";
  const cellLabel = member ? memberCellLabel(member) : "";
  return `<article class="alarm-card">
    <div>
      <strong>${escapeHtml(memberLabel)}</strong>
      <small>${escapeHtml([cellLabel, formatAlarmDateTime(visitAlarmAt(visit))].filter(Boolean).join(" · "))}</small>
      <p>${escapeHtml(visitSummaryText(visit))}</p>
    </div>
    <div class="alarm-actions">
      <button class="icon-button text-button subtle" data-alarm-member="${escapeAttribute(visit.memberId)}" data-alarm-visit="${escapeAttribute(visit.id)}" type="button">보기</button>
      <button class="icon-button text-button primary" data-alarm-dismiss="${escapeAttribute(visit.id)}" type="button">확인</button>
    </div>
  </article>`;
}

function noteAlarmCardHtml(note) {
  const association = memoAssociationLabel(note);
  return `<article class="alarm-card memo-alarm-card">
    <div>
      <span class="memo-category-chip category-${escapeAttribute(note.category)}">${escapeHtml(noteCategoryLabel(note.category))}</span>
      <strong>${escapeHtml(note.title || "메모 알림")}</strong>
      <small>${escapeHtml([association, formatNoteDateTime(note.remindAt)].filter(Boolean).join(" · "))}</small>
      ${note.body ? `<p>${escapeHtml(truncateText(note.body, 160))}</p>` : ""}
    </div>
    <div class="alarm-actions">
      <button class="icon-button text-button subtle" data-note-alarm-open="${escapeAttribute(note.id)}" type="button">메모 보기</button>
      <button class="icon-button text-button primary" data-note-alarm-dismiss="${escapeAttribute(note.id)}" type="button">확인</button>
    </div>
  </article>`;
}

function toggleAlarmPanel() {
  const open = el.alarmPanel.classList.contains("hidden");
  el.alarmPanel.classList.toggle("hidden", !open);
  el.alarmBellBtn.setAttribute("aria-expanded", open ? "true" : "false");
}

function closeAlarmPanel() {
  if (!el.alarmPanel) return;
  el.alarmPanel.classList.add("hidden");
  el.alarmBellBtn?.setAttribute("aria-expanded", "false");
}

async function handleAlarmListClick(event) {
  const noteDismissButton = closestElement(event.target, "[data-note-alarm-dismiss]");
  if (noteDismissButton) {
    noteDismissButton.disabled = true;
    try {
      await patchMemoReminder(noteDismissButton.dataset.noteAlarmDismiss, "dismissed");
      toast("메모 알림을 확인했습니다");
    } catch (error) {
      toast(error.message || "알림을 확인 처리하지 못했습니다");
    } finally {
      noteDismissButton.disabled = false;
    }
    return;
  }

  const noteOpenButton = closestElement(event.target, "[data-note-alarm-open]");
  if (noteOpenButton) {
    closeAlarmPanel();
    await openMemoCenter(noteOpenButton.dataset.noteAlarmOpen);
    return;
  }

  const dismissButton = closestElement(event.target, "[data-alarm-dismiss]");
  if (dismissButton) {
    const visit = state.visits.find((item) => item.id === dismissButton.dataset.alarmDismiss);
    dismissButton.disabled = true;
    try {
      if (visit) await dismissVisitAlarm(visit);
    } finally {
      if (dismissButton.isConnected) dismissButton.disabled = false;
    }
    return;
  }

  const memberButton = closestElement(event.target, "[data-alarm-member]");
  if (!memberButton) return;
  closeAlarmPanel();
  selectMember(memberButton.dataset.alarmMember);
  state.expandedVisitId = memberButton.dataset.alarmVisit || "";
  const member = selectedMember();
  if (member) renderVisits(member.id);
}

async function dismissVisitAlarm(visit) {
  if (!state.apiOnline) {
    state.dismissedAlarmKeys.add(alarmKey(visit));
    saveDismissedAlarmKeys();
    renderAlarmNotifications();
    toast("이 브라우저에서만 알림을 확인 처리했습니다");
    return;
  }
  try {
    const response = await writeFetch(`/api/visit-notes/${encodeURIComponent(visit.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        alarmState: "dismissed",
        expectedUpdatedAt: visit.updatedAt || ""
      })
    });
    const result = await response.json().catch(() => ({}));
    if (response.status === 409 && result.visit) {
      state.visits = state.visits.map((item) => item.id === result.visit.id ? result.visit : item);
    }
    if (!response.ok) throw new Error(result.error || "알림을 확인 처리하지 못했습니다");
    state.visits = state.visits.map((item) => item.id === result.id ? result : item);
    state.dismissedAlarmKeys.delete(alarmKey(visit));
    saveDismissedAlarmKeys();
    persist();
    renderAlarmNotifications();
    toast("알림을 확인했습니다");
  } catch (error) {
    toast(error.message || "알림을 확인 처리하지 못했습니다");
  }
}

async function loadNotes() {
  if (!isAdminViewer() || !state.apiOnline) return state.notes;
  const response = await writeFetch("/api/notes", {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store"
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "메모를 불러오지 못했습니다");
  state.notes = Array.isArray(result.notes) ? result.notes : [];
  renderMemoList();
  renderAlarmNotifications();
  return state.notes;
}

async function openMemoCenter(noteId = "") {
  if (!requireAdmin()) return;
  if (el.memoModal.classList.contains("hidden")) {
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    state.memoReturnFocus = activeElement?.closest("#alarmPanel") ? el.alarmBellBtn : activeElement || el.memoCenterBtn;
  }
  populateMemoAssociationOptions();
  el.memoModal.classList.remove("hidden");
  el.memoModal.setAttribute("aria-hidden", "false");
  renderMemoList();
  if (noteId && state.notes.some((note) => note.id === noteId)) editMemo(noteId);
  else if (!state.editingNoteId || !state.notes.some((note) => note.id === state.editingNoteId)) startNewMemo();
  try {
    await loadNotes();
    if (noteId && state.notes.some((note) => note.id === noteId)) editMemo(noteId);
  } catch (error) {
    toast(error.message || "메모를 새로고침하지 못했습니다");
  }
  setTimeout(() => (noteId ? el.memoTitle : el.memoSearchInput).focus(), 0);
}

function closeMemoCenter() {
  const wasOpen = !el.memoModal.classList.contains("hidden");
  el.memoModal.classList.add("hidden");
  el.memoModal.setAttribute("aria-hidden", "true");
  if (wasOpen) {
    const preferredFocus = state.memoReturnFocus;
    const returnFocus = preferredFocus?.isConnected
      && !preferredFocus.closest(".hidden")
      && preferredFocus.getClientRects().length > 0
      ? preferredFocus
      : el.memoCenterBtn;
    state.memoReturnFocus = null;
    window.setTimeout(() => returnFocus?.focus(), 0);
  }
}

function handleMemoModalKeydown(event) {
  if (el.memoModal.classList.contains("hidden")) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeMemoCenter();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = Array.from(el.memoModal.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
  )).filter((element) => !element.closest(".hidden") && element.getClientRects().length > 0);
  if (!focusable.length) {
    event.preventDefault();
    el.memoCloseBtn.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function populateMemoAssociationOptions(preferredMemberId = "", preferredGroupId = "") {
  const selectedMemberId = preferredMemberId || el.memoMemberId?.value || "";
  const selectedGroupId = preferredGroupId || el.memoGroupId?.value || "";
  const members = state.members
    .filter((member) => !member.trashedAt && (!member.archivedAt || member.id === selectedMemberId))
    .slice()
    .sort((a, b) => compareKoreanNames(a.name, b.name));
  el.memoMemberId.innerHTML = '<option value="">연결 안 함</option>' + members.map((member) => (
    `<option value="${escapeAttribute(member.id)}">${escapeHtml([
      member.name,
      member.title,
      memberCellLabel(member),
      member.archivedAt ? "제적" : ""
    ].filter(Boolean).join(" · "))}</option>`
  )).join("");
  el.memoGroupId.innerHTML = '<option value="">연결 안 함</option>' + state.groups
    .slice()
    .sort((a, b) => compareKoreanNames(a.name, b.name))
    .map((group) => `<option value="${escapeAttribute(group.id)}">${escapeHtml(group.name)}</option>`)
    .join("");
  el.memoMemberId.value = selectedMemberId;
  el.memoGroupId.value = selectedGroupId;
}

function filteredMemos() {
  const query = normalizeSearchText(el.memoSearchInput?.value || "");
  const category = el.memoCategoryFilter?.value || "";
  const status = el.memoStatusFilter?.value || "";
  return state.notes
    .filter((note) => !category || note.category === category)
    .filter((note) => !status || note.status === status)
    .filter((note) => {
      if (!query) return true;
      return normalizeSearchText([
        note.title,
        note.body,
        noteCategoryLabel(note.category),
        memoAssociationLabel(note)
      ].join(" ")).includes(query);
    })
    .slice()
    .sort(compareMemos);
}

function compareMemos(a, b) {
  if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
  if (a.status !== b.status) return a.status === "active" ? -1 : 1;
  const aReminder = a.remindAt ? new Date(a.remindAt).getTime() : Number.POSITIVE_INFINITY;
  const bReminder = b.remindAt ? new Date(b.remindAt).getTime() : Number.POSITIVE_INFINITY;
  if (aReminder !== bReminder) return aReminder - bReminder;
  return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
}

function renderMemoList() {
  if (!el.memoList) return;
  const notes = filteredMemos();
  el.memoEmpty.classList.toggle("hidden", notes.length > 0);
  el.memoList.innerHTML = notes.map((note) => memoListCardHtml(note)).join("");
}

function memoListCardHtml(note) {
  const selected = note.id === state.editingNoteId ? "selected" : "";
  const due = note.status === "active"
    && note.reminderState === "scheduled"
    && Number.isFinite(new Date(note.remindAt).getTime())
    && new Date(note.remindAt).getTime() <= Date.now();
  const classes = [
    "memo-list-card",
    "memo-list-item",
    selected,
    note.pinned ? "pinned" : "",
    note.remindAt ? "has-reminder" : "",
    due ? "is-due" : "",
    note.status === "done" ? "done" : ""
  ].filter(Boolean).join(" ");
  const reminder = note.remindAt
    ? `<span class="memo-reminder-chip reminder-${escapeAttribute(note.reminderState)}">${escapeHtml(formatNoteDateTime(note.remindAt))}</span>`
    : "";
  return `<button class="${classes}" data-memo-id="${escapeAttribute(note.id)}" type="button">
    <span class="memo-list-card-head memo-list-item-head">
      <span class="memo-category-chip memo-category-badge category-${escapeAttribute(note.category)}">${escapeHtml(noteCategoryLabel(note.category))}</span>
      ${note.pinned ? '<span class="memo-pin" title="고정 메모">고정</span>' : ""}
      <span class="memo-status-chip memo-status-badge">${escapeHtml(NOTE_STATUS_LABELS[note.status] || note.status)}</span>
    </span>
    <strong>${escapeHtml(note.title || "제목 없음")}</strong>
    ${note.body ? `<p class="memo-list-preview">${escapeHtml(truncateText(note.body, 100))}</p>` : ""}
    <span class="memo-list-meta memo-list-item-meta">${escapeHtml(memoAssociationLabel(note) || "연결 없음")}</span>
    ${reminder}
  </button>`;
}

function handleMemoListClick(event) {
  const card = closestElement(event.target, "[data-memo-id]");
  if (card) editMemo(card.dataset.memoId);
}

function startNewMemo() {
  if (!requireAdmin()) return;
  state.editingNoteId = "";
  el.memoForm.reset();
  el.memoCategory.value = "personal";
  el.memoStatus.value = "active";
  el.memoEditorTitle.textContent = "새 메모";
  el.memoDeleteBtn.classList.add("hidden");
  el.memoReminderResetBtn.classList.add("hidden");
  el.memoReminderStatus.textContent = "알림을 지정하지 않았습니다.";
  renderMemoList();
  el.memoTitle.focus();
}

function editMemo(noteId) {
  const note = state.notes.find((item) => item.id === noteId);
  if (!note) return;
  state.editingNoteId = note.id;
  populateMemoAssociationOptions(note.memberId || "", note.groupId || "");
  el.memoTitle.value = note.title || "";
  el.memoCategory.value = note.category || "personal";
  el.memoBody.value = note.body || "";
  el.memoPinned.checked = Boolean(note.pinned);
  el.memoStatus.value = note.status || "active";
  el.memoMemberId.value = note.memberId || "";
  el.memoGroupId.value = note.groupId || "";
  el.memoRemindAt.value = toDateTimeLocalValue(note.remindAt);
  el.memoEditorTitle.textContent = "메모 수정";
  el.memoDeleteBtn.classList.remove("hidden");
  renderMemoReminderStatus(note);
  renderMemoList();
}

function renderMemoReminderStatus(note) {
  if (!note?.remindAt) {
    el.memoReminderStatus.textContent = "알림을 지정하지 않았습니다.";
    el.memoReminderResetBtn.classList.add("hidden");
    return;
  }
  const labels = {
    scheduled: `알림 예정 · ${formatNoteDateTime(note.remindAt)}`,
    dismissed: `확인한 알림 · ${formatNoteDateTime(note.remindAt)}`,
    none: "알림을 지정하지 않았습니다."
  };
  el.memoReminderStatus.textContent = labels[note.reminderState] || formatNoteDateTime(note.remindAt);
  el.memoReminderResetBtn.classList.toggle("hidden", note.reminderState !== "dismissed");
}

async function saveMemo(event) {
  event.preventDefault();
  if (!requireAdmin()) return;
  const title = el.memoTitle.value.trim();
  if (!title) {
    toast("메모 제목을 입력하세요");
    el.memoTitle.focus();
    return;
  }
  const current = state.notes.find((note) => note.id === state.editingNoteId);
  const status = el.memoStatus.value;
  const remindAt = status === "done" ? "" : dateTimeLocalToIso(el.memoRemindAt.value);
  const payload = {
    category: el.memoCategory.value,
    title,
    body: el.memoBody.value.trim(),
    pinned: el.memoPinned.checked,
    status,
    memberId: el.memoMemberId.value || "",
    groupId: el.memoGroupId.value || ""
  };
  if (current) payload.expectedUpdatedAt = current.updatedAt;
  if (!current || String(current.remindAt || "") !== remindAt) payload.remindAt = remindAt;

  el.memoSaveBtn.disabled = true;
  try {
    const response = await writeFetch(current ? `/api/notes/${encodeURIComponent(current.id)}` : "/api/notes", {
      method: current ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));
    if (response.status === 409 && result.note) {
      upsertMemo(result.note);
      renderMemoList();
      renderAlarmNotifications();
    }
    if (!response.ok) throw new Error(result.error || "메모를 저장하지 못했습니다");
    upsertMemo(result);
    editMemo(result.id);
    renderAlarmNotifications();
    toast(current ? "메모를 수정했습니다" : "메모를 저장했습니다");
  } catch (error) {
    toast(error.message || "메모를 저장하지 못했습니다");
  } finally {
    el.memoSaveBtn.disabled = false;
  }
}

function upsertMemo(note) {
  const index = state.notes.findIndex((item) => item.id === note.id);
  if (index >= 0) state.notes[index] = note;
  else state.notes.push(note);
}

async function deleteMemo() {
  if (!requireAdmin()) return;
  const note = state.notes.find((item) => item.id === state.editingNoteId);
  if (!note) return;
  if (!confirm(`'${note.title}' 메모를 완전히 삭제할까요?`)) return;
  el.memoDeleteBtn.disabled = true;
  try {
    const response = await writeFetch(`/api/notes/${encodeURIComponent(note.id)}`, { method: "DELETE" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "메모를 삭제하지 못했습니다");
    state.notes = state.notes.filter((item) => item.id !== note.id);
    startNewMemo();
    renderAlarmNotifications();
    toast("메모를 삭제했습니다");
  } catch (error) {
    toast(error.message || "메모를 삭제하지 못했습니다");
  } finally {
    el.memoDeleteBtn.disabled = false;
  }
}

function cancelMemoEdit() {
  const note = state.notes.find((item) => item.id === state.editingNoteId);
  if (note) editMemo(note.id);
  else startNewMemo();
  toast("저장하지 않은 입력을 되돌렸습니다");
}

async function resetMemoReminder() {
  const note = state.notes.find((item) => item.id === state.editingNoteId);
  if (!note) return;
  el.memoReminderResetBtn.disabled = true;
  try {
    await patchMemoReminder(note.id, "scheduled");
    toast("메모 알림을 다시 켰습니다");
  } catch (error) {
    toast(error.message || "알림을 다시 켜지 못했습니다");
  } finally {
    el.memoReminderResetBtn.disabled = false;
  }
}

async function patchMemoReminder(noteId, reminderState) {
  const note = state.notes.find((item) => item.id === noteId);
  if (!note) throw new Error("메모를 찾을 수 없습니다. 새로고침해 주세요.");
  const response = await writeFetch(`/api/notes/${encodeURIComponent(noteId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reminderState, expectedUpdatedAt: note.updatedAt })
  });
  const result = await response.json().catch(() => ({}));
  if (response.status === 409 && result.note) {
    upsertMemo(result.note);
    renderMemoList();
    renderAlarmNotifications();
  }
  if (!response.ok) throw new Error(result.error || "메모 알림을 변경하지 못했습니다");
  upsertMemo(result);
  if (state.editingNoteId === result.id) editMemo(result.id);
  else renderMemoList();
  renderAlarmNotifications();
  return result;
}

function memoAssociationLabel(note) {
  const member = state.members.find((item) => item.id === note.memberId);
  const group = state.groups.find((item) => item.id === note.groupId);
  return [member?.name || "", group?.name || ""].filter(Boolean).join(" · ");
}

function noteCategoryLabel(category) {
  return NOTE_CATEGORY_LABELS[category] || category || "메모";
}

function formatNoteDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function toDateTimeLocalValue(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function dateTimeLocalToIso(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function truncateText(value, length) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  return text.length > length ? `${text.slice(0, length)}…` : text;
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

async function ensureManagedGroupOnline(message = "기관 관리는 온라인 연결에서만 저장할 수 있습니다") {
  if (state.apiOnline) return true;
  try {
    const response = await writeFetch("/api/bootstrap", {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    if (!response.ok) throw new Error("api unavailable");
    state.apiOnline = true;
    return true;
  } catch {
    state.apiOnline = false;
    toast(`${message}. 인터넷 연결을 확인한 뒤 다시 시도하세요`);
    return false;
  }
}

async function openSundayAttendance() {
  if (!requireAdmin()) return;
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

async function returnToSundayAttendance() {
  const date = state.returnToAttendanceDate || state.attendanceDate || nearestSundayDate();
  state.returnToAttendanceDate = "";
  state.attendanceDate = date;
  await openSundayAttendance();
  requestAnimationFrame(scrollToAttendanceResults);
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

  el.attendanceDate.value = date;
  el.attendanceDateLabel.textContent = formatKoreanDateLabel(date);
  renderAttendanceSummary(members, presentIds);
  renderAttendanceHistory();
  renderAttendanceCellStats(members, presentIds);
  renderAttendanceMemberGrid(members, presentIds);
  renderAttendanceResults(members, presentIds);
}

function renderAttendanceSummary(members, presentIds) {
  const presentCount = members.filter((member) => presentIds.has(member.id)).length;
  const totalCount = members.length;
  el.attendanceSummary.innerHTML = `
    <span class="attendance-summary-counts">
      <strong>출석 ${presentCount}명</strong>
      <span>전체 ${totalCount}명 · 결석 ${Math.max(totalCount - presentCount, 0)}명</span>
    </span>
    <span class="attendance-summary-action">명단보기</span>`;
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

  el.attendanceCellStats.innerHTML = groups.map((group) => `<span class="attendance-cell-stat" data-attendance-cell-id="${escapeAttribute(group.cellId)}">
    <strong>${escapeHtml(group.cellName)}</strong>
    <span data-attendance-cell-count>${group.present}/${group.total}명</span>
  </span>`).join("");
}

function renderAttendanceMemberGrid(members, presentIds) {
  if (!members.length) {
    el.attendanceMemberGrid.innerHTML = '<p class="attendance-empty">출석 체크할 성도가 없습니다.</p>';
    return;
  }

  el.attendanceMemberGrid.innerHTML = groupedAttendanceMembers(members, presentIds).map((group) => `
    <section class="attendance-cell-section" data-attendance-cell-id="${escapeAttribute(group.cellId)}">
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
  const nameLinkOptions = { linkPhones: isMobileView(), linkDetails: !isMobileView() };

  el.attendanceResults.innerHTML = `
    <div class="attendance-results-toolbar">
      <button class="icon-button text-button subtle attendance-results-top-button" data-attendance-scroll-top type="button">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 19V5M5 12l7-7 7 7"></path>
        </svg>
        <span>출석체크로</span>
      </button>
    </div>
    <section class="attendance-result-column absent">
      <h3>결석 ${absentMembers.length}명</h3>
      ${attendanceNamesByCellHtml(absentMembers, nameLinkOptions)}
    </section>
    <section class="attendance-result-column present">
      <h3>출석 ${presentMembers.length}명</h3>
      ${attendanceNamesByCellHtml(presentMembers, nameLinkOptions)}
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

function toggleSundayAttendanceMember(memberId, memberCard) {
  const presentIds = new Set(state.attendancePresentIds);
  if (presentIds.has(memberId)) presentIds.delete(memberId);
  else presentIds.add(memberId);
  state.attendancePresentIds = Array.from(presentIds);

  const members = attendanceMembersForSelectedDate();
  renderAttendanceSummary(members, presentIds);
  updateAttendanceMemberCard(memberCard, memberId, presentIds.has(memberId));
  updateAttendanceCellCount(memberId, members, presentIds);
  renderAttendanceResults(members, presentIds);
}

function updateAttendanceMemberCard(memberCard, memberId, present) {
  const card = memberCard?.isConnected
    ? memberCard
    : Array.from(el.attendanceMemberGrid.querySelectorAll("[data-attendance-member-id]"))
      .find((item) => item.dataset.attendanceMemberId === memberId);
  if (!card) return;
  card.classList.toggle("present", present);
  card.setAttribute("aria-pressed", String(present));
  const status = card.querySelector("em");
  if (status) status.textContent = present ? "출석" : "결석";
}

function updateAttendanceCellCount(memberId, members, presentIds) {
  const group = groupedAttendanceMembers(members, presentIds)
    .find((item) => item.members.some((member) => member.id === memberId));
  if (!group) return;

  const cellElements = [
    ...el.attendanceCellStats.querySelectorAll("[data-attendance-cell-id]"),
    ...el.attendanceMemberGrid.querySelectorAll("[data-attendance-cell-id]")
  ].filter((item) => item.dataset.attendanceCellId === String(group.cellId));

  cellElements.forEach((item) => {
    const count = item.querySelector("[data-attendance-cell-count]")
      || item.querySelector(".attendance-cell-section-head span");
    if (count) count.textContent = `${group.present}/${group.total}명`;
  });
}

function clearSundayAttendance() {
  const ok = confirm("출석 체크를 모두 해제할까요?");
  if (!ok) return;
  state.attendancePresentIds = [];
  renderSundayAttendance();
}

function scrollToAttendanceResults() {
  el.attendanceResults.scrollIntoView({ behavior: "smooth", block: "start" });
}

function scrollToAttendanceChecklist() {
  const dialog = el.attendanceModal.querySelector(".attendance-dialog");
  if (dialog) dialog.scrollTo({ top: 0, behavior: "smooth" });
  else el.attendanceModal.scrollTo({ top: 0, behavior: "smooth" });
}

function handleAttendanceSummaryKeydown(event) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  scrollToAttendanceResults();
}

function shiftSundayAttendanceDate(dayOffset) {
  const current = parseDateValue(state.attendanceDate) || parseDateValue(nearestSundayDate());
  current.setDate(current.getDate() + dayOffset);
  loadSundayAttendanceDate(localDateString(current));
}

async function saveSundayAttendance() {
  if (!requireAdmin()) return;
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
  if (!requireAdmin()) return;
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
    if (visitTrashedAt(visit)) return groups;
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
  const detailActive = Boolean(selectedMember());
  el.workspace.classList.toggle("detail-active", detailActive);
  document.body.classList.toggle("detail-active", detailActive);
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
  if (!requireAdmin()) return;
  el.settingsForm.reset();
  el.settingsForm.scrollTop = 0;
  setActiveSettingsCategory("settingsBasicSection");
  el.passkeyPasswordResetStatus.textContent = "현재 비밀번호를 잊었을 때만 사용하세요.";
  el.passkeyPasswordResetStatus.classList.remove("error-text");
  resetManagedGroupEditor();
  renderManagedGroupSettings();
  el.communityTitleInput.value = cleanTitle(state.settings?.communityTitle);
  el.callNoteWebhookUrl.value = `${window.location.origin}/api/webhook/call-note`;
  el.callNoteTokenOutput.value = "";
  setPasskeyStatus({ loading: true });
  el.settingsModal.classList.remove("hidden");
  el.settingsModal.setAttribute("aria-hidden", "false");
  loadPasskeyStatus();
  loadCallNoteTokenStatus();
  loadGuestPasswordStatus();
  loadMobileNotificationStatus();
  setTimeout(() => el.settingsCloseBtn.focus(), 0);
}

function handleSettingsCategoryNavigation(event) {
  const button = closestElement(event.target, '[role="tab"][data-settings-target]');
  if (!button) return;
  event.preventDefault();
  setActiveSettingsCategory(String(button.dataset.settingsTarget || ""));
}

function handleSettingsCategoryKeydown(event) {
  const current = closestElement(event.target, '[role="tab"][data-settings-target]');
  if (!current) return;
  const tabs = [...el.settingsCategoryNav.querySelectorAll('[role="tab"][data-settings-target]')];
  const currentIndex = tabs.indexOf(current);
  if (currentIndex < 0) return;

  let nextIndex;
  if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
  else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  else if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = tabs.length - 1;
  else return;

  event.preventDefault();
  const nextTab = tabs[nextIndex];
  setActiveSettingsCategory(String(nextTab.dataset.settingsTarget || ""));
  nextTab.focus();
}

function setActiveSettingsCategory(targetId) {
  const target = document.getElementById(targetId);
  if (!target || target.getAttribute("role") !== "tabpanel") return;

  el.settingsCategoryNav.querySelectorAll('[role="tab"][data-settings-target]').forEach((button) => {
    const active = button.dataset.settingsTarget === targetId;
    button.classList.toggle("is-active", active);
    button.classList.toggle("primary", active);
    button.classList.toggle("subtle", !active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  el.settingsForm.querySelectorAll('[role="tabpanel"]').forEach((panel) => {
    panel.hidden = panel.id !== targetId;
  });
  el.settingsForm.scrollTop = 0;
}

function closeSettings() {
  clearMobileNotificationTransientState();
  el.settingsModal.classList.add("hidden");
  el.settingsModal.setAttribute("aria-hidden", "true");
}

async function loadMobileNotificationStatus(options = {}) {
  if (!isAdminViewer() || state.mobileNotificationLoading) return;
  state.mobileNotificationLoading = true;
  if (!options.silent) {
    el.mobileNotificationStatus.textContent = "휴대폰 연결과 발송 서버 상태를 확인하는 중입니다.";
  }
  renderMobileNotificationSettings();
  try {
    const response = await writeFetch("/api/integrations/call-note/admin/status?deliveryLimit=10", {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "휴대폰 알림 상태를 확인하지 못했습니다");
    state.mobileNotificationStatus = result;
    reconcileMobilePairPolling(result);
  } catch (error) {
    state.mobileNotificationStatus = { error: error.message || "휴대폰 알림 상태를 확인하지 못했습니다" };
  } finally {
    state.mobileNotificationLoading = false;
    renderMobileNotificationSettings();
  }
}

function renderMobileNotificationSettings() {
  if (!el.mobileNotificationStatusBadge) return;
  const data = state.mobileNotificationStatus;
  const devices = Array.isArray(data?.devices) ? data.devices : [];
  const activeDevice = devices.find((device) => device.status === "active");
  const pendingDevice = devices.find((device) => device.status === "pending");
  const readiness = mobileNotificationReadiness(data, activeDevice, pendingDevice);

  el.mobileNotificationStatusBadge.textContent = readiness.badge;
  el.mobileNotificationStatusBadge.classList.remove("is-ready", "is-warning", "is-error");
  el.mobileNotificationStatusBadge.classList.add(readiness.className);
  el.mobileNotificationStatus.textContent = data?.error
    ? data.error
    : state.mobileNotificationLoading
      ? "휴대폰 연결과 발송 서버 상태를 확인하는 중입니다."
      : readiness.message;
  el.mobilePairCodeCreateBtn.disabled = state.mobileNotificationLoading
    || data?.apiSecretConfigured === false
    || (data?.pushTransport === "relay" && data?.relayConfigured === false);
  el.mobileNotificationRefreshBtn.disabled = state.mobileNotificationLoading;

  el.mobilePairCodeOutput.textContent = state.mobilePairCode || "------";
  renderMobilePairExpiry();
  renderMobileDeviceList(devices);
  renderMobileDeliveryList(Array.isArray(data?.deliveries) ? data.deliveries : []);
}

function mobileNotificationReadiness(data, activeDevice, pendingDevice) {
  if (!data) {
    return { badge: "확인 중", className: "is-warning", message: "휴대폰 알림 상태를 확인하는 중입니다." };
  }
  if (data.error) {
    return { badge: "확인 실패", className: "is-error", message: data.error };
  }
  if (!data.apiSecretConfigured) {
    return {
      badge: "서버 비밀값 필요",
      className: "is-error",
      message: "웹 API의 NOTIFICATION_SECRET을 먼저 설정해야 연결코드를 만들 수 있습니다."
    };
  }
  if (data.pushTransport === "relay" && !data.relayConfigured) {
    return {
      badge: "중계서버 설정 필요",
      className: "is-error",
      message: "이 공동체관리 웹의 공용 알림 중계 연결키를 먼저 설정해야 합니다."
    };
  }
  if (pendingDevice) {
    return {
      badge: "등록 확인 중",
      className: "is-warning",
      message: "새 휴대폰이 자격증명을 안전하게 저장하고 최종 등록을 완료하기를 기다리고 있습니다."
    };
  }
  if (!activeDevice) {
    return {
      badge: "연결 안 됨",
      className: "is-warning",
      message: "연결코드를 만든 뒤 심방콜노트 앱의 공동체관리 알림 설정에 입력하세요."
    };
  }
  if (data.pushTransport === "relay" && activeDevice.relayTargetReady !== true) {
    return {
      badge: "휴대폰 중계 등록 대기",
      className: "is-warning",
      message: "휴대폰 연결은 완료됐지만 공용 알림 중계 등록이 아직 끝나지 않았습니다. 앱에서 연결을 다시 확인해 주세요."
    };
  }
  if (!data.schedulerConfigured) {
    return {
      badge: "발송 서버 대기",
      className: "is-warning",
      message: "휴대폰은 연결됐지만 예약 발송 Worker가 아직 실행된 기록이 없습니다."
    };
  }
  if (!data.fcmConfigured) {
    return {
      badge: "FCM 설정 필요",
      className: "is-error",
      message: data.pushTransport === "relay"
        ? "휴대폰은 연결됐지만 공용 알림 중계 서버 설정을 확인해야 합니다."
        : "휴대폰은 연결됐지만 Worker의 Firebase 서비스 계정 설정이 필요합니다."
    };
  }
  if (data.pushTransport !== "relay" && !data.workerSecretConfigured) {
    return {
      badge: "Worker 비밀값 필요",
      className: "is-error",
      message: "예약 발송 Worker에도 웹 API와 같은 NOTIFICATION_SECRET을 설정해야 합니다."
    };
  }
  if (!data.senderEnabled) {
    return {
      badge: "발송 꺼짐",
      className: "is-warning",
      message: "점검용 안전 스위치가 꺼져 있습니다. 설정을 마친 뒤 PUSH_SEND_ENABLED를 true로 배포하세요."
    };
  }
  if (["configuration_error", "error", "degraded"].includes(data.dispatcher?.status)) {
    return {
      badge: "발송 서버 확인",
      className: "is-error",
      message: "예약 발송 Worker의 최근 실행에서 오류가 확인되었습니다. 최근 전송 상태와 Worker 설정을 확인하세요."
    };
  }
  if (activeDevice.notificationPermission === "denied" || !activeDevice.notificationsEnabled) {
    return {
      badge: "휴대폰 권한 확인",
      className: "is-warning",
      message: "연결과 발송 서버는 준비됐지만 휴대폰의 알림 권한 또는 채널 설정을 확인해야 합니다."
    };
  }
  return {
    badge: "사용 가능",
    className: "is-ready",
    message: "예약 메모와 심방 알람이 되면 FCM으로 심방콜노트 앱에 전송됩니다. 수신 시각은 통신 상태에 따라 조금 늦을 수 있습니다."
  };
}

function renderMobilePairExpiry() {
  if (!state.mobilePairCode || !state.mobilePairCodeExpiresAt) {
    el.mobilePairCodeExpiry.textContent = "코드를 만들면 이 화면에 한 번만 표시됩니다.";
    return;
  }
  const remainingMs = Date.parse(state.mobilePairCodeExpiresAt) - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    el.mobilePairCodeExpiry.textContent = "연결코드가 만료되었습니다. 새 코드를 만드세요.";
    stopMobilePairTimers({ clearCode: true, preserveExpiryMessage: true });
    return;
  }
  const minutes = Math.floor(remainingMs / 60000);
  const seconds = Math.floor((remainingMs % 60000) / 1000);
  el.mobilePairCodeExpiry.textContent = `${minutes}분 ${String(seconds).padStart(2, "0")}초 안에 앱에 입력하세요.`;
}

function renderMobileDeviceList(devices) {
  if (!devices.length) {
    el.mobileDeviceList.innerHTML = '<p class="call-note-empty">아직 연결된 심방콜노트 앱이 없습니다.</p>';
    return;
  }
  el.mobileDeviceList.innerHTML = devices.map((device) => {
    const stateLabel = {
      active: "연결됨",
      pending: "등록 확인 중",
      unregistered: "FCM 재등록 필요"
    }[device.status] || "연결 해제됨";
    const registrationMode = device.registrationMode === "fid" ? "Firebase 설치 ID" : "이전 등록 토큰";
    const permission = {
      granted: device.notificationsEnabled ? "알림 허용" : "알림 채널 꺼짐",
      denied: "알림 권한 거부",
      unknown: "알림 권한 미확인"
    }[device.notificationPermission] || "알림 권한 미확인";
    const lastSeen = device.lastSeenAt ? `최근 확인 ${formatNoteDateTime(device.lastSeenAt)}` : "아직 앱 응답 없음";
    const relayTargetReady = state.mobileNotificationStatus?.pushTransport !== "relay"
      || device.relayTargetReady === true;
    const testButton = device.status === "active" && relayTargetReady
      ? '<button class="icon-button text-button primary" type="button" data-mobile-device-action="test">테스트 알림</button>'
      : "";
    return `<article class="mobile-device-card" data-mobile-device-id="${escapeAttribute(device.deviceId)}">
      <div class="mobile-device-card-head">
        <h4>${escapeHtml(device.deviceName || "심방콜노트 Android")}</h4>
        <span class="mobile-device-state is-${escapeAttribute(device.status)}">${escapeHtml(stateLabel)}</span>
      </div>
      <p class="mobile-device-meta">${escapeHtml([device.appVersion ? `앱 ${device.appVersion}` : "", registrationMode, permission, lastSeen].filter(Boolean).join(" · "))}</p>
      <div class="mobile-device-actions">
        ${testButton}
        <button class="icon-button text-button danger" type="button" data-mobile-device-action="disconnect">연결 해제</button>
      </div>
    </article>`;
  }).join("");
}

function renderMobileDeliveryList(deliveries) {
  if (!deliveries.length) {
    el.mobileDeliveryList.innerHTML = '<p class="call-note-empty">아직 휴대폰으로 보낸 알림이 없습니다.</p>';
    return;
  }
  el.mobileDeliveryList.innerHTML = deliveries.map((delivery) => {
    const displayState = delivery.ackState || delivery.sendState;
    const stateLabel = mobileDeliveryStateLabel(displayState);
    const kindLabel = {
      connection_test: "연결 테스트",
      visit_alarm: "심방 알람",
      memo_reminder: "메모 알림"
    }[delivery.kind] || "알 수 없는 알림";
    const times = [
      delivery.scheduledAt ? `예약 ${formatNoteDateTime(delivery.scheduledAt)}` : "",
      delivery.openedAt ? `열람 ${formatNoteDateTime(delivery.openedAt)}`
        : delivery.displayedAt ? `표시 ${formatNoteDateTime(delivery.displayedAt)}`
          : delivery.receivedAt ? `수신 ${formatNoteDateTime(delivery.receivedAt)}`
            : delivery.acceptedAt ? `FCM 접수 ${formatNoteDateTime(delivery.acceptedAt)}` : "",
      mobileDeliveryErrorLabel(delivery.errorCode)
    ].filter(Boolean).join(" · ");
    return `<article class="mobile-delivery-card">
      <div class="mobile-delivery-card-head">
        <strong>${escapeHtml(kindLabel)}</strong>
        <span class="mobile-delivery-state is-${escapeAttribute(displayState || "pending")}">${escapeHtml(stateLabel)}</span>
      </div>
      <p class="mobile-delivery-meta">${escapeHtml(times || "처리 상태를 기다리는 중입니다.")}</p>
    </article>`;
  }).join("");
}

function mobileDeliveryStateLabel(stateValue) {
  return {
    pending: "발송 대기",
    sending: "발송 중",
    retry_wait: "재시도 대기",
    waiting_target: "휴대폰 재등록 대기",
    blocked_config: "서버 설정 확인",
    accepted: "FCM 접수",
    received: "수신 확인",
    displayed: "표시 확인",
    opened: "열람 확인",
    dead: "발송 실패",
    cancelled: "취소됨"
  }[stateValue] || "상태 확인 중";
}

function mobileDeliveryErrorLabel(code) {
  return {
    WAITING_FOR_DEVICE: "연결된 휴대폰 없음",
    FCM_UNREGISTERED: "FCM 재등록 필요",
    PUSH_DISABLED: "발송 꺼짐",
    TARGET_DECRYPT_FAILED: "서버 비밀값 불일치",
    RELAY_TARGET_NOT_SYNCED: "휴대폰 중계 등록 대기",
    RELAY_SEND_DISABLED: "중앙 알림 발송 꺼짐",
    RELAY_TIMEOUT: "중앙 알림 서버 응답 지연",
    RELAY_NETWORK_ERROR: "중앙 알림 서버 연결 실패",
    RELAY_AUTH_INVALID: "중앙 알림 연결키 확인 필요",
    FCM_PERMISSION_DENIED: "Firebase 권한 확인 필요",
    MAX_SEND_ATTEMPTS: "재시도 한도 초과",
    DELIVERY_EXPIRED: "알림 유효기간 만료",
    REMINDER_CANCELLED: "메모 알림 취소",
    VISIT_ALARM_CANCELLED: "심방 알람 취소",
    VISIT_ALARM_CHANGED: "심방 알람 변경",
    VISIT_ALARM_DELETED: "심방 알람 삭제",
    DEVICE_DISCONNECTED: "휴대폰 연결 해제"
  }[code] || (code ? "오류 확인 필요" : "");
}

async function createMobilePairCode() {
  if (!requireAdmin()) return;
  if (!confirm("10분 동안 한 번만 사용할 수 있는 휴대폰 연결코드를 만들까요? 기존 미사용 코드는 취소됩니다.")) return;
  el.mobilePairCodeCreateBtn.disabled = true;
  try {
    const response = await writeFetch("/api/integrations/call-note/admin/pair-codes", {
      method: "POST",
      headers: { Accept: "application/json" }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "연결코드를 만들지 못했습니다");
    state.mobilePairCode = String(result.pairCode || "");
    state.mobilePairCodeExpiresAt = String(result.expiresAt || "");
    startMobilePairTimers();
    renderMobileNotificationSettings();
    toast("연결코드를 만들었습니다. 심방콜노트 앱에 입력하세요");
    await loadMobileNotificationStatus({ silent: true });
  } catch (error) {
    toast(error.message || "연결코드를 만들지 못했습니다");
  } finally {
    const status = state.mobileNotificationStatus;
    el.mobilePairCodeCreateBtn.disabled = status?.apiSecretConfigured === false
      || (status?.pushTransport === "relay" && status?.relayConfigured === false);
  }
}

async function handleMobileDeviceAction(event) {
  const button = closestElement(event.target, "[data-mobile-device-action]");
  if (!button || !requireAdmin()) return;
  const card = closestElement(button, "[data-mobile-device-id]");
  const deviceId = card?.dataset.mobileDeviceId || "";
  if (!deviceId) return;
  const action = button.dataset.mobileDeviceAction;
  if (action === "test") await sendMobileTestNotification(deviceId, button);
  if (action === "disconnect") await disconnectMobileDevice(deviceId, button);
}

async function sendMobileTestNotification(deviceId, button) {
  button.disabled = true;
  try {
    const response = await writeFetch(`/api/integrations/call-note/admin/devices/${encodeURIComponent(deviceId)}/test`, {
      method: "POST",
      headers: { Accept: "application/json" }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "테스트 알림을 예약하지 못했습니다");
    toast("테스트 알림을 예약했습니다. 보통 1분 안에 발송됩니다");
    await loadMobileNotificationStatus({ silent: true });
  } catch (error) {
    toast(error.message || "테스트 알림을 예약하지 못했습니다");
  } finally {
    button.disabled = false;
  }
}

async function disconnectMobileDevice(deviceId, button) {
  if (!confirm("이 심방콜노트 앱의 웹 알림 연결을 해제할까요? 앱에서 다시 연결코드를 입력해야 합니다.")) return;
  button.disabled = true;
  try {
    const response = await writeFetch(`/api/integrations/call-note/admin/devices/${encodeURIComponent(deviceId)}`, {
      method: "DELETE",
      headers: { Accept: "application/json" }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "휴대폰 연결을 해제하지 못했습니다");
    toast("휴대폰 알림 연결을 해제했습니다");
    await loadMobileNotificationStatus();
  } catch (error) {
    toast(error.message || "휴대폰 연결을 해제하지 못했습니다");
  } finally {
    button.disabled = false;
  }
}

function startMobilePairTimers() {
  stopMobilePairTimers();
  state.mobilePairCountdownTimerId = window.setInterval(renderMobilePairExpiry, 1000);
  state.mobilePairPollTimerId = window.setInterval(() => {
    if (!el.settingsModal.classList.contains("hidden")) loadMobileNotificationStatus({ silent: true });
  }, 5000);
}

function reconcileMobilePairPolling(result) {
  const pairCode = result?.pairCode;
  const devices = Array.isArray(result?.devices) ? result.devices : [];
  const hasPending = devices.some((device) => device.status === "pending");
  const expired = pairCode?.expiresAt && Date.parse(pairCode.expiresAt) <= Date.now();
  if (pairCode?.usedAt || pairCode?.invalidatedAt || expired) {
    state.mobilePairCode = "";
    state.mobilePairCodeExpiresAt = "";
  }
  if ((pairCode?.usedAt && !hasPending) || pairCode?.invalidatedAt || expired) {
    stopMobilePairTimers();
  }
}

function stopMobilePairTimers(options = {}) {
  if (state.mobilePairPollTimerId) window.clearInterval(state.mobilePairPollTimerId);
  if (state.mobilePairCountdownTimerId) window.clearInterval(state.mobilePairCountdownTimerId);
  state.mobilePairPollTimerId = 0;
  state.mobilePairCountdownTimerId = 0;
  if (options.clearCode) {
    state.mobilePairCode = "";
    state.mobilePairCodeExpiresAt = "";
    el.mobilePairCodeOutput.textContent = "------";
    if (!options.preserveExpiryMessage) {
      el.mobilePairCodeExpiry.textContent = "코드를 만들면 이 화면에 한 번만 표시됩니다.";
    }
  }
}

function clearMobileNotificationTransientState() {
  stopMobilePairTimers({ clearCode: true });
  state.mobileNotificationStatus = null;
  state.mobileNotificationLoading = false;
}

async function loadGuestPasswordStatus() {
  el.guestPasswordStatus.textContent = "게스트 계정 상태를 확인하는 중입니다.";
  try {
    const response = await writeFetch("/api/auth/guest-password", {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "게스트 계정 상태를 확인하지 못했습니다");
    setGuestPasswordStatus(Boolean(result.enabled));
  } catch (error) {
    el.guestPasswordStatusBadge.textContent = "확인 실패";
    el.guestPasswordStatusBadge.classList.remove("enabled", "is-enabled", "is-disabled");
    el.guestPasswordStatus.textContent = error.message || "게스트 계정 상태를 확인하지 못했습니다.";
  }
}

function setGuestPasswordStatus(enabled) {
  state.guestPasswordEnabled = Boolean(enabled);
  el.guestPasswordStatusBadge.textContent = enabled ? "사용 중" : "사용 안 함";
  el.guestPasswordStatusBadge.classList.toggle("enabled", enabled);
  el.guestPasswordStatusBadge.classList.toggle("is-enabled", enabled);
  el.guestPasswordStatusBadge.classList.toggle("is-disabled", !enabled);
  el.guestPasswordDisableBtn.disabled = !enabled;
  el.guestPasswordStatus.textContent = enabled
    ? "셀리더는 게스트 비밀번호로 이름·사진·전화번호·주소만 조회할 수 있습니다."
    : "게스트 비밀번호를 만들면 관리자와 같은 로그인 화면에서 조회 전용으로 접속할 수 있습니다.";
}

async function saveGuestPassword() {
  if (!requireAdmin()) return;
  const password = el.guestPasswordInput.value.trim();
  if (!/^\d{4}$/.test(password)) {
    toast("게스트 비밀번호는 숫자 4자리로 입력하세요");
    el.guestPasswordInput.focus();
    return;
  }
  if (!confirm("입력한 비밀번호를 셀리더용 게스트 비밀번호로 저장할까요?")) return;
  el.guestPasswordSaveBtn.disabled = true;
  try {
    const response = await writeFetch("/api/auth/guest-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "게스트 비밀번호를 저장하지 못했습니다");
    el.guestPasswordInput.value = "";
    setGuestPasswordStatus(Boolean(result.enabled));
    toast("게스트 비밀번호를 저장했습니다. 기존 게스트는 즉시 로그아웃됩니다");
  } catch (error) {
    toast(error.message || "게스트 비밀번호를 저장하지 못했습니다");
  } finally {
    el.guestPasswordSaveBtn.disabled = false;
  }
}

async function disableGuestPassword() {
  if (!requireAdmin() || !state.guestPasswordEnabled) return;
  if (!confirm("게스트 계정을 끌까요? 이미 로그인한 게스트도 즉시 로그아웃됩니다.")) return;
  el.guestPasswordDisableBtn.disabled = true;
  try {
    const response = await writeFetch("/api/auth/guest-password", { method: "DELETE" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "게스트 계정을 끄지 못했습니다");
    setGuestPasswordStatus(Boolean(result.enabled));
    toast("게스트 계정을 껐습니다");
  } catch (error) {
    toast(error.message || "게스트 계정을 끄지 못했습니다");
  } finally {
    el.guestPasswordDisableBtn.disabled = !state.guestPasswordEnabled;
  }
}

function renderManagedGroupSettings() {
  const groups = state.groups
    .slice()
    .sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) || compareKoreanNames(a.name, b.name));

  if (!groups.length) {
    el.groupList.innerHTML = '<p class="call-note-empty">아직 등록된 기관/사역이 없습니다.</p>';
    el.groupListStatus.textContent = "기관을 추가하면 좌측 셀 목록 아래에 표시됩니다.";
    return;
  }

  el.groupList.innerHTML = groups.map((group) => {
    const memberIds = new Set(group.memberIds || []);
    const activeCount = state.members.filter((member) => memberIds.has(member.id) && !member.archivedAt && !member.trashedAt).length;
    const detail = [group.description, `${activeCount}명`].filter(Boolean).join(" · ");
    return `<article class="managed-group-row" data-managed-group-id="${escapeAttribute(group.id)}">
      <div class="managed-group-row-text">
        <strong>${escapeHtml(group.name)}</strong>
        <span>${escapeHtml(detail)}</span>
      </div>
      <div class="managed-group-row-actions">
        <button class="icon-button text-button primary" data-group-action="members" type="button">구성원</button>
        <button class="icon-button text-button subtle" data-group-action="edit" type="button">수정</button>
        <button class="icon-button text-button danger" data-group-action="delete" type="button">삭제</button>
      </div>
    </article>`;
  }).join("");
  el.groupListStatus.textContent = `${groups.length}개 기관/사역을 관리 중입니다.`;
}

function handleManagedGroupEditorKeydown(event) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  saveManagedGroup();
}

function handleManagedGroupListClick(event) {
  const button = closestElement(event.target, "[data-group-action]");
  const row = closestElement(button, "[data-managed-group-id]");
  if (!button || !row) return;
  const groupId = row.dataset.managedGroupId;
  if (button.dataset.groupAction === "members") openGroupMembers(groupId);
  if (button.dataset.groupAction === "edit") editManagedGroup(groupId);
  if (button.dataset.groupAction === "delete") deleteManagedGroup(groupId);
}

function editManagedGroup(groupId) {
  const group = state.groups.find((item) => item.id === groupId);
  if (!group) return;
  state.editingGroupId = groupId;
  el.groupNameInput.value = group.name || "";
  el.groupDescriptionInput.value = group.description || "";
  el.groupSaveBtn.textContent = "수정 저장";
  el.groupEditCancelBtn.classList.remove("hidden");
  el.groupNameInput.focus();
}

function resetManagedGroupEditor() {
  state.editingGroupId = "";
  el.groupNameInput.value = "";
  el.groupDescriptionInput.value = "";
  el.groupSaveBtn.textContent = "기관 추가";
  el.groupEditCancelBtn.classList.add("hidden");
}

async function saveManagedGroup() {
  if (!requireAdmin()) return;
  if (state.groupSavePending) return;
  const name = el.groupNameInput.value.trim();
  const description = el.groupDescriptionInput.value.trim();
  if (!name) {
    toast("기관/사역 이름을 입력하세요");
    el.groupNameInput.focus();
    return;
  }

  const editingId = state.editingGroupId;
  const editingGroup = editingId ? state.groups.find((group) => group.id === editingId) : null;
  const url = editingId ? `/api/groups/${encodeURIComponent(editingId)}` : "/api/groups";
  state.groupSavePending = true;
  el.groupSaveBtn.disabled = true;
  try {
    if (!(await ensureManagedGroupOnline())) return;
    const response = await writeFetch(url, {
      method: editingId ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        description,
        ...(editingGroup ? { expectedUpdatedAt: editingGroup.updatedAt } : {})
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "기관을 저장하지 못했습니다");

    const index = state.groups.findIndex((group) => group.id === result.id);
    if (index >= 0) state.groups[index] = result;
    else state.groups.push(result);
    resetManagedGroupEditor();
    renderManagedGroupSettings();
    persist();
    render();
    toast(editingId ? "기관 정보를 수정했습니다" : "기관을 추가했습니다");
  } catch (error) {
    if (error instanceof TypeError) state.apiOnline = false;
    toast(error.message || "기관을 저장하지 못했습니다");
  } finally {
    state.groupSavePending = false;
    el.groupSaveBtn.disabled = false;
  }
}

async function deleteManagedGroup(groupId) {
  if (!requireAdmin()) return;
  const group = state.groups.find((item) => item.id === groupId);
  if (!group) return;
  if (!(await ensureManagedGroupOnline())) return;
  const ok = confirm(`'${group.name}' 기관을 삭제할까요?\n구성원의 성도 정보와 심방기록은 삭제되지 않습니다.\n셀과 다른 기관이 없는 구성원은 왼쪽 '미지정 구성원'에 표시됩니다.`);
  if (!ok) return;
  try {
    const response = await writeFetch(`/api/groups/${encodeURIComponent(groupId)}`, { method: "DELETE" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "기관을 삭제하지 못했습니다");
    state.groups = state.groups.filter((item) => item.id !== groupId);
    if (state.selectedGroupId === groupId) {
      state.selectedGroupId = "";
      state.selectedMemberId = "";
    }
    resetManagedGroupEditor();
    renderManagedGroupSettings();
    persist();
    render();
    toast("기관을 삭제했습니다");
  } catch (error) {
    if (error instanceof TypeError) state.apiOnline = false;
    toast(error.message || "기관을 삭제하지 못했습니다");
  }
}

function openGroupMembers(groupId) {
  if (!requireAdmin()) return;
  const group = state.groups.find((item) => item.id === groupId);
  if (!group) return;
  state.editingGroupMembersId = groupId;
  state.groupMemberDraftIds = new Set(group.memberIds || []);
  el.groupMemberSearchInput.value = "";
  el.groupMembersTitle.textContent = `${group.name} 구성원`;
  renderGroupMemberList();
  el.groupMembersModal.classList.remove("hidden");
  el.groupMembersModal.setAttribute("aria-hidden", "false");
  setTimeout(() => el.groupMemberSearchInput.focus(), 0);
}

function closeGroupMembers() {
  el.groupMembersModal.classList.add("hidden");
  el.groupMembersModal.setAttribute("aria-hidden", "true");
  state.editingGroupMembersId = "";
  state.groupMemberDraftIds = new Set();
}

function renderGroupMemberList() {
  const query = el.groupMemberSearchInput.value.trim();
  const members = state.members
    .filter((member) => !member.trashedAt && !member.archivedAt)
    .filter((member) => !query || memberMatchesSearch(member, query))
    .sort((a, b) => cellSortRank(a.cellId) - cellSortRank(b.cellId) || compareKoreanNames(a.name, b.name));

  if (!members.length) {
    el.groupMemberList.innerHTML = '<p class="call-note-empty">검색된 성도가 없습니다.</p>';
  } else {
    el.groupMemberList.innerHTML = members.map((member) => {
      const checked = state.groupMemberDraftIds.has(member.id) ? "checked" : "";
      const detail = [member.title, memberCellLabel(member) || "기관 전용"].filter(Boolean).join(" · ");
      return `<label class="group-member-option">
        <input type="checkbox" data-group-member-id="${escapeAttribute(member.id)}" ${checked}>
        ${portraitHtml(member)}
        <span class="group-member-option-text">
          <strong>${memberNameHtml(member)}</strong>
          <span>${escapeHtml(detail)}</span>
        </span>
      </label>`;
    }).join("");
  }
  el.groupMembersStatus.textContent = `${state.groupMemberDraftIds.size}명 선택 · 제적처리된 성도의 기존 소속은 유지됩니다.`;
}

function handleGroupMemberSelection(event) {
  const input = closestElement(event.target, "[data-group-member-id]");
  if (!input) return;
  if (input.checked) state.groupMemberDraftIds.add(input.dataset.groupMemberId);
  else state.groupMemberDraftIds.delete(input.dataset.groupMemberId);
  el.groupMembersStatus.textContent = `${state.groupMemberDraftIds.size}명 선택 · 저장하면 기관 명단에 반영됩니다.`;
}

async function saveGroupMembers() {
  const groupId = state.editingGroupMembersId;
  const group = state.groups.find((item) => item.id === groupId);
  if (!group) return;
  const nextMemberIds = [...state.groupMemberDraftIds];
  el.groupMembersSaveBtn.disabled = true;
  try {
    if (!(await ensureManagedGroupOnline())) {
      el.groupMembersStatus.textContent = "기관 구성원 저장은 온라인 연결이 필요합니다. 연결을 확인한 뒤 다시 시도하세요.";
      return;
    }
    const savedGroup = await replaceGroupMembers(groupId, nextMemberIds, group.updatedAt);
    Object.assign(group, savedGroup);
    if (state.selectedGroupId === groupId && state.selectedMemberId && !group.memberIds.includes(state.selectedMemberId)) {
      state.selectedMemberId = "";
    }
    if (isSystemCellId(state.selectedCellId) && !unassignedMembers().length) {
      state.selectedCellId = visibleCells()[0]?.id || "";
    }
    closeGroupMembers();
    renderManagedGroupSettings();
    persist();
    render();
    toast("기관 구성원을 저장했습니다");
  } catch (error) {
    if (error.status === 409) {
      el.groupMembersStatus.textContent = "다른 기기에서 기관 명단이 먼저 변경되었습니다. 페이지를 새로고침한 뒤 다시 선택해 주세요.";
    } else {
      if (error instanceof TypeError) state.apiOnline = false;
      el.groupMembersStatus.textContent = error.message || "구성원을 저장하지 못했습니다.";
    }
  } finally {
    el.groupMembersSaveBtn.disabled = false;
  }
}

async function replaceGroupMembers(groupId, memberIds, expectedUpdatedAt) {
  const response = await writeFetch(`/api/groups/${encodeURIComponent(groupId)}/members`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memberIds, expectedUpdatedAt })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || "구성원을 저장하지 못했습니다");
    error.status = response.status;
    error.code = result.code || "";
    throw error;
  }
  return result;
}

async function startNewGroupMember() {
  const groupId = state.editingGroupMembersId;
  if (!groupId) return;
  if (!(await ensureManagedGroupOnline("기관 전용 신규 구성원은 온라인 연결에서만 등록할 수 있습니다"))) return;
  closeGroupMembers();
  closeSettings();
  state.selectedGroupId = groupId;
  state.selectedMemberId = "";
  state.pendingGroupId = groupId;
  persist();
  render();
  await startNewMember();
}

function openCallNoteInbox() {
  if (!requireAdmin()) return;
  renderCallNoteImports();
  el.callNoteModal.classList.remove("hidden");
  el.callNoteModal.setAttribute("aria-hidden", "false");
  el.callNoteInboxBtn.setAttribute("aria-expanded", "true");
  loadCallNoteImports();
  setTimeout(() => el.callNoteCloseBtn.focus(), 0);
}

function closeCallNoteInbox() {
  el.callNoteModal.classList.add("hidden");
  el.callNoteModal.setAttribute("aria-hidden", "true");
  el.callNoteInboxBtn.setAttribute("aria-expanded", "false");
}

function isCallNoteInboxOpen() {
  return Boolean(el.callNoteModal && !el.callNoteModal.classList.contains("hidden"));
}

function refreshCallNoteImportsForIndicator() {
  if (!state.apiOnline || isCallNoteInboxOpen()) return;
  loadCallNoteImports({ silent: true });
}

async function saveCommunityTitle() {
  const communityTitle = cleanTitle(el.communityTitleInput.value);
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
      communityTitle: typeof result.communityTitle === "string" ? result.communityTitle : communityTitle
    };
    persist();
    renderCommunityTitle();
    toast(communityTitle ? "상단 제목을 저장했습니다" : "화면 제목을 비웠습니다");
  } catch (error) {
    toast(error.message || "상단 제목을 저장하지 못했습니다");
  } finally {
    el.saveCommunityTitleBtn.disabled = false;
  }
}

async function loadPasskeyStatus() {
  try {
    const response = await writeFetch("/api/auth/passkeys", {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    const result = await readPasskeyResponse(response, "패스키 상태를 확인하지 못했습니다.");
    setPasskeyStatus(result);
    return result;
  } catch (error) {
    setPasskeyStatus({ error: error.message || "패스키 상태를 확인하지 못했습니다." });
    return null;
  }
}

function setPasskeyStatus(result = {}) {
  const loading = Boolean(result.loading);
  const count = Math.max(0, Number(result.count || 0));
  const supported = supportsPasskeyRegistration();
  const available = result.available !== false;
  const registered = count > 0;

  el.passkeyStatusBadge.classList.toggle("is-registered", !loading && registered);
  el.passkeyStatusBadge.classList.toggle("is-unavailable", !loading && (!supported || !available || Boolean(result.error)));
  el.passkeyStatusBadge.textContent = loading
    ? "확인 중"
    : result.error ? "확인 실패" : registered ? `${count}개 등록됨` : supported && available ? "미등록" : "사용 불가";

  el.passkeyRegisterBtn.disabled = loading || !supported || !available || Boolean(result.error);
  el.passkeyClearBtn.disabled = loading || !registered;
  el.passkeyPasswordResetBtn.disabled = loading || !registered || !supportsPasskeyAuthentication() || !available || Boolean(result.error);

  if (loading) {
    el.passkeyStatus.textContent = "패스키 상태를 확인하는 중입니다.";
  } else if (result.error) {
    el.passkeyStatus.textContent = result.error;
  } else if (!supported) {
    el.passkeyStatus.textContent = "이 브라우저에서는 패스키 등록을 지원하지 않습니다. 비밀번호 로그인은 계속 사용할 수 있습니다.";
  } else if (!available) {
    el.passkeyStatus.textContent = "서버의 패스키 보안 키가 아직 설정되지 않았습니다. 비밀번호 로그인은 계속 사용할 수 있습니다.";
  } else if (registered) {
    const latest = Array.isArray(result.passkeys)
      ? result.passkeys.map((item) => item.lastUsedAt || item.createdAt).filter(Boolean).sort().at(-1)
      : "";
    el.passkeyStatus.textContent = latest
      ? `패스키 ${count}개가 등록되어 있습니다. 최근 사용: ${formatPasskeyDate(latest)}`
      : `패스키 ${count}개가 등록되어 있습니다.`;
  } else {
    el.passkeyStatus.textContent = "등록된 패스키가 없습니다. 이 기기 등록을 눌러 시작하세요.";
  }
}

async function registerPasskeyForDevice() {
  if (!supportsPasskeyRegistration()) {
    toast("이 브라우저에서는 패스키를 등록할 수 없습니다.");
    return;
  }

  el.passkeyRegisterBtn.disabled = true;
  el.passkeyClearBtn.disabled = true;
  el.passkeyStatus.textContent = "기기의 패스키 인증기를 확인하는 중입니다.";

  try {
    if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function") {
      const platformAvailable = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      if (!platformAvailable) {
        throw new Error("이 기기에서 지문·얼굴·화면 잠금 인증기를 사용할 수 없습니다.");
      }
    }

    const optionsResponse = await writeFetch("/api/auth/passkey/register-options", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      cache: "no-store",
      body: "{}"
    });
    const ceremony = await readPasskeyResponse(optionsResponse, "패스키 등록 정보를 불러오지 못했습니다.");
    const credential = await navigator.credentials.create({
      publicKey: decodePasskeyRegistrationOptions(ceremony.options)
    });
    if (!credential) throw new Error("패스키 등록이 취소되었습니다.");

    el.passkeyStatus.textContent = "등록된 패스키를 확인하는 중입니다.";
    const registerResponse = await writeFetch("/api/auth/passkey/register", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      cache: "no-store",
      body: JSON.stringify({
        challengeToken: ceremony.challengeToken,
        credential: serializePasskeyRegistrationCredential(credential)
      })
    });
    const result = await readPasskeyResponse(registerResponse, "패스키를 등록하지 못했습니다.");
    setPasskeyStatus(result);
    toast("패스키를 등록했습니다");
  } catch (error) {
    const message = passkeyRegistrationErrorMessage(error);
    toast(`등록 실패: ${message}`);
    const status = await loadPasskeyStatus();
    if (!status || Number(status.count || 0) === 0) {
      el.passkeyStatusBadge.textContent = "등록 실패";
      el.passkeyStatusBadge.classList.remove("is-registered");
      el.passkeyStatusBadge.classList.add("is-unavailable");
      el.passkeyStatus.textContent = `등록 실패: ${message}`;
    }
  }
}

async function clearRegisteredPasskeys() {
  const confirmed = confirm("등록된 패스키를 모두 삭제할까요?\n삭제 후에는 다시 등록하기 전까지 비밀번호로 로그인해야 합니다.");
  if (!confirmed) return;

  el.passkeyRegisterBtn.disabled = true;
  el.passkeyClearBtn.disabled = true;
  el.passkeyStatus.textContent = "등록된 패스키를 삭제하는 중입니다.";
  try {
    const response = await writeFetch("/api/auth/passkeys/clear", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      cache: "no-store",
      body: JSON.stringify({ confirm: "clear" })
    });
    const result = await readPasskeyResponse(response, "패스키 등록을 삭제하지 못했습니다.");
    setPasskeyStatus(result);
    toast(result.removed ? "등록된 패스키를 모두 삭제했습니다" : "삭제할 패스키가 없습니다");
  } catch (error) {
    toast(error.message || "패스키 등록을 삭제하지 못했습니다.");
    await loadPasskeyStatus();
  }
}

function supportsPasskeyRegistration() {
  return Boolean(
    window.isSecureContext
    && window.PublicKeyCredential
    && navigator.credentials
    && typeof navigator.credentials.create === "function"
  );
}

function supportsPasskeyAuthentication() {
  return Boolean(
    window.isSecureContext
    && window.PublicKeyCredential
    && navigator.credentials
    && typeof navigator.credentials.get === "function"
  );
}

async function resetPasswordWithPasskey() {
  const newPassword = el.resetNewPassword.value;
  const confirmPassword = el.resetConfirmPassword.value;
  let resetSucceeded = false;

  if (!newPassword || !confirmPassword) {
    setPasskeyPasswordResetStatus("새 비밀번호와 확인 비밀번호를 모두 입력하세요.", true);
    el.resetNewPassword.focus();
    return;
  }
  if (newPassword.length < 12) {
    setPasskeyPasswordResetStatus("새 비밀번호는 12자 이상으로 입력하세요.", true);
    el.resetNewPassword.focus();
    return;
  }
  if (newPassword !== confirmPassword) {
    setPasskeyPasswordResetStatus("새 비밀번호가 서로 다릅니다.", true);
    el.resetConfirmPassword.focus();
    return;
  }
  if (!supportsPasskeyAuthentication()) {
    setPasskeyPasswordResetStatus("이 브라우저에서는 패스키 본인 확인을 사용할 수 없습니다.", true);
    return;
  }

  el.passkeyPasswordResetBtn.disabled = true;
  setPasskeyPasswordResetStatus("지문·패스키 본인 확인을 준비하는 중입니다.");
  try {
    const optionsResponse = await writeFetch("/api/auth/passkey/password-reset-options", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      credentials: "same-origin",
      cache: "no-store",
      body: "{}"
    });
    const ceremony = await readPasskeyResponse(optionsResponse, "비밀번호 재설정 인증 정보를 불러오지 못했습니다.");
    const credential = await navigator.credentials.get({
      publicKey: decodePasskeyAuthenticationOptions(ceremony.options)
    });
    if (!credential) throw new Error("패스키 본인 확인이 취소되었습니다.");

    setPasskeyPasswordResetStatus("패스키를 확인했습니다. 새 비밀번호를 저장하는 중입니다.");
    const resetResponse = await writeFetch("/api/auth/passkey/reset-password", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({
        challengeToken: ceremony.challengeToken,
        credential: serializePasskeyAuthenticationCredential(credential),
        newPassword
      })
    });
    await readPasskeyResponse(resetResponse, "관리자 비밀번호를 재설정하지 못했습니다.");
    el.resetNewPassword.value = "";
    el.resetConfirmPassword.value = "";
    el.currentPassword.value = "";
    el.newPassword.value = "";
    el.confirmPassword.value = "";
    resetSucceeded = true;
    setPasskeyPasswordResetStatus("관리자 비밀번호가 변경되었습니다. 새 비밀번호 또는 패스키로 다시 로그인합니다.");
  } catch (error) {
    setPasskeyPasswordResetStatus(passkeyAuthenticationErrorMessage(error), true);
  } finally {
    if (resetSucceeded) {
      window.location.replace("/__auth/logout");
      return;
    }
    const status = await loadPasskeyStatus();
    if (!status) el.passkeyPasswordResetBtn.disabled = true;
  }
}

function decodePasskeyAuthenticationOptions(options) {
  if (!options || typeof options !== "object") {
    throw new Error("패스키 인증 정보가 올바르지 않습니다.");
  }
  return {
    ...options,
    challenge: passkeyBase64UrlToBytes(options.challenge),
    allowCredentials: Array.isArray(options.allowCredentials)
      ? options.allowCredentials.map((credential) => ({
        ...credential,
        id: passkeyBase64UrlToBytes(credential.id)
      }))
      : []
  };
}

function serializePasskeyAuthenticationCredential(credential) {
  const response = credential.response;
  return {
    id: credential.id,
    rawId: passkeyBytesToBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
    clientExtensionResults: credential.getClientExtensionResults?.() || {},
    response: {
      clientDataJSON: passkeyBytesToBase64Url(response.clientDataJSON),
      authenticatorData: passkeyBytesToBase64Url(response.authenticatorData),
      signature: passkeyBytesToBase64Url(response.signature),
      userHandle: response.userHandle ? passkeyBytesToBase64Url(response.userHandle) : undefined
    }
  };
}

function passkeyAuthenticationErrorMessage(error) {
  if (error?.name === "NotAllowedError" || error?.name === "AbortError") {
    return "본인 확인이 취소되었거나 시간이 초과되었습니다. 다시 시도하세요.";
  }
  if (error?.name === "SecurityError") return "공식 운영 주소에서만 패스키 본인 확인을 사용할 수 있습니다.";
  if (error?.code === "CHALLENGE_REPLAYED" || error?.code === "CHALLENGE_INVALID") {
    return "인증 요청이 만료되었습니다. 버튼을 눌러 다시 시도하세요.";
  }
  return error?.message || "패스키 본인 확인 후 비밀번호를 변경하지 못했습니다.";
}

function setPasskeyPasswordResetStatus(message, isError = false) {
  el.passkeyPasswordResetStatus.textContent = message;
  el.passkeyPasswordResetStatus.classList.toggle("error-text", isError);
}

function decodePasskeyRegistrationOptions(options) {
  if (!options || typeof options !== "object" || !options.user) {
    throw new Error("패스키 등록 정보가 올바르지 않습니다.");
  }
  return {
    ...options,
    challenge: passkeyBase64UrlToBytes(options.challenge),
    user: {
      ...options.user,
      id: passkeyBase64UrlToBytes(options.user.id)
    },
    excludeCredentials: Array.isArray(options.excludeCredentials)
      ? options.excludeCredentials.map((credential) => ({
        ...credential,
        id: passkeyBase64UrlToBytes(credential.id)
      }))
      : []
  };
}

function serializePasskeyRegistrationCredential(credential) {
  const response = credential.response;
  const publicKey = response.getPublicKey?.();
  const authenticatorData = response.getAuthenticatorData?.();
  return {
    id: credential.id,
    rawId: passkeyBytesToBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
    clientExtensionResults: credential.getClientExtensionResults?.() || {},
    response: {
      clientDataJSON: passkeyBytesToBase64Url(response.clientDataJSON),
      attestationObject: passkeyBytesToBase64Url(response.attestationObject),
      transports: response.getTransports?.() || [],
      authenticatorData: authenticatorData ? passkeyBytesToBase64Url(authenticatorData) : undefined,
      publicKeyAlgorithm: response.getPublicKeyAlgorithm?.(),
      publicKey: publicKey ? passkeyBytesToBase64Url(publicKey) : undefined
    }
  };
}

async function readPasskeyResponse(response, fallbackMessage) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || fallbackMessage);
    error.code = result.code || "";
    throw error;
  }
  return result;
}

function passkeyBase64UrlToBytes(value) {
  const base64 = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function passkeyBytesToBase64Url(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function passkeyRegistrationErrorMessage(error) {
  if (error?.name === "NotAllowedError" || error?.name === "AbortError") {
    return "등록이 취소되었거나 시간이 초과되었습니다.";
  }
  if (error?.name === "InvalidStateError") return "이 기기의 패스키가 이미 등록되어 있습니다.";
  if (error?.name === "NotSupportedError") return "이 기기는 요청된 패스키 방식을 지원하지 않습니다.";
  if (error?.name === "SecurityError") return "공식 운영 주소에서만 패스키를 등록할 수 있습니다.";
  return error?.message || "패스키를 등록하지 못했습니다.";
}

function formatPasskeyDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("ko-KR") : "";
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

async function loadCallNoteImports(options = {}) {
  const silent = Boolean(options.silent);
  if (!state.apiOnline) {
    if (!silent) updateCallNoteInboxStatus("서버 연결 상태에서 사용할 수 있습니다.");
    renderCallNoteImports();
    return;
  }
  if (!silent) updateCallNoteInboxStatus("웹훅 메시지를 불러오는 중입니다.");
  try {
    const response = await writeFetch("/api/call-note-imports?status=needs_review", {
      headers: { Accept: "application/json" }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "load failed");
    state.callNoteImports = Array.isArray(result.imports) ? result.imports : [];
    if (!silent || isCallNoteInboxOpen()) {
      const expiredDeleted = Number(result.expiredDeleted || 0);
      updateCallNoteInboxStatus(expiredDeleted ? callNoteInboxExpiredSummary(expiredDeleted) : callNoteInboxSummary());
    }
  } catch (error) {
    if (!silent) updateCallNoteInboxStatus(error.message || "웹훅 메시지를 불러오지 못했습니다.");
  }
  renderCallNoteImports();
}

function renderCallNoteImports() {
  const imports = state.callNoteImports || [];
  renderCallNoteInboxIndicator();
  if (!el.callNoteInbox) return;
  if (!imports.length) {
    el.callNoteInbox.innerHTML = '<p class="call-note-empty">검토할 기록이 없습니다.</p>';
    return;
  }
  el.callNoteInbox.innerHTML = imports.map(callNoteImportHtml).join("");
}

function renderCallNoteInboxIndicator() {
  if (!el.callNoteInboxBtn || !el.callNoteInboxCount) return;
  const count = (state.callNoteImports || []).length;
  el.callNoteInboxCount.textContent = String(count);
  el.callNoteInboxCount.classList.toggle("hidden", !count);
  el.callNoteInboxBtn.classList.toggle("has-items", Boolean(count));
  const label = count ? `웹훅 메시지 ${count}건 확인 필요` : "웹훅 메시지";
  el.callNoteInboxBtn.setAttribute("aria-label", label);
  el.callNoteInboxBtn.title = label;
}

function updateCallNoteInboxStatus(message) {
  if (el.callNoteInboxStatus) el.callNoteInboxStatus.textContent = message;
}

function callNoteInboxSummary() {
  const count = (state.callNoteImports || []).length;
  return count ? `확인 필요한 웹훅 메시지 ${count}건` : "확인 필요한 웹훅 메시지가 없습니다.";
}

function callNoteInboxExpiredSummary(expiredDeleted) {
  const base = callNoteInboxSummary();
  return `3일 지난 미분류 메시지 ${expiredDeleted}건을 자동 삭제했습니다. ${base}`;
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
    const cellLabel = isSystemCellId(member.cellId) ? "" : (member.cellName || memberCellLabel(member));
    const groupLabel = Array.isArray(member.groupNames) ? member.groupNames.join(", ") : memberGroupLabels(member);
    const affiliation = [cellLabel, groupLabel].filter(Boolean).join(" / ") || "기관 전용";
    const label = `${member.name}${member.title || ""} · ${affiliation}`;
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
      cellName: memberCellLabel(member),
      groupNames: state.groups
        .filter((group) => group.memberIds?.includes(member.id))
        .map((group) => group.name)
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
    updateCallNoteInboxStatus(callNoteInboxSummary());
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
    updateCallNoteInboxStatus(callNoteInboxSummary());
    toast("콜노트 기록을 무시했습니다");
  } catch (error) {
    toast(error.message || "처리하지 못했습니다");
  } finally {
    button.disabled = false;
  }
}

async function changePassword() {
  const currentPassword = el.currentPassword.value.trim();
  const newPassword = el.newPassword.value.trim();
  const confirmPassword = el.confirmPassword.value.trim();

  if (!currentPassword || !newPassword || !confirmPassword) {
    toast("\uBE44\uBC00\uBC88\uD638\uB97C \uBAA8\uB450 \uC785\uB825\uD558\uC138\uC694");
    return;
  }
  if (newPassword.length < 12) {
    toast("\uC0C8 \uBE44\uBC00\uBC88\uD638\uB294 12\uC790 \uC774\uC0C1\uC73C\uB85C \uC785\uB825\uD558\uC138\uC694");
    el.newPassword.focus();
    return;
  }
  if (newPassword !== confirmPassword) {
    toast("\uC0C8 \uBE44\uBC00\uBC88\uD638\uAC00 \uC11C\uB85C \uB2E4\uB985\uB2C8\uB2E4");
    el.confirmPassword.focus();
    return;
  }

  el.adminPasswordSaveBtn.disabled = true;
  try {
    const response = await fetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "password update failed");
    window.location.replace("/__auth/logout");
    return;
  } catch (error) {
    toast(error.message || "\uBE44\uBC00\uBC88\uD638\uB97C \uBCC0\uACBD\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4");
  } finally {
    el.adminPasswordSaveBtn.disabled = false;
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
  state.pendingGroupId = "";
  state.returnToAttendanceDate = "";
  persist();
  render();
}

function currentCell() {
  return state.cells.find((cell) => cell.id === state.selectedCellId) || visibleCells()[0];
}

function currentGroup() {
  return state.groups.find((group) => group.id === state.selectedGroupId) || null;
}

function visibleCells() {
  return state.cells.filter((cell) => !cell.isSystem && cell.id !== UNASSIGNED_CELL_ID);
}

function unassignedMembers() {
  const groupedMemberIds = new Set(
    state.groups.flatMap((group) => Array.isArray(group.memberIds) ? group.memberIds : [])
  );
  return state.members.filter((member) => (
    !member.trashedAt
    && !isDraftMember(member)
    && isSystemCellId(member.cellId)
    && !groupedMemberIds.has(member.id)
  ));
}

function isSystemCellId(cellId) {
  return cellId === UNASSIGNED_CELL_ID || Boolean(state.cells.find((cell) => cell.id === cellId)?.isSystem);
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
  return localDateString(new Date());
}

function cleanTitle(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 40);
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
