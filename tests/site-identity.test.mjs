import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  SiteIdentityError,
  canonicalizeSiteOrigin,
  readStoredSiteIdentity,
  requireCanonicalSiteId,
  requireSiteIdentity
} from "../lib/site-identity.js";

const SITE_ID = "123e4567-e89b-42d3-a456-426614174000";

test("site origins canonicalize HTTPS hosts and IDNs without a trailing slash", () => {
  assert.equal(canonicalizeSiteOrigin("HTTPS://B\u00dcCHER.Example:443/"), "https://xn--bcher-kva.example");
  assert.equal(canonicalizeSiteOrigin("https://EXAMPLE.com"), "https://example.com");
});

test("site origins reject unsafe or non-origin URL components", () => {
  for (const value of [
    "http://example.com",
    "https://user@example.com",
    "https://example.com:8443",
    "https://example.com/path",
    "https://example.com/?query=1",
    "https://example.com/#fragment"
  ]) {
    assert.throws(() => canonicalizeSiteOrigin(value), SiteIdentityError, value);
  }
});

test("site ids require a lowercase canonical non-nil UUID", () => {
  assert.equal(requireCanonicalSiteId(SITE_ID), SITE_ID);
  assert.equal(
    requireCanonicalSiteId("123e4567-e89b-12d3-a456-426614174000"),
    "123e4567-e89b-12d3-a456-426614174000"
  );
  for (const value of [
    "00000000-0000-0000-0000-000000000000",
    SITE_ID.toUpperCase(),
    "not-a-uuid"
  ]) {
    assert.throws(() => requireCanonicalSiteId(value), SiteIdentityError, value);
  }
});

test("the first production request fixes the stored origin exactly once", async () => {
  const fixture = createFixture();
  try {
    const env = {
      DB: d1Adapter(fixture.sqlite),
      SITE_ORIGIN: "HTTPS://EXAMPLE.COM:443/",
      PASSKEY_ORIGIN: "https://example.com"
    };
    const request = new Request("https://example.com/api/integrations/call-note/devices/pair", { method: "POST" });
    assert.deepEqual(await requireSiteIdentity(request, env), {
      siteId: SITE_ID,
      siteOrigin: "https://example.com"
    });
    const first = fixture.sqlite.prepare(
      "SELECT value, updated_at AS updatedAt FROM app_settings WHERE key='notification.siteOrigin'"
    ).get();
    assert.equal(first.value, "https://example.com");

    assert.deepEqual(await requireSiteIdentity(request, env), {
      siteId: SITE_ID,
      siteOrigin: "https://example.com"
    });
    const second = fixture.sqlite.prepare(
      "SELECT value, updated_at AS updatedAt FROM app_settings WHERE key='notification.siteOrigin'"
    ).get();
    assert.deepEqual(second, first);
    assert.deepEqual(await readStoredSiteIdentity(env), {
      siteId: SITE_ID,
      siteOrigin: "https://example.com"
    });
  } finally {
    fixture.sqlite.close();
  }
});

test("preview, wrong, and conflicting configured origins are rejected without changing D1", async () => {
  const fixture = createFixture();
  try {
    const db = d1Adapter(fixture.sqlite);
    await assert.rejects(
      () => requireSiteIdentity(
        new Request("https://preview.example.com/api/integrations/call-note/devices/pair", { method: "POST" }),
        { DB: db, SITE_ORIGIN: "https://example.com" }
      ),
      (error) => error instanceof SiteIdentityError && error.code === "SITE_ORIGIN_MISMATCH"
    );
    assert.equal(readOrigin(fixture.sqlite), "");

    await assert.rejects(
      () => requireSiteIdentity(
        new Request("https://example.com/api/integrations/call-note/devices/pair", { method: "POST" }),
        {
          DB: db,
          SITE_ORIGIN: "https://example.com",
          PASSKEY_ORIGIN: "https://other.example.com"
        }
      ),
      (error) => error instanceof SiteIdentityError
        && error.code === "SITE_ORIGIN_CONFIGURATION_MISMATCH"
    );
    assert.equal(readOrigin(fixture.sqlite), "");
  } finally {
    fixture.sqlite.close();
  }
});

test("PASSKEY_ORIGIN is a safe fallback and a fixed origin cannot be replaced", async () => {
  const fixture = createFixture("https://example.com");
  try {
    const db = d1Adapter(fixture.sqlite);
    assert.deepEqual(await requireSiteIdentity(
      new Request("https://example.com/api/bootstrap"),
      { DB: db, PASSKEY_ORIGIN: "https://example.com" }
    ), { siteId: SITE_ID, siteOrigin: "https://example.com" });

    await assert.rejects(
      () => requireSiteIdentity(
        new Request("https://new.example.com/api/bootstrap"),
        { DB: db, SITE_ORIGIN: "https://new.example.com" }
      ),
      (error) => error instanceof SiteIdentityError && error.code === "SITE_ORIGIN_MISMATCH"
    );
    assert.equal(readOrigin(fixture.sqlite), "https://example.com");
  } finally {
    fixture.sqlite.close();
  }
});

test("worker reads require both migrated site settings and a fixed canonical origin", async () => {
  const fixture = createFixture();
  try {
    await assert.rejects(
      () => readStoredSiteIdentity({ DB: d1Adapter(fixture.sqlite) }),
      (error) => error instanceof SiteIdentityError && error.code === "SITE_ORIGIN_NOT_FIXED"
    );
    fixture.sqlite.prepare(
      "UPDATE app_settings SET value='https://EXAMPLE.com' WHERE key='notification.siteOrigin'"
    ).run();
    await assert.rejects(
      () => readStoredSiteIdentity({ DB: d1Adapter(fixture.sqlite) }),
      (error) => error instanceof SiteIdentityError && error.code === "SITE_ORIGIN_INVALID"
    );
  } finally {
    fixture.sqlite.close();
  }
});

function createFixture(origin = "") {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const insert = sqlite.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)");
  insert.run("notification.siteId", SITE_ID, "2026-07-14T00:00:00.000Z");
  insert.run("notification.siteOrigin", origin, "2026-07-14T00:00:00.000Z");
  return { sqlite };
}

function readOrigin(sqlite) {
  return sqlite.prepare(
    "SELECT value FROM app_settings WHERE key='notification.siteOrigin'"
  ).get().value;
}

function d1Adapter(sqlite) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      const bound = [];
      return {
        bind(...values) {
          bound.splice(0, bound.length, ...values);
          return this;
        },
        async all() {
          return { results: statement.all(...bound) };
        },
        async first() {
          return statement.get(...bound) || null;
        },
        async run() {
          const result = statement.run(...bound);
          return { meta: { changes: Number(result.changes || 0) } };
        }
      };
    }
  };
}
