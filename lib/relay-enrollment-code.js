import { base64Url, base64UrlToBytes } from "./notification-crypto.js";

const CODE_PREFIX = "csre_v1.";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_CODE_LENGTH = 2048;

export class RelayEnrollmentCodeError extends Error {
  constructor(code = "RELAY_ENROLLMENT_CODE_INVALID") {
    super(code);
    this.name = "RelayEnrollmentCodeError";
    this.code = code;
  }
}

export function createRelayEnrollmentCode(value) {
  const normalized = normalizeRelayEnrollmentCodeValue(value);
  const raw = new TextEncoder().encode(JSON.stringify(normalized));
  return `${CODE_PREFIX}${base64Url(raw)}`;
}

export function parseRelayEnrollmentCode(value) {
  const code = String(value || "");
  if (code.length > MAX_CODE_LENGTH || !code.startsWith(CODE_PREFIX)) {
    throw new RelayEnrollmentCodeError();
  }
  const encoded = code.slice(CODE_PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new RelayEnrollmentCodeError();
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(base64UrlToBytes(encoded)));
  } catch {
    throw new RelayEnrollmentCodeError();
  }
  const normalized = normalizeRelayEnrollmentCodeValue(parsed);
  if (createRelayEnrollmentCode(normalized) !== code) throw new RelayEnrollmentCodeError();
  return normalized;
}

function normalizeRelayEnrollmentCodeValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RelayEnrollmentCodeError();
  }
  const keys = Object.keys(value).sort();
  const expected = ["expiresAt", "issuedAt", "requestId", "siteId", "siteOrigin", "token", "version"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new RelayEnrollmentCodeError();
  }
  if (value.version !== 1) throw new RelayEnrollmentCodeError();
  const requestId = String(value.requestId || "").toLowerCase();
  const siteId = String(value.siteId || "").toLowerCase();
  const siteOrigin = canonicalSiteOrigin(value.siteOrigin);
  const issuedAt = strictIsoTimestamp(value.issuedAt);
  const expiresAt = strictIsoTimestamp(value.expiresAt);
  const token = String(value.token || "");
  if (!UUID_PATTERN.test(requestId) || !UUID_PATTERN.test(siteId) || !TOKEN_PATTERN.test(token)
    || Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    throw new RelayEnrollmentCodeError();
  }
  return { version: 1, requestId, siteId, siteOrigin, issuedAt, expiresAt, token };
}

function strictIsoTimestamp(value) {
  const text = String(value || "");
  const milliseconds = Date.parse(text);
  if (!ISO_PATTERN.test(text) || !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== text) {
    throw new RelayEnrollmentCodeError();
  }
  return text;
}

function canonicalSiteOrigin(value) {
  const source = String(value || "").trim();
  let url;
  try {
    url = new URL(source);
  } catch {
    throw new RelayEnrollmentCodeError();
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname || url.port
    || url.pathname !== "/" || url.search || url.hash || source.includes("?") || source.includes("#")) {
    throw new RelayEnrollmentCodeError();
  }
  return url.origin;
}
