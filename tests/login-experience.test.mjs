import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const authScript = readFileSync(new URL("../public/auth.js", import.meta.url), "utf8");
const appScript = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("mobile passkey login automatically requests the platform authenticator once", () => {
  assert.match(authScript, /dataset\.passkeyAutostart !== "true"/);
  assert.match(authScript, /isMobileDevice\(\)/);
  assert.match(authScript, /isUserVerifyingPlatformAuthenticatorAvailable/);
  assert.match(authScript, /sessionStorage\.setItem\(AUTO_PROMPT_KEY, String\(Date\.now\(\)\)\)/);
  assert.match(authScript, /loginWithPasskey\(\{ automatic: true \}\)/);
});

test("passkey login carries the automatic-login choice to the server", () => {
  assert.match(authScript, /remember: Boolean\(remember\?\.checked\)/);
});

test("the client disables idle logout for a server-confirmed persistent session", () => {
  assert.match(appScript, /X-Seosanch-Session-Persistent/);
  assert.match(appScript, /if \(state\.sessionPersistent\) \{/);
  assert.match(appScript, /state\.sessionPersistent = value === "1"/);
});
