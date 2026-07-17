import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("settings separate Relay enrollment, FCM pairing, and the existing webhook in that order", () => {
  const relay = html.indexOf('id="relayEnrollmentSettingsTitle"');
  const fcm = html.indexOf('id="mobileNotificationSettingsTitle"');
  const webhook = html.indexOf('id="callNoteWebhookUrl"');
  assert.ok(relay >= 0 && relay < fcm && fcm < webhook);
  assert.match(html, /1단계 · 중앙 Relay 사이트 등록/);
  assert.match(html, /2단계 · FCM 앱 연결\(메모·심방 알림\)/);
  assert.match(html, /FCM 앱 6자리 연결코드 만들기/);
  assert.match(html, /중앙 관리자에게 보낼 등록 요청 코드/);
  assert.match(html, /relayEnrollmentRequestCodeOutput[^>]+readonly/);
  assert.doesNotMatch(html, /등록 요청 6자리/);
});

test("this site exposes no central operator controls or secrets", () => {
  assert.doesNotMatch(html, /centralRelayOperator|다른 사이트에서 받은 코드|등록 사이트 목록/);
  assert.doesNotMatch(app, /CENTRAL_RELAY_OPERATOR|RELAY_OPERATOR_TOKEN|relay-operator/);
  assert.doesNotMatch(`${html}\n${app}`, /RELAY_HMAC_SECRET/);
  assert.doesNotMatch(app, /result\.secret|payload\.secret/);
});

test("FCM pairing remains locked until a trustworthy Relay enrollment is connected", () => {
  const match = app.match(/function relayEnrollmentReady\(data\) \{([\s\S]*?)\n\}/);
  assert.ok(match, "relayEnrollmentReady must remain a standalone testable function");
  const ready = new Function("data", match[1]);
  assert.equal(ready(undefined), false);
  assert.equal(ready({ error: "status failed" }), false);
  assert.equal(ready({ pushTransport: "relay", relayEnrollment: { state: "pending" }, relayClientConfigured: true }), false);
  assert.equal(ready({ pushTransport: "relay", relayEnrollment: { state: "not_registered" } }), false);
  assert.equal(ready({ pushTransport: "relay", relayEnrollment: { state: "connected" } }), true);
  assert.equal(ready({ pushTransport: "relay", relayClientConfigured: true }), true);
  assert.equal(ready({ pushTransport: "direct" }), true);
  assert.match(app, /1단계 중앙 Relay 사이트 등록을 먼저 완료하세요/);
});
