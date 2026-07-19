const ROLES = [
  { value: "", label: "일반" },
  { value: "cell_leader", label: "셀장" },
  { value: "assistant_leader", label: "부셀장" },
  { value: "prayer_leader", label: "기도장" }
];

const DEFAULT_CELLS = [
  { id: "male-8", name: "남자 8셀", meta: "66~68년생", gender: "남자", sortOrder: 10 },
  { id: "male-16", name: "남자 16셀", meta: "90년생이하", gender: "남자", sortOrder: 20 },
  { id: "female-3", name: "여자 3셀", meta: "47~48년생", gender: "여자", sortOrder: 30 },
  { id: "female-9", name: "여자 9셀", meta: "58년생", gender: "여자", sortOrder: 40 },
  { id: "female-15", name: "여자 15셀", meta: "66년생", gender: "여자", sortOrder: 50 },
  { id: "female-25", name: "여자 25셀", meta: "77년생", gender: "여자", sortOrder: 60 },
  { id: "female-33", name: "여자 33셀", meta: "86~87년생", gender: "여자", sortOrder: 70 }
];

const INITIAL_CELLS = Array.isArray(window.SEED_CELLS) && window.SEED_CELLS.length
  ? window.SEED_CELLS.map((cell) => ({ ...cell }))
  : DEFAULT_CELLS;

const PHOTO_VERSION = window.SEED_DATA_VERSION || "20260704-photo-fix-2";

const seedRows = [];

const INITIAL_MEMBERS = Array.isArray(window.SEED_MEMBERS)
  ? window.SEED_MEMBERS.map((member) => ({ ...member }))
  : seedRows.map((row, index) => ({
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
    prayerRequests: "",
    photoUrl: `photos/seed-${String(index + 1).padStart(3, "0")}.jpg?v=${PHOTO_VERSION}`,
    photoKey: "",
    photoRemoved: false,
    archivedAt: "",
    trashedAt: "",
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z"
  }));

const INITIAL_VISITS = Array.isArray(window.SEED_VISITS)
  ? window.SEED_VISITS.map((visit) => ({ ...visit }))
  : [];

const STORE_KEY = `seosanch-cell:${window.SEED_DATA_VERSION || "v1"}`;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const D1_REQUIRED = window.location.protocol !== "file:" && !LOCAL_HOSTS.has(window.location.hostname);
const UI_STORE_KEY = `${STORE_KEY}:ui`;
const DEFAULT_COMMUNITY_TITLE = window.SEED_COMMUNITY_TITLE || "청년공동체 목양웹";
const MISSING_COMMUNITY_TITLE = "설정에서 제목을 입력하세요";
const VISIT_META_PREFIX = "visit-meta:";
const VISIT_TYPE_ALARM = "알람";
const ALARM_DISMISS_KEY = "seosanch-cell:alarm-dismissed:v1";
const ATTENDANCE_MODES = [
  { value: "present", label: "출석" },
  { value: "online", label: "온라인" },
  { value: "absent", label: "결석" },
  { value: "military", label: "군복무" },
  { value: "study", label: "유학" },
  { value: "other", label: "기타" }
];

const state = {
  viewer: {
    id: "owner",
    role: "owner",
    canViewSensitive: true,
    canEdit: true,
    canManageUsers: true,
    canManageSettings: true,
    canUseMemos: true
  },
  settings: {
    communityTitle: DEFAULT_COMMUNITY_TITLE
  },
  cells: [],
  members: [],
  visits: [],
  careTasks: [],
  prayerTopics: [],
  dashboard: null,
  timelineEvents: [],
  timelineMemberId: "",
  timelineLoading: false,
  timelineFilter: "all",
  prayerFilter: "praying",
  editingTaskId: "",
  editingPrayerId: "",
  prayerEditorMode: "create",
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
  attendanceStatuses: {},
  attendanceMarkMode: "present",
  returnToAttendanceDate: "",
  callNoteImports: [],
  mobileNotification: null,
  relayEnrollmentRequestCode: "",
  relayEnrollmentRequestExpiresAt: "",
  relayEnrollmentLoading: false,
  mobilePairCode: "",
  mobilePairCodeExpiresAt: "",
  mobileNotificationPollId: 0,
  mobilePairCountdownId: 0,
  webPush: null,
  webPushSubscription: null,
  webPushBusy: false,
  webPushPollId: 0,
  webPushPendingTestId: "",
  editingVisitId: "",
  visitListCollapsed: false,
  visitListPageOpen: false,
  expandedVisitId: "",
  showVisitTrash: false,
  dismissedAlarmKeys: new Set(),
  alarmTimerId: 0,
  apiOnline: false
};

const el = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindElements();
  bindEvents();
  const openTodayPastoral = consumeTodayPastoralNotificationRoute();
  state.dismissedAlarmKeys = readDismissedAlarmKeys();
  el.memberBirth.maxLength = 10;
  populateRoleOptions();
  await loadState();
  state.selectedCellId = state.selectedCellId || state.cells[0]?.id || "";
  render();
  await loadDashboardData(false);
  if (openTodayPastoral) showDashboard();
  renderAlarmNotifications();
  state.alarmTimerId = window.setInterval(renderAlarmNotifications, 30000);
}

function bindElements() {
  [
    "workspace", "cellTabs", "searchInput", "showArchived", "memberGrid", "cellTitle", "cellMeta", "cellWordBtn", "cellPrintBtn", "allWordBtn", "allPrintBtn",
    "activeCount", "archivedCount", "addMemberBtn", "memoCenterBtn", "communityBtn", "dashboardBtn", "dashboardBadge", "dashboardModal", "dashboardCloseBtn", "dashboardRefreshBtn", "dashboardSummary", "dashboardStatus", "dashboardContent", "visitDatesBtn", "attendanceBtn", "attendanceModal", "attendanceCloseBtn", "attendancePrevBtn", "attendanceNextBtn",
    "attendanceDate", "attendanceDateLabel", "attendanceHistory", "attendanceModeTabs", "attendanceSummary", "attendanceCellStats", "attendanceMemberGrid", "attendanceResults",
    "attendanceSaveBtn", "attendanceClearBtn", "settingsBtn", "settingsModal", "settingsForm", "settingsCloseBtn", "settingsCancelBtn", "logoutBtn", "annualReportBtn", "railAnnualReportBtn",
    "communityTitleText", "communityTitleInput", "saveCommunityTitleBtn", "currentPassword", "newPassword", "confirmPassword", "autoLoginStatus", "autoLoginRevokeBtn", "passkeyStatus", "passkeyRegisterBtn", "passkeyClearBtn", "pwaInstallStatus", "pwaInstallBtn", "webPushStatusBadge", "webPushDevice", "webPushRegisterBtn", "webPushTestBtn", "webPushUnregisterBtn", "webPushStatus", "relayEnrollmentStatusBadge", "relayEnrollmentSummary", "relayEnrollmentRequestPanel", "relayEnrollmentRequestLabel", "relayEnrollmentRequestCodeOutput", "relayEnrollmentRequestExpiry", "relayEnrollmentRequestCreateBtn", "relayEnrollmentRequestCopyBtn", "relayEnrollmentStatus", "callNoteRefreshBtn", "callNoteWebhookUrl", "callNoteTokenBtn", "callNoteTokenReissueBtn", "callNoteTokenOutput", "callNoteStatus", "callNoteInbox", "mobileNotificationStatusBadge", "mobilePairCodeOutput", "mobilePairCodeExpiry", "mobilePairCodeCreateBtn", "mobileDeviceList", "mobileNotificationRefreshBtn", "mobileDeliveryList", "mobileNotificationStatus", "visitDatesModal", "visitDatesCloseBtn", "visitMonthPrevBtn", "visitMonthNextBtn", "visitMonthLabel", "visitCalendar", "visitDateSelectedLabel", "visitDateEntries", "visitRecordModal", "visitRecordCloseBtn", "detailPanel", "emptyDetail",
    "memberForm", "formMode", "formTitle", "backToListBtn", "basicInfoJumpBtn", "contactMemberBtn", "contactMemberActions", "contactCallLink", "contactSmsLink", "bottomBackToListBtn", "closePanelBtn", "photoPreview", "profileDetails", "openVisitRecordBtn", "openMemberMemosBtn", "memberWordBtn", "memberPrintBtn",
    "quickCellMovePanel", "quickCellMove", "quickCellMoveBtn",
    "photoInput", "memberName", "memberTitle", "memberCell",
    "memberRole", "memberBaptismStatus", "memberPhone", "memberHomePhone", "memberBirth", "memberBirthCalendar", "memberRegisteredAt", "memberRegisteredAtPicker", "memberRegisteredAtPickerBtn", "memberAge", "memberCalendar", "memberAddress", "memberLongAbsent", "memberMemo", "memberPrayer",
    "taskSection", "taskCount", "taskDueDate", "taskAssignee", "taskTitle", "taskNote", "taskSaveBtn", "taskCancelBtn", "taskList",
    "prayerSection", "prayerCount", "prayerContent", "prayerAnswerField", "prayerAnswerNote", "prayerUrgent", "prayerSaveBtn", "prayerCancelBtn", "prayerFilters", "prayerList",
    "timelineSection", "timelineCount", "timelineRefreshBtn", "timelineFilters", "timelineList",
    "archiveBtn", "restoreBtn", "deleteBtn", "visitCount", "visitDate",
    "visitType", "visitAlarmFields", "visitAlarmDate", "visitAlarmTime", "visitSummary", "addVisitBtn", "visitSubmitLabel", "cancelVisitEditBtn", "deleteVisitEditBtn", "visitMemberSummary", "visitTrashToggleBtn", "visitListToggleBtn", "visitList",
    "alarmCenter", "alarmBellBtn", "alarmCount", "alarmPanel", "alarmCloseBtn", "alarmList",
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
  el.memoCenterBtn.addEventListener("click", () => navigateToMemos());
  el.communityBtn.addEventListener("click", () => { window.location.href = "/community.html"; });
  el.dashboardBtn.addEventListener("click", openDashboard);
  el.dashboardCloseBtn.addEventListener("click", closeDashboard);
  el.dashboardRefreshBtn.addEventListener("click", () => loadDashboardData(true));
  el.dashboardModal.addEventListener("click", (event) => {
    if (event.target === el.dashboardModal) closeDashboard();
  });
  el.dashboardSummary.addEventListener("click", (event) => {
    const button = closestElement(event.target, "[data-dashboard-target]");
    if (!button) return;
    document.getElementById(button.dataset.dashboardTarget)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  el.dashboardContent.addEventListener("click", (event) => {
    const button = closestElement(event.target, "[data-dashboard-member]");
    if (!button) return;
    closeDashboard();
    selectMember(button.dataset.dashboardMember);
  });
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
      state.returnToAttendanceDate = state.attendanceDate || nearestSundayDate();
      closeSundayAttendance();
      selectMember(detailButton.dataset.attendanceMemberDetail);
    }
  });
  el.attendanceMemberGrid.addEventListener("click", (event) => {
    const button = closestElement(event.target, "[data-attendance-member-id]");
    if (button) {
      event.preventDefault();
      toggleSundayAttendanceMember(button.dataset.attendanceMemberId, button);
    }
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
  el.openMemberMemosBtn.addEventListener("click", () => {
    const member = selectedMember();
    if (member) navigateToMemos("", member.id, true);
  });
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
  el.relayEnrollmentRequestCreateBtn.addEventListener("click", createRelayEnrollmentRequest);
  el.relayEnrollmentRequestCopyBtn.addEventListener("click", copyRelayEnrollmentRequestCode);
  el.mobilePairCodeCreateBtn.addEventListener("click", createMobilePairCode);
  el.mobileNotificationRefreshBtn.addEventListener("click", () => loadMobileNotificationStatus());
  el.mobileDeviceList.addEventListener("click", handleMobileDeviceAction);
  el.autoLoginRevokeBtn.addEventListener("click", revokeAutoLogin);
  el.passkeyRegisterBtn.addEventListener("click", registerPasskey);
  el.passkeyClearBtn.addEventListener("click", clearPasskeys);
  el.pwaInstallBtn.addEventListener("click", installPastoralApp);
  el.webPushRegisterBtn.addEventListener("click", registerWebPushDevice);
  el.webPushTestBtn.addEventListener("click", sendWebPushTest);
  el.webPushUnregisterBtn.addEventListener("click", unregisterWebPushDevice);
  window.addEventListener("pastoral:pwa-installable", renderPwaInstallState);
  window.addEventListener("pastoral:pwa-installed", renderPwaInstallState);
  window.addEventListener("pastoral:pwa-ready", renderPwaInstallState);
  el.annualReportBtn.addEventListener("click", openAnnualReport);
  el.railAnnualReportBtn.addEventListener("click", openAnnualReport);
  el.memberWordBtn.addEventListener("click", () => exportCareReport("word", "member"));
  el.memberPrintBtn.addEventListener("click", () => exportCareReport("print", "member"));
  el.cellWordBtn.addEventListener("click", () => exportCareReport("word", "cell"));
  el.cellPrintBtn.addEventListener("click", () => exportCareReport("print", "cell"));
  el.allWordBtn.addEventListener("click", () => exportCareReport("word", "all"));
  el.allPrintBtn.addEventListener("click", () => exportCareReport("print", "all"));
  el.logoutBtn.addEventListener("click", () => {
    window.location.href = "/__auth/logout";
  });
  el.closePanelBtn.addEventListener("click", closeDetail);
  el.memberForm.addEventListener("submit", saveMember);
  el.memberCell.addEventListener("change", () => {
    el.quickCellMove.value = el.memberCell.value;
  });
  el.attendanceModeTabs.addEventListener("click", (event) => {
    const button = closestElement(event.target, "[data-attendance-mode]");
    if (button) setAttendanceMarkMode(button.dataset.attendanceMode);
  });
  el.quickCellMove.addEventListener("change", () => {
    el.memberCell.value = el.quickCellMove.value;
  });
  el.quickCellMoveBtn.addEventListener("click", moveSelectedMemberCell);
  el.taskSaveBtn.addEventListener("click", saveCareTask);
  el.taskCancelBtn.addEventListener("click", resetCareTaskEditor);
  el.taskList.addEventListener("click", handleCareTaskListClick);
  el.prayerSaveBtn.addEventListener("click", savePrayerTopic);
  el.prayerCancelBtn.addEventListener("click", resetPrayerEditor);
  el.prayerFilters.addEventListener("click", (event) => {
    const button = closestElement(event.target, "[data-prayer-filter]");
    if (!button) return;
    state.prayerFilter = button.dataset.prayerFilter || "praying";
    renderPrayerTopics();
  });
  el.prayerList.addEventListener("click", handlePrayerTopicListClick);
  el.timelineRefreshBtn.addEventListener("click", () => loadMemberTimeline(state.selectedMemberId, true));
  el.timelineFilters.addEventListener("click", (event) => {
    const button = closestElement(event.target, "[data-timeline-filter]");
    if (!button) return;
    state.timelineFilter = button.dataset.timelineFilter || "all";
    renderMemberTimeline();
  });
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
  window.open("/annual-report.html", "_blank", "noopener");
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
  state.careTasks = local.careTasks || [];
  state.prayerTopics = local.prayerTopics || [];
  state.attendanceSessions = local.attendanceSessions;
  state.selectedCellId = local.selectedCellId || "";
  state.showArchived = Boolean(local.showArchived);
  el.showArchived.checked = state.showArchived;

  try {
    const response = await fetch("/api/bootstrap", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("api unavailable");
    const data = await response.json();
    state.viewer = { ...state.viewer, ...(data.viewer || {}) };
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
      state.careTasks = data.careTasks || [];
      state.prayerTopics = data.prayerTopics || [];
      state.apiOnline = true;
    }
  } catch {
    state.apiOnline = false;
  }
}

function readLocal() {
  const ui = readLocalUi();
  if (D1_REQUIRED) {
    return {
      settings: { communityTitle: DEFAULT_COMMUNITY_TITLE },
      cells: structuredClone(INITIAL_CELLS),
      members: [],
      visits: [],
      careTasks: [],
      prayerTopics: [],
      attendanceSessions: [],
      selectedCellId: ui.selectedCellId || INITIAL_CELLS[0]?.id || "",
      showArchived: ui.showArchived
    };
  }
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
        careTasks: saved.careTasks || [],
        prayerTopics: saved.prayerTopics || [],
        attendanceSessions: saved.attendanceSessions || [],
        selectedCellId: ui.selectedCellId || saved.selectedCellId || "",
        showArchived: ui.showArchived || saved.showArchived || false
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
    visits: structuredClone(INITIAL_VISITS),
    careTasks: [],
    prayerTopics: [],
    attendanceSessions: [],
    selectedCellId: ui.selectedCellId || INITIAL_CELLS[0]?.id || "",
    showArchived: ui.showArchived
  };
}

function readLocalUi() {
  try {
    const saved = JSON.parse(localStorage.getItem(UI_STORE_KEY) || "null");
    return {
      selectedCellId: saved?.selectedCellId || "",
      showArchived: Boolean(saved?.showArchived)
    };
  } catch {
    localStorage.removeItem(UI_STORE_KEY);
    return { selectedCellId: "", showArchived: false };
  }
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
  if (D1_REQUIRED) {
    localStorage.setItem(UI_STORE_KEY, JSON.stringify({
      selectedCellId: state.selectedCellId,
      showArchived: state.showArchived
    }));
    return;
  }
  localStorage.setItem(STORE_KEY, JSON.stringify({
    settings: state.settings,
    cells: state.cells,
    members: state.members,
    visits: state.visits,
    careTasks: state.careTasks,
    prayerTopics: state.prayerTopics,
    attendanceSessions: state.attendanceSessions,
    selectedCellId: state.selectedCellId,
    showArchived: state.showArchived
  }));
}

function ensureWritableStore() {
  if (!D1_REQUIRED || state.apiOnline) return true;
  toast("D1 연결이 없어 저장하지 않았습니다. 잠시 후 다시 시도해주세요.");
  return false;
}

function handleRequiredD1Failure() {
  if (!D1_REQUIRED) return;
  toast("D1 저장에 실패했습니다. 최신 데이터를 다시 불러옵니다.");
  window.setTimeout(() => window.location.reload(), 900);
}

function render() {
  renderViewerAccess();
  renderCommunityTitle();
  renderCellTabs();
  renderCellSelect();
  renderMembers();
  renderDetail();
  updateMobileDetailState();
  renderAlarmNotifications();
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
  const optionsHtml = state.cells
    .map((cell) => `<option value="${cell.id}">${escapeHtml(cell.name)} ${escapeHtml(cell.meta || "")}</option>`)
    .join("");
  el.memberCell.innerHTML = optionsHtml;
  el.quickCellMove.innerHTML = optionsHtml;
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
    const importPending = D1_REQUIRED && state.apiOnline && !isSearching && state.members.length === 0;
    const emptyTitle = importPending ? "D1 성도 데이터 import 필요" : (isSearching ? "\uAC80\uC0C9 \uACB0\uACFC \uC5C6\uC74C" : "\uACB0\uACFC \uC5C6\uC74C");
    const emptyHint = importPending ? "셀과 사진 저장소는 연결됐고, 성도/심방 데이터만 아직 D1에 없습니다" : (isSearching ? "\uC774\uB984, \uC804\uD654, \uC9D1\uC804\uD654, \uAC00\uC871/\uC790\uB140\uBA54\uBAA8\uB97C \uD655\uC778\uD558\uC138\uC694" : "\uAC80\uC0C9 \uC870\uAC74\uC744 \uC870\uC815\uD558\uC138\uC694");
    el.memberGrid.classList.remove("sectioned");
    el.memberGrid.innerHTML = `<div class="member-card member-empty-card"><span class="member-name">${emptyTitle}</span><span class="member-sub">${emptyHint}</span></div>`;
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
  const displayTitle = title || MISSING_COMMUNITY_TITLE;
  if (el.communityTitleText) {
    el.communityTitleText.textContent = displayTitle;
    el.communityTitleText.classList.toggle("missing-title", !title);
  }
  document.title = "목양웹";
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

async function exportCareReport(kind, scope = "member") {
  const button = reportActionButton(kind, scope);
  const label = button.querySelector("span");
  const originalLabel = label?.textContent || "";
  let printWindow = null;
  button.disabled = true;
  if (label) label.textContent = "준비";
  try {
    if (kind === "print") {
      printWindow = window.open("", "_blank");
      if (!printWindow) throw new Error("출력 창이 차단되었습니다. 팝업을 허용해주세요");
      printWindow.document.write("<p>출력 자료를 준비하는 중입니다.</p>");
    }
    const report = await buildCareReport(scope);
    if (kind === "print") {
      printCareReport(report.html, printWindow);
      toast("출력 창을 열었습니다");
    } else {
      downloadWordDocument(report.html, report.fileName);
      toast("워드 파일을 만들었습니다");
    }
  } catch (error) {
    if (printWindow && !printWindow.closed) printWindow.close();
    toast(error.message || "자료를 만들지 못했습니다");
  } finally {
    button.disabled = false;
    if (label) label.textContent = originalLabel;
  }
}

function reportActionButton(kind, scope) {
  const buttons = {
    "member:word": el.memberWordBtn,
    "member:print": el.memberPrintBtn,
    "cell:word": el.cellWordBtn,
    "cell:print": el.cellPrintBtn,
    "all:word": el.allWordBtn,
    "all:print": el.allPrintBtn
  };
  return buttons[`${scope}:${kind}`] || el.memberWordBtn;
}

async function buildCareReport(scope) {
  const selection = careReportSelection(scope);
  if (!selection.members.length) throw new Error("내보낼 성도 자료가 없습니다");

  const preparedMembers = [];
  for (const member of selection.members) {
    preparedMembers.push({
      member,
      photoSrc: await memberPhotoDataUrl(member),
      visits: memberReportVisits(member.id)
    });
  }

  const generatedAt = new Date().toLocaleString("ko-KR");
  const title = `${selection.title} 목양자료`;
  return {
    title,
    fileName: `${safeFileName(title)}_${localDateString(new Date())}.doc`,
    html: careReportHtml({ ...selection, title, generatedAt }, preparedMembers)
  };
}

function careReportSelection(scope) {
  const selected = selectedMember();
  const selectedSnapshot = selected ? currentMemberReportSnapshot(selected) : null;

  if (scope === "member") {
    if (!selectedSnapshot) throw new Error("성도를 먼저 선택하세요");
    return {
      scope,
      title: selectedSnapshot.name || "성도",
      members: [selectedSnapshot]
    };
  }

  const reportable = state.members
    .filter((member) => !member.trashedAt && !isDraftMember(member))
    .map((member) => selectedSnapshot && member.id === selectedSnapshot.id ? selectedSnapshot : member);

  if (scope === "cell") {
    const cellId = selectedSnapshot?.cellId || state.selectedCellId;
    const cell = state.cells.find((item) => item.id === cellId);
    return {
      scope,
      cellId,
      title: cell ? cell.name : "현재 셀",
      members: reportable
        .filter((member) => member.cellId === cellId)
        .sort((a, b) => compareMembersForDisplay(a, b, false))
    };
  }

  return {
    scope: "all",
    title: "전체",
    members: reportable.sort((a, b) => compareMembersForDisplay(a, b, true))
  };
}

function currentMemberReportSnapshot(member) {
  if (!member || member.id !== state.selectedMemberId || el.memberForm.classList.contains("hidden")) return member;
  const birthDate = formatBirthDateInput(el.memberBirth.value);
  const registeredAt = formatDateInputValue(el.memberRegisteredAt.value);
  return {
    ...member,
    name: el.memberName.value.trim() || member.name || "",
    title: el.memberTitle.value.trim() || member.title || "",
    cellId: el.memberCell.value || member.cellId || "",
    role: el.memberRole.value || member.role || "",
    phone: formatPhoneNumber(el.memberPhone.value, "mobile"),
    homePhone: formatPhoneNumber(el.memberHomePhone.value, "landline"),
    birth: buildBirthValue(birthDate, el.memberBirthCalendar.value === "lunar", member.birth),
    registeredAt,
    baptized: el.memberBaptismStatus.value === "1",
    address: el.memberAddress.value.trim(),
    longAbsent: el.memberLongAbsent.checked,
    memo: el.memberMemo.value.trim(),
    prayerRequests: member.prayerRequests || ""
  };
}

async function memberPhotoDataUrl(member) {
  const src = member.photoUrl || (member.photoKey ? `/api/photos/${encodeURIComponent(member.photoKey)}` : "");
  if (!src) return "";
  if (src.startsWith("data:")) return src;
  try {
    const response = await fetch(src, { credentials: "same-origin" });
    if (!response.ok) return "";
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) return "";
    return await fileToDataUrl(blob);
  } catch {
    return "";
  }
}

function memberReportVisits(memberId) {
  return state.visits
    .filter((visit) => visit.memberId === memberId && !visitTrashedAt(visit))
    .sort((a, b) => `${b.visitDate || ""}${b.createdAt || ""}`.localeCompare(`${a.visitDate || ""}${a.createdAt || ""}`));
}

function careReportHtml(report, preparedMembers) {
  const groups = careReportGroups(report, preparedMembers);
  let memberIndex = 0;
  const groupHtml = groups.map((group) => `
    ${report.scope === "all" ? `<h2 class="group-title">${escapeHtml(group.title)}</h2>` : ""}
    ${group.members.map((item) => memberReportHtml(item.member, item.photoSrc, item.visits, memberIndex++ === 0)).join("")}
  `).join("");

  return `<!doctype html>
<html lang="ko" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(report.title)}</title>
    <style>
      @page { size: A4; margin: 16mm 14mm; }
      body { margin: 0; color: #211f1b; font-family: "Malgun Gothic", "Apple SD Gothic Neo", Arial, sans-serif; font-size: 10.5pt; line-height: 1.45; }
      .cover { margin: 0 0 14pt; padding-bottom: 9pt; border-bottom: 2pt solid #23746b; }
      h1 { margin: 0 0 5pt; font-size: 20pt; }
      h2.group-title { margin: 18pt 0 8pt; color: #8c2f24; font-size: 13pt; page-break-before: always; page-break-after: avoid; }
      .cover + h2.group-title { page-break-before: auto; }
      h2.group-title + .member-report { page-break-before: auto; }
      .meta { color: #6f665b; font-size: 9pt; }
      .member-report { padding-top: 4pt; page-break-before: always; }
      .member-report.first { page-break-before: auto; }
      .member-head { width: 100%; border-collapse: collapse; margin-bottom: 10pt; }
      .photo-cell { width: 34mm; vertical-align: top; padding-right: 10pt; }
      .photo { width: 30mm; height: 38mm; object-fit: cover; border: 1pt solid #c8b89c; }
      .photo-placeholder { width: 30mm; height: 38mm; display: table-cell; vertical-align: middle; text-align: center; border: 1pt solid #c8b89c; background: #f5efe4; color: #7a705f; font-size: 16pt; font-weight: 700; }
      .member-name { margin: 0; font-size: 18pt; }
      .member-sub { margin: 4pt 0 0; color: #6f665b; }
      table.info { width: 100%; border-collapse: collapse; margin: 6pt 0 10pt; }
      table.info th, table.info td { border: 1pt solid #d9c9b3; padding: 5pt 6pt; vertical-align: top; }
      table.info th { width: 24%; background: #f6efe3; color: #594f44; text-align: left; }
      .section { margin: 10pt 0; page-break-inside: auto; }
      .section h3 { margin: 0 0 5pt; color: #23746b; font-size: 12pt; }
      .box { min-height: 20pt; border: 1pt solid #d9c9b3; padding: 7pt; white-space: pre-wrap; }
      .visit { margin: 0 0 7pt; border: 1pt solid #d9c9b3; padding: 7pt; page-break-inside: avoid; }
      .visit strong { color: #4b4035; }
      .visit p { margin: 4pt 0 0; white-space: pre-wrap; }
      .empty { color: #8b8173; }
    </style>
  </head>
  <body>
    <div class="cover">
      <h1>${escapeHtml(report.title)}</h1>
      <div class="meta">생성일: ${escapeHtml(report.generatedAt)} · 인원: ${preparedMembers.length}명 · 범위: ${escapeHtml(reportScopeLabel(report.scope))}</div>
    </div>
    ${groupHtml}
  </body>
</html>`;
}

function careReportGroups(report, preparedMembers) {
  if (report.scope !== "all") return [{ title: report.title, members: preparedMembers }];

  const byCell = new Map();
  for (const item of preparedMembers) {
    const cellId = item.member.cellId || "unknown";
    if (!byCell.has(cellId)) byCell.set(cellId, []);
    byCell.get(cellId).push(item);
  }

  const groups = state.cells
    .filter((cell) => byCell.has(cell.id))
    .map((cell) => ({ title: cell.name, members: byCell.get(cell.id) }));
  if (byCell.has("unknown")) groups.push({ title: "셀 없음", members: byCell.get("unknown") });
  return groups;
}

function memberReportHtml(member, photoSrc, visits, isFirst = false) {
  const fields = memberReportFields(member);
  const prayerTopics = memberPrayerTopics(member.id);
  const careTasks = memberCareTasks(member.id);
  const photoHtml = photoSrc
    ? `<img class="photo" src="${escapeAttribute(photoSrc)}" alt="${escapeAttribute(member.name || "성도 사진")}">`
    : `<div class="photo-placeholder">${escapeHtml(initials(member.name))}</div>`;
  const firstClass = isFirst ? " first" : "";
  return `<section class="member-report${firstClass}">
    <table class="member-head">
      <tr>
        <td class="photo-cell">${photoHtml}</td>
        <td>
          <h2 class="member-name">${escapeHtml(member.name || "이름 없음")}</h2>
          <p class="member-sub">${escapeHtml([member.title || "청년", memberCellLabel(member)].filter(Boolean).join(" · "))}</p>
        </td>
      </tr>
    </table>
    <table class="info">
      ${fields.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeMultilineHtml(value || "-")}</td></tr>`).join("")}
    </table>
    <div class="section">
      <h3>가족/메모</h3>
      <div class="box">${escapeMultilineHtml(member.memo || "기록 없음")}</div>
    </div>
    <div class="section">
      <h3>기도제목 ${prayerTopics.length}건</h3>
      ${prayerTopics.length ? prayerTopics.map(prayerReportHtml).join("") : '<p class="empty">기록 없음</p>'}
    </div>
    <div class="section">
      <h3>후속 돌봄 ${careTasks.length}건</h3>
      ${careTasks.length ? careTasks.map(careTaskReportHtml).join("") : '<p class="empty">기록 없음</p>'}
    </div>
    <div class="section">
      <h3>심방내역 ${visits.length}건</h3>
      ${visits.length ? visits.map(visitReportHtml).join("") : '<p class="empty">기록 없음</p>'}
    </div>
  </section>`;
}

function prayerReportHtml(topic) {
  const status = { praying: "기도 중", answered: "응답됨", closed: "종료" }[topic.status] || "기도 중";
  return `<article class="visit">
    <strong>${escapeHtml([status, topic.priority === "urgent" ? "긴급" : ""].filter(Boolean).join(" · "))}</strong>
    <p>${escapeMultilineHtml(topic.content || "")}</p>
    ${topic.answeredNote ? `<p>응답: ${escapeMultilineHtml(topic.answeredNote)}</p>` : ""}
  </article>`;
}

function careTaskReportHtml(task) {
  return `<article class="visit">
    <strong>${escapeHtml([task.dueDate, task.status === "completed" ? "완료" : "예정", task.assignee].filter(Boolean).join(" · "))}</strong>
    <p>${escapeMultilineHtml(task.title || "")}</p>
    ${task.note ? `<p>${escapeMultilineHtml(task.note)}</p>` : ""}
  </article>`;
}

function memberReportFields(member) {
  const birth = parseBirthValue(member.birth);
  const age = birth.date ? ageLabel(birth.date) : (birth.age ? `${birth.age}세` : "");
  const birthLabel = [birth.date, birth.marker === "\uC74C" ? "음력" : "", age].filter(Boolean).join(" ");
  const status = [
    member.archivedAt ? "제적처리" : "활동",
    member.longAbsent ? "장기결석자" : "",
    isNewMember(member) ? "새가족" : ""
  ].filter(Boolean).join(" · ");
  return [
    ["셀", memberCellLabel(member) || "셀 없음"],
    ["직분", member.title || "청년"],
    ["역할", memberRoleLabel(member) || "일반"],
    ["전화번호", formatPhoneNumber(member.phone || "", "mobile")],
    ["집전화", formatPhoneNumber(member.homePhone || "", "landline")],
    ["생년월일", birthLabel],
    ["교회등록일", member.registeredAt || ""],
    ["세례", member.baptized ? "세례" : "미세례"],
    ["상태", status],
    ["주소", member.address || ""]
  ];
}

function visitReportHtml(visit) {
  const title = [visit.visitDate || "", visit.visitType || "심방"].filter(Boolean).join(" · ");
  return `<article class="visit">
    <strong>${escapeHtml(title || "심방내역")}</strong>
    <p>${escapeMultilineHtml(visitSummaryText(visit) || "내용 없음")}</p>
  </article>`;
}

function downloadWordDocument(html, fileName) {
  const blob = new Blob(["\ufeff", html], { type: "application/msword;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function printCareReport(html, printWindow) {
  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.focus();
  setTimeout(() => printWindow.print(), 350);
}

function reportScopeLabel(scope) {
  return { member: "한 사람", cell: "셀", all: "전체" }[scope] || "한 사람";
}

function escapeMultilineHtml(value) {
  return escapeHtml(value).replace(/\r?\n/g, "<br>");
}

function safeFileName(value) {
  return String(value || "목양자료")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "목양자료";
}

async function openDashboard() {
  showDashboard();
  await loadDashboardData(false);
}

function renderViewerAccess() {
  const viewer = state.viewer || {};
  el.settingsBtn.classList.toggle("hidden", !viewer.canManageSettings);
  el.memoCenterBtn.classList.toggle("hidden", !viewer.canUseMemos);
  el.addMemberBtn.classList.toggle("hidden", !viewer.canEdit);
  el.attendanceSaveBtn.classList.toggle("hidden", !viewer.canEdit);
  el.archiveBtn.classList.toggle("access-hidden", !viewer.canEdit);
  el.restoreBtn.classList.toggle("access-hidden", !viewer.canEdit);
  el.deleteBtn.classList.toggle("access-hidden", !viewer.canEdit || !["owner", "pastor"].includes(viewer.role));
  el.taskSection.classList.toggle("readonly-section", !viewer.canEdit);
  el.prayerSection.classList.toggle("hidden", !viewer.canViewSensitive);
  el.openVisitRecordBtn.classList.toggle("hidden", !viewer.canEdit || !viewer.canViewSensitive);
}

function showDashboard() {
  el.dashboardModal.classList.remove("hidden");
  el.dashboardModal.setAttribute("aria-hidden", "false");
  renderDashboard();
}

function closeDashboard() {
  el.dashboardModal.classList.add("hidden");
  el.dashboardModal.setAttribute("aria-hidden", "true");
}

async function loadDashboardData(showFeedback = false) {
  if (!state.apiOnline) {
    if (showFeedback) toast("D1 연결 후 대시보드를 불러올 수 있습니다");
    return;
  }
  el.dashboardRefreshBtn.disabled = true;
  if (!state.dashboard) el.dashboardStatus.textContent = "목양 현황을 불러오는 중입니다";
  try {
    const response = await fetch("/api/dashboard", { headers: { Accept: "application/json" } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "대시보드를 불러오지 못했습니다");
    state.dashboard = data;
    updateDashboardBadge();
    renderDashboard();
    if (showFeedback) toast("목양 현황을 새로고침했습니다");
  } catch (error) {
    el.dashboardStatus.textContent = error.message || "대시보드를 불러오지 못했습니다";
    if (showFeedback) toast(el.dashboardStatus.textContent);
  } finally {
    el.dashboardRefreshBtn.disabled = false;
  }
}

function updateDashboardBadge() {
  const summary = state.dashboard?.summary || {};
  const count = Number(summary.birthdays || 0)
    + Number(summary.newFamilies || 0)
    + Number(summary.attendanceRisks || 0)
    + Number(summary.overdueTasks || 0)
    + Number(summary.urgentPrayers || 0);
  el.dashboardBadge.textContent = count > 99 ? "99+" : String(count);
  el.dashboardBadge.classList.toggle("hidden", count < 1);
}

function renderDashboard() {
  const dashboard = state.dashboard;
  if (!dashboard) {
    el.dashboardSummary.innerHTML = "";
    el.dashboardContent.innerHTML = '<p class="dashboard-empty">목양 현황을 불러오는 중입니다.</p>';
    return;
  }

  const summaryItems = [
    ["dashboardBirthdays", "오늘 생일", dashboard.summary.birthdays],
    ["dashboardNewFamilies", "새가족 미연락", dashboard.summary.newFamilies],
    ["dashboardAttendance", "연속 결석", dashboard.summary.attendanceRisks],
    ["dashboardCareGaps", "심방 공백", dashboard.summary.careGaps],
    ["dashboardTasks", "기한 지난 일정", dashboard.summary.overdueTasks],
    ["dashboardPrayers", "긴급 기도", dashboard.summary.urgentPrayers]
  ];
  el.dashboardSummary.innerHTML = summaryItems.map(([target, label, count]) => `
    <button data-dashboard-target="${target}" type="button">
      <strong>${Number(count || 0)}명</strong>
      <span>${escapeHtml(label)}</span>
    </button>`).join("");
  el.dashboardStatus.textContent = `${formatKoreanDateLabel(dashboard.today)} 기준 · 관심 성도 ${Number(dashboard.summary.attentionMembers || 0)}명`;

  const birthdayRows = (dashboard.birthdays || []).map((member) => dashboardMemberRowHtml(
    member,
    member.daysUntil === 0 ? "오늘 생일" : `${member.daysUntil}일 후 생일`,
    member.daysUntil === 0 ? "오늘" : `D-${member.daysUntil}`
  ));
  const newFamilyRows = (dashboard.newFamilies || []).map((member) => dashboardMemberRowHtml(
    member,
    `등록 ${formatShortDateLabel(member.registeredAt)} · 아직 돌봄 기록 없음`,
    "연락 필요"
  ));
  const attendanceRows = (dashboard.attendanceRisks || []).map((member) => dashboardMemberRowHtml(
    member,
    `${member.consecutiveAbsences}주 연속 결석${member.longAbsent ? " · 장기결석" : ""}`,
    `${member.consecutiveAbsences}주`
  ));
  const careGapRows = (dashboard.careGaps || []).map((member) => dashboardMemberRowHtml(
    member,
    member.lastVisitDate ? `마지막 심방 ${formatShortDateLabel(member.lastVisitDate)}` : "심방 기록 없음",
    member.daysSinceCare === null ? "미기록" : `${member.daysSinceCare}일`
  ));
  const taskRows = (dashboard.tasks || []).map((task) => dashboardMemberRowHtml(
    task.member,
    `${task.title}${task.assignee ? ` · ${task.assignee}` : ""}`,
    task.overdue ? `${Math.max(daysBetweenDates(task.dueDate, dashboard.today), 1)}일 지남` : formatShortDateLabel(task.dueDate)
  ));
  const prayerRows = (dashboard.urgentPrayers || []).map((topic) => dashboardMemberRowHtml(
    topic.member,
    topic.content,
    "긴급"
  ));

  el.dashboardContent.innerHTML = [
    dashboardGroupHtml("dashboardBirthdays", "생일 및 7일 이내", dashboard.birthdays?.length || 0, birthdayRows),
    dashboardGroupHtml("dashboardNewFamilies", "새가족 미연락", dashboard.newFamilies?.length || 0, newFamilyRows),
    dashboardGroupHtml("dashboardAttendance", "3주 이상 연속 결석", dashboard.attendanceRisks?.length || 0, attendanceRows,
      dashboard.attendanceSessionCount < 3 ? "출석 기록이 3주 이상 쌓이면 자동으로 표시됩니다." : ""),
    dashboardGroupHtml("dashboardCareGaps", "90일 이상 심방 공백", dashboard.careGaps?.length || 0, careGapRows),
    dashboardGroupHtml("dashboardTasks", "이번 주 후속 돌봄", dashboard.tasks?.length || 0, taskRows),
    dashboardGroupHtml("dashboardPrayers", "긴급 기도제목", dashboard.urgentPrayers?.length || 0, prayerRows)
  ].join("");
}

function dashboardGroupHtml(id, title, count, rows, emptyMessage = "해당 성도가 없습니다.") {
  const visibleRows = rows.slice(0, 24);
  return `<section class="dashboard-group" id="${id}">
    <div class="dashboard-group-head">
      <h3>${escapeHtml(title)}</h3>
      <span>${Number(count || 0)}명</span>
    </div>
    <div class="dashboard-list">
      ${visibleRows.length ? visibleRows.join("") : `<p class="dashboard-empty">${escapeHtml(emptyMessage)}</p>`}
      ${rows.length > visibleRows.length ? `<p class="dashboard-empty">외 ${rows.length - visibleRows.length}명</p>` : ""}
    </div>
  </section>`;
}

function dashboardMemberRowHtml(member, meta, badge) {
  if (!member?.id) return "";
  return `<button class="dashboard-list-item" data-dashboard-member="${escapeAttribute(member.id)}" type="button">
    ${portraitHtml(member)}
    <span>
      <strong>${memberNameHtml(member)}</strong>
      <small>${escapeHtml([member.cellName, meta].filter(Boolean).join(" · "))}</small>
    </span>
    <em>${escapeHtml(badge || "보기")}</em>
  </button>`;
}

function daysBetweenDates(fromValue, toValue) {
  const from = parseDateValue(fromValue);
  const to = parseDateValue(toValue);
  if (!from || !to) return 0;
  return Math.floor((to.getTime() - from.getTime()) / 86400000);
}

function memberCareTasks(memberId = state.selectedMemberId) {
  return state.careTasks
    .filter((task) => task.memberId === memberId && task.status !== "cancelled")
    .sort((a, b) => {
      const statusDifference = (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1);
      if (statusDifference) return statusDifference;
      return String(a.dueDate || "").localeCompare(String(b.dueDate || ""));
    });
}

function renderCareTasks() {
  const member = selectedMember();
  if (!member || isDraftMember(member)) {
    el.taskList.innerHTML = "";
    el.taskCount.textContent = "0건";
    return;
  }
  const tasks = memberCareTasks(member.id);
  const pendingCount = tasks.filter((task) => task.status === "pending").length;
  el.taskCount.textContent = `${pendingCount}건 예정`;
  if (!el.taskDueDate.value) el.taskDueDate.value = dateAfterDays(7);
  el.taskList.innerHTML = tasks.length
    ? tasks.map(careTaskRowHtml).join("")
    : '<p class="care-empty">등록된 후속 돌봄 일정이 없습니다.</p>';
}

function careTaskRowHtml(task) {
  const completed = task.status === "completed";
  const overdue = !completed && task.dueDate < today();
  const dateLabel = formatShortDateLabel(task.dueDate);
  return `<article class="care-record-row ${completed ? "completed" : ""}">
    <div class="care-record-main">
      <strong>${escapeHtml(task.title)}</strong>
      <small>${escapeHtml([dateLabel, task.assignee ? `담당 ${task.assignee}` : "", overdue ? "기한 지남" : completed ? "완료" : "예정"].filter(Boolean).join(" · "))}</small>
      ${task.note ? `<p>${escapeMultilineHtml(task.note)}</p>` : ""}
    </div>
    <div class="care-record-actions">
      <button class="primary-action" data-task-action="${completed ? "reopen" : "complete"}" data-task-id="${escapeAttribute(task.id)}" type="button">${completed ? "다시 열기" : "완료"}</button>
      <button data-task-action="edit" data-task-id="${escapeAttribute(task.id)}" type="button">수정</button>
      <button class="danger-action" data-task-action="delete" data-task-id="${escapeAttribute(task.id)}" type="button">삭제</button>
    </div>
  </article>`;
}

async function saveCareTask() {
  const member = selectedMember();
  if (!member || isDraftMember(member) || !ensureWritableStore()) return;
  const title = el.taskTitle.value.trim();
  const dueDate = normalizeDateInput(el.taskDueDate.value);
  if (!title || !dueDate) {
    toast("예정일과 후속 돌봄 내용을 입력하세요");
    (!dueDate ? el.taskDueDate : el.taskTitle).focus();
    return;
  }

  const editing = state.careTasks.find((task) => task.id === state.editingTaskId);
  const payload = {
    memberId: member.id,
    dueDate,
    title,
    assignee: el.taskAssignee.value.trim(),
    note: el.taskNote.value.trim()
  };
  el.taskSaveBtn.disabled = true;
  try {
    const response = await writeFetch(editing ? `/api/care-tasks/${encodeURIComponent(editing.id)}` : "/api/care-tasks", {
      method: editing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const saved = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(saved.error || "후속 돌봄 일정을 저장하지 못했습니다");
    state.careTasks = editing
      ? state.careTasks.map((task) => task.id === saved.id ? saved : task)
      : [...state.careTasks, saved];
    resetCareTaskEditor();
    persist();
    renderCareTasks();
    await refreshPastoralViews(member.id);
    toast(editing ? "후속 돌봄 일정을 수정했습니다" : "후속 돌봄 일정을 추가했습니다");
  } catch (error) {
    toast(error.message || "후속 돌봄 일정을 저장하지 못했습니다");
  } finally {
    el.taskSaveBtn.disabled = false;
  }
}

function resetCareTaskEditor() {
  state.editingTaskId = "";
  el.taskDueDate.value = dateAfterDays(7);
  el.taskAssignee.value = "";
  el.taskTitle.value = "";
  el.taskNote.value = "";
  el.taskSaveBtn.textContent = "일정 추가";
  el.taskCancelBtn.classList.add("hidden");
}

function handleCareTaskListClick(event) {
  const button = closestElement(event.target, "[data-task-action]");
  if (!button) return;
  const task = state.careTasks.find((item) => item.id === button.dataset.taskId);
  if (!task) return;
  const action = button.dataset.taskAction;
  if (action === "edit") {
    state.editingTaskId = task.id;
    el.taskDueDate.value = task.dueDate || dateAfterDays(7);
    el.taskAssignee.value = task.assignee || "";
    el.taskTitle.value = task.title || "";
    el.taskNote.value = task.note || "";
    el.taskSaveBtn.textContent = "일정 저장";
    el.taskCancelBtn.classList.remove("hidden");
    el.taskTitle.focus();
    return;
  }
  if (action === "complete" || action === "reopen") {
    updateCareTaskStatus(task, action === "complete" ? "completed" : "pending");
    return;
  }
  if (action === "delete") deleteCareTask(task);
}

async function updateCareTaskStatus(task, status) {
  if (!ensureWritableStore()) return;
  try {
    const response = await writeFetch(`/api/care-tasks/${encodeURIComponent(task.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status })
    });
    const saved = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(saved.error || "일정 상태를 변경하지 못했습니다");
    state.careTasks = state.careTasks.map((item) => item.id === saved.id ? saved : item);
    renderCareTasks();
    await refreshPastoralViews(task.memberId);
    toast(status === "completed" ? "후속 돌봄을 완료했습니다" : "후속 돌봄 일정을 다시 열었습니다");
  } catch (error) {
    toast(error.message || "일정 상태를 변경하지 못했습니다");
  }
}

async function deleteCareTask(task) {
  if (!confirm("이 후속 돌봄 일정을 삭제할까요?") || !ensureWritableStore()) return;
  try {
    const response = await writeFetch(`/api/care-tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "일정을 삭제하지 못했습니다");
    state.careTasks = state.careTasks.filter((item) => item.id !== task.id);
    if (state.editingTaskId === task.id) resetCareTaskEditor();
    renderCareTasks();
    await refreshPastoralViews(task.memberId);
    toast("후속 돌봄 일정을 삭제했습니다");
  } catch (error) {
    toast(error.message || "일정을 삭제하지 못했습니다");
  }
}

function memberPrayerTopics(memberId = state.selectedMemberId) {
  return state.prayerTopics
    .filter((topic) => topic.memberId === memberId)
    .sort((a, b) => String(b.updatedAt || b.startedAt || "").localeCompare(String(a.updatedAt || a.startedAt || "")));
}

function activePrayerSummary(memberId) {
  return memberPrayerTopics(memberId)
    .filter((topic) => topic.status === "praying")
    .map((topic) => topic.content)
    .filter(Boolean)
    .join("\n\n");
}

function renderPrayerTopics() {
  const member = selectedMember();
  if (!member || isDraftMember(member)) {
    el.prayerList.innerHTML = "";
    el.prayerCount.textContent = "0건";
    return;
  }
  const topics = memberPrayerTopics(member.id);
  const activeCount = topics.filter((topic) => topic.status === "praying").length;
  const visible = state.prayerFilter === "all"
    ? topics
    : topics.filter((topic) => topic.status === state.prayerFilter);
  el.prayerCount.textContent = `${activeCount}건 기도 중`;
  Array.from(el.prayerFilters.querySelectorAll("[data-prayer-filter]")).forEach((button) => {
    button.classList.toggle("active", button.dataset.prayerFilter === state.prayerFilter);
  });
  el.prayerList.innerHTML = visible.length
    ? visible.map(prayerTopicRowHtml).join("")
    : '<p class="care-empty">이 상태의 기도제목이 없습니다.</p>';
  el.memberPrayer.value = activePrayerSummary(member.id) || member.prayerRequests || "";
}

function prayerTopicRowHtml(topic) {
  const statusLabel = { praying: "기도 중", answered: "응답됨", closed: "종료" }[topic.status] || "기도 중";
  const dateValue = topic.status === "answered" ? topic.answeredAt : topic.status === "closed" ? topic.closedAt : topic.startedAt;
  return `<article class="care-record-row ${topic.status !== "praying" ? "completed" : ""}">
    <div class="care-record-main">
      <span class="care-status-badge ${topic.priority === "urgent" ? "urgent" : topic.status === "answered" ? "answered" : ""}">${topic.priority === "urgent" ? "긴급 · " : ""}${statusLabel}</span>
      <strong>${escapeHtml(topic.content)}</strong>
      <small>${escapeHtml(formatShortDateLabel(String(dateValue || "").slice(0, 10)))}</small>
      ${topic.answeredNote ? `<p>응답: ${escapeMultilineHtml(topic.answeredNote)}</p>` : ""}
    </div>
    <div class="care-record-actions">
      ${topic.status === "praying" ? `<button class="primary-action" data-prayer-action="answer" data-prayer-id="${escapeAttribute(topic.id)}" type="button">응답</button>` : `<button class="primary-action" data-prayer-action="reopen" data-prayer-id="${escapeAttribute(topic.id)}" type="button">다시 기도</button>`}
      ${topic.status === "praying" ? `<button data-prayer-action="close" data-prayer-id="${escapeAttribute(topic.id)}" type="button">종료</button>` : ""}
      <button data-prayer-action="edit" data-prayer-id="${escapeAttribute(topic.id)}" type="button">수정</button>
      <button class="danger-action" data-prayer-action="delete" data-prayer-id="${escapeAttribute(topic.id)}" type="button">삭제</button>
    </div>
  </article>`;
}

async function savePrayerTopic() {
  const member = selectedMember();
  if (!member || isDraftMember(member) || !ensureWritableStore()) return;
  const content = el.prayerContent.value.trim();
  if (!content) {
    toast("기도제목을 입력하세요");
    el.prayerContent.focus();
    return;
  }
  const editing = state.prayerTopics.find((topic) => topic.id === state.editingPrayerId);
  const answering = Boolean(editing && state.prayerEditorMode === "answer");
  const answeredNote = el.prayerAnswerNote.value.trim();
  if (answering && !answeredNote) {
    toast("응답 또는 감사 내용을 입력하세요");
    el.prayerAnswerNote.focus();
    return;
  }
  const payload = {
    memberId: member.id,
    content,
    priority: el.prayerUrgent.checked ? "urgent" : "normal",
    ...(answering ? { status: "answered", answeredNote } : {})
  };
  el.prayerSaveBtn.disabled = true;
  try {
    const response = await writeFetch(editing ? `/api/prayer-topics/${encodeURIComponent(editing.id)}` : "/api/prayer-topics", {
      method: editing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const saved = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(saved.error || "기도제목을 저장하지 못했습니다");
    state.prayerTopics = editing
      ? state.prayerTopics.map((topic) => topic.id === saved.id ? saved : topic)
      : [...state.prayerTopics, saved];
    applyMemberPrayerResponse(member.id, saved);
    resetPrayerEditor();
    state.prayerFilter = "praying";
    renderPrayerTopics();
    await refreshPastoralViews(member.id);
    toast(answering ? "기도 응답으로 기록했습니다" : editing ? "기도제목을 수정했습니다" : "기도제목을 추가했습니다");
  } catch (error) {
    toast(error.message || "기도제목을 저장하지 못했습니다");
  } finally {
    el.prayerSaveBtn.disabled = false;
  }
}

function resetPrayerEditor() {
  state.editingPrayerId = "";
  state.prayerEditorMode = "create";
  el.prayerContent.value = "";
  el.prayerAnswerNote.value = "";
  el.prayerAnswerField.classList.add("hidden");
  el.prayerUrgent.checked = false;
  el.prayerSaveBtn.textContent = "기도제목 추가";
  el.prayerCancelBtn.classList.add("hidden");
}

function handlePrayerTopicListClick(event) {
  const button = closestElement(event.target, "[data-prayer-action]");
  if (!button) return;
  const topic = state.prayerTopics.find((item) => item.id === button.dataset.prayerId);
  if (!topic) return;
  const action = button.dataset.prayerAction;
  if (action === "edit") {
    state.editingPrayerId = topic.id;
    state.prayerEditorMode = "edit";
    el.prayerContent.value = topic.content || "";
    el.prayerAnswerNote.value = topic.answeredNote || "";
    el.prayerAnswerField.classList.add("hidden");
    el.prayerUrgent.checked = topic.priority === "urgent";
    el.prayerSaveBtn.textContent = "기도제목 저장";
    el.prayerCancelBtn.classList.remove("hidden");
    el.prayerContent.focus();
    return;
  }
  if (action === "answer") {
    state.editingPrayerId = topic.id;
    state.prayerEditorMode = "answer";
    el.prayerContent.value = topic.content || "";
    el.prayerAnswerNote.value = topic.answeredNote || "";
    el.prayerUrgent.checked = topic.priority === "urgent";
    el.prayerAnswerField.classList.remove("hidden");
    el.prayerSaveBtn.textContent = "응답 저장";
    el.prayerCancelBtn.classList.remove("hidden");
    el.prayerAnswerNote.focus();
    return;
  }
  if (action === "close") {
    if (confirm("이 기도제목을 종료할까요?")) updatePrayerTopicStatus(topic, "closed", topic.answeredNote || "");
    return;
  }
  if (action === "reopen") updatePrayerTopicStatus(topic, "praying", "");
  if (action === "delete") deletePrayerTopic(topic);
}

async function updatePrayerTopicStatus(topic, status, answeredNote) {
  if (!ensureWritableStore()) return;
  try {
    const response = await writeFetch(`/api/prayer-topics/${encodeURIComponent(topic.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, answeredNote })
    });
    const saved = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(saved.error || "기도제목 상태를 변경하지 못했습니다");
    state.prayerTopics = state.prayerTopics.map((item) => item.id === saved.id ? saved : item);
    applyMemberPrayerResponse(topic.memberId, saved);
    renderPrayerTopics();
    await refreshPastoralViews(topic.memberId);
    toast(status === "answered" ? "기도 응답으로 기록했습니다" : status === "closed" ? "기도제목을 종료했습니다" : "다시 기도 중으로 변경했습니다");
  } catch (error) {
    toast(error.message || "기도제목 상태를 변경하지 못했습니다");
  }
}

async function deletePrayerTopic(topic) {
  if (!confirm("이 기도제목을 삭제할까요?") || !ensureWritableStore()) return;
  try {
    const response = await writeFetch(`/api/prayer-topics/${encodeURIComponent(topic.id)}`, { method: "DELETE" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "기도제목을 삭제하지 못했습니다");
    state.prayerTopics = state.prayerTopics.filter((item) => item.id !== topic.id);
    applyMemberPrayerResponse(topic.memberId, result);
    if (state.editingPrayerId === topic.id) resetPrayerEditor();
    renderPrayerTopics();
    await refreshPastoralViews(topic.memberId);
    toast("기도제목을 삭제했습니다");
  } catch (error) {
    toast(error.message || "기도제목을 삭제하지 못했습니다");
  }
}

function applyMemberPrayerResponse(memberId, result) {
  if (!Object.prototype.hasOwnProperty.call(result || {}, "memberPrayerRequests")) return;
  state.members = state.members.map((member) => member.id === memberId
    ? { ...member, prayerRequests: result.memberPrayerRequests || "" }
    : member);
}

async function loadMemberTimeline(memberId, showFeedback = false) {
  if (!memberId || isDraftMember(state.members.find((member) => member.id === memberId))) return;
  state.timelineMemberId = memberId;
  state.timelineLoading = true;
  renderMemberTimeline();
  try {
    if (!state.apiOnline) throw new Error("D1 연결이 필요합니다");
    const response = await fetch(`/api/members/${encodeURIComponent(memberId)}/timeline`, { headers: { Accept: "application/json" } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "타임라인을 불러오지 못했습니다");
    if (state.timelineMemberId !== memberId) return;
    state.timelineEvents = Array.isArray(data.events) ? data.events : [];
    if (showFeedback) toast("타임라인을 새로고침했습니다");
  } catch (error) {
    if (state.timelineMemberId === memberId) state.timelineEvents = localMemberTimeline(memberId);
    if (showFeedback) toast(error.message || "타임라인을 불러오지 못했습니다");
  } finally {
    if (state.timelineMemberId === memberId) {
      state.timelineLoading = false;
      renderMemberTimeline();
    }
  }
}

function localMemberTimeline(memberId) {
  const visitEvents = state.visits
    .filter((visit) => visit.memberId === memberId && !visitTrashedAt(visit))
    .map((visit) => ({
      id: `visit:${visit.id}`,
      kind: "visit",
      date: visit.visitDate,
      sortAt: `${visit.visitDate}T12:00:00Z`,
      title: visit.visitType || "심방",
      summary: visit.summary || "",
      detail: visit.prayer || "",
      status: "recorded"
    }));
  const taskEvents = memberCareTasks(memberId).map((task) => ({
    id: `task:${task.id}`,
    kind: "task",
    date: task.status === "completed" && task.completedAt ? task.completedAt.slice(0, 10) : task.dueDate,
    sortAt: task.completedAt || `${task.dueDate}T12:00:00Z`,
    title: task.status === "completed" ? "후속 돌봄 완료" : "후속 돌봄",
    summary: task.title,
    detail: task.note || "",
    status: task.status
  }));
  const prayerEvents = memberPrayerTopics(memberId).map((topic) => ({
    id: `prayer:${topic.id}`,
    kind: "prayer",
    date: String(topic.answeredAt || topic.closedAt || topic.startedAt || "").slice(0, 10),
    sortAt: topic.answeredAt || topic.closedAt || topic.updatedAt || topic.startedAt,
    title: topic.status === "answered" ? "기도 응답" : topic.status === "closed" ? "기도 종료" : "기도 중",
    summary: topic.content,
    detail: topic.answeredNote || "",
    status: topic.status,
    priority: topic.priority
  }));
  return [...visitEvents, ...taskEvents, ...prayerEvents]
    .sort((a, b) => String(b.sortAt || b.date).localeCompare(String(a.sortAt || a.date)));
}

function renderMemberTimeline() {
  const member = selectedMember();
  if (!member || isDraftMember(member)) {
    el.timelineList.innerHTML = "";
    el.timelineCount.textContent = "0건";
    return;
  }
  Array.from(el.timelineFilters.querySelectorAll("[data-timeline-filter]")).forEach((button) => {
    button.classList.toggle("active", button.dataset.timelineFilter === state.timelineFilter);
  });
  if (state.timelineLoading && state.timelineMemberId === member.id) {
    el.timelineList.innerHTML = '<p class="timeline-loading">타임라인을 불러오는 중입니다.</p>';
    return;
  }
  const events = state.timelineMemberId === member.id ? state.timelineEvents : [];
  const visible = state.timelineFilter === "all"
    ? events
    : events.filter((event) => event.kind === state.timelineFilter);
  el.timelineCount.textContent = `${events.length}건`;
  el.timelineList.innerHTML = visible.length
    ? visible.map(timelineItemHtml).join("")
    : '<p class="care-empty">이 종류의 기록이 없습니다.</p>';
}

function timelineItemHtml(event) {
  const kindLabel = { visit: "심방", attendance: "출석", prayer: "기도", task: "후속", cell: "셀 이동" }[event.kind] || "기록";
  const statusClass = event.priority === "urgent" ? " urgent" : "";
  return `<article class="timeline-item">
    <time class="timeline-date">${escapeHtml(formatShortDateLabel(event.date))}</time>
    <div class="timeline-body">
      <span class="timeline-kind${statusClass}">${escapeHtml(kindLabel)}</span>
      <strong>${escapeHtml(event.title || kindLabel)}</strong>
      ${event.summary ? `<p>${escapeMultilineHtml(event.summary)}</p>` : ""}
      ${event.detail ? `<p>${escapeMultilineHtml(event.detail)}</p>` : ""}
    </div>
  </article>`;
}

async function refreshPastoralViews(memberId) {
  persist();
  await Promise.all([
    loadMemberTimeline(memberId),
    loadDashboardData(false)
  ]);
}

function schedulePastoralRefresh(memberId) {
  if (state.timelineMemberId === memberId) {
    state.timelineEvents = localMemberTimeline(memberId);
    renderMemberTimeline();
  }
  window.setTimeout(() => {
    loadMemberTimeline(memberId).catch(() => {});
    loadDashboardData(false).catch(() => {});
  }, 450);
}

function dateAfterDays(dayOffset) {
  const date = parseDateValue(today()) || new Date();
  date.setDate(date.getDate() + Number(dayOffset || 0));
  return localDateString(date);
}

function selectMember(memberId) {
  const member = state.members.find((item) => item.id === memberId);
  if (member?.cellId) state.selectedCellId = member.cellId;
  state.selectedMemberId = memberId;
  state.mode = "view";
  state.pendingPhotoData = null;
  state.editingVisitId = "";
  state.editingTaskId = "";
  state.editingPrayerId = "";
  state.timelineEvents = [];
  state.timelineMemberId = "";
  state.timelineFilter = "all";
  state.prayerFilter = "praying";
  resetCareTaskEditor();
  resetPrayerEditor();
  state.visitListCollapsed = isMobileView();
  state.visitListPageOpen = false;
  state.expandedVisitId = "";
  state.showVisitTrash = false;
  persist();
  renderCellTabs();
  renderMembers();
  renderDetail();
  scrollToSelectedDetail();
  loadMemberTimeline(memberId).catch(() => {});
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
  el.quickCellMove.value = member.cellId || state.selectedCellId;
  el.quickCellMove.disabled = isDraftMember(member);
  el.quickCellMoveBtn.disabled = isDraftMember(member);
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
  el.memberPrayer.value = activePrayerSummary(member.id) || member.prayerRequests || "";
  el.profileDetails.open = false;
  hideVisitRecord();
  el.archiveBtn.classList.toggle("hidden", Boolean(member.archivedAt));
  el.restoreBtn.classList.toggle("hidden", !member.archivedAt);
  el.deleteBtn.classList.toggle("hidden", isDraftMember(member));
  const draft = isDraftMember(member);
  el.taskSection.classList.toggle("hidden", draft);
  el.prayerSection.classList.toggle("hidden", draft);
  el.timelineSection.classList.toggle("hidden", draft);
  renderCareTasks();
  renderPrayerTopics();
  renderMemberTimeline();
  renderVisits(member.id);
  updateMobileDetailState();
}

function startNewMember() {
  if (!ensureWritableStore()) return;
  const draft = state.members.find(isDraftMember);
  if (draft) {
    state.selectedCellId = draft.cellId || state.selectedCellId;
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
  const member = selectedMember();
  if (!member) return;
  if (!ensureWritableStore()) return;

  const wasNew = isDraftMember(member);
  const previousMember = structuredClone(member);
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
      if (D1_REQUIRED) {
        Object.assign(member, previousMember);
        state.pendingPhotoData = null;
        state.pendingPhotoFile = null;
        render();
        handleRequiredD1Failure();
        return;
      }
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
  if (state.apiOnline) await refreshPastoralViews(member.id);
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

async function moveSelectedMemberCell() {
  const member = selectedMember();
  if (!member) return;
  if (isDraftMember(member)) {
    toast("신규 성도는 저장 후 셀 이동하세요");
    return;
  }
  if (!ensureWritableStore()) return;

  const nextCellId = el.quickCellMove.value;
  if (!state.cells.some((cell) => cell.id === nextCellId)) {
    toast("이동할 셀을 선택하세요");
    return;
  }
  if (nextCellId === member.cellId) {
    toast("이미 선택한 셀입니다");
    return;
  }

  const previousCellId = member.cellId;
  const previousSelectedCellId = state.selectedCellId;
  el.quickCellMoveBtn.disabled = true;
  try {
    if (state.apiOnline) {
      const saved = await moveMemberCellToApi(member.id, nextCellId);
      Object.assign(member, saved);
    } else {
      member.cellId = nextCellId;
      member.updatedAt = new Date().toISOString();
    }
    state.selectedCellId = member.cellId;
    persist();
    render();
    if (state.apiOnline) await loadMemberTimeline(member.id);
    toast("셀을 이동했습니다");
  } catch {
    state.apiOnline = false;
    member.cellId = previousCellId;
    state.selectedCellId = previousSelectedCellId;
    render();
    if (D1_REQUIRED) {
      handleRequiredD1Failure();
      return;
    }
    toast("셀 이동을 저장하지 못했습니다");
  } finally {
    el.quickCellMoveBtn.disabled = isDraftMember(selectedMember());
  }
}

async function moveMemberCellToApi(memberId, cellId) {
  const response = await writeFetch(`/api/members/${encodeURIComponent(memberId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cellId })
  });
  if (!response.ok) throw new Error("cell move failed");
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
  if (!ensureWritableStore()) return;
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
  if (!ensureWritableStore()) return;
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
  if (!ensureWritableStore()) return;
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
  if (!ensureWritableStore()) return;
  const summary = el.visitSummary.value.trim();
  if (!summary) {
    toast("요약을 입력하세요");
    el.visitSummary.focus();
    return;
  }
  if (!validateVisitAlarmForm()) return;

  if (state.editingVisitId) {
    updateVisit(member, summary);
    return;
  }

  const visit = {
    id: `visit-${crypto.randomUUID()}`,
    memberId: member.id,
    visitDate: visitDateFromForm(),
    visitType: el.visitType.value || "전화",
    summary,
    action: visitActionFromForm(),
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
  renderAlarmNotifications();
  hideVisitRecord();
  if (!el.visitDatesModal.classList.contains("hidden")) renderVisitDates();
  schedulePastoralRefresh(member.id);
  toast("심방내역이 추가되었습니다");
}

function updateVisit(member, summary) {
  if (!ensureWritableStore()) return;
  const visit = state.visits.find((item) => item.id === state.editingVisitId && item.memberId === member.id);
  if (!visit) {
    cancelVisitEdit();
    return;
  }

  const updated = {
    ...visit,
    visitDate: visitDateFromForm(),
    visitType: el.visitType.value || "전화",
    summary,
    prayer: "",
    action: visitActionFromForm(visit)
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
  renderAlarmNotifications();
  hideVisitRecord();
  if (!el.visitDatesModal.classList.contains("hidden")) renderVisitDates();
  schedulePastoralRefresh(member.id);
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
  el.cancelVisitEditBtn.classList.toggle("hidden", !editing);
  el.deleteVisitEditBtn.classList.toggle("hidden", !editing);
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
  el.visitAlarmDate.value = el.visitAlarmDate.value || el.visitDate.value || today();
  el.visitAlarmTime.value = el.visitAlarmTime.value || defaultAlarmTime();
}

function syncVisitAlarmDate() {
  if (el.visitType.value === VISIT_TYPE_ALARM && !el.visitAlarmDate.value) {
    el.visitAlarmDate.value = el.visitDate.value || today();
  }
}

function validateVisitAlarmForm() {
  if (el.visitType.value !== VISIT_TYPE_ALARM) return true;
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
    alarmAt: `${el.visitAlarmDate.value || el.visitDate.value || today()}T${el.visitAlarmTime.value}`
  });
}

function defaultAlarmTime() {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function trashEditingVisit() {
  const visitId = state.editingVisitId;
  if (!visitId) return;
  const moved = trashVisit(visitId);
  if (!moved) return;
  state.editingVisitId = "";
  resetVisitForm();
  hideVisitRecord();
}

function trashVisit(visitId) {
  const visit = state.visits.find((item) => item.id === visitId);
  const member = selectedMember();
  if (!visit || !member || visit.memberId !== member.id) return false;
  if (!ensureWritableStore()) return false;
  const ok = confirm("이 심방내역을 휴지통으로 이동할까요?");
  if (!ok) return false;
  const updated = {
    ...visit,
    action: visitActionWithMeta(visit, { trashedAt: new Date().toISOString() })
  };
  state.visits = state.visits.map((item) => item.id === updated.id ? updated : item);
  if (state.editingVisitId === updated.id) state.editingVisitId = "";
  persist();
  callApi(`/api/visit-notes/${encodeURIComponent(updated.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: updated.action })
  });
  renderVisits(member.id);
  renderAlarmNotifications();
  if (!el.visitDatesModal.classList.contains("hidden")) renderVisitDates();
  schedulePastoralRefresh(member.id);
  toast("휴지통으로 이동했습니다");
  return true;
}

function restoreVisit(visitId) {
  const visit = state.visits.find((item) => item.id === visitId);
  const member = selectedMember();
  if (!visit || !member || visit.memberId !== member.id) return;
  if (!ensureWritableStore()) return;
  const updated = {
    ...visit,
    action: visitActionWithMeta(visit, { trashedAt: "" })
  };
  state.visits = state.visits.map((item) => item.id === updated.id ? updated : item);
  persist();
  callApi(`/api/visit-notes/${encodeURIComponent(updated.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: updated.action })
  });
  renderVisits(member.id);
  renderAlarmNotifications();
  if (!el.visitDatesModal.classList.contains("hidden")) renderVisitDates();
  schedulePastoralRefresh(member.id);
  toast("심방내역을 복구했습니다");
}

function deleteVisitPermanently(visitId) {
  const visit = state.visits.find((item) => item.id === visitId);
  const member = selectedMember();
  if (!visit || !member || visit.memberId !== member.id) return;
  if (!ensureWritableStore()) return;
  const ok = confirm("휴지통의 심방내역을 완전히 삭제할까요?\n이 작업은 되돌릴 수 없습니다.");
  if (!ok) return;
  state.visits = state.visits.filter((item) => item.id !== visit.id);
  if (state.editingVisitId === visit.id) state.editingVisitId = "";
  persist();
  callApi(`/api/visit-notes/${encodeURIComponent(visit.id)}`, {
    method: "DELETE"
  });
  renderVisits(member.id);
  renderAlarmNotifications();
  if (!el.visitDatesModal.classList.contains("hidden")) renderVisitDates();
  schedulePastoralRefresh(member.id);
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
  return String(parseVisitMeta(visit).alarmAt || "").trim();
}

function visitTrashedAt(visit) {
  return String(parseVisitMeta(visit).trashedAt || "").trim();
}

function splitAlarmDateTime(alarmAt) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(alarmAt || ""));
  return { date: match?.[1] || "", time: match?.[2] || "" };
}

function parseAlarmAt(alarmAt) {
  const { date, time } = splitAlarmDateTime(alarmAt);
  if (!date || !time) return null;
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const parsed = new Date(year, month - 1, day, hour, minute);
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
    .filter((visit) => !visitTrashedAt(visit))
    .filter((visit) => {
      const alarmAt = parseAlarmAt(visitAlarmAt(visit));
      return alarmAt && alarmAt.getTime() <= now && !state.dismissedAlarmKeys.has(alarmKey(visit));
    })
    .sort((a, b) => parseAlarmAt(visitAlarmAt(a)).getTime() - parseAlarmAt(visitAlarmAt(b)).getTime());
}

function renderAlarmNotifications() {
  if (!el.alarmCenter) return;
  const alarms = dueAlarmVisits();
  el.alarmCenter.classList.toggle("hidden", !alarms.length);
  el.alarmCount.textContent = String(alarms.length);
  if (!alarms.length) {
    closeAlarmPanel();
    el.alarmList.innerHTML = "";
    return;
  }
  el.alarmList.innerHTML = alarms.map((visit) => alarmCardHtml(visit)).join("");
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

function handleAlarmListClick(event) {
  const dismissButton = closestElement(event.target, "[data-alarm-dismiss]");
  if (dismissButton) {
    const visit = state.visits.find((item) => item.id === dismissButton.dataset.alarmDismiss);
    if (visit) state.dismissedAlarmKeys.add(alarmKey(visit));
    saveDismissedAlarmKeys();
    renderAlarmNotifications();
    toast("알림을 확인했습니다");
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

async function callApi(url, options) {
  if (!state.apiOnline) return;
  try {
    const response = await writeFetch(url, options);
    if (!response.ok) throw new Error("api failed");
  } catch {
    state.apiOnline = false;
    handleRequiredD1Failure();
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
  state.attendanceMarkMode = "present";
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
      state.attendanceStatuses = Object.fromEntries(state.attendanceRecords.map((record) => [
        record.memberId,
        normalizeAttendanceMode(record.attendanceStatus, record.present)
      ]));
      state.attendancePresentIds = state.attendanceRecords
        .filter((record) => attendanceCountsAsPresent(normalizeAttendanceMode(record.attendanceStatus, record.present)))
        .map((record) => record.memberId);
      renderSundayAttendance();
      return;
    } catch {
      state.apiOnline = false;
    }
  }

  const localSession = state.attendanceSessions.find((session) => session.attendanceDate === date);
  state.attendanceRecords = Array.isArray(localSession?.records) ? localSession.records : [];
  state.attendanceStatuses = Object.fromEntries(state.attendanceRecords.map((record) => [
    record.memberId,
    normalizeAttendanceMode(record.attendanceStatus, record.present)
  ]));
  state.attendancePresentIds = state.attendanceRecords
    .filter((record) => attendanceCountsAsPresent(normalizeAttendanceMode(record.attendanceStatus, record.present)))
    .map((record) => record.memberId);
  renderSundayAttendance();
}

function renderSundayAttendance() {
  const date = state.attendanceDate || nearestSundayDate();
  const members = attendanceMembersForSelectedDate();
  const statuses = attendanceStatusMap(members);
  const presentIds = new Set(members
    .filter((member) => attendanceCountsAsPresent(statuses[member.id]))
    .map((member) => member.id));
  state.attendancePresentIds = Array.from(presentIds);
  const statusCounts = attendanceStatusCounts(members, statuses);
  const totalCount = members.length;

  el.attendanceDate.value = date;
  el.attendanceDateLabel.textContent = formatKoreanDateLabel(date);
  Array.from(el.attendanceModeTabs.querySelectorAll("[data-attendance-mode]")).forEach((button) => {
    button.classList.toggle("active", button.dataset.attendanceMode === state.attendanceMarkMode);
  });
  renderAttendanceSummary(totalCount, statusCounts);
  renderAttendanceHistory();
  renderAttendanceCellStats(members, presentIds);
  renderAttendanceMemberGrid(members, presentIds, statuses);
  renderAttendanceResults(members, statuses);
}

function renderAttendanceSummary(totalCount, statusCounts) {
  el.attendanceSummary.innerHTML = `
    <span class="attendance-summary-counts">
      <strong>출석 ${statusCounts.present}명 · 온라인 ${statusCounts.online}명</strong>
      <span>전체 ${totalCount}명 · 결석 ${statusCounts.absent}명 · 군복무/유학/기타 ${statusCounts.military + statusCounts.study + statusCounts.other}명</span>
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

  el.attendanceCellStats.innerHTML = groups.map((group) => `<span class="attendance-cell-stat">
    <strong>${escapeHtml(group.cellName)}</strong>
    ${group.present}/${group.total}명
  </span>`).join("");
}

function renderAttendanceMemberGrid(members, presentIds, statuses) {
  if (!members.length) {
    el.attendanceMemberGrid.innerHTML = '<p class="attendance-empty">출석 체크할 성도가 없습니다.</p>';
    return;
  }

  el.attendanceMemberGrid.innerHTML = groupedAttendanceMembers(members, presentIds).map((group) => `
    <section class="attendance-cell-section" data-attendance-cell-id="${escapeAttribute(group.cellId)}">
      <div class="attendance-cell-section-head">
        <strong>${escapeHtml(group.cellName)}</strong>
        <span data-attendance-cell-count>${group.present}/${group.total}명</span>
      </div>
      <div class="attendance-cell-members">
        ${attendanceCellMembersHtml(group.members, presentIds, statuses)}
      </div>
    </section>`).join("");
}

function attendanceCellMembersHtml(members, presentIds, statuses) {
  const regularMembers = members.filter((member) => !member.longAbsent);
  const longAbsentMembers = members.filter((member) => member.longAbsent);
  const sections = [];
  if (regularMembers.length) sections.push(`<div class="attendance-member-subsection">
    <div class="attendance-member-subsection-grid">
      ${regularMembers.map((member) => attendanceMemberCardHtml(member, statuses)).join("")}
    </div>
  </div>`);
  if (longAbsentMembers.length) sections.push(`<div class="attendance-member-subsection long-absent">
    <div class="attendance-member-subsection-title">
      <strong>장기결석자</strong>
      <span>${longAbsentMembers.length}명</span>
    </div>
    <div class="attendance-member-subsection-grid">
      ${longAbsentMembers.map((member) => attendanceMemberCardHtml(member, statuses)).join("")}
    </div>
  </div>`);
  return sections.join("");
}

function attendanceMemberCardHtml(member, statuses) {
  const status = normalizeAttendanceMode(statuses[member.id], false);
  const present = status === "present";
  return `<button class="attendance-member-card ${present ? "present" : ""} status-${escapeAttribute(status)} ${member.longAbsent ? "long-absent" : ""}" data-attendance-member-id="${escapeAttribute(member.id)}" type="button" aria-label="${escapeAttribute(`${member.name} ${attendanceModeLabel(status)}`)}">
    ${portraitHtml(member)}
    <span>
      <strong>${memberNameHtml(member)}</strong>
      <small>${escapeHtml([member.title, member.longAbsent ? "장기결석" : ""].filter(Boolean).join(" · "))}</small>
      ${newMemberBadgeHtml(member)}
    </span>
    <em>${escapeHtml(attendanceModeLabel(status))}</em>
  </button>`;
}

function renderAttendanceResults(members, statuses) {
  const nameLinkOptions = { linkPhones: isMobileView(), linkDetails: !isMobileView() };
  const resultSections = ATTENDANCE_MODES.map((mode) => {
    const statusMembers = members.filter((member) => normalizeAttendanceMode(statuses[member.id], false) === mode.value);
    return `<section class="attendance-result-column status-${mode.value}">
      <h3>${escapeHtml(mode.label)} ${statusMembers.length}명</h3>
      ${attendanceNamesByCellHtml(statusMembers, nameLinkOptions)}
    </section>`;
  });
  el.attendanceResults.innerHTML = `
    <div class="attendance-results-toolbar">
      <button class="icon-button text-button subtle attendance-results-top-button" data-attendance-scroll-top type="button">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 19V5M5 12l7-7 7 7"></path>
        </svg>
        <span>출석체크로</span>
      </button>
    </div>
    ${resultSections.join("")}`;
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

function normalizeAttendanceMode(value, presentFallback = false) {
  const mode = String(value || "").trim();
  if (ATTENDANCE_MODES.some((item) => item.value === mode)) return mode;
  return presentFallback ? "present" : "absent";
}

function attendanceModeLabel(value) {
  return ATTENDANCE_MODES.find((item) => item.value === value)?.label || "결석";
}

function attendanceCountsAsPresent(status) {
  return status === "present" || status === "online";
}

function attendanceStatusMap(members) {
  const recordByMember = new Map(state.attendanceRecords.map((record) => [record.memberId, record]));
  const result = {};
  members.forEach((member) => {
    const record = recordByMember.get(member.id);
    result[member.id] = normalizeAttendanceMode(
      state.attendanceStatuses[member.id] || record?.attendanceStatus,
      Boolean(record?.present)
    );
  });
  state.attendanceStatuses = result;
  return result;
}

function attendanceStatusCounts(members, statuses) {
  const counts = Object.fromEntries(ATTENDANCE_MODES.map((mode) => [mode.value, 0]));
  members.forEach((member) => {
    counts[normalizeAttendanceMode(statuses[member.id], false)] += 1;
  });
  return counts;
}

function setAttendanceMarkMode(mode) {
  if (!ATTENDANCE_MODES.some((item) => item.value === mode)) return;
  state.attendanceMarkMode = mode;
  Array.from(el.attendanceModeTabs.querySelectorAll("[data-attendance-mode]")).forEach((button) => {
    button.classList.toggle("active", button.dataset.attendanceMode === mode);
  });
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

function toggleSundayAttendanceMember(memberId, button) {
  const scrollState = captureAttendanceScroll(button);
  const current = normalizeAttendanceMode(state.attendanceStatuses[memberId], false);
  const selected = state.attendanceMarkMode || "present";
  state.attendanceStatuses = {
    ...state.attendanceStatuses,
    [memberId]: current === selected ? "absent" : selected
  };
  const members = attendanceMembersForSelectedDate();
  const statuses = attendanceStatusMap(members);
  const presentIds = new Set(members
    .filter((member) => attendanceCountsAsPresent(statuses[member.id]))
    .map((member) => member.id));
  const statusCounts = attendanceStatusCounts(members, statuses);
  const member = members.find((item) => item.id === memberId);
  state.attendancePresentIds = Array.from(presentIds);

  renderAttendanceSummary(members.length, statusCounts);
  renderAttendanceCellStats(members, presentIds);
  updateAttendanceMemberCard(button, member, statuses[memberId]);
  updateAttendanceCellSectionCount(member, groupedAttendanceMembers(members, presentIds));
  renderAttendanceResults(members, statuses);
  restoreAttendanceScroll(scrollState);
}

function updateAttendanceMemberCard(button, member, statusValue) {
  if (!button || !member) return;
  const status = normalizeAttendanceMode(statusValue, false);
  ATTENDANCE_MODES.forEach((mode) => button.classList.remove(`status-${mode.value}`));
  button.classList.toggle("present", status === "present");
  button.classList.add(`status-${status}`);
  button.setAttribute("aria-label", `${member.name} ${attendanceModeLabel(status)}`);
  const statusLabel = button.querySelector("em");
  if (statusLabel) statusLabel.textContent = attendanceModeLabel(status);
  button.blur();
}

function updateAttendanceCellSectionCount(member, groups) {
  if (!member) return;
  const group = groups.find((item) => item.cellId === member.cellId);
  if (!group) return;
  const section = Array.from(el.attendanceMemberGrid.querySelectorAll("[data-attendance-cell-id]"))
    .find((item) => item.dataset.attendanceCellId === group.cellId);
  const count = section?.querySelector("[data-attendance-cell-count]");
  if (count) count.textContent = `${group.present}/${group.total}명`;
}

function clearSundayAttendance() {
  const ok = confirm("출석 체크를 모두 해제할까요?");
  if (!ok) return;
  state.attendanceStatuses = Object.fromEntries(attendanceMembersForSelectedDate().map((member) => [member.id, "absent"]));
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

function captureAttendanceScroll(anchor) {
  const dialog = el.attendanceModal.querySelector(".attendance-dialog");
  return {
    dialog,
    dialogTop: dialog?.scrollTop || 0,
    modalTop: el.attendanceModal.scrollTop || 0,
    windowTop: window.scrollY || 0,
    anchor,
    anchorTop: anchor?.getBoundingClientRect().top
  };
}

function restoreAttendanceScroll(stateToRestore) {
  const restore = () => {
    if (stateToRestore.dialog) stateToRestore.dialog.scrollTop = stateToRestore.dialogTop;
    el.attendanceModal.scrollTop = stateToRestore.modalTop;
    window.scrollTo(window.scrollX, stateToRestore.windowTop);
    if (stateToRestore.anchor?.isConnected && Number.isFinite(stateToRestore.anchorTop)) {
      const offset = stateToRestore.anchor.getBoundingClientRect().top - stateToRestore.anchorTop;
      if (Math.abs(offset) > 0.5 && stateToRestore.dialog) {
        stateToRestore.dialog.scrollTop += offset;
      }
    }
  };
  restore();
  requestAnimationFrame(() => requestAnimationFrame(restore));
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
  if (!ensureWritableStore()) return;

  const members = attendanceMembersForSelectedDate();
  const attendanceStatuses = attendanceStatusMap(members);
  const presentMemberIds = members
    .filter((member) => attendanceCountsAsPresent(attendanceStatuses[member.id]))
    .map((member) => member.id);
  el.attendanceSaveBtn.disabled = true;
  try {
    if (state.apiOnline) {
      const response = await writeFetch("/api/sunday-attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attendanceDate,
          label: formatKoreanDateLabel(attendanceDate),
          presentMemberIds,
          attendanceStatuses
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "attendance save failed");
      state.attendanceRecords = Array.isArray(data.records) ? data.records : [];
      state.attendanceStatuses = Object.fromEntries(state.attendanceRecords.map((record) => [
        record.memberId,
        normalizeAttendanceMode(record.attendanceStatus, record.present)
      ]));
      state.attendancePresentIds = state.attendanceRecords
        .filter((record) => attendanceCountsAsPresent(normalizeAttendanceMode(record.attendanceStatus, record.present)))
        .map((record) => record.memberId);
      upsertAttendanceSession(data.session, state.attendanceRecords);
    } else {
      saveSundayAttendanceLocally(attendanceDate, attendanceStatuses);
    }
    persist();
    renderSundayAttendance();
    await loadDashboardData(false);
    toast("주일출석이 저장되었습니다");
  } catch (error) {
    if (D1_REQUIRED) {
      state.apiOnline = false;
      handleRequiredD1Failure();
      return;
    }
    toast(error.message || "주일출석을 저장하지 못했습니다");
  } finally {
    el.attendanceSaveBtn.disabled = false;
  }
}

function saveSundayAttendanceLocally(attendanceDate, attendanceStatuses) {
  const now = new Date().toISOString();
  const members = activeMembersForAttendance();
  const records = members.map((member) => {
    const attendanceStatus = normalizeAttendanceMode(attendanceStatuses[member.id], false);
    return {
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
      present: attendanceCountsAsPresent(attendanceStatus),
      attendanceStatus,
      createdAt: now,
      updatedAt: now
    };
  });
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
  state.attendanceStatuses = Object.fromEntries(records.map((record) => [record.memberId, record.attendanceStatus]));
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

function navigateToMemos(noteId = "", memberId = "", compose = false) {
  const url = new URL("/memos.html", window.location.origin);
  if (noteId) url.searchParams.set("note", noteId);
  if (memberId) url.searchParams.set("member", memberId);
  if (compose) url.searchParams.set("compose", "1");
  window.location.assign(url.toString());
}

function openSettings() {
  el.settingsForm.reset();
  el.communityTitleInput.value = cleanTitle(state.settings?.communityTitle);
  el.callNoteWebhookUrl.value = `${window.location.origin}/api/webhook/call-note`;
  el.callNoteTokenOutput.value = "";
  renderCallNoteImports();
  el.settingsModal.classList.remove("hidden");
  el.settingsModal.setAttribute("aria-hidden", "false");
  loadAutoLoginStatus();
  loadPasskeyStatus();
  loadCallNoteTokenStatus();
  loadCallNoteImports();
  renderPwaInstallState();
  loadWebPushStatus();
  startWebPushPolling();
  setTimeout(() => el.currentPassword.focus(), 0);
}

async function loadAutoLoginStatus() {
  if (!el.autoLoginStatus) return;
  el.autoLoginStatus.textContent = "이 기기의 자동 로그인 상태를 확인하는 중입니다.";
  try {
    const response = await writeFetch("/__auth/auto-login/status", {
      headers: { Accept: "application/json" }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "auto login status failed");
    const expiresAt = result.expiresAt ? new Date(result.expiresAt) : null;
    el.autoLoginStatus.textContent = result.enabled
      ? `이 기기의 자동 로그인이 켜져 있습니다. ${formatMobileDate(expiresAt)}까지 유지됩니다.`
      : "이 기기의 자동 로그인이 꺼져 있습니다. 다음 로그인에서 선택할 수 있습니다.";
    el.autoLoginRevokeBtn.disabled = !result.enabled;
  } catch (error) {
    el.autoLoginStatus.textContent = error.message || "자동 로그인 상태를 확인하지 못했습니다.";
    el.autoLoginRevokeBtn.disabled = true;
  }
}

async function revokeAutoLogin() {
  const ok = confirm("이 기기의 자동 로그인을 해제할까요?\n현재 로그인은 로그아웃할 때까지 유지됩니다.");
  if (!ok) return;
  el.autoLoginRevokeBtn.disabled = true;
  try {
    const response = await writeFetch("/__auth/auto-login/revoke", {
      method: "POST",
      headers: { Accept: "application/json" }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "auto login revoke failed");
    el.autoLoginStatus.textContent = "이 기기의 자동 로그인을 해제했습니다.";
    toast("자동 로그인을 해제했습니다");
  } catch (error) {
    el.autoLoginStatus.textContent = error.message || "자동 로그인을 해제하지 못했습니다.";
    await loadAutoLoginStatus();
  }
}

function closeSettings() {
  stopMobileNotificationPolling();
  stopWebPushPolling();
  el.settingsModal.classList.add("hidden");
  el.settingsModal.setAttribute("aria-hidden", "true");
}

function consumeTodayPastoralNotificationRoute() {
  const url = new URL(window.location.href);
  if (url.searchParams.get("open") !== "today-pastoral") return false;
  url.searchParams.delete("open");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  return true;
}

function renderPwaInstallState() {
  if (!el.pwaInstallStatus || !el.pwaInstallBtn) return;
  const pwa = window.PastoralPwa;
  if (!pwa?.supportsServiceWorker()) {
    el.pwaInstallStatus.textContent = "이 브라우저에서는 앱 설치를 지원하지 않습니다.";
    el.pwaInstallBtn.disabled = true;
    return;
  }
  if (pwa.isStandalone()) {
    el.pwaInstallStatus.textContent = "목양웹이 이 기기에 설치되어 있습니다.";
    el.pwaInstallBtn.textContent = "설치됨";
    el.pwaInstallBtn.disabled = true;
    return;
  }
  if (pwa.canPromptInstall()) {
    el.pwaInstallStatus.textContent = "이 기기의 홈 화면에 목양웹을 설치할 수 있습니다.";
    el.pwaInstallBtn.textContent = "앱 설치";
    el.pwaInstallBtn.disabled = false;
    return;
  }
  el.pwaInstallStatus.textContent = pwa.isIos()
    ? "iPhone Safari의 공유 메뉴에서 홈 화면에 추가할 수 있습니다."
    : "브라우저 메뉴에서 앱 설치 또는 홈 화면에 추가를 선택할 수 있습니다.";
  el.pwaInstallBtn.textContent = "설치 방법";
  el.pwaInstallBtn.disabled = false;
}

async function installPastoralApp() {
  const pwa = window.PastoralPwa;
  if (!pwa) return;
  el.pwaInstallBtn.disabled = true;
  try {
    const result = await pwa.install();
    if (result.status === "manual-ios") {
      alert("Safari 아래쪽의 공유 버튼을 누른 뒤 '홈 화면에 추가'를 선택하세요.");
    } else if (result.status === "manual") {
      alert("브라우저 메뉴에서 '앱 설치' 또는 '홈 화면에 추가'를 선택하세요.");
    } else if (result.status === "accepted") {
      toast("목양웹 설치를 시작했습니다");
    }
  } finally {
    renderPwaInstallState();
  }
}

async function loadWebPushStatus(options = {}) {
  if (!el.webPushStatus) return;
  if (!state.apiOnline) {
    renderWebPushError("서버 연결 상태에서 알림을 설정할 수 있습니다.");
    return;
  }
  if (!options.silent) el.webPushStatus.textContent = "알림 서버 상태를 확인하는 중입니다.";
  try {
    const [response, subscription] = await Promise.all([
      writeFetch("/api/notifications/web-push", { headers: { Accept: "application/json" } }),
      window.PastoralPwa?.getSubscription().catch(() => null) || Promise.resolve(null)
    ]);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "알림 상태를 확인하지 못했습니다.");
    state.webPush = result;
    state.webPushSubscription = subscription;
    reconcileWebPushTest(result.latestTest);
    renderWebPushSettings();
  } catch (error) {
    renderWebPushError(error.message || "알림 상태를 확인하지 못했습니다.");
  }
}

function renderWebPushSettings() {
  if (!el.webPushStatusBadge) return;
  const pwa = window.PastoralPwa;
  const result = state.webPush || {};
  const supported = Boolean(pwa?.supportsPush());
  const permission = supported ? Notification.permission : "unsupported";
  const localSubscription = Boolean(state.webPushSubscription);
  const currentDevice = Boolean(result.active && localSubscription);
  const ready = Boolean(result.ready && currentDevice);

  el.webPushStatusBadge.classList.remove("is-ready", "is-warning", "is-error");
  if (!supported) {
    el.webPushStatusBadge.textContent = "지원 안 됨";
    el.webPushStatusBadge.classList.add("is-error");
  } else if (permission === "denied") {
    el.webPushStatusBadge.textContent = "권한 차단";
    el.webPushStatusBadge.classList.add("is-error");
  } else if (ready) {
    el.webPushStatusBadge.textContent = "알림 준비됨";
    el.webPushStatusBadge.classList.add("is-ready");
  } else if (currentDevice) {
    el.webPushStatusBadge.textContent = "발송 준비 중";
    el.webPushStatusBadge.classList.add("is-warning");
  } else if (result.active) {
    el.webPushStatusBadge.textContent = "다른 기기 등록";
    el.webPushStatusBadge.classList.add("is-warning");
  } else {
    el.webPushStatusBadge.textContent = "미등록";
    el.webPushStatusBadge.classList.add("is-warning");
  }

  if (result.device) {
    const detail = [formatMobileDate(result.device.pairedAt), formatMobileDate(result.device.lastSeenAt)]
      .filter(Boolean).join(" · ");
    el.webPushDevice.innerHTML = `<div><strong>${escapeHtml(result.device.deviceName || "등록된 기기")}</strong><p>${escapeHtml(detail || "알림 기기 등록됨")}</p></div><span class="mobile-device-state">${currentDevice ? "현재 기기" : "등록 기기"}</span>`;
  } else {
    el.webPushDevice.innerHTML = '<p class="call-note-empty">등록된 알림 기기가 없습니다.</p>';
  }

  const busy = state.webPushBusy;
  const iosNeedsInstall = Boolean(pwa?.isIos() && !pwa.isStandalone());
  el.webPushRegisterBtn.disabled = busy || !supported || !result.configured
    || permission === "denied" || iosNeedsInstall;
  el.webPushTestBtn.disabled = busy || !ready;
  el.webPushUnregisterBtn.disabled = busy || !currentDevice;

  if (!supported) {
    el.webPushStatus.textContent = "이 브라우저에서는 푸시 알림을 지원하지 않습니다.";
  } else if (iosNeedsInstall) {
    el.webPushStatus.textContent = "iPhone에서는 먼저 Safari에서 홈 화면에 설치한 뒤 설치된 목양웹을 열어 등록하세요.";
  } else if (permission === "denied") {
    el.webPushStatus.textContent = "브라우저 또는 휴대폰 설정에서 목양웹 알림 권한을 허용해야 합니다.";
  } else if (!result.configured) {
    el.webPushStatus.textContent = "알림 서버 키 설정이 아직 완료되지 않았습니다.";
  } else if (ready) {
    el.webPushStatus.textContent = "메모와 심방 일정 알림을 이 기기에서 받을 수 있습니다.";
  } else if (currentDevice) {
    el.webPushStatus.textContent = "기기 등록은 완료됐으며 알림 발송 서버가 준비되는 중입니다.";
  } else if (result.active) {
    el.webPushStatus.textContent = "다른 기기가 등록되어 있습니다. 이 기기를 등록하면 기존 기기를 대신합니다.";
  } else {
    el.webPushStatus.textContent = "알림을 받을 휴대폰이나 PC에서 이 기기에 알림 등록을 누르세요.";
  }
}

async function registerWebPushDevice() {
  const pwa = window.PastoralPwa;
  if (!pwa?.supportsPush() || !state.webPush?.publicKey) return;
  if (pwa.isIos() && !pwa.isStandalone()) {
    alert("Safari의 공유 버튼에서 '홈 화면에 추가'를 선택한 뒤 설치된 목양웹에서 다시 등록하세요.");
    return;
  }
  state.webPushBusy = true;
  renderWebPushSettings();
  let subscription = null;
  try {
    subscription = await pwa.subscribe(state.webPush.publicKey);
    const platform = pwa.platform();
    const response = await writeFetch("/api/notifications/web-push/subscription", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        subscription: subscription.toJSON(),
        platform,
        deviceName: webPushDeviceName(platform)
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "이 기기를 등록하지 못했습니다.");
    state.webPush = result;
    state.webPushSubscription = subscription;
    toast("이 기기에 목양웹 알림을 등록했습니다");
  } catch (error) {
    if (error.message === "NOTIFICATION_PERMISSION_DENIED") {
      toast("알림 권한이 허용되지 않았습니다");
    } else {
      toast(error.message || "이 기기를 등록하지 못했습니다.");
    }
  } finally {
    state.webPushBusy = false;
    await loadWebPushStatus({ silent: true });
  }
}

async function unregisterWebPushDevice() {
  const pwa = window.PastoralPwa;
  const subscription = state.webPushSubscription || await pwa?.getSubscription().catch(() => null);
  if (!subscription) return;
  if (!confirm("이 기기에서 목양웹 알림을 해제할까요?")) return;
  state.webPushBusy = true;
  renderWebPushSettings();
  try {
    const response = await writeFetch("/api/notifications/web-push/subscription", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ subscription: subscription.toJSON() })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "알림 등록을 해제하지 못했습니다.");
    await pwa.unsubscribe(subscription);
    state.webPush = result;
    state.webPushSubscription = null;
    state.webPushPendingTestId = "";
    toast("이 기기의 목양웹 알림을 해제했습니다");
  } catch (error) {
    toast(error.message || "알림 등록을 해제하지 못했습니다.");
  } finally {
    state.webPushBusy = false;
    await loadWebPushStatus({ silent: true });
  }
}

async function sendWebPushTest() {
  state.webPushBusy = true;
  renderWebPushSettings();
  try {
    const response = await writeFetch("/api/notifications/web-push/test", {
      method: "POST",
      headers: { Accept: "application/json" }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "시험 알림을 예약하지 못했습니다.");
    state.webPushPendingTestId = String(result.notificationId || "");
    el.webPushStatus.textContent = "시험 알림을 예약했습니다. 보통 1분 안에 도착합니다.";
    toast("시험 알림을 예약했습니다");
  } catch (error) {
    toast(error.message || "시험 알림을 예약하지 못했습니다.");
  } finally {
    state.webPushBusy = false;
    renderWebPushSettings();
  }
}

function reconcileWebPushTest(latestTest) {
  if (!state.webPushPendingTestId || latestTest?.notificationId !== state.webPushPendingTestId) return;
  if (latestTest.sendState === "accepted") {
    state.webPushPendingTestId = "";
    toast("시험 알림을 발송했습니다");
  } else if (["dead", "cancelled", "blocked_config"].includes(latestTest.sendState)) {
    state.webPushPendingTestId = "";
    toast("시험 알림 발송에 실패했습니다. 알림 설정을 다시 확인하세요.");
  }
}

function renderWebPushError(message) {
  state.webPush = null;
  if (!el.webPushStatusBadge) return;
  el.webPushStatusBadge.textContent = "확인 필요";
  el.webPushStatusBadge.classList.remove("is-ready");
  el.webPushStatusBadge.classList.add("is-error");
  el.webPushStatus.textContent = message;
  el.webPushRegisterBtn.disabled = true;
  el.webPushTestBtn.disabled = true;
  el.webPushUnregisterBtn.disabled = true;
}

function startWebPushPolling() {
  stopWebPushPolling();
  state.webPushPollId = window.setInterval(() => {
    if (!el.settingsModal.classList.contains("hidden") && !state.webPushBusy) {
      loadWebPushStatus({ silent: true });
    }
  }, 5000);
}

function stopWebPushPolling() {
  if (state.webPushPollId) window.clearInterval(state.webPushPollId);
  state.webPushPollId = 0;
}

function webPushDeviceName(platform) {
  return {
    android: "Android 휴대폰",
    ios: "iPhone 또는 iPad",
    windows: "Windows PC",
    macos: "Mac",
    linux: "Linux PC",
    other: "웹 브라우저"
  }[platform] || "웹 브라우저";
}

async function saveCommunityTitle() {
  if (!ensureWritableStore()) return;
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
  if (!el.passkeyStatus) return;
  if (!state.apiOnline) {
    updatePasskeyStatus({ count: 0 }, "\uC11C\uBC84 \uC5F0\uACB0 \uC0C1\uD0DC\uC5D0\uC11C \uC0AC\uC6A9\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.");
    return;
  }
  el.passkeyStatus.textContent = "이 기기의 지문·얼굴 인증 상태를 확인하는 중입니다.";
  try {
    const platformAvailable = await isPlatformAuthenticatorAvailable();
    const response = await writeFetch("/api/auth/passkeys", {
      headers: { Accept: "application/json" }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "passkey status failed");
    updatePasskeyStatus(result, "", platformAvailable);
  } catch (error) {
    updatePasskeyStatus({ count: 0 }, error.message || "\uD328\uC2A4\uD0A4 \uC0C1\uD0DC\uB97C \uD655\uC778\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
  }
}

function updatePasskeyStatus(result, message = "", platformAvailable = null) {
  const count = Number(result.count || 0);
  el.passkeyStatus.textContent = message || (count
    ? `등록된 지문·얼굴 로그인 ${count}개 (생체정보는 기기에만 보관됩니다)`
    : platformAvailable === false
      ? "기기 설정에서 지문·얼굴 또는 화면잠금을 먼저 등록해주세요."
      : "등록된 지문·얼굴 로그인이 없습니다.");
  el.passkeyRegisterBtn.disabled = platformAvailable === false;
  el.passkeyClearBtn.disabled = count < 1;
}

async function registerPasskey() {
  if (!ensureWritableStore()) return;
  if (!window.PublicKeyCredential || !navigator.credentials?.create) {
    toast("\uC774 \uAE30\uAE30\uC5D0\uC11C \uD328\uC2A4\uD0A4\uB97C \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
    return;
  }

  if (!(await isPlatformAuthenticatorAvailable())) {
    el.passkeyStatus.textContent = "기기 설정에서 지문·얼굴 또는 화면잠금을 먼저 등록해주세요.";
    toast("이 기기에서 지문·얼굴 로그인을 사용할 수 없습니다");
    return;
  }

  el.passkeyRegisterBtn.disabled = true;
  el.passkeyStatus.textContent = "기기에 표시되는 창에서 지문 또는 얼굴을 확인해주세요.";
  try {
    const optionsResponse = await writeFetch("/api/auth/passkey/register-options", {
      headers: { Accept: "application/json" }
    });
    const options = await optionsResponse.json().catch(() => ({}));
    if (!optionsResponse.ok) throw new Error(options.error || "passkey options failed");

    const credential = await navigator.credentials.create({
      publicKey: hydrateCreationOptions(options.publicKey)
    });
    const registerResponse = await writeFetch("/api/auth/passkey/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        token: options.token,
        credential: serializeAttestation(credential)
      })
    });
    const result = await registerResponse.json().catch(() => ({}));
    if (!registerResponse.ok) throw new Error(result.error || "passkey register failed");
    updatePasskeyStatus(result);
    toast("지문·얼굴 로그인을 등록했습니다");
  } catch (error) {
    el.passkeyStatus.textContent = passkeyErrorMessage(error, "지문·얼굴 로그인을 등록하지 못했습니다.");
  } finally {
    el.passkeyRegisterBtn.disabled = false;
  }
}

async function clearPasskeys() {
  if (!ensureWritableStore()) return;
  const ok = confirm("등록된 지문·얼굴 로그인을 모두 삭제할까요?\n다음 로그인부터 지문·얼굴 로그인 버튼이 사라집니다.");
  if (!ok) return;

  el.passkeyClearBtn.disabled = true;
  try {
    const response = await writeFetch("/api/auth/passkeys/clear", {
      method: "POST",
      headers: { Accept: "application/json" }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "passkey clear failed");
    updatePasskeyStatus(result);
    toast("지문·얼굴 로그인 등록을 삭제했습니다");
  } catch (error) {
    el.passkeyStatus.textContent = error.message || "\uD328\uC2A4\uD0A4 \uB4F1\uB85D\uC744 \uC0AD\uC81C\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.";
  } finally {
    await loadPasskeyStatus();
  }
}

async function isPlatformAuthenticatorAvailable() {
  if (!window.PublicKeyCredential || !navigator.credentials) return false;
  const check = window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable;
  if (typeof check !== "function") return true;
  try {
    return await check.call(window.PublicKeyCredential);
  } catch {
    return false;
  }
}

function passkeyErrorMessage(error, fallback) {
  if (error?.name === "NotAllowedError") {
    return "지문·얼굴 인증이 취소되었거나 제한 시간이 지났습니다.";
  }
  if (error?.name === "InvalidStateError") {
    return "이 기기의 지문·얼굴 로그인이 이미 등록되어 있습니다.";
  }
  if (error?.name === "SecurityError") {
    return "보안 연결에서만 지문·얼굴 로그인을 등록할 수 있습니다.";
  }
  return error?.message || fallback;
}

function hydrateCreationOptions(publicKey) {
  return {
    ...publicKey,
    challenge: base64UrlToBuffer(publicKey.challenge),
    user: {
      ...publicKey.user,
      id: base64UrlToBuffer(publicKey.user.id)
    },
    excludeCredentials: (publicKey.excludeCredentials || []).map((credential) => ({
      ...credential,
      id: base64UrlToBuffer(credential.id)
    }))
  };
}

function serializeAttestation(credential) {
  const transports = typeof credential.response.getTransports === "function"
    ? credential.response.getTransports()
    : [];
  return {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment || "",
    response: {
      clientDataJSON: bufferToBase64Url(credential.response.clientDataJSON),
      attestationObject: bufferToBase64Url(credential.response.attestationObject),
      transports
    }
  };
}

function base64UrlToBuffer(value) {
  const base64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function bufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
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
  if (!ensureWritableStore()) return;
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

function relayEnrollmentReady(data) {
  if (!data || data.error) return false;
  if (data.pushTransport !== "relay") return true;
  if (data.relayEnrollment?.state) return data.relayEnrollment.state === "connected";
  return data.relayClientConfigured === true;
}

async function createRelayEnrollmentRequest() {
  const connected = state.mobileNotification?.relayEnrollment?.state === "connected";
  const label = connected ? "연결키 재발급 요청 코드" : "중앙 Relay 등록 요청 코드";
  if (!confirm(`${label}를 만들까요? 기존 미사용 요청 코드는 취소되며 새 코드는 10분 후 만료됩니다.`)) return;
  state.relayEnrollmentLoading = true;
  renderRelayEnrollmentSettings();
  try {
    const response = await writeFetch("/api/integrations/call-note/admin/relay-enrollments", {
      method: "POST",
      headers: { Accept: "application/json" }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `${label}를 만들지 못했습니다`);
    state.relayEnrollmentRequestCode = String(result.requestCode || "");
    state.relayEnrollmentRequestExpiresAt = String(result.expiresAt || "");
    await loadMobileNotificationStatus({ silent: true });
    startMobileNotificationPolling();
    toast(`${label}를 만들었습니다`);
  } catch (error) {
    el.relayEnrollmentStatus.textContent = error.message || `${label}를 만들지 못했습니다.`;
    toast(error.message || `${label}를 만들지 못했습니다`);
  } finally {
    state.relayEnrollmentLoading = false;
    renderRelayEnrollmentSettings();
  }
}

async function copyRelayEnrollmentRequestCode() {
  const code = state.relayEnrollmentRequestCode;
  if (!code) return;
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(code);
    } else {
      el.relayEnrollmentRequestCodeOutput.focus();
      el.relayEnrollmentRequestCodeOutput.select();
      if (!document.execCommand("copy")) throw new Error("copy failed");
    }
    toast("중앙 Relay 등록 요청 코드를 복사했습니다");
  } catch {
    el.relayEnrollmentRequestCodeOutput.focus();
    el.relayEnrollmentRequestCodeOutput.select();
    el.relayEnrollmentStatus.textContent = "코드가 선택되었습니다. 기기의 복사 기능으로 복사하세요.";
  }
}

function renderRelayEnrollmentSettings() {
  if (!el.relayEnrollmentStatusBadge) return;
  const result = state.mobileNotification || {};
  const enrollment = result.relayEnrollment || {};
  const connected = enrollment.state === "connected";
  const pending = enrollment.state === "pending";
  const reissuePending = connected && Boolean(enrollment.reissuePending);
  const error = !state.mobileNotification;

  el.relayEnrollmentStatusBadge.classList.remove("is-ready", "is-warning", "is-error");
  if (error) {
    el.relayEnrollmentStatusBadge.textContent = "확인 필요";
    el.relayEnrollmentStatusBadge.classList.add("is-error");
    el.relayEnrollmentSummary.textContent = "중앙 Relay 등록 상태를 확인할 수 없습니다.";
  } else if (connected) {
    el.relayEnrollmentStatusBadge.textContent = "Relay 등록 완료";
    el.relayEnrollmentStatusBadge.classList.add("is-ready");
    el.relayEnrollmentSummary.textContent = reissuePending
      ? "현재 연결은 유지되며, 새 연결키 발급을 중앙 관리자가 승인하기를 기다리고 있습니다."
      : enrollment.source === "legacy_environment"
        ? "기존 환경 연결키로 중앙 Relay에 등록되어 있습니다."
        : "중앙 Relay 등록이 완료되어 FCM 앱 연결을 사용할 수 있습니다.";
  } else if (pending) {
    el.relayEnrollmentStatusBadge.textContent = "중앙 관리자 승인 대기";
    el.relayEnrollmentStatusBadge.classList.add("is-warning");
    el.relayEnrollmentSummary.textContent = "등록 요청 코드를 중앙 관리자에게 전달하고 승인을 기다리세요.";
  } else {
    el.relayEnrollmentStatusBadge.textContent = "Relay 미등록";
    el.relayEnrollmentStatusBadge.classList.add(enrollment.errorCode ? "is-error" : "is-warning");
    el.relayEnrollmentSummary.textContent = enrollment.errorCode === "RELAY_CREDENTIAL_DECRYPT_FAILED"
      ? "저장된 Relay 연결키를 확인할 수 없습니다. 새 등록 요청 코드로 연결키를 다시 발급받으세요."
      : "등록 요청 코드를 만든 뒤 중앙 관리자에게 전달해야 합니다.";
  }

  const reissue = connected;
  el.relayEnrollmentRequestLabel.textContent = reissue
    ? "중앙 관리자에게 보낼 연결키 재발급 요청 코드"
    : "중앙 관리자에게 보낼 등록 요청 코드";
  el.relayEnrollmentRequestCreateBtn.textContent = reissue
    ? "연결키 재발급 요청 코드 만들기"
    : pending ? "새 등록 요청 코드 만들기" : "등록 요청 코드 만들기";
  el.relayEnrollmentRequestCreateBtn.disabled = state.relayEnrollmentLoading || error;
  el.relayEnrollmentRequestCodeOutput.value = state.relayEnrollmentRequestCode;
  el.relayEnrollmentRequestCopyBtn.disabled = !state.relayEnrollmentRequestCode;
  renderRelayEnrollmentRequestExpiry(enrollment);

  if (state.relayEnrollmentRequestCode) {
    el.relayEnrollmentStatus.textContent = "긴 요청 코드를 중앙 관리자에게 전달하세요. 이 코드는 FCM 앱 6자리 연결코드가 아닙니다.";
  } else if (reissuePending) {
    el.relayEnrollmentStatus.textContent = "연결키 재발급 승인 대기 중입니다. 요청 코드는 보안을 위해 다시 표시되지 않습니다.";
  } else if (pending) {
    el.relayEnrollmentStatus.textContent = "중앙 관리자 승인 대기 중입니다. 요청 코드는 보안을 위해 다시 표시되지 않습니다.";
  } else if (connected) {
    el.relayEnrollmentStatus.textContent = "등록 완료 상태입니다. 필요할 때만 연결키 재발급 요청 코드를 만드세요.";
  } else if (!error) {
    el.relayEnrollmentStatus.textContent = "로그인한 관리자만 등록 요청 코드를 만들 수 있습니다.";
  }
}

function renderRelayEnrollmentRequestExpiry(enrollment = state.mobileNotification?.relayEnrollment || {}) {
  const expiresAt = state.relayEnrollmentRequestExpiresAt || enrollment.pendingExpiresAt || "";
  if (!expiresAt) {
    el.relayEnrollmentRequestExpiry.textContent = "이 코드는 10분 동안 한 번만 사용할 수 있습니다.";
    return;
  }
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000));
  if (!seconds) {
    state.relayEnrollmentRequestCode = "";
    state.relayEnrollmentRequestExpiresAt = "";
    el.relayEnrollmentRequestCodeOutput.value = "";
    el.relayEnrollmentRequestCopyBtn.disabled = true;
    el.relayEnrollmentRequestExpiry.textContent = "등록 요청 코드가 만료되었습니다.";
    return;
  }
  el.relayEnrollmentRequestExpiry.textContent = `${Math.floor(seconds / 60)}분 ${String(seconds % 60).padStart(2, "0")}초 후 만료`;
}

function reconcileRelayEnrollmentRequestState(result) {
  const enrollment = result?.relayEnrollment || {};
  const expired = state.relayEnrollmentRequestExpiresAt
    && Date.parse(state.relayEnrollmentRequestExpiresAt) <= Date.now();
  const completed = enrollment.state === "connected" && !enrollment.reissuePending;
  if (expired || completed) {
    state.relayEnrollmentRequestCode = "";
    state.relayEnrollmentRequestExpiresAt = "";
  }
}

async function loadMobileNotificationStatus(options = {}) {
  if (!state.apiOnline) {
    renderMobileNotificationError("서버 연결 상태에서 확인할 수 있습니다.");
    return;
  }
  if (!options.silent) el.mobileNotificationStatus.textContent = "휴대폰 연결 상태를 확인하는 중입니다.";
  try {
    const response = await writeFetch("/api/integrations/call-note/admin/status", {
      headers: { Accept: "application/json" }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "휴대폰 연결 상태를 확인하지 못했습니다");
    state.mobileNotification = result;
    reconcileRelayEnrollmentRequestState(result);
    reconcileMobilePairState(result);
    renderMobileNotificationSettings();
  } catch (error) {
    renderMobileNotificationError(error.message || "휴대폰 연결 상태를 확인하지 못했습니다");
  }
}

function renderMobileNotificationSettings() {
  const result = state.mobileNotification || {};
  renderRelayEnrollmentSettings();
  const devices = Array.isArray(result.devices) ? result.devices : [];
  const deliveries = Array.isArray(result.deliveries) ? result.deliveries : [];
  const activeDevices = devices.filter((device) => device.status === "active");
  const ready = Boolean(result.senderEnabled && result.relayConfigured && result.schedulerConfigured);
  const enrollmentReady = relayEnrollmentReady(result);

  el.mobileNotificationStatusBadge.textContent = activeDevices.length
    ? ready ? "연결됨" : "설정 확인"
    : "미연결";
  el.mobileNotificationStatusBadge.classList.toggle("is-ready", ready && activeDevices.length > 0);
  el.mobileNotificationStatusBadge.classList.toggle("is-warning", !ready || !activeDevices.length);
  el.mobilePairCodeCreateBtn.disabled = !enrollmentReady || result.apiSecretConfigured === false;
  el.mobilePairCodeCreateBtn.closest(".mobile-pair-panel")?.classList.toggle("is-locked", !enrollmentReady);
  el.mobilePairCodeOutput.textContent = state.mobilePairCode || "------";
  renderMobilePairExpiry();

  el.mobileDeviceList.innerHTML = devices.length
    ? devices.map(mobileDeviceHtml).join("")
    : '<p class="call-note-empty">연결된 휴대폰이 없습니다. Android 앱에서 연결코드를 입력하세요.</p>';
  el.mobileDeliveryList.innerHTML = deliveries.length
    ? deliveries.map(mobileDeliveryHtml).join("")
    : '<p class="call-note-empty">아직 알림 전송 기록이 없습니다.</p>';

  const checks = [
    result.apiSecretConfigured ? "기기 인증 준비" : "기기 인증키 필요",
    enrollmentReady ? "Relay 사이트 등록 완료" : "1단계 Relay 등록 필요",
    result.relayConfigured ? "중앙 Relay 연결" : "발송 Worker 연결 확인 필요",
    result.schedulerConfigured ? "발송 Worker 작동" : "발송 Worker 확인 필요",
    result.senderEnabled ? "발송 사용" : "발송 일시 중지"
  ];
  el.mobileNotificationStatus.textContent = checks.join(" · ");
}

function mobileDeviceHtml(device) {
  const active = device.status === "active";
  const stateLabel = {
    active: "연결됨",
    pending: "등록 대기",
    unregistered: "토큰 재등록 필요",
    revoked: "연결 해제"
  }[device.status] || "상태 확인";
  const detail = [device.deviceName, device.appVersion ? `앱 ${device.appVersion}` : "", formatMobileDate(device.lastSeenAt || device.updatedAt)]
    .filter(Boolean)
    .join(" · ");
  return `<article class="mobile-device-card">
    <div><strong>${escapeHtml(device.deviceName || "Android 기기")}</strong><p>${escapeHtml(detail || stateLabel)}</p></div>
    <span class="mobile-device-state">${escapeHtml(stateLabel)}</span>
    <div class="mobile-device-actions">
      ${active ? `<button class="icon-button text-button subtle" type="button" data-mobile-device-action="test" data-device-id="${escapeAttribute(device.deviceId)}">테스트</button>` : ""}
      <button class="icon-button text-button danger" type="button" data-mobile-device-action="disconnect" data-device-id="${escapeAttribute(device.deviceId)}">연결 해제</button>
    </div>
  </article>`;
}

function mobileDeliveryHtml(delivery) {
  const kind = delivery.kind === "visit_alarm" ? "심방 알림" : delivery.kind === "memo_reminder" ? "메모 알림" : "연결 테스트";
  const stateLabel = {
    pending: "대기",
    sending: "발송 중",
    retry_wait: "재시도 대기",
    accepted: "접수됨",
    waiting_target: "기기 등록 대기",
    blocked_config: "설정 대기",
    dead: "실패",
    cancelled: "취소"
  }[delivery.sendState] || delivery.sendState || "확인 중";
  const detail = [formatMobileDate(delivery.scheduledAt), mobileDeliveryErrorLabel(delivery.errorCode)].filter(Boolean).join(" · ");
  return `<article class="mobile-delivery-card"><div><strong>${escapeHtml(kind)}</strong><p>${escapeHtml(detail || "전송 정보 없음")}</p></div><span>${escapeHtml(stateLabel)}</span></article>`;
}

function mobileDeliveryErrorLabel(code) {
  return {
    RELAY_SEND_DISABLED: "중앙 알림 발송 꺼짐",
    RELAY_AUTH_INVALID: "중앙 Relay 키 확인 필요",
    RELAY_TARGET_NOT_SYNCED: "휴대폰 등록 대기",
    FCM_PERMISSION_DENIED: "휴대폰 알림 권한 필요",
    MAX_SEND_ATTEMPTS: "재시도 한도 초과",
    DELIVERY_EXPIRED: "알림 만료"
  }[String(code || "")] || "";
}

async function createMobilePairCode() {
  if (!relayEnrollmentReady(state.mobileNotification)) {
    toast("1단계 중앙 Relay 사이트 등록을 먼저 완료하세요");
    return;
  }
  if (!confirm("심방콜노트 앱에 입력할 FCM 6자리 연결코드를 만들까요? 10분 동안 한 번만 사용할 수 있습니다.")) return;
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
    renderMobileNotificationSettings();
    startMobileNotificationPolling();
    toast("FCM 앱 6자리 연결코드를 만들었습니다. Android 콜노트 앱에 입력하세요");
  } catch (error) {
    el.mobileNotificationStatus.textContent = error.message || "연결코드를 만들지 못했습니다";
    toast(error.message || "연결코드를 만들지 못했습니다");
  } finally {
    el.mobilePairCodeCreateBtn.disabled = !relayEnrollmentReady(state.mobileNotification)
      || state.mobileNotification?.apiSecretConfigured === false;
  }
}

async function handleMobileDeviceAction(event) {
  const button = closestElement(event.target, "[data-mobile-device-action]");
  if (!button) return;
  const deviceId = String(button.dataset.deviceId || "");
  const action = button.dataset.mobileDeviceAction;
  if (!deviceId) return;
  if (action === "disconnect" && !confirm("이 휴대폰의 웹 알림 연결을 해제할까요?")) return;
  button.disabled = true;
  try {
    const url = action === "test"
      ? `/api/integrations/call-note/admin/devices/${encodeURIComponent(deviceId)}/test`
      : `/api/integrations/call-note/admin/devices/${encodeURIComponent(deviceId)}`;
    const response = await writeFetch(url, {
      method: action === "test" ? "POST" : "DELETE",
      headers: { Accept: "application/json" }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "기기 요청을 처리하지 못했습니다");
    toast(action === "test" ? "테스트 알림을 예약했습니다" : "휴대폰 연결을 해제했습니다");
    await loadMobileNotificationStatus({ silent: true });
  } catch (error) {
    toast(error.message || "기기 요청을 처리하지 못했습니다");
  } finally {
    button.disabled = false;
  }
}

function reconcileMobilePairState(result) {
  const pairCode = result?.pairCode;
  const expired = pairCode?.expiresAt && Date.parse(pairCode.expiresAt) <= Date.now();
  if (pairCode?.usedAt || pairCode?.invalidatedAt || expired) {
    state.mobilePairCode = "";
    state.mobilePairCodeExpiresAt = "";
  }
}

function startMobileNotificationPolling() {
  stopMobileNotificationPolling();
  state.mobileNotificationPollId = window.setInterval(() => {
    if (!el.settingsModal.classList.contains("hidden")) loadMobileNotificationStatus({ silent: true });
  }, 5000);
  state.mobilePairCountdownId = window.setInterval(() => {
    renderRelayEnrollmentRequestExpiry();
    renderMobilePairExpiry();
  }, 1000);
}

function stopMobileNotificationPolling() {
  if (state.mobileNotificationPollId) window.clearInterval(state.mobileNotificationPollId);
  if (state.mobilePairCountdownId) window.clearInterval(state.mobilePairCountdownId);
  state.mobileNotificationPollId = 0;
  state.mobilePairCountdownId = 0;
}

function renderMobilePairExpiry() {
  if (!state.mobilePairCode || !state.mobilePairCodeExpiresAt) {
    el.mobilePairCodeExpiry.textContent = "코드를 만들면 이 화면에 한 번만 표시됩니다.";
    return;
  }
  const seconds = Math.max(0, Math.ceil((Date.parse(state.mobilePairCodeExpiresAt) - Date.now()) / 1000));
  if (!seconds) {
    state.mobilePairCode = "";
    state.mobilePairCodeExpiresAt = "";
    el.mobilePairCodeOutput.textContent = "------";
    el.mobilePairCodeExpiry.textContent = "연결코드가 만료되었습니다.";
    return;
  }
  el.mobilePairCodeExpiry.textContent = `${Math.floor(seconds / 60)}분 ${String(seconds % 60).padStart(2, "0")}초 후 만료`;
}

function renderMobileNotificationError(message) {
  state.mobileNotification = null;
  renderRelayEnrollmentSettings();
  el.mobileNotificationStatusBadge.textContent = "확인 필요";
  el.mobileNotificationStatusBadge.classList.remove("is-ready");
  el.mobileNotificationStatusBadge.classList.add("is-warning");
  el.mobilePairCodeCreateBtn.disabled = true;
  el.mobilePairCodeCreateBtn.closest(".mobile-pair-panel")?.classList.add("is-locked");
  el.mobileNotificationStatus.textContent = message;
}

function formatMobileDate(value) {
  const date = new Date(value || "");
  return Number.isFinite(date.getTime()) ? date.toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" }) : "";
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
  if (!ensureWritableStore()) return;
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
    schedulePastoralRefresh(memberId);
    toast("콜노트 기록을 심방내역에 저장했습니다");
  } catch (error) {
    if (D1_REQUIRED) {
      state.apiOnline = false;
      handleRequiredD1Failure();
      return;
    }
    toast(error.message || "저장하지 못했습니다");
  } finally {
    button.disabled = false;
  }
}

async function ignoreCallNoteImport(id, button) {
  if (!ensureWritableStore()) return;
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
    if (D1_REQUIRED) {
      state.apiOnline = false;
      handleRequiredD1Failure();
      return;
    }
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
  state.returnToAttendanceDate = "";
  state.timelineMemberId = "";
  state.timelineEvents = [];
  state.editingTaskId = "";
  state.editingPrayerId = "";
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
  const weekdays = ["주일", "월", "화", "수", "목", "금", "토"];
  return `${date.getMonth() + 1}/${date.getDate()} ${weekdays[date.getDay()]}`;
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
