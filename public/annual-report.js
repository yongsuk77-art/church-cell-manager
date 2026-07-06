const ANNUAL_ROLES = [
  { value: "cell_leader", label: "셀장" },
  { value: "assistant_leader", label: "부셀장" },
  { value: "prayer_leader", label: "기도장" }
];

const FIRST_PAGE_MEMBER_SLOTS = 30;
const CONTINUATION_MEMBER_SLOTS = 36;

const annualState = {
  settings: {},
  cells: [],
  members: [],
  showLongAbsent: false,
  showCoverLogo: true
};

const annualEl = {};
let annualNoticeTimer = 0;

document.addEventListener("DOMContentLoaded", initAnnualReport);

async function initAnnualReport() {
  [
    "annualBook",
    "annualStatus",
    "annualShowLongAbsent",
    "annualShowLogo",
    "annualRefreshBtn",
    "annualPrintBtn",
    "annualBackBtn",
    "annualPrintNotice"
  ].forEach((id) => {
    annualEl[id] = document.getElementById(id);
  });


  annualEl.annualShowLongAbsent.addEventListener("change", () => {
    annualState.showLongAbsent = annualEl.annualShowLongAbsent.checked;
    renderAnnualReport();
  });
  annualEl.annualShowLogo.addEventListener("change", () => {
    annualState.showCoverLogo = annualEl.annualShowLogo.checked;
    renderAnnualReport();
  });
  annualEl.annualRefreshBtn.addEventListener("click", () => {
    showAnnualNotice("최신 성도, 사진, 설정 자료를 다시 불러옵니다.");
    loadAnnualData();
  });
  annualEl.annualPrintBtn.addEventListener("click", handleAnnualPrint);
  annualEl.annualBackBtn.addEventListener("click", () => {
    window.location.href = "/index.html";
  });

  await loadAnnualData();
}


function handleAnnualPrint() {
  if (shouldBlockMobilePrint()) {
    showAnnualNotice("PDF 저장은 PC에서 해야 안정적입니다. 컴퓨터에서 접속해 PDF 저장을 진행해 주세요.");
    return;
  }
  window.print();
}

function shouldBlockMobilePrint() {
  const narrowScreen = window.matchMedia("(max-width: 900px)").matches;
  const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  return narrowScreen || (coarsePointer && window.innerWidth < 1200);
}

function showAnnualNotice(message) {
  if (!annualEl.annualPrintNotice) return;
  annualEl.annualPrintNotice.textContent = message;
  annualEl.annualPrintNotice.hidden = false;
  window.clearTimeout(annualNoticeTimer);
  annualNoticeTimer = window.setTimeout(() => {
    annualEl.annualPrintNotice.hidden = true;
  }, 5200);
}
async function loadAnnualData() {
  annualEl.annualStatus.textContent = "자료를 불러오는 중입니다";
  annualEl.annualBook.innerHTML = "";

  try {
    const response = await fetch("/api/bootstrap", {
      cache: "no-store",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error("bootstrap failed");

    const data = await response.json();
    annualState.settings = data.settings || {};
    annualState.cells = Array.isArray(data.cells) ? data.cells : [];
    annualState.members = Array.isArray(data.members) ? data.members : [];
    renderAnnualReport();
  } catch (error) {
    annualEl.annualStatus.textContent = "자료를 불러오지 못했습니다";
    annualEl.annualBook.innerHTML = `<div class="annual-error">연감 자료를 불러오지 못했습니다. 로그인 상태와 네트워크를 확인한 뒤 새로고침하세요.</div>`;
  }
}

function renderAnnualReport() {
  const cells = annualState.cells
    .slice()
    .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
  const pages = [coverPageHtml()];

  cells.forEach((cell) => {
    pages.push(...cellPagesHtml(cell));
  });

  annualEl.annualBook.innerHTML = pages.join("");
  annualEl.annualStatus.textContent = `${cells.length}개 셀, ${visibleAnnualMembers().length}명`;
  document.title = `${coverTitleText()} 사진요람`;
}

function coverPageHtml() {
  const titleLines = coverTitleLines();
  const year = new Date().getFullYear();
  return `<section class="annual-page annual-cover" aria-label="표지">
    <div class="cover-panel"></div>
    <div class="cover-title">${titleLines.map(escapeHtml).join("<br>")}</div>
    <div class="cover-year">${year}</div>
    ${annualState.showCoverLogo ? '<img class="cover-logo" src="./annual-logo.png?v=annual-logo-1" alt="서산교회">' : ""}
  </section>`;
}

function cellPagesHtml(cell) {
  const members = cellMembers(cell.id);
  const leaderIds = new Set();
  const leaders = ANNUAL_ROLES.map((role) => {
    const member = members.find((item) => item.role === role.value);
    if (member) leaderIds.add(member.id);
    return { role, member };
  });
  const regulars = members.filter((member) => !leaderIds.has(member.id));
  const first = regulars.slice(0, FIRST_PAGE_MEMBER_SLOTS);
  const rest = chunk(regulars.slice(FIRST_PAGE_MEMBER_SLOTS), CONTINUATION_MEMBER_SLOTS);
  const pages = [
    cellPageHtml(cell, leaders, first, false)
  ];

  rest.forEach((group) => {
    pages.push(cellPageHtml(cell, [], group, true));
  });
  return pages;
}

function cellPageHtml(cell, leaders, members, continuation) {
  const slotCount = continuation ? CONTINUATION_MEMBER_SLOTS : FIRST_PAGE_MEMBER_SLOTS;
  return `<section class="annual-page annual-sheet ${continuation ? "annual-continuation" : ""}" aria-label="${escapeAttribute(cellTitle(cell))}">
    <div class="annual-table">
      <div class="annual-cell-title">${escapeHtml(cellTitle(cell))}</div>
      ${continuation ? "" : leaderGridHtml(leaders)}
      ${memberGridHtml(members, slotCount)}
    </div>
  </section>`;
}

function leaderGridHtml(leaders) {
  const slots = leaders.length ? leaders : ANNUAL_ROLES.map((role) => ({ role, member: null }));
  return `<div class="annual-leader-grid">
    ${slots.map(({ role, member }) => leaderCardHtml(member, role)).join("")}
  </div>`;
}

function leaderCardHtml(member, role) {
  if (!member) {
    return `<div class="annual-leader-card empty">
      <div class="annual-leader-photo"></div>
      <div class="annual-caption"></div>
    </div>`;
  }

  return `<div class="annual-leader-card">
    ${longAbsentBadgeHtml(member)}
    <div class="annual-leader-photo">${photoHtml(member)}</div>
    ${captionHtml(member, role.label, true)}
  </div>`;
}

function memberGridHtml(members, slotCount) {
  const slots = paddedSlots(members, slotCount);
  return `<div class="annual-member-grid">
    ${slots.map((member) => personCardHtml(member)).join("")}
  </div>`;
}

function personCardHtml(member) {
  if (!member) {
    return `<div class="annual-person-card empty">
      <div class="annual-person-photo"></div>
      <div class="annual-caption"></div>
    </div>`;
  }

  return `<div class="annual-person-card">
    ${longAbsentBadgeHtml(member)}
    <div class="annual-person-photo">${photoHtml(member)}</div>
    ${captionHtml(member)}
  </div>`;
}

function longAbsentBadgeHtml(member) {
  if (!annualState.showLongAbsent || !member?.longAbsent) return "";
  return '<span class="annual-long-absent">장기결석</span>';
}

function photoHtml(member) {
  const src = memberPhotoSrc(member);
  if (!src) return "";
  return `<img src="${escapeAttribute(src)}" alt="${escapeAttribute(member.name || "")}" loading="eager">`;
}

function memberPhotoSrc(member) {
  const src = member.photoUrl || (member.photoKey ? `/api/photos/${encodeURIComponent(member.photoKey)}` : "");
  if (!src) return "";
  try {
    return new URL(src, window.location.origin).href;
  } catch {
    return src;
  }
}

function captionHtml(member, roleLabel = "", wide = false) {
  const caption = memberCaption(member, roleLabel);
  const sizeClass = captionSizeClass(caption, wide);
  return `<div class="annual-caption ${sizeClass}">${escapeHtml(caption)}</div>`;
}

function captionSizeClass(text, wide = false) {
  const metric = captionMetric(text);
  const thresholds = wide
    ? [16, 14, 12, 10]
    : [11, 9, 8, 7];
  if (metric >= thresholds[0]) return "caption-micro";
  if (metric >= thresholds[1]) return "caption-tiny";
  if (metric >= thresholds[2]) return "caption-tight";
  if (metric >= thresholds[3]) return "caption-compact";
  return "";
}

function captionMetric(text) {
  return Array.from(cleanAnnualText(text).replace(/[\s()]/g, "")).length;
}

function memberCaption(member, roleLabel = "") {
  const text = [member.name, member.title].map(cleanAnnualText).filter(Boolean).join(" ");
  return roleLabel ? `${text} (${roleLabel})` : text;
}

function cellTitle(cell) {
  const name = cleanAnnualText(cell.name);
  const meta = cleanAnnualText(cell.meta);
  return meta ? `${name}  (${meta})` : name;
}

function cellMembers(cellId) {
  return visibleAnnualMembers()
    .filter((member) => member.cellId === cellId)
    .sort(compareAnnualMembers);
}

function visibleAnnualMembers() {
  return annualState.members.filter((member) => {
    if (member.trashedAt) return false;
    if (member.archivedAt) return false;
    return true;
  });
}

function compareAnnualMembers(a, b) {
  const roleDiff = annualRoleRank(a.role) - annualRoleRank(b.role);
  if (roleDiff) return roleDiff;
  const nameDiff = cleanAnnualText(a.name).localeCompare(cleanAnnualText(b.name), "ko-KR", { numeric: true });
  if (nameDiff) return nameDiff;
  return String(a.id || "").localeCompare(String(b.id || ""), "ko-KR", { numeric: true });
}

function annualRoleRank(role) {
  const ranks = {
    cell_leader: 0,
    assistant_leader: 1,
    prayer_leader: 2
  };
  return Object.prototype.hasOwnProperty.call(ranks, role) ? ranks[role] : 10;
}

function paddedSlots(items, count) {
  const slots = items.slice(0, count);
  while (slots.length < count) slots.push(null);
  return slots;
}

function chunk(items, size) {
  const groups = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}

function coverTitleText() {
  return cleanAnnualText(annualState.settings?.communityTitle) || "공동체";
}

function coverTitleLines() {
  const title = coverTitleText();
  const words = title.split(/\s+/).filter(Boolean);
  if (!words.length) return ["공동체", "사진요람"];
  if (words.length === 1) return [words[0], "사진요람"];
  return [...words, "사진요람"];
}

function cleanAnnualText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}
