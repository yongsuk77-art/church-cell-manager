export const SITE_ID_SETTING_KEY = "notification.siteId";
export const SITE_ORIGIN_SETTING_KEY = "notification.siteOrigin";

const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export class SiteIdentityError extends Error {
  constructor(message, code = "SITE_IDENTITY_INVALID", status = 503) {
    super(message);
    this.name = "SiteIdentityError";
    this.code = code;
    this.status = status;
  }
}

export function canonicalizeSiteOrigin(value) {
  const source = String(value ?? "").trim();
  if (!source) {
    throw new SiteIdentityError(
      "Site origin is not configured",
      "SITE_ORIGIN_NOT_CONFIGURED"
    );
  }

  let url;
  try {
    url = new URL(source);
  } catch {
    throw new SiteIdentityError("Site origin is invalid", "SITE_ORIGIN_INVALID");
  }

  if (url.protocol !== "https:") {
    throw new SiteIdentityError("Site origin must use HTTPS", "SITE_ORIGIN_HTTPS_REQUIRED");
  }
  if (url.username || url.password) {
    throw new SiteIdentityError("Site origin must not contain user information", "SITE_ORIGIN_INVALID");
  }
  if (!url.hostname || url.port) {
    throw new SiteIdentityError("Site origin must not contain a non-default port", "SITE_ORIGIN_INVALID");
  }
  if (url.pathname !== "/" || url.search || url.hash || source.includes("?") || source.includes("#")) {
    throw new SiteIdentityError("Site origin must not contain a path, query, or fragment", "SITE_ORIGIN_INVALID");
  }

  // URL.origin lowercases the scheme/host, converts IDNs to ASCII, removes the
  // default HTTPS port, and does not include a trailing slash.
  return url.origin;
}

export function requireCanonicalSiteId(value) {
  const siteId = String(value ?? "");
  if (siteId === NIL_UUID || !CANONICAL_UUID_PATTERN.test(siteId)) {
    throw new SiteIdentityError(
      "Stored site id is not a canonical non-nil UUID",
      "SITE_ID_INVALID"
    );
  }
  return siteId;
}

export async function requireSiteIdentity(request, env) {
  if (!(request instanceof Request)) {
    throw new SiteIdentityError("A request is required", "SITE_REQUEST_REQUIRED", 500);
  }
  requireDatabase(env);

  const configuredOrigin = configuredSiteOrigin(env);
  const requestOrigin = originFromRequest(request);
  if (requestOrigin !== configuredOrigin) {
    throw new SiteIdentityError(
      "This request origin is not the configured production site",
      "SITE_ORIGIN_MISMATCH",
      403
    );
  }

  let identity = await readIdentityRows(env.DB);
  const siteId = requireCanonicalSiteId(identity.siteId);

  if (!identity.siteOrigin) {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE app_settings
       SET value = ?, updated_at = ?
       WHERE key = ? AND value = ''`
    ).bind(configuredOrigin, now, SITE_ORIGIN_SETTING_KEY).run();
    identity = await readIdentityRows(env.DB);
  }

  if (!identity.siteOrigin) {
    throw new SiteIdentityError(
      "Site origin seed is missing; apply the site identity migration",
      "SITE_IDENTITY_MIGRATION_REQUIRED"
    );
  }

  const storedOrigin = canonicalizeSiteOrigin(identity.siteOrigin);
  if (storedOrigin !== identity.siteOrigin || storedOrigin !== configuredOrigin) {
    throw new SiteIdentityError(
      "Stored site origin does not match the configured production site",
      "SITE_ORIGIN_MISMATCH",
      403
    );
  }

  return { siteId, siteOrigin: storedOrigin };
}

export async function readStoredSiteIdentity(env) {
  requireDatabase(env);
  const identity = await readIdentityRows(env.DB);
  const siteId = requireCanonicalSiteId(identity.siteId);
  if (!identity.siteOrigin) {
    throw new SiteIdentityError(
      "Site origin has not been fixed by a production request",
      "SITE_ORIGIN_NOT_FIXED"
    );
  }
  const siteOrigin = canonicalizeSiteOrigin(identity.siteOrigin);
  if (siteOrigin !== identity.siteOrigin) {
    throw new SiteIdentityError(
      "Stored site origin is not canonical",
      "SITE_ORIGIN_INVALID"
    );
  }
  return { siteId, siteOrigin };
}

function configuredSiteOrigin(env) {
  const configured = [];
  if (String(env?.SITE_ORIGIN ?? "").trim()) {
    configured.push(canonicalizeSiteOrigin(env.SITE_ORIGIN));
  }
  if (String(env?.PASSKEY_ORIGIN ?? "").trim()) {
    configured.push(canonicalizeSiteOrigin(env.PASSKEY_ORIGIN));
  }
  if (!configured.length) {
    throw new SiteIdentityError(
      "SITE_ORIGIN or PASSKEY_ORIGIN must be configured",
      "SITE_ORIGIN_NOT_CONFIGURED"
    );
  }
  if (configured.some((origin) => origin !== configured[0])) {
    throw new SiteIdentityError(
      "SITE_ORIGIN and PASSKEY_ORIGIN do not identify the same site",
      "SITE_ORIGIN_CONFIGURATION_MISMATCH"
    );
  }
  return configured[0];
}

function originFromRequest(request) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    throw new SiteIdentityError("Request URL is invalid", "SITE_REQUEST_ORIGIN_INVALID", 400);
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname || url.port) {
    throw new SiteIdentityError(
      "Request must use the configured HTTPS origin",
      "SITE_REQUEST_ORIGIN_INVALID",
      403
    );
  }
  return url.origin;
}

async function readIdentityRows(db) {
  let rows;
  try {
    rows = await db.prepare(
      `SELECT key, value
       FROM app_settings
       WHERE key IN (?, ?)`
    ).bind(SITE_ID_SETTING_KEY, SITE_ORIGIN_SETTING_KEY).all();
  } catch {
    throw new SiteIdentityError(
      "Site identity settings are unavailable; apply the site identity migration",
      "SITE_IDENTITY_MIGRATION_REQUIRED"
    );
  }

  const values = new Map((rows?.results || []).map((row) => [String(row.key), String(row.value ?? "")]));
  if (!values.has(SITE_ID_SETTING_KEY) || !values.has(SITE_ORIGIN_SETTING_KEY)) {
    throw new SiteIdentityError(
      "Site identity settings are missing; apply the site identity migration",
      "SITE_IDENTITY_MIGRATION_REQUIRED"
    );
  }
  return {
    siteId: values.get(SITE_ID_SETTING_KEY),
    siteOrigin: values.get(SITE_ORIGIN_SETTING_KEY)
  };
}

function requireDatabase(env) {
  if (!env?.DB || typeof env.DB.prepare !== "function") {
    throw new SiteIdentityError("D1 binding DB is not configured", "DATABASE_UNAVAILABLE");
  }
}
