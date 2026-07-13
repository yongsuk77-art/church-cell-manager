import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

function position(marker) {
  const index = html.indexOf(marker);
  assert.notEqual(index, -1, `missing settings marker: ${marker}`);
  return index;
}

test("settings navigation exposes the three requested category buttons", () => {
  const targets = [...html.matchAll(/data-settings-target="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(targets, [
    "settingsBasicSection",
    "settingsSecuritySection",
    "settingsCallNoteAppSection"
  ]);
  assert.match(html, />기본 설정<\/button>/);
  assert.match(html, />비밀번호 변경<\/button>/);
  assert.match(html, />심방콜노트 앱<\/button>/);
});

test("security and call-note settings are grouped while PDF remains last", () => {
  const basic = position('id="settingsBasicSection"');
  const groups = position('id="managedGroupSettingsTitle"');
  const security = position('id="settingsSecuritySection"');
  const guest = position('id="guestAccountSettingsTitle"');
  const passkey = position('id="passkeySettingsTitle"');
  const password = position('id="adminPasswordSettingsTitle"');
  const passwordActions = position('id="settingsCancelBtn"');
  const callNoteApp = position('id="settingsCallNoteAppSection"');
  const webhook = position('id="callNoteWebhookUrl"');
  const mobile = position('id="mobileNotificationSettingsTitle"');
  const annual = position('class="call-note-settings annual-settings admin-only"');
  const pdf = position('id="annualReportBtn"');

  assert.ok(basic < groups);
  assert.ok(groups < security);
  assert.ok(security < guest && guest < passkey && passkey < password);
  assert.ok(password < passwordActions && passwordActions < callNoteApp);
  assert.ok(callNoteApp < webhook && webhook < mobile);
  assert.ok(mobile < annual && annual < pdf);
});

test("settings category buttons use accessible in-dialog smooth navigation", () => {
  assert.match(script, /settingsCategoryNav\.addEventListener\("click", handleSettingsCategoryNavigation\)/);
  assert.match(script, /target\.scrollIntoView\(\{/);
  assert.match(script, /setActiveSettingsCategory\("settingsBasicSection"\)/);
  assert.match(styles, /\.settings-category-nav\s*\{[\s\S]*?position:\s*sticky;/);
  assert.match(styles, /\.settings-jump-target\s*\{[\s\S]*?scroll-margin-top:/);
});
