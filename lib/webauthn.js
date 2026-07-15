import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from "@simplewebauthn/server";

export const PASSKEYS_KEY = "auth.passkeys";

const PASSKEY_CHALLENGE_VERSION = 1;
const PASSKEY_CHALLENGE_TTL_SECONDS = 5 * 60;
const PASSKEY_CHALLENGE_DOMAIN = "seosanch-cell:webauthn-challenge:v1:";
const PASSKEY_RP_NAME = "남아메리카 공동체 관리";
const PASSKEY_ADMIN_NAME = "admin";
const PASSKEY_ADMIN_DISPLAY_NAME = "공동체 관리자";
const PASSKEY_MAX_CREDENTIALS = 8;
const PASSKEY_CAS_RETRIES = 5;
const PASSKEY_TIMEOUT_MS = PASSKEY_CHALLENGE_TTL_SECONDS * 1000;
const PASSKEY_ES256_ALGORITHM = -7;
const DEFAULT_PASSKEY_ORIGIN = "https://seosanch-cell.pages.dev";
const DEFAULT_PASSKEY_RP_ID = "seosanch-cell.pages.dev";
const SESSION_COOKIE = "__Host-seosanch_cell_session";
const SESSION_VERSION = "v5";
const LEGACY_SESSION_VERSION = "v4";
const STANDARD_SESSION_MODE = "standard";
const REMEMBER_SESSION_MODE = "remember";
const SESSION_ADMIN_ROLE = "admin";
const SESSION_BINDING_DOMAIN = "seosanch-cell:webauthn-session:v1:";
const SESSION_REVISION_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ALLOWED_TRANSPORTS = new Set(["ble", "hybrid", "internal", "nfc", "smart-card", "usb"]);

export class PasskeyError extends Error {
  constructor(message, status = 400, code = "PASSKEY_ERROR") {
    super(message);
    this.name = "PasskeyError";
    this.status = status;
    this.code = code;
  }
}

export async function hasUsablePasskeys(request, env) {
  if (!hasStrongChallengeSecret(env)) return false;
  try {
    const relyingParty = relyingPartyForRequest(request, env);
    const credentials = await readPasskeyCredentials(env);
    return credentials.some((credential) => credentialMatchesRelyingParty(credential, relyingParty));
  } catch {
    return false;
  }
}

export async function getPasskeyStatus(request, env) {
  const relyingParty = relyingPartyForRequest(request, env);
  const credentials = (await readPasskeyCredentials(env))
    .filter((credential) => credentialMatchesRelyingParty(credential, relyingParty));

  return {
    available: hasStrongChallengeSecret(env),
    registered: credentials.length > 0,
    count: credentials.length,
    passkeys: credentials.map((credential) => ({
      createdAt: credential.createdAt,
      lastUsedAt: credential.lastUsedAt,
      backedUp: credential.backedUp
    }))
  };
}

export async function createPasskeyRegistrationOptions(request, env) {
  const relyingParty = requireSameOriginRequest(request, env);
  const allCredentials = await readPasskeyCredentials(env);
  const credentials = allCredentials
    .filter((credential) => credentialMatchesRelyingParty(credential, relyingParty));

  if (credentials.length >= PASSKEY_MAX_CREDENTIALS) {
    throw new PasskeyError(`패스키는 최대 ${PASSKEY_MAX_CREDENTIALS}개까지 등록할 수 있습니다.`, 409, "PASSKEY_LIMIT");
  }

  const challengeBytes = crypto.getRandomValues(new Uint8Array(32));
  const userHandle = await stableUserHandle(relyingParty.rpId);
  const options = await generateRegistrationOptions({
    rpName: PASSKEY_RP_NAME,
    rpID: relyingParty.rpId,
    userName: PASSKEY_ADMIN_NAME,
    userID: base64UrlToBytes(userHandle),
    userDisplayName: PASSKEY_ADMIN_DISPLAY_NAME,
    challenge: challengeBytes,
    timeout: PASSKEY_TIMEOUT_MS,
    attestationType: "none",
    excludeCredentials: credentials.map((credential) => ({
      id: credential.id,
      transports: credential.transports
    })),
    authenticatorSelection: {
      authenticatorAttachment: "platform",
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required"
    },
    supportedAlgorithmIDs: [PASSKEY_ES256_ALGORITHM]
  });

  const challengeToken = await createChallengeToken({
    purpose: "register",
    challenge: options.challenge,
    relyingParty,
    sessionBinding: await currentSessionBinding(request),
    userHandle
  }, env);

  return { options, challengeToken };
}

export async function registerPasskey(request, env, body) {
  const relyingParty = requireSameOriginRequest(request, env);
  assertRegistrationBody(body);
  const sessionBinding = await currentSessionBinding(request);
  const challenge = await verifyChallengeToken(
    body.challengeToken,
    "register",
    relyingParty,
    env,
    sessionBinding
  );

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.credential,
      expectedChallenge: challenge.challenge,
      expectedOrigin: relyingParty.origin,
      expectedRPID: relyingParty.rpId,
      expectedType: "webauthn.create",
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: [PASSKEY_ES256_ALGORITHM]
    });
  } catch (error) {
    logPasskeyVerificationFailure("register", error);
    throw new PasskeyError(
      "패스키 등록 응답을 확인하지 못했습니다. 기기 잠금을 다시 인증해주세요.",
      400,
      "REGISTRATION_INVALID"
    );
  }

  if (!verification.verified || !verification.registrationInfo) {
    throw new PasskeyError("패스키 등록을 확인하지 못했습니다.", 400, "REGISTRATION_INVALID");
  }

  const info = verification.registrationInfo;
  if (info.fmt !== "none") {
    throw new PasskeyError("지원하지 않는 패스키 등록 형식입니다.", 400, "ATTESTATION_UNSUPPORTED");
  }
  if (body.credential.authenticatorAttachment
    && body.credential.authenticatorAttachment !== "platform") {
    throw new PasskeyError("휴대폰이나 PC에 내장된 인증기를 사용해주세요.", 400, "PLATFORM_REQUIRED");
  }

  const credentialId = String(info.credential.id || "");
  assertBase64Url(credentialId, "credential ID", 2048);
  if (base64UrlToBytes(credentialId).byteLength > 1023) {
    throw new PasskeyError("패스키 식별자가 너무 깁니다.", 400, "CREDENTIAL_ID_TOO_LONG");
  }

  const now = new Date().toISOString();
  const record = {
    id: credentialId,
    publicKey: bytesToBase64Url(info.credential.publicKey),
    algorithm: PASSKEY_ES256_ALGORITHM,
    counter: normalizeCounter(info.credential.counter),
    transports: normalizeTransports(body.credential.response?.transports),
    userHandle: challenge.userHandle,
    deviceType: info.credentialDeviceType === "multiDevice" ? "multiDevice" : "singleDevice",
    backedUp: Boolean(info.credentialBackedUp),
    rpId: relyingParty.rpId,
    origin: relyingParty.origin,
    createdAt: now,
    lastUsedAt: ""
  };

  await consumeChallenge(env, challenge);
  await appendPasskeyCredential(env, record, relyingParty);
  return getPasskeyStatus(request, env);
}

export async function createPasskeyAuthenticationOptions(request, env) {
  const relyingParty = relyingPartyForRequest(request, env);
  const credentials = (await readPasskeyCredentials(env))
    .filter((credential) => credentialMatchesRelyingParty(credential, relyingParty));

  if (!credentials.length) {
    throw new PasskeyError("등록된 패스키가 없습니다.", 404, "PASSKEY_NOT_FOUND");
  }

  const challengeBytes = crypto.getRandomValues(new Uint8Array(32));
  const options = await generateAuthenticationOptions({
    rpID: relyingParty.rpId,
    challenge: challengeBytes,
    timeout: PASSKEY_TIMEOUT_MS,
    userVerification: "required",
    allowCredentials: credentials.map((credential) => ({
      id: credential.id,
      transports: credential.transports
    }))
  });
  const challengeToken = await createChallengeToken({
    purpose: "login",
    challenge: options.challenge,
    relyingParty
  }, env);

  return { options, challengeToken };
}

export async function createPasskeyPasswordResetOptions(request, env) {
  const relyingParty = requireSameOriginRequest(request, env);
  const credentials = (await readPasskeyCredentials(env))
    .filter((credential) => credentialMatchesRelyingParty(credential, relyingParty));

  if (!credentials.length) {
    throw new PasskeyError("등록된 패스키가 없습니다.", 404, "PASSKEY_NOT_FOUND");
  }

  const challengeBytes = crypto.getRandomValues(new Uint8Array(32));
  const options = await generateAuthenticationOptions({
    rpID: relyingParty.rpId,
    challenge: challengeBytes,
    timeout: PASSKEY_TIMEOUT_MS,
    userVerification: "required",
    allowCredentials: credentials.map((credential) => ({
      id: credential.id,
      transports: credential.transports
    }))
  });
  const challengeToken = await createChallengeToken({
    purpose: "password-reset",
    challenge: options.challenge,
    relyingParty,
    sessionBinding: await currentSessionBinding(request)
  }, env);

  return { options, challengeToken };
}

export async function authenticatePasskey(request, env, body) {
  const relyingParty = requireSameOriginRequest(request, env);
  assertAuthenticationBody(body);
  const challenge = await verifyChallengeToken(
    body.challengeToken,
    "login",
    relyingParty,
    env
  );

  return verifyPasskeyAssertion(env, relyingParty, body, challenge, "login");
}

export async function verifyPasskeyPasswordReset(request, env, body) {
  const relyingParty = requireSameOriginRequest(request, env);
  assertAuthenticationBody(body);
  const sessionBinding = await currentSessionBinding(request);
  const challenge = await verifyChallengeToken(
    body.challengeToken,
    "password-reset",
    relyingParty,
    env,
    sessionBinding
  );

  return verifyPasskeyAssertion(env, relyingParty, body, challenge, "password-reset");
}

async function verifyPasskeyAssertion(env, relyingParty, body, challenge, ceremony) {
  const allCredentials = await readPasskeyCredentials(env);
  const credentialId = String(body.credential.id || "");
  const recordIndex = allCredentials.findIndex((credential) => (
    credential.id === credentialId && credentialMatchesRelyingParty(credential, relyingParty)
  ));
  if (recordIndex < 0) {
    throw new PasskeyError("등록되지 않은 패스키입니다.", 401, "PASSKEY_NOT_FOUND");
  }

  const record = allCredentials[recordIndex];
  const returnedUserHandle = String(body.credential.response?.userHandle || "");
  if (returnedUserHandle && !(await timingSafeStringEqual(returnedUserHandle, record.userHandle))) {
    throw new PasskeyError("패스키 사용자 정보가 일치하지 않습니다.", 401, "USER_HANDLE_MISMATCH");
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.credential,
      expectedChallenge: challenge.challenge,
      expectedOrigin: relyingParty.origin,
      expectedRPID: relyingParty.rpId,
      expectedType: "webauthn.get",
      credential: {
        id: record.id,
        publicKey: base64UrlToBytes(record.publicKey),
        counter: record.counter,
        transports: record.transports
      },
      requireUserVerification: true
    });
  } catch (error) {
    logPasskeyVerificationFailure(ceremony, error);
    throw new PasskeyError(
      ceremony === "password-reset"
        ? "패스키를 확인하지 못했습니다. 기기 잠금을 다시 인증해주세요."
        : "패스키를 확인하지 못했습니다. 다시 시도하거나 비밀번호로 로그인해주세요.",
      401,
      "AUTHENTICATION_INVALID"
    );
  }

  if (!verification.verified || !verification.authenticationInfo?.userVerified) {
    throw new PasskeyError("기기 잠금 인증을 확인하지 못했습니다.", 401, "USER_VERIFICATION_REQUIRED");
  }

  const info = verification.authenticationInfo;
  await consumeChallenge(env, challenge);
  await updateAuthenticatedCredential(env, relyingParty, record, info);
  return { credentialId: record.id };
}

export async function clearPasskeys(request, env) {
  const relyingParty = requireSameOriginRequest(request, env);
  const removed = await removePasskeyCredentials(env, relyingParty);
  return { removed, ...(await getPasskeyStatus(request, env)) };
}

function relyingPartyForRequest(request, env) {
  const url = new URL(request.url);
  const currentOrigin = url.origin;
  const hostname = url.hostname.toLowerCase();

  if (isLocalHostname(hostname)) {
    return { origin: currentOrigin, rpId: hostname };
  }

  const expectedOrigin = normalizeConfiguredOrigin(env.PASSKEY_ORIGIN || DEFAULT_PASSKEY_ORIGIN);
  const rpId = String(env.PASSKEY_RP_ID || DEFAULT_PASSKEY_RP_ID).trim().toLowerCase();
  if (!isValidRpId(rpId) || !originMatchesRpId(expectedOrigin, rpId)) {
    throw new PasskeyError("패스키 도메인 설정이 올바르지 않습니다.", 503, "RP_CONFIGURATION_INVALID");
  }
  if (currentOrigin !== expectedOrigin) {
    throw new PasskeyError("패스키는 공식 운영 주소에서만 사용할 수 있습니다.", 403, "ORIGIN_NOT_ALLOWED");
  }
  return { origin: expectedOrigin, rpId };
}

function requireSameOriginRequest(request, env) {
  const relyingParty = relyingPartyForRequest(request, env);
  const requestOrigin = String(request.headers.get("Origin") || "");
  if (requestOrigin !== relyingParty.origin) {
    throw new PasskeyError("요청 출처를 확인할 수 없습니다.", 403, "ORIGIN_NOT_ALLOWED");
  }
  return relyingParty;
}

function normalizeConfiguredOrigin(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw new PasskeyError("패스키 origin 설정이 올바르지 않습니다.", 503, "ORIGIN_CONFIGURATION_INVALID");
  }
}

function originMatchesRpId(origin, rpId) {
  const hostname = new URL(origin).hostname.toLowerCase();
  return hostname === rpId;
}

function isValidRpId(value) {
  return /^[a-z0-9.-]+$/.test(value)
    && !value.startsWith(".")
    && !value.endsWith(".")
    && !value.includes("..");
}

function isLocalHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function credentialMatchesRelyingParty(credential, relyingParty) {
  return credential.rpId === relyingParty.rpId && credential.origin === relyingParty.origin;
}

async function createChallengeToken(input, env) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    version: PASSKEY_CHALLENGE_VERSION,
    purpose: input.purpose,
    challenge: input.challenge,
    jti: randomBase64Url(24),
    issuedAt: now,
    expiresAt: now + PASSKEY_CHALLENGE_TTL_SECONDS,
    origin: input.relyingParty.origin,
    rpId: input.relyingParty.rpId
  };
  if (input.sessionBinding) payload.sessionBinding = input.sessionBinding;
  if (input.userHandle) payload.userHandle = input.userHandle;

  const encodedPayload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await signChallengePayload(encodedPayload, env);
  return `v1.${encodedPayload}.${signature}`;
}

async function verifyChallengeToken(token, purpose, relyingParty, env, sessionBinding = "") {
  const value = String(token || "");
  if (value.length > 4096) throw invalidChallenge();
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw invalidChallenge();
  assertBase64Url(parts[1], "challenge payload", 3072);
  assertBase64Url(parts[2], "challenge signature", 128);

  const key = await challengeHmacKey(env, ["verify"]);
  const validSignature = await crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlToBytes(parts[2]),
    new TextEncoder().encode(`${PASSKEY_CHALLENGE_DOMAIN}${parts[1]}`)
  );
  if (!validSignature) throw invalidChallenge();

  let payload;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(base64UrlToBytes(parts[1])));
  } catch {
    throw invalidChallenge();
  }

  const now = Math.floor(Date.now() / 1000);
  const issuedAt = Number(payload?.issuedAt);
  const expiresAt = Number(payload?.expiresAt);
  if (payload?.version !== PASSKEY_CHALLENGE_VERSION
    || payload?.purpose !== purpose
    || payload?.origin !== relyingParty.origin
    || payload?.rpId !== relyingParty.rpId
    || !Number.isInteger(issuedAt)
    || !Number.isInteger(expiresAt)
    || expiresAt - issuedAt !== PASSKEY_CHALLENGE_TTL_SECONDS
    || issuedAt > now + 30
    || expiresAt < now) {
    throw invalidChallenge();
  }
  assertBase64Url(payload.challenge, "challenge", 256);
  assertBase64Url(payload.jti, "challenge ID", 256);

  if (purpose === "register") {
    assertBase64Url(payload.userHandle, "user handle", 256);
  }
  if (purpose === "register" || purpose === "password-reset") {
    if (!sessionBinding
      || typeof payload.sessionBinding !== "string"
      || !(await timingSafeStringEqual(payload.sessionBinding, sessionBinding))) {
      throw invalidChallenge();
    }
  }

  return payload;
}

async function signChallengePayload(encodedPayload, env) {
  const key = await challengeHmacKey(env, ["sign"]);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${PASSKEY_CHALLENGE_DOMAIN}${encodedPayload}`)
  );
  return bytesToBase64Url(signature);
}

async function challengeHmacKey(env, usages) {
  const secret = challengeSecret(env);
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages
  );
}

function challengeSecret(env) {
  const secret = String(env.PASSKEY_CHALLENGE_SECRET || env.SESSION_SECRET || "");
  if (secret.length < 32) {
    throw new PasskeyError(
      "패스키용 보안 키가 설정되어 있지 않습니다.",
      503,
      "PASSKEY_SECRET_NOT_CONFIGURED"
    );
  }
  return secret;
}

function hasStrongChallengeSecret(env) {
  return String(env.PASSKEY_CHALLENGE_SECRET || env.SESSION_SECRET || "").length >= 32;
}

async function consumeChallenge(env, challenge) {
  await ensureChallengeUseTable(env);
  const tokenHash = await sha256Base64Url(challenge.jti);
  const now = Math.floor(Date.now() / 1000);
  const results = await env.DB.batch([
    env.DB.prepare("DELETE FROM passkey_challenge_uses WHERE expires_at < ?").bind(now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO passkey_challenge_uses (token_hash, expires_at, used_at) VALUES (?, ?, ?)"
    ).bind(tokenHash, challenge.expiresAt, new Date().toISOString())
  ]);
  const inserted = Number(results?.[1]?.meta?.changes || 0);
  if (inserted !== 1) {
    throw new PasskeyError("이미 사용된 패스키 요청입니다. 다시 시도해주세요.", 409, "CHALLENGE_REPLAYED");
  }
}

async function ensureChallengeUseTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS passkey_challenge_uses (
      token_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      used_at TEXT NOT NULL
    )`
  ).run();
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_passkey_challenge_uses_expires_at ON passkey_challenge_uses(expires_at)"
  ).run();
}

async function readPasskeyCredentials(env) {
  return (await readPasskeySnapshot(env)).credentials;
}

async function readPasskeySnapshot(env) {
  if (!env.DB) return { rawValue: null, credentials: [] };
  await ensureAppSettingsTable(env);
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?")
    .bind(PASSKEYS_KEY)
    .first();
  if (typeof row?.value !== "string") return { rawValue: null, credentials: [] };

  let parsed;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    throw invalidPasskeyStore();
  }

  const values = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.credentials) ? parsed.credentials : null;
  if (!values || values.length > PASSKEY_MAX_CREDENTIALS) throw invalidPasskeyStore();
  const credentials = values.map(normalizeStoredCredential);
  if (credentials.some((credential) => !credential)
    || new Set(credentials.map((credential) => credential.id)).size !== credentials.length) {
    throw invalidPasskeyStore();
  }
  return { rawValue: row.value, credentials };
}

async function compareAndSwapPasskeyCredentials(env, snapshot, credentials) {
  const normalized = credentials.map(normalizeStoredCredential).filter(Boolean);
  if (normalized.length !== credentials.length || normalized.length > PASSKEY_MAX_CREDENTIALS) {
    throw new PasskeyError("등록 가능한 패스키 수를 초과했습니다.", 409, "PASSKEY_LIMIT");
  }
  const updatedAt = new Date().toISOString();
  const value = JSON.stringify({ version: 1, credentials: normalized });
  let result;
  if (snapshot.rawValue === null) {
    result = await env.DB.prepare(
      "INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)"
    ).bind(PASSKEYS_KEY, value, updatedAt).run();
  } else {
    result = await env.DB.prepare(
      "UPDATE app_settings SET value = ?, updated_at = ? WHERE key = ? AND value = ?"
    ).bind(value, updatedAt, PASSKEYS_KEY, snapshot.rawValue).run();
  }
  return Number(result?.meta?.changes || 0) === 1;
}

async function appendPasskeyCredential(env, record, relyingParty) {
  for (let attempt = 0; attempt < PASSKEY_CAS_RETRIES; attempt += 1) {
    const snapshot = await readPasskeySnapshot(env);
    if (snapshot.credentials.some((credential) => credential.id === record.id)) {
      throw new PasskeyError("이미 등록된 패스키입니다.", 409, "PASSKEY_EXISTS");
    }
    const relyingPartyCount = snapshot.credentials
      .filter((credential) => credentialMatchesRelyingParty(credential, relyingParty))
      .length;
    if (snapshot.credentials.length >= PASSKEY_MAX_CREDENTIALS
      || relyingPartyCount >= PASSKEY_MAX_CREDENTIALS) {
      throw new PasskeyError(
        `패스키는 최대 ${PASSKEY_MAX_CREDENTIALS}개까지 등록할 수 있습니다.`,
        409,
        "PASSKEY_LIMIT"
      );
    }
    if (await compareAndSwapPasskeyCredentials(env, snapshot, [...snapshot.credentials, record])) return;
  }
  throw passkeyStoreBusy();
}

async function updateAuthenticatedCredential(env, relyingParty, verifiedRecord, info) {
  const newCounter = normalizeCounter(info.newCounter);
  const lastUsedAt = new Date().toISOString();
  for (let attempt = 0; attempt < PASSKEY_CAS_RETRIES; attempt += 1) {
    const snapshot = await readPasskeySnapshot(env);
    const recordIndex = snapshot.credentials.findIndex((credential) => (
      credential.id === verifiedRecord.id
      && credentialMatchesRelyingParty(credential, relyingParty)
    ));
    if (recordIndex < 0) {
      throw new PasskeyError("등록되지 않은 패스키입니다.", 401, "PASSKEY_NOT_FOUND");
    }

    const currentRecord = snapshot.credentials[recordIndex];
    if (!sameCredentialMaterial(currentRecord, verifiedRecord)) {
      throw new PasskeyError("패스키 등록 정보가 변경되었습니다.", 409, "PASSKEY_CHANGED");
    }
    if ((newCounter !== 0 || currentRecord.counter !== 0)
      && newCounter <= currentRecord.counter) {
      throw new PasskeyError(
        "패스키 사용 횟수를 확인할 수 없습니다. 비밀번호로 로그인한 뒤 패스키를 다시 등록해 주세요.",
        401,
        "AUTHENTICATOR_COUNTER_INVALID"
      );
    }

    const updatedCredentials = [...snapshot.credentials];
    updatedCredentials[recordIndex] = {
      ...currentRecord,
      counter: newCounter,
      deviceType: info.credentialDeviceType === "multiDevice" ? "multiDevice" : "singleDevice",
      backedUp: Boolean(info.credentialBackedUp),
      lastUsedAt
    };
    if (await compareAndSwapPasskeyCredentials(env, snapshot, updatedCredentials)) return;
  }
  throw passkeyStoreBusy();
}

async function removePasskeyCredentials(env, relyingParty) {
  for (let attempt = 0; attempt < PASSKEY_CAS_RETRIES; attempt += 1) {
    const snapshot = await readPasskeySnapshot(env);
    const remaining = snapshot.credentials
      .filter((credential) => !credentialMatchesRelyingParty(credential, relyingParty));
    const removed = snapshot.credentials.length - remaining.length;
    if (removed === 0) return 0;
    if (await compareAndSwapPasskeyCredentials(env, snapshot, remaining)) return removed;
  }
  throw passkeyStoreBusy();
}

function sameCredentialMaterial(actual, expected) {
  return actual.id === expected.id
    && actual.publicKey === expected.publicKey
    && actual.algorithm === expected.algorithm
    && actual.userHandle === expected.userHandle
    && actual.rpId === expected.rpId
    && actual.origin === expected.origin;
}

function invalidPasskeyStore() {
  return new PasskeyError(
    "저장된 패스키 설정을 읽을 수 없습니다.",
    503,
    "PASSKEY_STORE_INVALID"
  );
}

function passkeyStoreBusy() {
  return new PasskeyError(
    "다른 기기에서 패스키 설정이 변경되었습니다. 잠시 후 다시 시도해 주세요.",
    409,
    "PASSKEY_STORE_BUSY"
  );
}

async function ensureAppSettingsTable(env) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)"
  ).run();
}

function normalizeStoredCredential(value) {
  if (!value || typeof value !== "object") return null;
  const id = String(value.id || "");
  const publicKey = String(value.publicKey || "");
  const userHandle = String(value.userHandle || "");
  const rpId = String(value.rpId || "").toLowerCase();
  const origin = String(value.origin || "");
  if (!id || id.length > 2048 || !BASE64URL_PATTERN.test(id)
    || !publicKey || publicKey.length > 8192 || !BASE64URL_PATTERN.test(publicKey)
    || !userHandle || userHandle.length > 256 || !BASE64URL_PATTERN.test(userHandle)
    || Number(value.algorithm) !== PASSKEY_ES256_ALGORITHM
    || !isValidRpId(rpId)
    || !origin) {
    return null;
  }
  try {
    if (new URL(origin).origin !== origin || !originMatchesRpId(origin, rpId)) return null;
  } catch {
    return null;
  }
  return {
    id,
    publicKey,
    algorithm: PASSKEY_ES256_ALGORITHM,
    counter: normalizeCounter(value.counter),
    transports: normalizeTransports(value.transports),
    userHandle,
    deviceType: value.deviceType === "multiDevice" ? "multiDevice" : "singleDevice",
    backedUp: Boolean(value.backedUp),
    rpId,
    origin,
    createdAt: normalizeIsoDate(value.createdAt),
    lastUsedAt: normalizeIsoDate(value.lastUsedAt, "")
  };
}

function normalizeTransports(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item)).filter((item) => ALLOWED_TRANSPORTS.has(item)))];
}

function normalizeCounter(value) {
  const counter = Number(value);
  return Number.isSafeInteger(counter) && counter >= 0 ? counter : 0;
}

function normalizeIsoDate(value, fallback = new Date().toISOString()) {
  const text = String(value || "");
  return Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : fallback;
}

async function currentSessionBinding(request) {
  const session = parseCookies(request.headers.get("Cookie") || "")[SESSION_COOKIE] || "";
  const parts = session.split(".");
  let version;
  let role;
  let revision;
  let sessionId;
  let expiresAtText;
  let signature;
  if (parts.length === 7 && parts[0] === SESSION_VERSION) {
    const mode = parts[2];
    if (mode !== STANDARD_SESSION_MODE && mode !== REMEMBER_SESSION_MODE) {
      throw sessionRequired();
    }
    [version, role, , revision, sessionId, expiresAtText, signature] = parts;
  } else if (parts.length === 6 && parts[0] === LEGACY_SESSION_VERSION) {
    [version, role, revision, sessionId, expiresAtText, signature] = parts;
  } else {
    throw sessionRequired();
  }
  const expiresAt = Number(expiresAtText);
  if ((version !== SESSION_VERSION && version !== LEGACY_SESSION_VERSION)
    || role !== SESSION_ADMIN_ROLE
    || !SESSION_REVISION_PATTERN.test(revision)
    || !SESSION_ID_PATTERN.test(sessionId)
    || !/^\d{1,12}$/.test(expiresAtText)
    || !Number.isSafeInteger(expiresAt)
    || expiresAt <= Math.floor(Date.now() / 1000)
    || !SESSION_SIGNATURE_PATTERN.test(signature)) {
    throw sessionRequired();
  }
  return sha256Base64Url(`${SESSION_BINDING_DOMAIN}${role}:${revision}:${sessionId}`);
}

function sessionRequired() {
  return new PasskeyError("로그인 세션을 확인할 수 없습니다.", 401, "SESSION_REQUIRED");
}

async function stableUserHandle(rpId) {
  return sha256Base64Url(`seosanch-cell:passkey-admin:${rpId}`);
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return bytesToBase64Url(digest);
}

function parseCookies(header) {
  return Object.fromEntries(
    String(header)
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index === -1 ? [part, ""] : [part.slice(0, index), part.slice(index + 1)];
      })
  );
}

function assertRegistrationBody(body) {
  assertCeremonyEnvelope(body);
  const credential = body.credential;
  if (credential.type !== "public-key" || !credential.response) throw invalidCredential();
  assertBase64Url(credential.id, "credential ID", 2048);
  assertBase64Url(credential.rawId, "raw credential ID", 2048);
  assertBase64Url(credential.response.clientDataJSON, "client data", 16384);
  assertBase64Url(credential.response.attestationObject, "attestation object", 131072);
}

function assertAuthenticationBody(body) {
  assertCeremonyEnvelope(body);
  const credential = body.credential;
  if (credential.type !== "public-key" || !credential.response) throw invalidCredential();
  assertBase64Url(credential.id, "credential ID", 2048);
  assertBase64Url(credential.rawId, "raw credential ID", 2048);
  assertBase64Url(credential.response.clientDataJSON, "client data", 16384);
  assertBase64Url(credential.response.authenticatorData, "authenticator data", 16384);
  assertBase64Url(credential.response.signature, "signature", 4096);
  if (credential.response.userHandle) assertBase64Url(credential.response.userHandle, "user handle", 2048);
}

function assertCeremonyEnvelope(body) {
  if (!body || typeof body !== "object" || !body.credential || typeof body.challengeToken !== "string") {
    throw invalidCredential();
  }
  if (body.challengeToken.length > 4096 || JSON.stringify(body).length > 196608) throw invalidCredential();
}

function assertBase64Url(value, label, maxLength) {
  const text = String(value || "");
  if (!text || text.length > maxLength || !BASE64URL_PATTERN.test(text)) {
    throw new PasskeyError(`${label} 형식이 올바르지 않습니다.`, 400, "ENCODING_INVALID");
  }
}

function invalidCredential() {
  return new PasskeyError("패스키 응답 형식이 올바르지 않습니다.", 400, "CREDENTIAL_INVALID");
}

function invalidChallenge() {
  return new PasskeyError("패스키 요청이 만료되었거나 올바르지 않습니다. 다시 시도해주세요.", 400, "CHALLENGE_INVALID");
}

function randomBase64Url(length) {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(length)));
}

function bytesToBase64Url(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const text = String(value || "");
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function timingSafeStringEqual(actual, expected) {
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(actual || ""))),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(expected || "")))
  ]);
  const actualBytes = new Uint8Array(actualHash);
  const expectedBytes = new Uint8Array(expectedHash);
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(actualBytes, expectedBytes);
  }
  let difference = 0;
  for (let index = 0; index < actualBytes.length; index += 1) {
    difference |= actualBytes[index] ^ expectedBytes[index];
  }
  return difference === 0;
}

function logPasskeyVerificationFailure(ceremony, error) {
  console.warn(JSON.stringify({
    event: `passkey.${ceremony}.verification_failed`,
    error: error instanceof Error ? error.name : "UnknownError"
  }));
}
