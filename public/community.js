const state = {
  overview: null,
  activeTab: "assignments",
  reportPeriod: "week",
  report: null,
  editingFamilyId: "",
  familyDraftMembers: new Map(),
  editingUserId: "",
  suggestionRows: []
};

const el = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindElements();
  bindEvents();
  setInitialDates();
  await loadOverview();
  const requestedTab = new URLSearchParams(window.location.search).get("open");
  openTab(requestedTab || "assignments");
}

function bindElements() {
  document.querySelectorAll("[id]").forEach((node) => { el[node.id] = node; });
}

function bindEvents() {
  document.querySelector(".community-tabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (button) openTab(button.dataset.tab);
  });
  el.refreshAssignmentsBtn.addEventListener("click", loadOverview);
  el.notificationBtn.addEventListener("click", registerNotifications);
  el.notificationTestBtn.addEventListener("click", sendTestNotification);
  el.assignmentForm.addEventListener("submit", createAssignment);
  el.assignmentList.addEventListener("click", handleAssignmentAction);
  el.assignmentSuggestions.addEventListener("click", useAssignmentSuggestion);
  el.loadSuggestionsBtn.addEventListener("click", loadAssignmentSuggestions);

  el.inviteForm.addEventListener("submit", createInvite);
  el.copyInviteBtn.addEventListener("click", copyInviteUrl);
  el.shareInviteBtn.addEventListener("click", shareInviteUrl);
  el.newcomerList.addEventListener("click", handleNewcomerAction);

  el.newFamilyBtn.addEventListener("click", () => openFamilyEditor());
  el.closeFamilyBtn.addEventListener("click", closeFamilyEditor);
  el.familyList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-family-id]");
    if (button) openFamilyEditor(button.dataset.familyId);
  });
  el.familyMemberSearch.addEventListener("input", () => {
    updateFamilyDraftFromPicker();
    renderFamilyMemberPicker();
  });
  el.familyMemberPicker.addEventListener("change", updateFamilyDraftFromPicker);
  el.familyMemberPicker.addEventListener("input", updateFamilyDraftFromPicker);
  el.familyForm.addEventListener("submit", saveFamily);
  el.deleteFamilyBtn.addEventListener("click", deleteFamily);

  document.querySelectorAll("[data-report-period]").forEach((button) => {
    button.addEventListener("click", () => setReportPeriod(button.dataset.reportPeriod));
  });
  el.loadReportBtn.addEventListener("click", loadReport);
  el.downloadReportBtn.addEventListener("click", downloadReportWord);
  el.printReportBtn.addEventListener("click", printReport);

  el.userForm.addEventListener("submit", saveUser);
  el.userRole.addEventListener("change", syncUserRoleControls);
  el.userList.addEventListener("click", handleUserAction);
  el.cancelUserEditBtn.addEventListener("click", resetUserForm);
}

function setInitialDates() {
  const today = localDateString();
  el.assignmentDueDate.value = today;
  el.reportAnchor.value = today;
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + 30);
  el.inviteExpiresAt.value = localDateString(expiry);
}

async function loadOverview() {
  try {
    const overview = await api("/api/community/overview");
    state.overview = overview;
    renderOverview();
    await loadNotificationStatus();
  } catch (error) {
    toast(error.message || "공동체 자료를 불러오지 못했습니다");
  }
}

async function loadNotificationStatus() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    el.notificationStatus.textContent = "이 브라우저는 알림을 지원하지 않습니다";
    el.notificationBtn.classList.add("hidden");
    return;
  }
  try {
    const status = await api("/api/notifications/web-push");
    el.notificationStatus.textContent = status.active ? "이 기기 알림 연결됨" : "이 기기 알림 미등록";
    el.notificationBtn.textContent = status.active ? "알림 다시 등록" : "이 기기 알림 등록";
    el.notificationBtn.disabled = !status.configured;
    el.notificationTestBtn.classList.toggle("hidden", !status.ready);
  } catch {
    el.notificationStatus.textContent = "알림 상태를 확인하지 못했습니다";
  }
}

async function registerNotifications() {
  el.notificationBtn.disabled = true;
  try {
    const status = await api("/api/notifications/web-push");
    if (!status.publicKey) throw new Error("알림 서버 설정이 아직 완료되지 않았습니다");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("기기 설정에서 알림을 허용해주세요");
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlBytes(status.publicKey)
      });
    }
    await api("/api/notifications/web-push/subscription", {
      method: "POST",
      body: {
        subscription: subscription.toJSON(),
        platform: browserPlatform(),
        deviceName: browserDeviceName()
      }
    });
    toast("이 기기에서 담당 목양 알림을 받습니다");
    await loadNotificationStatus();
  } catch (error) {
    toast(error.message || "알림을 등록하지 못했습니다");
  } finally {
    el.notificationBtn.disabled = false;
  }
}

async function sendTestNotification() {
  el.notificationTestBtn.disabled = true;
  try {
    await api("/api/notifications/web-push/test", { method: "POST" });
    toast("시험 알림을 보냈습니다");
  } catch (error) {
    toast(error.message || "시험 알림을 보내지 못했습니다");
  } finally {
    el.notificationTestBtn.disabled = false;
  }
}

function base64UrlBytes(value) {
  const base64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function browserPlatform() {
  const value = navigator.userAgent.toLowerCase();
  if (/android/.test(value)) return "android";
  if (/iphone|ipad|ipod/.test(value)) return "ios";
  if (/windows/.test(value)) return "windows";
  if (/macintosh|mac os/.test(value)) return "macos";
  if (/linux/.test(value)) return "linux";
  return "other";
}

function browserDeviceName() {
  return { android: "Android 기기", ios: "iPhone 또는 iPad", windows: "Windows PC", macos: "Mac", linux: "Linux PC", other: "웹 브라우저" }[browserPlatform()];
}

function renderOverview() {
  const overview = state.overview;
  if (!overview) return;
  el.viewerName.textContent = overview.viewer.displayName || overview.viewer.username || "사용자";
  el.viewerRole.textContent = overview.viewer.roleLabel || "";
  document.querySelectorAll("[data-owner-only]").forEach((node) => {
    node.classList.toggle("hidden", !overview.viewer.canManageUsers);
  });
  el.assignmentForm.classList.toggle("hidden", !overview.viewer.canEdit);
  el.newFamilyBtn.classList.toggle("hidden", !overview.viewer.canEdit);
  renderAssignmentOptions();
  renderAssignments();
  renderNewcomers();
  renderFamilies();
  renderUserCellPicker();
  renderUsers();
}

function openTab(tab) {
  const allowed = new Set(["assignments", "newcomers", "families", "reports", "users"]);
  const next = allowed.has(tab) ? tab : "assignments";
  if (["newcomers", "users"].includes(next) && !state.overview?.viewer?.canManageUsers) {
    state.activeTab = "assignments";
  } else {
    state.activeTab = next;
  }
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === state.activeTab);
  });
  document.querySelectorAll("[data-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === state.activeTab);
  });
  const url = new URL(window.location.href);
  url.searchParams.set("open", state.activeTab);
  history.replaceState(null, "", url);
  if (state.activeTab === "reports" && !state.report) loadReport();
}

function renderAssignmentOptions() {
  const members = state.overview?.members || [];
  const users = state.overview?.users || [];
  el.assignmentMember.innerHTML = optionList(members, "id", (member) => `${member.name} · ${member.cellName || cellName(member.cellId)}`);
  el.assignmentAssignee.innerHTML = optionList(users, "id", (user) => `${user.displayName} · ${user.roleLabel}`);
}

function renderAssignments() {
  const assignments = state.overview?.assignments || [];
  const today = localDateString();
  const open = assignments.filter((item) => !["completed", "cancelled"].includes(item.status));
  const mine = open.filter((item) => item.assigneeUserId === state.overview.viewer.id);
  const overdue = open.filter((item) => item.dueDate < today);
  const completed = assignments.filter((item) => item.status === "completed");
  el.assignmentMetrics.innerHTML = [
    ["내 진행 업무", mine.length],
    ["전체 진행", open.length],
    ["기한 지남", overdue.length],
    ["완료", completed.length]
  ].map(([label, count]) => `<div class="metric"><span>${label}</span><strong>${count}건</strong></div>`).join("");

  const sorted = assignments.slice().sort((a, b) => {
    const aMine = a.assigneeUserId === state.overview.viewer.id ? 0 : 1;
    const bMine = b.assigneeUserId === state.overview.viewer.id ? 0 : 1;
    const aClosed = ["completed", "cancelled"].includes(a.status) ? 1 : 0;
    const bClosed = ["completed", "cancelled"].includes(b.status) ? 1 : 0;
    return aClosed - bClosed || aMine - bMine || String(a.dueDate).localeCompare(String(b.dueDate));
  });
  el.assignmentList.innerHTML = sorted.length
    ? sorted.map(assignmentHtml).join("")
    : '<p class="empty-state">배정된 목양 업무가 없습니다.</p>';
}

function assignmentHtml(item) {
  const status = assignmentStatusLabel(item.status);
  const canEdit = state.overview.viewer.canEdit;
  const isClosed = ["completed", "cancelled"].includes(item.status);
  const buttons = canEdit && !isClosed ? `
    <button data-assignment-action="contacted" data-assignment-id="${attr(item.id)}" type="button">연락함</button>
    <button data-assignment-action="visit_planned" data-assignment-id="${attr(item.id)}" type="button">심방 예정</button>
    <button data-assignment-action="complete" data-assignment-id="${attr(item.id)}" type="button">완료</button>
    <button data-assignment-action="cancelled" data-assignment-id="${attr(item.id)}" type="button">취소</button>` : "";
  return `<article class="work-item">
    <div class="work-item-head">
      <div><h4>${html(item.title)}</h4><p>${html(item.memberName)} · ${html(item.cellName)}</p></div>
      <span class="status-badge status-${attr(item.status)}">${status}</span>
    </div>
    ${item.note ? `<p>${multiline(item.note)}</p>` : ""}
    <div class="work-meta">
      <span>담당 ${html(item.assigneeDisplayName)}</span>
      <span>기한 ${formatDate(item.dueDate)}</span>
      <span>${assignmentSourceLabel(item.sourceKind)}</span>
    </div>
    ${buttons ? `<div class="item-actions">${buttons}</div>` : ""}
  </article>`;
}

async function createAssignment(event) {
  event.preventDefault();
  const payload = {
    memberId: el.assignmentMember.value,
    assigneeUserId: el.assignmentAssignee.value,
    title: el.assignmentTitle.value.trim(),
    dueDate: el.assignmentDueDate.value,
    sourceKind: el.assignmentSourceKind.value,
    sourceKey: el.assignmentForm.dataset.sourceKey || "",
    note: el.assignmentNote.value.trim()
  };
  try {
    await api("/api/community/assignments", { method: "POST", body: payload });
    el.assignmentTitle.value = "";
    el.assignmentNote.value = "";
    delete el.assignmentForm.dataset.sourceKey;
    toast("목양 업무를 배정했습니다");
    await loadOverview();
  } catch (error) {
    toast(error.message);
  }
}

async function handleAssignmentAction(event) {
  const button = event.target.closest("[data-assignment-action]");
  if (!button) return;
  const status = button.dataset.assignmentAction === "complete" ? "completed" : button.dataset.assignmentAction;
  try {
    await api(`/api/community/assignments/${encodeURIComponent(button.dataset.assignmentId)}`, {
      method: "PATCH",
      body: { status }
    });
    toast(status === "completed" ? "목양 업무를 완료했습니다" : "진행 상태를 변경했습니다");
    await loadOverview();
  } catch (error) {
    toast(error.message);
  }
}

async function loadAssignmentSuggestions() {
  el.loadSuggestionsBtn.disabled = true;
  try {
    const dashboard = await api("/api/dashboard");
    const rows = [
      ...(dashboard.birthdays || []).map((member) => suggestion(member, "birthday", "생일 축하 및 안부 연락", `birthday:${dashboard.today}:${member.id}`)),
      ...(dashboard.newFamilies || []).map((member) => suggestion(member, "new_family", "새가족 환영 연락", `new-family:${member.id}`)),
      ...(dashboard.attendanceRisks || []).map((member) => suggestion(member, "attendance", `${member.consecutiveAbsences}주 연속 결석 확인`, `attendance:${dashboard.today}:${member.id}`)),
      ...(dashboard.careGaps || []).map((member) => suggestion(member, "care_gap", "장기 심방 공백 확인", `care-gap:${dashboard.today}:${member.id}`)),
      ...(dashboard.tasks || []).map((task) => suggestion(task.member, "task", task.title, `task:${task.id}`)),
      ...(dashboard.urgentPrayers || []).map((topic) => suggestion(topic.member, "prayer", "긴급 기도제목 확인", `prayer:${topic.id}`))
    ];
    const existingSources = new Set((state.overview.assignments || []).map((item) => `${item.sourceKind}:${item.sourceKey}`));
    state.suggestionRows = uniqueBy(rows, (row) => `${row.sourceKind}:${row.sourceKey}`)
      .filter((row) => !existingSources.has(`${row.sourceKind}:${row.sourceKey}`));
    renderAssignmentSuggestions();
  } catch (error) {
    toast(error.message || "오늘의 목양 항목을 불러오지 못했습니다");
  } finally {
    el.loadSuggestionsBtn.disabled = false;
  }
}

function suggestion(member, sourceKind, title, sourceKey) {
  return {
    memberId: member.id,
    memberName: member.name,
    cellName: member.cellName,
    sourceKind,
    sourceKey,
    title
  };
}

function renderAssignmentSuggestions() {
  el.assignmentSuggestions.classList.remove("hidden");
  el.assignmentSuggestions.innerHTML = state.suggestionRows.length
    ? state.suggestionRows.slice(0, 12).map((row, index) => `<article class="work-item">
      <div class="work-item-head"><div><h4>${html(row.title)}</h4><p>${html(row.memberName)} · ${html(row.cellName)}</p></div><span class="status-badge">추천</span></div>
      <div class="item-actions"><button data-suggestion-index="${index}" type="button">배정 양식에 넣기</button></div>
    </article>`).join("")
    : '<p class="empty-state">새로 배정할 추천 항목이 없습니다.</p>';
}

function useAssignmentSuggestion(event) {
  const button = event.target.closest("[data-suggestion-index]");
  if (!button) return;
  const row = state.suggestionRows[Number(button.dataset.suggestionIndex)];
  if (!row) return;
  el.assignmentMember.value = row.memberId;
  el.assignmentTitle.value = row.title;
  el.assignmentSourceKind.value = row.sourceKind;
  el.assignmentForm.dataset.sourceKey = row.sourceKey;
  el.assignmentTitle.focus();
  el.assignmentForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderNewcomers() {
  if (!state.overview?.viewer?.canManageUsers) return;
  const rows = state.overview.submissions || [];
  el.newcomerCount.textContent = `${rows.filter((row) => row.status === "pending").length}건 대기`;
  el.newcomerList.innerHTML = rows.length
    ? rows.map(newcomerHtml).join("")
    : '<p class="empty-state">접수된 새가족 등록이 없습니다.</p>';
}

function newcomerHtml(row) {
  const pending = row.status === "pending";
  const duplicates = row.duplicates || [];
  const cellOptions = optionList(state.overview.cells || [], "id", (cell) => cell.name);
  const duplicateOptions = duplicates.length
    ? `<select data-newcomer-existing><option value="">기존 성도 선택</option>${optionList(duplicates, "id", (member) => `${member.name} · ${cellName(member.cellId)}`)}</select>`
    : "";
  return `<article class="newcomer-item" data-newcomer-id="${attr(row.id)}">
    <div class="work-item-head"><div><h4>${html(row.name)}</h4><p>${html(formatPhone(row.phone) || "전화번호 없음")} · ${formatDateTime(row.createdAt)}</p></div><span class="status-badge status-${attr(row.status)}">${newcomerStatusLabel(row.status)}</span></div>
    ${row.birth ? `<p>생년월일 ${formatDate(row.birth)}</p>` : ""}
    ${row.address ? `<p>주소 ${html(row.address)}</p>` : ""}
    ${row.familyDetails ? `<p>가족사항 ${multiline(row.familyDetails)}</p>` : ""}
    ${duplicates.length ? `<p><strong>중복 후보:</strong> ${duplicates.map((member) => html(`${member.name} (${formatPhone(member.phone) || cellName(member.cellId)})`)).join(", ")}</p>` : ""}
    ${pending ? `<div class="item-actions">
      <select data-newcomer-cell aria-label="등록 셀">${cellOptions}</select>
      ${duplicateOptions}
      ${duplicates.length ? `<button data-newcomer-action="link" type="button">기존 성도 연결</button>` : ""}
      <button data-newcomer-action="approve" type="button">새 성도로 등록</button>
      <button data-newcomer-action="reject" type="button">반려</button>
    </div>` : ""}
  </article>`;
}

async function createInvite(event) {
  event.preventDefault();
  const expiresAt = new Date(`${el.inviteExpiresAt.value}T23:59:59+09:00`).toISOString();
  try {
    const result = await api("/api/community/newcomers/invites", {
      method: "POST",
      body: {
        label: el.inviteLabel.value.trim(),
        expiresAt,
        maxSubmissions: Number(el.inviteLimit.value)
      }
    });
    el.inviteUrl.value = result.url;
    renderQr(result.url);
    el.inviteResult.classList.remove("hidden");
    toast("새가족 등록 QR을 만들었습니다");
    await loadOverview();
  } catch (error) {
    toast(error.message);
  }
}

function renderQr(value) {
  if (typeof window.qrcode !== "function") {
    el.inviteQr.removeAttribute("src");
    return;
  }
  const qr = window.qrcode(0, "M");
  qr.addData(value);
  qr.make();
  el.inviteQr.src = qr.createDataURL(6, 4);
}

async function copyInviteUrl() {
  try {
    await navigator.clipboard.writeText(el.inviteUrl.value);
    toast("등록 주소를 복사했습니다");
  } catch {
    el.inviteUrl.select();
    document.execCommand("copy");
    toast("등록 주소를 복사했습니다");
  }
}

async function shareInviteUrl() {
  if (!el.inviteUrl.value) return;
  if (navigator.share) {
    await navigator.share({ title: el.inviteLabel.value, url: el.inviteUrl.value }).catch(() => {});
  } else {
    await copyInviteUrl();
  }
}

async function handleNewcomerAction(event) {
  const button = event.target.closest("[data-newcomer-action]");
  if (!button) return;
  const item = button.closest("[data-newcomer-id]");
  const action = button.dataset.newcomerAction;
  const body = action === "reject"
    ? { action: "reject" }
    : {
      action: "approve",
      cellId: item.querySelector("[data-newcomer-cell]").value,
      useExistingMemberId: action === "link" ? item.querySelector("[data-newcomer-existing]")?.value : "",
      force: action === "approve"
    };
  if (action === "link" && !body.useExistingMemberId) {
    toast("연결할 기존 성도를 선택하세요");
    return;
  }
  try {
    await api(`/api/community/newcomers/submissions/${encodeURIComponent(item.dataset.newcomerId)}`, { method: "PATCH", body });
    toast(action === "reject" ? "등록 신청을 반려했습니다" : "새가족 등록을 처리했습니다");
    await loadOverview();
  } catch (error) {
    toast(error.message);
  }
}

function renderFamilies() {
  const families = state.overview?.families || [];
  el.familyList.innerHTML = families.length
    ? families.map((family) => `<article class="family-item">
      <button class="family-open" data-family-id="${attr(family.id)}" type="button">
        <div class="work-item-head"><h3>${html(family.name)}</h3><span class="count-badge">${family.members.length}명</span></div>
        ${family.note ? `<p>${multiline(family.note)}</p>` : ""}
        <div class="family-members">${family.members.map((member) => `<span>${html(member.name)}${member.relationship ? ` · ${html(member.relationship)}` : ""}</span>`).join("") || "<span>구성원 없음</span>"}</div>
        ${family.members.length ? `<div class="family-care">${family.members.map(familyCareRowHtml).join("")}</div>` : ""}
      </button>
    </article>`).join("")
    : '<p class="empty-state">연결된 가족 자료가 없습니다.</p>';
  if (state.editingFamilyId) openFamilyEditor(state.editingFamilyId, false);
}

function familyCareRowHtml(member) {
  const attendance = member.latestAttendance?.status
    ? { present: "출석", online: "온라인", absent: "결석", military: "군복무", study: "유학", other: "기타" }[member.latestAttendance.status] || member.latestAttendance.status
    : "기록 없음";
  return `<div><strong>${html(member.name)}</strong><span>최근 심방 ${member.lastVisitDate ? formatDate(member.lastVisitDate) : "기록 없음"}</span><span>기도 ${Number(member.activePrayerCount || 0)}건</span><span>최근 출석 ${html(attendance)}</span></div>`;
}

function openFamilyEditor(id = "", scroll = true) {
  state.editingFamilyId = id;
  const family = (state.overview.families || []).find((item) => item.id === id);
  state.familyDraftMembers = new Map((family?.members || []).map((member) => [member.id, {
    memberId: member.id,
    relationship: member.relationship || "",
    isPrimary: Boolean(member.isPrimary)
  }]));
  el.familyId.value = id;
  el.familyName.value = family?.name || "";
  el.familyNote.value = family?.note || "";
  el.familyMemberSearch.value = "";
  el.familyEditorTitle.textContent = family ? `${family.name} 편집` : "가족 추가";
  el.deleteFamilyBtn.classList.toggle("hidden", !family);
  el.familyForm.classList.remove("hidden");
  renderFamilyMemberPicker();
  if (scroll) el.familyForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeFamilyEditor() {
  state.editingFamilyId = "";
  state.familyDraftMembers = new Map();
  el.familyForm.classList.add("hidden");
}

function renderFamilyMemberPicker() {
  const selected = state.familyDraftMembers;
  const search = el.familyMemberSearch.value.trim().toLowerCase();
  const rows = (state.overview?.members || []).filter((member) => !search || `${member.name} ${member.cellName}`.toLowerCase().includes(search));
  el.familyMemberPicker.innerHTML = rows.map((member) => {
    const link = selected.get(member.id);
    return `<div class="member-choice" data-family-member="${attr(member.id)}">
      <input type="checkbox" ${link ? "checked" : ""} aria-label="${attr(member.name)} 가족 구성원 선택">
      <span><strong>${html(member.name)}</strong><small>${html(member.cellName || cellName(member.cellId))}</small></span>
      <input data-relationship value="${attr(link?.relationship || "")}" maxlength="50" placeholder="관계">
      <label class="check-row"><input data-primary type="radio" name="familyPrimary" ${link?.isPrimary ? "checked" : ""}><span>대표</span></label>
    </div>`;
  }).join("") || '<p class="empty-state">검색 결과가 없습니다.</p>';
}

function updateFamilyDraftFromPicker(event) {
  if (event?.target?.matches?.("[data-primary]") && event.target.checked) {
    for (const [id, member] of state.familyDraftMembers) {
      state.familyDraftMembers.set(id, { ...member, isPrimary: false });
    }
  }
  for (const row of el.familyMemberPicker.querySelectorAll("[data-family-member]")) {
    const checked = row.querySelector('input[type="checkbox"]').checked;
    if (!checked) {
      state.familyDraftMembers.delete(row.dataset.familyMember);
      continue;
    }
    state.familyDraftMembers.set(row.dataset.familyMember, {
      memberId: row.dataset.familyMember,
      relationship: row.querySelector("[data-relationship]").value.trim(),
      isPrimary: row.querySelector("[data-primary]").checked
    });
  }
}

async function saveFamily(event) {
  event.preventDefault();
  const payload = { name: el.familyName.value.trim(), note: el.familyNote.value.trim() };
  try {
    let familyId = state.editingFamilyId;
    if (familyId) {
      await api(`/api/community/families/${encodeURIComponent(familyId)}`, { method: "PATCH", body: payload });
    } else {
      const created = await api("/api/community/families", { method: "POST", body: payload });
      familyId = created.id;
    }
    updateFamilyDraftFromPicker();
    const members = [...state.familyDraftMembers.values()];
    await api(`/api/community/families/${encodeURIComponent(familyId)}/members`, { method: "PUT", body: { members } });
    state.editingFamilyId = familyId;
    toast("가족 정보를 저장했습니다");
    await loadOverview();
  } catch (error) {
    toast(error.message);
  }
}

async function deleteFamily() {
  if (!state.editingFamilyId || !window.confirm("이 가족 연결을 삭제할까요? 성도 자료는 삭제되지 않습니다.")) return;
  try {
    await api(`/api/community/families/${encodeURIComponent(state.editingFamilyId)}`, { method: "DELETE" });
    closeFamilyEditor();
    toast("가족 연결을 삭제했습니다");
    await loadOverview();
  } catch (error) {
    toast(error.message);
  }
}

function setReportPeriod(period) {
  state.reportPeriod = period === "month" ? "month" : "week";
  document.querySelectorAll("[data-report-period]").forEach((button) => {
    button.classList.toggle("active", button.dataset.reportPeriod === state.reportPeriod);
  });
}

async function loadReport() {
  try {
    state.report = await api(`/api/community/reports?period=${state.reportPeriod}&anchor=${encodeURIComponent(el.reportAnchor.value)}`);
    renderReport();
    el.downloadReportBtn.disabled = false;
    el.printReportBtn.disabled = false;
  } catch (error) {
    toast(error.message);
  }
}

function renderReport() {
  const report = state.report;
  if (!report) return;
  const summary = report.summary;
  const metrics = [
    ["재적 성도", summary.memberCount],
    ["새 등록", summary.newMemberCount],
    ["심방", summary.visitCount],
    ["심방 성도", summary.visitedMemberCount],
    ["출석 주일", summary.attendanceSessionCount],
    ["출석 성도", summary.presentMemberCount],
    ["결석 기록", summary.absenceRecordCount],
    ["목양 완료", summary.assignmentCompletedCount]
  ];
  el.reportOutput.innerHTML = `<div class="report-heading"><h3>${report.periodLabel} 목양 보고</h3><p>${formatDate(report.startDate)} ~ ${formatDate(report.endDate)}</p></div>
    <div class="metric-strip">${metrics.slice(0, 4).map(([label, count]) => `<div class="metric"><span>${label}</span><strong>${count}</strong></div>`).join("")}</div>
    <table class="report-table"><thead><tr><th>셀</th><th>인원</th><th>심방</th><th>출석 인원</th><th>목양 진행</th><th>목양 완료</th></tr></thead><tbody>
      ${(report.cellBreakdown || []).map((cell) => `<tr><td>${html(cell.cellName)}</td><td>${cell.memberCount}</td><td>${cell.visitCount}</td><td>${cell.presentMemberCount}</td><td>${cell.assignmentOpenCount}</td><td>${cell.assignmentCompletedCount}</td></tr>`).join("")}
    </tbody></table>
    <div class="metric-strip">${metrics.slice(4).map(([label, count]) => `<div class="metric"><span>${label}</span><strong>${count}</strong></div>`).join("")}</div>`;
}

function reportDocumentHtml(report) {
  const summary = report.summary;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${report.periodLabel} 목양 보고</title><style>
    @page{size:A4;margin:18mm}body{font-family:"Malgun Gothic",sans-serif;color:#211e19;font-size:11pt;line-height:1.5}h1{font-size:22pt;margin:0 0 5mm}p{margin:0 0 5mm;color:#665d52}.summary{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid #bdb3a4;margin:6mm 0}.summary div{padding:4mm;border-right:1px solid #ddd4c8}.summary div:last-child{border:0}.summary span{display:block;font-size:9pt;color:#6d6459}.summary strong{font-size:16pt}table{width:100%;border-collapse:collapse;margin-top:6mm}th,td{border:1px solid #cfc6b8;padding:2.5mm;text-align:right}th:first-child,td:first-child{text-align:left}th{background:#f2eee7}footer{margin-top:8mm;font-size:9pt;color:#776e63}
  </style></head><body><h1>${report.periodLabel} 목양 보고</h1><p>${formatDate(report.startDate)} ~ ${formatDate(report.endDate)}</p>
  <div class="summary">${[
    ["재적 성도", summary.memberCount], ["새 등록", summary.newMemberCount], ["심방", summary.visitCount], ["목양 완료", summary.assignmentCompletedCount]
  ].map(([label, count]) => `<div><span>${label}</span><strong>${count}</strong></div>`).join("")}</div>
  <table><thead><tr><th>셀</th><th>인원</th><th>심방</th><th>출석 인원</th><th>목양 진행</th><th>목양 완료</th></tr></thead><tbody>${(report.cellBreakdown || []).map((cell) => `<tr><td>${html(cell.cellName)}</td><td>${cell.memberCount}</td><td>${cell.visitCount}</td><td>${cell.presentMemberCount}</td><td>${cell.assignmentOpenCount}</td><td>${cell.assignmentCompletedCount}</td></tr>`).join("")}</tbody></table>
  <footer>후속 돌봄 생성 ${summary.taskCreatedCount}건 · 완료 ${summary.taskCompletedCount}건 · 기도 시작 ${summary.prayerStartedCount}건 · 응답 ${summary.prayerAnsweredCount}건</footer></body></html>`;
}

function downloadReportWord() {
  if (!state.report) return;
  const blob = new Blob(["\ufeff", reportDocumentHtml(state.report)], { type: "application/msword;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${state.report.periodLabel}-목양보고-${state.report.startDate}-${state.report.endDate}.doc`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function printReport() {
  if (!state.report) return;
  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    toast("팝업을 허용한 뒤 다시 시도하세요");
    return;
  }
  printWindow.opener = null;
  printWindow.document.open();
  printWindow.document.write(reportDocumentHtml(state.report));
  printWindow.document.close();
  printWindow.focus();
  window.setTimeout(() => printWindow.print(), 300);
}

function renderUserCellPicker(selected = []) {
  const selectedSet = new Set(selected);
  el.userCellPicker.innerHTML = (state.overview?.cells || []).map((cell) => `<label class="cell-choice"><input type="checkbox" value="${attr(cell.id)}" ${selectedSet.has(cell.id) ? "checked" : ""}><span><strong>${html(cell.name)}</strong><small>${html(cell.meta || "")}</small></span></label>`).join("");
  syncUserRoleControls();
}

function renderUsers() {
  if (!state.overview?.viewer?.canManageUsers) return;
  const users = state.overview.managedUsers || [];
  el.userList.innerHTML = users.map((user) => `<article class="user-item">
    <div class="work-item-head"><div><h4>${html(user.displayName)}</h4><p>${html(user.username)} · ${html(user.roleLabel)}</p></div><span class="status-badge status-${attr(user.status)}">${user.status === "active" ? "사용 중" : "사용 중지"}</span></div>
    <p>${user.hasGlobalScope ? "전체 셀" : (user.cellIds || []).map(cellName).join(", ") || "담당 셀 없음"}</p>
    <div class="work-meta"><span>${user.canViewSensitive ? "민감정보 열람" : "민감정보 가림"}</span><span>${user.canEdit ? "수정 가능" : "조회 전용"}</span>${user.lastLoginAt ? `<span>최근 로그인 ${formatDateTime(user.lastLoginAt)}</span>` : ""}</div>
    ${user.id !== "owner" ? `<div class="item-actions"><button data-user-action="edit" data-user-id="${attr(user.id)}" type="button">권한 편집</button><button data-user-action="toggle" data-user-id="${attr(user.id)}" type="button">${user.status === "active" ? "사용 중지" : "다시 사용"}</button></div>` : ""}
  </article>`).join("");
}

function syncUserRoleControls() {
  const global = el.userRole.value === "pastor";
  el.userCellPicker.classList.toggle("hidden", global);
  if (el.userRole.value === "viewer") {
    el.userCanEdit.checked = false;
    el.userCanEdit.disabled = true;
  } else {
    el.userCanEdit.disabled = false;
  }
}

async function saveUser(event) {
  event.preventDefault();
  const cellIds = [...el.userCellPicker.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
  const body = {
    displayName: el.userDisplayName.value.trim(),
    role: el.userRole.value,
    cellIds,
    canViewSensitive: el.userCanSensitive.checked,
    canEdit: el.userCanEdit.checked
  };
  if (el.userPassword.value) body.password = el.userPassword.value;
  if (!state.editingUserId) {
    body.username = el.userUsername.value.trim();
    if (!body.password) {
      toast("12자 이상의 임시 비밀번호를 입력하세요");
      return;
    }
  }
  try {
    await api(state.editingUserId ? `/api/community/users/${encodeURIComponent(state.editingUserId)}` : "/api/community/users", {
      method: state.editingUserId ? "PATCH" : "POST",
      body
    });
    toast(state.editingUserId ? "사용자 권한을 저장했습니다" : "사용자 계정을 만들었습니다");
    resetUserForm();
    await loadOverview();
  } catch (error) {
    toast(error.message);
  }
}

async function handleUserAction(event) {
  const button = event.target.closest("[data-user-action]");
  if (!button) return;
  const user = (state.overview.managedUsers || []).find((item) => item.id === button.dataset.userId);
  if (!user) return;
  if (button.dataset.userAction === "edit") {
    state.editingUserId = user.id;
    el.userFormTitle.textContent = `${user.displayName} 권한 편집`;
    el.userSubmitBtn.textContent = "권한 저장";
    el.cancelUserEditBtn.classList.remove("hidden");
    el.userUsername.value = user.username;
    el.userUsername.disabled = true;
    el.userDisplayName.value = user.displayName;
    el.userPassword.value = "";
    el.userPassword.required = false;
    el.userPassword.placeholder = "변경할 때만 12자 이상 입력";
    el.userRole.value = user.role;
    el.userCanSensitive.checked = user.canViewSensitive;
    el.userCanEdit.checked = user.canEdit;
    renderUserCellPicker(user.cellIds || []);
    el.userForm.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const nextStatus = user.status === "active" ? "disabled" : "active";
  if (nextStatus === "disabled" && !window.confirm(`${user.displayName} 계정을 사용 중지할까요? 등록된 자동 로그인과 알림도 해제됩니다.`)) return;
  try {
    await api(`/api/community/users/${encodeURIComponent(user.id)}`, { method: "PATCH", body: { status: nextStatus } });
    toast(nextStatus === "active" ? "계정을 다시 사용할 수 있습니다" : "계정을 사용 중지했습니다");
    await loadOverview();
  } catch (error) {
    toast(error.message);
  }
}

function resetUserForm() {
  state.editingUserId = "";
  el.userForm.reset();
  el.userFormTitle.textContent = "사용자 추가";
  el.userSubmitBtn.textContent = "계정 만들기";
  el.cancelUserEditBtn.classList.add("hidden");
  el.userUsername.disabled = false;
  el.userPassword.required = true;
  el.userPassword.placeholder = "";
  el.userRole.value = "pastor";
  el.userCanEdit.checked = true;
  renderUserCellPicker();
}

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");
  let body = options.body;
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(body);
  }
  const response = await fetch(url, { ...options, headers, body, credentials: "same-origin" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "요청을 처리하지 못했습니다");
    error.code = payload.code || "";
    throw error;
  }
  return payload;
}

function optionList(rows, valueKey, label) {
  return rows.map((row) => `<option value="${attr(row[valueKey])}">${html(label(row))}</option>`).join("");
}

function cellName(id) {
  return (state.overview?.cells || []).find((cell) => cell.id === id)?.name || id || "셀 미지정";
}

function assignmentStatusLabel(value) {
  return { waiting: "대기", contacted: "연락함", visit_planned: "심방 예정", completed: "완료", cancelled: "취소" }[value] || value;
}

function assignmentSourceLabel(value) {
  return { manual: "직접 등록", birthday: "생일", new_family: "새가족", attendance: "출석", care_gap: "심방 공백", task: "후속 돌봄", prayer: "기도" }[value] || value;
}

function newcomerStatusLabel(value) {
  return { pending: "검토 대기", approved: "등록 완료", rejected: "반려" }[value] || value;
}

function formatPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return digits;
}

function formatDate(value) {
  const date = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.replace(/-/g, ".") : "";
}

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(date)
    : "";
}

function localDateString(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function uniqueBy(rows, key) {
  const seen = new Set();
  return rows.filter((row) => {
    const value = key(row);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

let toastTimer = 0;
function toast(message) {
  el.toast.textContent = message || "처리했습니다";
  el.toast.classList.remove("hidden");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.toast.classList.add("hidden"), 2800);
}

function html(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function attr(value) {
  return html(value);
}

function multiline(value) {
  return html(value).replace(/\r?\n/g, "<br>");
}
