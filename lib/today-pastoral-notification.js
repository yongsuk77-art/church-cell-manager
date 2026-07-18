const KOREA_OFFSET_MS = 9 * 60 * 60 * 1000;
const ATTENDANCE_STATUSES = new Set(["present", "online", "absent", "military", "study", "other"]);
const VISIT_META_PREFIX = "visit-meta:";

export async function readTodayPastoralNotificationSummary(env, now = new Date()) {
  if (!env?.DB) throw new Error("DATABASE_UNAVAILABLE");
  const today = koreaDateKey(now);
  const newFamilyThreshold = shiftDateKey(today, -60);
  const careThreshold = shiftDateKey(today, -90);
  const [membersResult, visitsResult, tasksResult, prayersResult, sessionsResult, attendanceResult] = await Promise.all([
    env.DB.prepare(
      `SELECT id, birth, registered_at AS registeredAt
       FROM members
       WHERE COALESCE(archived_at, '') = '' AND COALESCE(trashed_at, '') = ''`
    ).all(),
    env.DB.prepare(
      `SELECT member_id AS memberId, visit_date AS visitDate, action
       FROM visit_notes
       ORDER BY visit_date DESC, created_at DESC`
    ).all(),
    env.DB.prepare(
      `SELECT member_id AS memberId
       FROM care_tasks
       WHERE status = 'pending' AND due_date < ?`
    ).bind(today).all(),
    env.DB.prepare(
      `SELECT member_id AS memberId
       FROM prayer_topics
       WHERE status = 'praying' AND priority = 'urgent'`
    ).all(),
    env.DB.prepare(
      `SELECT id, attendance_date AS attendanceDate
       FROM sunday_attendance_sessions
       ORDER BY attendance_date DESC
       LIMIT 4`
    ).all(),
    env.DB.prepare(
      `SELECT r.member_id AS memberId, r.present, r.attendance_status AS attendanceStatus,
        s.attendance_date AS attendanceDate
       FROM sunday_attendance_records r
       JOIN sunday_attendance_sessions s ON s.id = r.session_id
       WHERE s.id IN (
         SELECT id FROM sunday_attendance_sessions ORDER BY attendance_date DESC LIMIT 4
       )
       ORDER BY s.attendance_date DESC`
    ).all()
  ]);

  const members = membersResult.results || [];
  const memberIds = new Set(members.map((member) => String(member.id || "")).filter(Boolean));
  const lastVisitByMember = new Map();
  for (const row of visitsResult.results || []) {
    const memberId = String(row.memberId || "");
    if (!memberIds.has(memberId) || lastVisitByMember.has(memberId) || visitIsTrashed(row.action)) continue;
    lastVisitByMember.set(memberId, clean(row.visitDate));
  }

  const birthdays = members.filter((member) => birthdayDaysUntil(member.birth, today) === 0).length;
  const newFamilies = members.filter((member) => {
    const registeredAt = normalizeDateKey(member.registeredAt);
    if (!registeredAt || registeredAt < newFamilyThreshold || registeredAt > today) return false;
    const lastVisitDate = lastVisitByMember.get(String(member.id || "")) || "";
    return !lastVisitDate || lastVisitDate < registeredAt;
  }).length;
  const careGaps = members.filter((member) => {
    const lastVisitDate = lastVisitByMember.get(String(member.id || "")) || "";
    return !lastVisitDate || lastVisitDate <= careThreshold;
  }).length;

  const sessions = sessionsResult.results || [];
  const attendanceByMember = new Map();
  for (const row of attendanceResult.results || []) {
    const memberId = String(row.memberId || "");
    if (!memberIds.has(memberId)) continue;
    if (!attendanceByMember.has(memberId)) attendanceByMember.set(memberId, []);
    attendanceByMember.get(memberId).push(row);
  }
  let attendanceRisks = 0;
  for (const member of members) {
    const records = attendanceByMember.get(String(member.id || "")) || [];
    let consecutiveAbsences = 0;
    for (const session of sessions) {
      const record = records.find((item) => item.attendanceDate === session.attendanceDate);
      if (!record || normalizeAttendanceStatus(record.attendanceStatus, record.present) !== "absent") break;
      consecutiveAbsences += 1;
    }
    if (consecutiveAbsences >= 3) attendanceRisks += 1;
  }

  const overdueTasks = (tasksResult.results || [])
    .filter((task) => memberIds.has(String(task.memberId || ""))).length;
  const urgentPrayers = (prayersResult.results || [])
    .filter((topic) => memberIds.has(String(topic.memberId || ""))).length;
  const notificationCount = birthdays + newFamilies + attendanceRisks + careGaps + overdueTasks + urgentPrayers;

  return {
    today,
    birthdays,
    newFamilies,
    attendanceRisks,
    careGaps,
    overdueTasks,
    urgentPrayers,
    notificationCount
  };
}

export function koreaDateKey(date = new Date()) {
  return new Date(date.getTime() + KOREA_OFFSET_MS).toISOString().slice(0, 10);
}

export function todayPastoralTriggerAt(dateKey, hour = 8) {
  const normalizedHour = Number.isInteger(Number(hour))
    ? Math.max(0, Math.min(23, Number(hour)))
    : 8;
  const date = normalizeDateKey(dateKey);
  if (!date) return new Date(Number.NaN);
  return new Date(`${date}T${String(normalizedHour).padStart(2, "0")}:00:00+09:00`);
}

function shiftDateKey(value, dayOffset) {
  const date = normalizeDateKey(value);
  if (!date) return "";
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + Number(dayOffset || 0))).toISOString().slice(0, 10);
}

function birthdayDaysUntil(birthValue, todayValue) {
  const birth = normalizeDateKey(birthValue);
  const today = normalizeDateKey(todayValue);
  if (!birth || !today) return -1;
  const [, month, day] = birth.split("-").map(Number);
  const [year, todayMonth, todayDay] = today.split("-").map(Number);
  const todayUtc = Date.UTC(year, todayMonth - 1, todayDay);
  let birthdayUtc = Date.UTC(year, month - 1, day);
  if (birthdayUtc < todayUtc) birthdayUtc = Date.UTC(year + 1, month - 1, day);
  return Math.round((birthdayUtc - todayUtc) / 86400000);
}

function normalizeDateKey(value) {
  const match = /(\d{4})[-./](\d{1,2})[-./](\d{1,2})/.exec(clean(value));
  if (!match) return "";
  const month = String(Number(match[2])).padStart(2, "0");
  const day = String(Number(match[3])).padStart(2, "0");
  const normalized = `${match[1]}-${month}-${day}`;
  const timestamp = Date.parse(`${normalized}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== normalized) return "";
  return normalized;
}

function normalizeAttendanceStatus(value, presentFallback = false) {
  const status = clean(value);
  if (ATTENDANCE_STATUSES.has(status)) return status;
  return truthy(presentFallback) ? "present" : "absent";
}

function visitIsTrashed(action) {
  const text = clean(action);
  if (!text.startsWith(VISIT_META_PREFIX)) return false;
  try {
    const parsed = JSON.parse(text.slice(VISIT_META_PREFIX.length));
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.trashedAt);
  } catch {
    return false;
  }
}

function truthy(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function clean(value) {
  return String(value || "").trim();
}
