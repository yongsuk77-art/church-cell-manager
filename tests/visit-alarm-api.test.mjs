import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeVisit,
  normalizeVisitAlarmDateTime
} from "../functions/api/[[path]].js";

const ALARM_AT = "2026-07-14T10:30:00+09:00";
const ALARM_AT_UTC = "2026-07-14T01:30:00.000Z";

test("visit alarm timestamps are normalized to UTC, including the legacy Korea-local format", () => {
  assert.equal(normalizeVisitAlarmDateTime(ALARM_AT), ALARM_AT_UTC);
  assert.equal(normalizeVisitAlarmDateTime("2026-07-14T10:30"), ALARM_AT_UTC);
});

test("a manual alarm visit receives a stable scheduled alarm identity", () => {
  const visit = normalizeVisit({
    id: "visit-1",
    memberId: "member-1",
    visitDate: "2026-07-14",
    visitType: "알람",
    summary: "Follow up",
    action: `visit-meta:${JSON.stringify({ alarmAt: ALARM_AT })}`,
    alarmAt: ALARM_AT,
    source: "manual"
  });
  assert.equal(visit.alarmAt, ALARM_AT_UTC);
  assert.equal(visit.alarmState, "scheduled");
  assert.match(visit.alarmId, /^[0-9a-f-]{36}$/i);
  assert.equal(visit.alarmDismissedAt, "");
});

test("ordinary edits keep an alarm id, while rescheduling and reactivation rotate it", () => {
  const previous = {
    id: "visit-1",
    memberId: "member-1",
    visitDate: "2026-07-14",
    visitType: "알람",
    summary: "Old",
    prayer: "",
    action: `visit-meta:${JSON.stringify({ alarmAt: ALARM_AT_UTC })}`,
    source: "manual",
    rawPayload: "",
    alarmAt: ALARM_AT_UTC,
    alarmState: "scheduled",
    alarmId: "11111111-1111-4111-8111-111111111111",
    alarmDismissedAt: "",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z"
  };
  const edited = normalizeVisit({ summary: "New" }, previous);
  assert.equal(edited.alarmId, previous.alarmId);
  assert.equal(edited.alarmAt, previous.alarmAt);

  const rescheduled = normalizeVisit({
    alarmAt: "2026-07-14T11:30:00+09:00",
    action: `visit-meta:${JSON.stringify({ alarmAt: "2026-07-14T11:30:00+09:00" })}`,
    alarmState: "scheduled"
  }, previous);
  assert.notEqual(rescheduled.alarmId, previous.alarmId);

  const dismissedPrevious = { ...previous, alarmState: "dismissed", alarmDismissedAt: "2026-07-13T01:00:00.000Z" };
  const reactivated = normalizeVisit({ alarmState: "scheduled" }, dismissedPrevious);
  assert.notEqual(reactivated.alarmId, previous.alarmId);
  assert.equal(reactivated.alarmState, "scheduled");
});

test("dismissal is persisted and trashing or changing type removes the active alarm source", () => {
  const previous = normalizeVisit({
    id: "visit-1",
    memberId: "member-1",
    visitType: "알람",
    summary: "Alarm",
    alarmAt: ALARM_AT,
    action: `visit-meta:${JSON.stringify({ alarmAt: ALARM_AT })}`,
    source: "manual"
  });
  const dismissed = normalizeVisit({ alarmState: "dismissed" }, previous);
  assert.equal(dismissed.alarmState, "dismissed");
  assert.equal(dismissed.alarmId, previous.alarmId);
  assert.ok(dismissed.alarmDismissedAt);

  const trashed = normalizeVisit({
    action: `visit-meta:${JSON.stringify({ alarmAt: ALARM_AT, trashedAt: "2026-07-14T00:00:00.000Z" })}`
  }, previous);
  assert.deepEqual(
    [trashed.alarmAt, trashed.alarmState, trashed.alarmId, trashed.alarmDismissedAt],
    ["", "none", "", ""]
  );

  const changedType = normalizeVisit({ visitType: "전화" }, previous);
  assert.equal(changedType.alarmState, "none");
  assert.equal(changedType.alarmId, "");

  const dismissedTrashed = normalizeVisit({
    action: `visit-meta:${JSON.stringify({ alarmAt: ALARM_AT, trashedAt: "2026-07-14T00:00:00.000Z" })}`
  }, dismissed);
  assert.equal(dismissedTrashed.alarmState, "dismissed");
  assert.equal(dismissedTrashed.alarmId, dismissed.alarmId);
  const dismissedRestored = normalizeVisit({
    action: `visit-meta:${JSON.stringify({ alarmAt: ALARM_AT })}`
  }, dismissedTrashed);
  assert.equal(dismissedRestored.alarmState, "dismissed");
  assert.equal(dismissedRestored.alarmId, dismissed.alarmId);
});

test("non-manual visit records cannot request phone alarms", () => {
  assert.throws(() => normalizeVisit({
    memberId: "member-1",
    visitType: "알람",
    summary: "Imported",
    alarmAt: ALARM_AT,
    source: "call-note-app"
  }), /cannot schedule alarms/);

  const importedWithoutAlarmRequest = normalizeVisit({
    memberId: "member-1",
    visitType: "알람",
    summary: "Imported",
    source: "call-note-app"
  });
  assert.equal(importedWithoutAlarmRequest.alarmState, "none");
  assert.equal(importedWithoutAlarmRequest.alarmId, "");
});
