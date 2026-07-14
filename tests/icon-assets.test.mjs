import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const ICON_URL = "/favicon.png?v=community-icon-3";
const APPLE_ICON_URL = "/apple-touch-icon.png?v=community-icon-3";
const MANIFEST_URL = "/site.webmanifest?v=community-icon-3";

test("every HTML entry point uses the current community icon set", () => {
  for (const path of [
    "public/index.html",
    "public/annual-report.html",
    "functions/_middleware.js"
  ]) {
    const source = readFileSync(path, "utf8");
    assert.match(source, new RegExp(escapeRegExp(ICON_URL)));
    assert.match(source, new RegExp(escapeRegExp(APPLE_ICON_URL)));
    assert.match(source, new RegExp(escapeRegExp(MANIFEST_URL)));
    assert.doesNotMatch(source, /favicon\.svg/);
  }
});

test("the install manifest points to the current community icon", () => {
  const manifest = JSON.parse(readFileSync("public/site.webmanifest", "utf8"));
  assert.equal(manifest.name, "공동체관리");
  assert.equal(manifest.short_name, "공동체관리");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.deepEqual(manifest.icons, [{
    src: ICON_URL,
    sizes: "512x512",
    type: "image/png",
    purpose: "any"
  }]);
  assert.equal(existsSync("public/favicon.svg"), false);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
