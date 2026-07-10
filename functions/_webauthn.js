export const AUTH_PASSKEYS_KEY = "auth.passkeys";

const PASSKEY_TTL_SECONDS = 60 * 5;
const PASSKEY_RP_NAME = "\uBAA9\uC591\uC6F9";
const PASSKEY_ADMIN_NAME = "church-admin";
const PASSKEY_ADMIN_DISPLAY_NAME = "\uBAA9\uC591\uC6F9 \uAD00\uB9AC\uC790";
const COSE_KTY_EC2 = 2;
const COSE_ALG_ES256 = -7;
const COSE_CRV_P256 = 1;

export async function createPasskeyRegistrationOptions(env, request) {
  const credentials = await getPasskeys(env);
  const challengeToken = await createChallengeToken(env, request, "passkey-register");
  return {
    token: challengeToken.token,
    expiresAt: challengeToken.expiresAt,
    publicKey: {
      challenge: challengeToken.challenge,
      rp: {
        name: PASSKEY_RP_NAME,
        id: challengeToken.rpId
      },
      user: {
        id: base64Url(randomBytes(16)),
        name: PASSKEY_ADMIN_NAME,
        displayName: PASSKEY_ADMIN_DISPLAY_NAME
      },
      pubKeyCredParams: [
        { type: "public-key", alg: COSE_ALG_ES256 }
      ],
      timeout: PASSKEY_TTL_SECONDS * 1000,
      attestation: "none",
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "preferred",
        requireResidentKey: false,
        userVerification: "required"
      },
      excludeCredentials: credentials.map((credential) => ({
        type: "public-key",
        id: credential.id,
        transports: credential.transports || undefined
      }))
    }
  };
}

export async function createPasskeyLoginOptions(env, request) {
  const credentials = await getPasskeys(env);
  if (!credentials.length) return { enabled: false };

  const challengeToken = await createChallengeToken(env, request, "passkey-login");
  return {
    enabled: true,
    token: challengeToken.token,
    expiresAt: challengeToken.expiresAt,
    publicKey: {
      challenge: challengeToken.challenge,
      rpId: challengeToken.rpId,
      allowCredentials: credentials.map((credential) => ({
        type: "public-key",
        id: credential.id,
        transports: credential.transports || undefined
      })),
      timeout: PASSKEY_TTL_SECONDS * 1000,
      userVerification: "required"
    }
  };
}

export async function verifyPasskeyRegistration(env, request, token, credential) {
  const challenge = await verifyChallengeToken(env, token, "passkey-register");
  const clientDataBytes = decodeRequiredBytes(credential?.response?.clientDataJSON, "clientDataJSON is required");
  const clientData = parseClientData(clientDataBytes, "webauthn.create", challenge);
  const attestationBytes = decodeRequiredBytes(credential?.response?.attestationObject, "attestationObject is required");
  const attestation = decodeCbor(attestationBytes).value;
  if (!(attestation instanceof Map)) throw passkeyError("Invalid attestation object");

  const authData = attestation.get("authData");
  if (!(authData instanceof Uint8Array)) throw passkeyError("Missing authenticator data");

  const verifiedAuthData = await verifyAuthenticatorData(authData, challenge.rpId, { requireAttestedCredential: true });
  const attested = parseAttestedCredentialData(authData);
  const credentialId = base64Url(attested.credentialId);
  const suppliedId = clean(credential?.rawId || credential?.id);
  if (suppliedId && !timingSafeStringEqual(credentialId, suppliedId)) {
    throw passkeyError("Credential id mismatch");
  }

  const publicKeyJwk = coseKeyToJwk(attested.credentialPublicKey);
  const now = new Date().toISOString();
  return {
    id: credentialId,
    publicKeyJwk,
    signCount: verifiedAuthData.signCount,
    transports: normalizeTransports(credential?.response?.transports || credential?.transports),
    label: "platform",
    createdAt: now,
    updatedAt: now
  };
}

export async function verifyPasskeyLogin(env, request, token, credential, credentials) {
  const challenge = await verifyChallengeToken(env, token, "passkey-login");
  const credentialId = clean(credential?.rawId || credential?.id);
  if (!credentialId) throw passkeyError("Credential id is required");

  const storedCredential = credentials.find((item) => timingSafeStringEqual(item.id, credentialId));
  if (!storedCredential) throw passkeyError("Credential is not registered", 401);

  const clientDataBytes = decodeRequiredBytes(credential?.response?.clientDataJSON, "clientDataJSON is required");
  parseClientData(clientDataBytes, "webauthn.get", challenge);

  const authData = decodeRequiredBytes(credential?.response?.authenticatorData, "authenticatorData is required");
  const verifiedAuthData = await verifyAuthenticatorData(authData, challenge.rpId, { requireAttestedCredential: false });
  const clientDataHash = await sha256(clientDataBytes);
  const signedData = concatBytes(authData, clientDataHash);
  const signature = derToRawEcdsaSignature(decodeRequiredBytes(credential?.response?.signature, "signature is required"));

  const verified = await verifyEcdsaSignature(storedCredential.publicKeyJwk, signature, signedData);
  if (!verified) throw passkeyError("Passkey signature verification failed", 401);

  const previousSignCount = Number(storedCredential.signCount || 0);
  if (previousSignCount > 0 && verifiedAuthData.signCount > 0 && verifiedAuthData.signCount <= previousSignCount) {
    throw passkeyError("Passkey sign counter did not advance", 401);
  }

  return {
    credential: storedCredential,
    signCount: verifiedAuthData.signCount
  };
}

export async function getPasskeyStore(env) {
  if (!env.DB) return { version: 1, credentials: [] };
  await ensureAppSettingsTable(env);
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(AUTH_PASSKEYS_KEY).first();
  return normalizePasskeyStore(row?.value);
}

export async function getPasskeys(env) {
  return (await getPasskeyStore(env)).credentials;
}

export async function savePasskeyStore(env, store) {
  if (!env.DB) throw passkeyError("D1 binding DB is not configured", 503);
  await ensureAppSettingsTable(env);
  const normalized = normalizePasskeyStore(store);
  const updatedAt = new Date().toISOString();
  await appSettingStatement(env, AUTH_PASSKEYS_KEY, JSON.stringify(normalized), updatedAt).run();
  return normalized;
}

export async function addOrReplacePasskey(env, credential) {
  const store = await getPasskeyStore(env);
  const credentials = store.credentials.filter((item) => item.id !== credential.id);
  credentials.push(credential);
  return savePasskeyStore(env, { version: 1, credentials });
}

export async function updatePasskeySignCount(env, credentialId, signCount) {
  const store = await getPasskeyStore(env);
  const target = store.credentials.find((item) => item.id === credentialId);
  if (!target) return store;
  if (Number(signCount || 0) > Number(target.signCount || 0)) {
    target.signCount = Number(signCount || 0);
    target.updatedAt = new Date().toISOString();
    return savePasskeyStore(env, store);
  }
  return store;
}

export async function clearPasskeyStore(env) {
  return savePasskeyStore(env, { version: 1, credentials: [] });
}

export function publicPasskeyStatus(store) {
  const credentials = normalizePasskeyStore(store).credentials;
  return {
    registered: credentials.length > 0,
    count: credentials.length,
    credentials: credentials.map((credential) => ({
      id: credential.id,
      label: credential.label || "platform",
      createdAt: credential.createdAt || "",
      updatedAt: credential.updatedAt || "",
      transports: credential.transports || []
    }))
  };
}

async function createChallengeToken(env, request, kind) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    kind,
    challenge: base64Url(randomBytes(32)),
    origin: originFromRequest(request),
    rpId: rpIdFromRequest(request),
    issuedAt: now,
    expiresAt: now + PASSKEY_TTL_SECONDS
  };
  const encoded = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmacSha256(env, encoded);
  return {
    ...payload,
    token: `${encoded}.${signature}`
  };
}

async function verifyChallengeToken(env, token, expectedKind) {
  const [encoded, signature] = clean(token).split(".");
  if (!encoded || !signature) throw passkeyError("Invalid challenge token");

  const expectedSignature = await hmacSha256(env, encoded);
  if (!timingSafeStringEqual(signature, expectedSignature)) throw passkeyError("Invalid challenge token", 401);

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded)));
  } catch {
    throw passkeyError("Invalid challenge token");
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.kind !== expectedKind) throw passkeyError("Challenge type mismatch");
  if (Number(payload.expiresAt || 0) < now) throw passkeyError("Challenge expired", 401);
  if (!payload.challenge || !payload.origin || !payload.rpId) throw passkeyError("Incomplete challenge token");
  return payload;
}

function parseClientData(clientDataBytes, expectedType, challenge) {
  let clientData;
  try {
    clientData = JSON.parse(new TextDecoder().decode(clientDataBytes));
  } catch {
    throw passkeyError("Invalid client data");
  }

  if (clientData.type !== expectedType) throw passkeyError("Invalid client data type");
  if (!timingSafeStringEqual(clientData.challenge || "", challenge.challenge)) throw passkeyError("Challenge mismatch", 401);
  if (clientData.origin !== challenge.origin) throw passkeyError("Origin mismatch", 401);
  if (clientData.crossOrigin === true) throw passkeyError("Cross-origin passkey response is not allowed", 401);
  return clientData;
}

async function verifyAuthenticatorData(authData, rpId, options) {
  if (!(authData instanceof Uint8Array) || authData.length < 37) {
    throw passkeyError("Invalid authenticator data");
  }

  const rpIdHash = authData.slice(0, 32);
  const expectedRpIdHash = await sha256(new TextEncoder().encode(rpId));
  if (!timingSafeBytesEqual(rpIdHash, expectedRpIdHash)) throw passkeyError("RP ID hash mismatch", 401);

  const flags = authData[32];
  if ((flags & 0x01) !== 0x01) throw passkeyError("User presence is required", 401);
  if ((flags & 0x04) !== 0x04) throw passkeyError("User verification is required", 401);
  if (options.requireAttestedCredential && (flags & 0x40) !== 0x40) {
    throw passkeyError("Attested credential data is required");
  }

  return {
    flags,
    signCount: readUint32(authData, 33)
  };
}

function parseAttestedCredentialData(authData) {
  let offset = 37;
  if (authData.length < offset + 18) throw passkeyError("Invalid attested credential data");
  offset += 16;
  const credentialIdLength = (authData[offset] << 8) | authData[offset + 1];
  offset += 2;
  if (credentialIdLength < 1 || authData.length < offset + credentialIdLength) {
    throw passkeyError("Invalid credential id length");
  }
  const credentialId = authData.slice(offset, offset + credentialIdLength);
  offset += credentialIdLength;
  const decoded = decodeCbor(authData, offset);
  return {
    credentialId,
    credentialPublicKey: decoded.value
  };
}

function coseKeyToJwk(coseKey) {
  if (!(coseKey instanceof Map)) throw passkeyError("Invalid credential public key");
  const kty = coseKey.get(1);
  const alg = coseKey.get(3);
  const crv = coseKey.get(-1);
  const x = coseKey.get(-2);
  const y = coseKey.get(-3);
  if (kty !== COSE_KTY_EC2 || alg !== COSE_ALG_ES256 || crv !== COSE_CRV_P256) {
    throw passkeyError("Only ECDSA P-256 passkeys are supported");
  }
  if (!(x instanceof Uint8Array) || x.length !== 32 || !(y instanceof Uint8Array) || y.length !== 32) {
    throw passkeyError("Invalid P-256 public key coordinates");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: base64Url(x),
    y: base64Url(y),
    ext: true,
    key_ops: ["verify"]
  };
}

async function verifyEcdsaSignature(publicKeyJwk, signature, data) {
  const key = await crypto.subtle.importKey(
    "jwk",
    publicKeyJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signature,
    data
  );
}

function derToRawEcdsaSignature(signature) {
  let offset = 0;
  if (signature[offset] !== 0x30) throw passkeyError("Invalid ECDSA signature");
  offset += 1;
  const sequenceLength = readAsn1Length(signature, offset);
  offset = sequenceLength.offset;
  if (offset + sequenceLength.length > signature.length) throw passkeyError("Invalid ECDSA signature length");
  const r = readAsn1Integer(signature, offset);
  offset = r.offset;
  const s = readAsn1Integer(signature, offset);
  return concatBytes(normalizeEcdsaInteger(r.value), normalizeEcdsaInteger(s.value));
}

function readAsn1Integer(bytes, offset) {
  if (bytes[offset] !== 0x02) throw passkeyError("Invalid ECDSA integer");
  const lengthResult = readAsn1Length(bytes, offset + 1);
  const start = lengthResult.offset;
  const end = start + lengthResult.length;
  if (end > bytes.length) throw passkeyError("Invalid ECDSA integer length");
  return {
    value: bytes.slice(start, end),
    offset: end
  };
}

function readAsn1Length(bytes, offset) {
  const first = bytes[offset];
  if (first < 0x80) return { length: first, offset: offset + 1 };
  const byteCount = first & 0x7f;
  if (byteCount < 1 || byteCount > 2) throw passkeyError("Unsupported ASN.1 length");
  let length = 0;
  for (let index = 0; index < byteCount; index += 1) {
    length = (length << 8) | bytes[offset + 1 + index];
  }
  return { length, offset: offset + 1 + byteCount };
}

function normalizeEcdsaInteger(bytes) {
  let value = bytes;
  while (value.length > 32 && value[0] === 0) value = value.slice(1);
  if (value.length > 32) throw passkeyError("Invalid ECDSA integer size");
  const normalized = new Uint8Array(32);
  normalized.set(value, 32 - value.length);
  return normalized;
}

function decodeCbor(bytes, offset = 0) {
  const initial = bytes[offset];
  const major = initial >> 5;
  const additional = initial & 0x1f;
  let cursor = offset + 1;
  const lengthResult = readCborLength(bytes, cursor, additional);
  const length = lengthResult.length;
  cursor = lengthResult.offset;

  if (major === 0) return { value: length, offset: cursor };
  if (major === 1) return { value: -1 - length, offset: cursor };
  if (major === 2) {
    if (cursor + length > bytes.length) throw passkeyError("Invalid CBOR byte string");
    return { value: bytes.slice(cursor, cursor + length), offset: cursor + length };
  }
  if (major === 3) {
    if (cursor + length > bytes.length) throw passkeyError("Invalid CBOR text string");
    return { value: new TextDecoder().decode(bytes.slice(cursor, cursor + length)), offset: cursor + length };
  }
  if (major === 4) {
    const value = [];
    for (let index = 0; index < length; index += 1) {
      const decoded = decodeCbor(bytes, cursor);
      value.push(decoded.value);
      cursor = decoded.offset;
    }
    return { value, offset: cursor };
  }
  if (major === 5) {
    const value = new Map();
    for (let index = 0; index < length; index += 1) {
      const key = decodeCbor(bytes, cursor);
      cursor = key.offset;
      const item = decodeCbor(bytes, cursor);
      cursor = item.offset;
      value.set(key.value, item.value);
    }
    return { value, offset: cursor };
  }
  if (major === 6) return decodeCbor(bytes, cursor);
  if (major === 7) {
    if (additional === 20) return { value: false, offset: cursor };
    if (additional === 21) return { value: true, offset: cursor };
    if (additional === 22 || additional === 23) return { value: null, offset: cursor };
  }
  throw passkeyError("Unsupported CBOR value");
}

function readCborLength(bytes, offset, additional) {
  if (additional < 24) return { length: additional, offset };
  if (additional === 24) return { length: bytes[offset], offset: offset + 1 };
  if (additional === 25) return { length: (bytes[offset] << 8) | bytes[offset + 1], offset: offset + 2 };
  if (additional === 26) return { length: readUint32(bytes, offset), offset: offset + 4 };
  if (additional === 27) {
    const high = readUint32(bytes, offset);
    const low = readUint32(bytes, offset + 4);
    const length = high * 0x100000000 + low;
    if (!Number.isSafeInteger(length)) throw passkeyError("CBOR integer is too large");
    return { length, offset: offset + 8 };
  }
  throw passkeyError("Unsupported CBOR length");
}

function normalizePasskeyStore(value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = {};
    }
  }
  const credentials = Array.isArray(parsed?.credentials) ? parsed.credentials : [];
  return {
    version: 1,
    credentials: credentials
      .filter((credential) => credential?.id && credential?.publicKeyJwk?.kty === "EC")
      .map((credential) => ({
        id: String(credential.id),
        publicKeyJwk: credential.publicKeyJwk,
        signCount: Number(credential.signCount || 0),
        transports: normalizeTransports(credential.transports),
        label: clean(credential.label) || "platform",
        createdAt: clean(credential.createdAt),
        updatedAt: clean(credential.updatedAt)
      }))
  };
}

function normalizeTransports(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => clean(item))
    .filter((item) => /^(internal|usb|nfc|ble|hybrid|smart-card)$/.test(item));
}

async function ensureAppSettingsTable(env) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)"
  ).run();
}

function appSettingStatement(env, key, value, updatedAt = new Date().toISOString()) {
  return env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, value, updatedAt);
}

async function hmacSha256(env, payload) {
  const secret = env.SESSION_SECRET;
  if (!secret) throw passkeyError("SESSION_SECRET is not configured", 503);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return base64Url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function originFromRequest(request) {
  return new URL(request.url).origin;
}

function rpIdFromRequest(request) {
  return new URL(request.url).hostname.toLowerCase();
}

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

function decodeRequiredBytes(value, message) {
  if (!value) throw passkeyError(message);
  try {
    return base64UrlToBytes(value);
  } catch {
    throw passkeyError(message);
  }
}

function readUint32(bytes, offset) {
  return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

function concatBytes(...chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function base64Url(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const base64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function timingSafeStringEqual(actual, expected) {
  const actualBytes = new TextEncoder().encode(String(actual || ""));
  const expectedBytes = new TextEncoder().encode(String(expected || ""));
  return timingSafeBytesEqual(actualBytes, expectedBytes);
}

function timingSafeBytesEqual(actual, expected) {
  if (actual.length !== expected.length) return false;
  let result = 0;
  for (let index = 0; index < actual.length; index += 1) {
    result |= actual[index] ^ expected[index];
  }
  return result === 0;
}

function clean(value) {
  return String(value ?? "").trim();
}

function passkeyError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}
