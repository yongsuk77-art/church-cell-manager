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

test("settings navigation exposes three accessible tabs", () => {
  const targets = [...html.matchAll(/data-settings-target="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(targets, [
    "settingsBasicSection",
    "settingsSecuritySection",
    "settingsCallNoteAppSection"
  ]);
  assert.match(html, />기본 설정<\/button>/);
  assert.match(html, />비밀번호 변경<\/button>/);
  assert.match(html, />심방콜노트 앱<\/button>/);
  assert.match(html, /id="settingsCategoryNav"[^>]*role="tablist"/);
  assert.match(html, /id="settingsBasicTab"[^>]*role="tab"[^>]*aria-selected="true"[^>]*tabindex="0"/);
  assert.match(html, /id="settingsSecurityTab"[^>]*role="tab"[^>]*aria-selected="false"[^>]*tabindex="-1"/);
  assert.match(html, /id="settingsCallNoteAppTab"[^>]*role="tab"[^>]*aria-selected="false"[^>]*tabindex="-1"/);
});

test("each settings category is a separate tab panel with the requested content", () => {
  const basic = position('id="settingsBasicSection"');
  const title = position('id="communityTitleInput"');
  const groups = position('id="managedGroupSettingsTitle"');
  const annual = position('class="call-note-settings annual-settings admin-only"');
  const pdf = position('id="annualReportBtn"');
  const security = position('id="settingsSecuritySection"');
  const guest = position('id="guestAccountSettingsTitle"');
  const passkey = position('id="passkeySettingsTitle"');
  const password = position('id="adminPasswordSettingsTitle"');
  const reset = position('id="passkeyPasswordResetBtn"');
  const passwordActions = position('id="settingsCancelBtn"');
  const callNoteApp = position('id="settingsCallNoteAppSection"');
  const webhook = position('id="callNoteWebhookUrl"');
  const mobile = position('id="mobileNotificationSettingsTitle"');

  assert.match(html, /id="settingsBasicSection"[^>]*role="tabpanel"[^>]*aria-labelledby="settingsBasicTab"/);
  assert.match(html, /id="settingsSecuritySection"[^>]*role="tabpanel"[^>]*aria-labelledby="settingsSecurityTab"[^>]*hidden/);
  assert.match(html, /id="settingsCallNoteAppSection"[^>]*role="tabpanel"[^>]*aria-labelledby="settingsCallNoteAppTab"[^>]*hidden/);
  assert.ok(basic < title && title < groups && groups < annual && annual < pdf);
  assert.ok(pdf < security);
  assert.ok(security < guest && guest < passkey && passkey < password);
  assert.ok(password < reset && reset < passwordActions && passwordActions < callNoteApp);
  assert.ok(callNoteApp < webhook && webhook < mobile);
});

test("settings tabs switch panels without scrolling and support keyboard navigation", () => {
  assert.match(script, /settingsCategoryNav\.addEventListener\("click", handleSettingsCategoryNavigation\)/);
  assert.match(script, /settingsCategoryNav\.addEventListener\("keydown", handleSettingsCategoryKeydown\)/);
  assert.match(script, /setActiveSettingsCategory\("settingsBasicSection"\)/);
  assert.match(script, /button\.setAttribute\("aria-selected", String\(active\)\)/);
  assert.match(script, /panel\.hidden = panel\.id !== targetId/);
  assert.match(script, /event\.key === "ArrowRight"/);
  assert.match(script, /event\.key === "ArrowLeft"/);
  assert.match(script, /event\.key === "Home"/);
  assert.match(script, /event\.key === "End"/);
  const clickHandler = script.slice(
    script.indexOf("function handleSettingsCategoryNavigation"),
    script.indexOf("function handleSettingsCategoryKeydown")
  );
  assert.doesNotMatch(clickHandler, /scrollIntoView/);
  assert.match(styles, /\.settings-category-panel\[hidden\]\s*\{[\s\S]*?display:\s*none;/);
});

test("each settings action is independent from the shared form submit event", () => {
  assert.match(html, /id="adminPasswordSaveBtn"[^>]*type="button"/);
  assert.doesNotMatch(html, /id="settingsForm"[\s\S]*?<button[^>]*type="submit"/);
  assert.match(script, /settingsForm\.addEventListener\("submit", \(event\) => event\.preventDefault\(\)\)/);
  assert.match(script, /adminPasswordSaveBtn\.addEventListener\("click", changePassword\)/);
  assert.match(script, /el\.adminPasswordSaveBtn\.disabled = true/);
});

test("passkey password reset collects a confirmed password and uses WebAuthn assertion APIs", () => {
  assert.match(html, /id="resetNewPassword"[^>]*minlength="12"/);
  assert.match(html, /id="resetConfirmPassword"[^>]*minlength="12"/);
  assert.match(html, /id="passkeyPasswordResetBtn"[^>]*>지문·패스키로 확인 후 비밀번호 재설정<\/button>/);
  assert.match(html, /id="passkeyPasswordResetStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(script, /navigator\.credentials\.get\(\{[\s\S]*?decodePasskeyAuthenticationOptions/);
  assert.match(script, /"\/api\/auth\/passkey\/password-reset-options"/);
  assert.match(script, /"\/api\/auth\/passkey\/reset-password"/);
  assert.match(script, /challengeToken:\s*ceremony\.challengeToken/);
  assert.match(script, /credential:\s*serializePasskeyAuthenticationCredential\(credential\)/);
  assert.match(script, /newPassword/);
  assert.match(styles, /\.passkey-password-reset-fields\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,/);
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*?\.passkey-password-reset-fields\s*\{[\s\S]*?grid-template-columns:\s*1fr;/);
});
