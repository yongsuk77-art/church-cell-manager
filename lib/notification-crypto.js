const textEncoder = new TextEncoder();
const DEVICE_CREDENTIAL_PREFIX = "dvc_v1_";

export class NotificationSecretError extends Error {
  constructor(message = "Mobile notification secret is not configured") {
    super(message);
    this.name = "NotificationSecretError";
    this.code = "NOTIFICATION_SECRET_MISSING";
  }
}

export function requireNotificationSecret(env) {
  const secret = String(env?.NOTIFICATION_SECRET || "");
  if ([...secret].length < 32) throw new NotificationSecretError();
  return secret;
}

export function createDeviceCredential() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${DEVICE_CREDENTIAL_PREFIX}${base64Url(bytes)}`;
}

export function createRelayEnrollmentToken() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function isDeviceCredentialShape(value) {
  return new RegExp(`^${DEVICE_CREDENTIAL_PREFIX}[A-Za-z0-9_-]{43}$`).test(String(value || ""));
}

export function createSixDigitPairCode() {
  const range = 1_000_000;
  const limit = Math.floor(0x1_0000_0000 / range) * range;
  const values = new Uint32Array(1);
  while (true) {
    crypto.getRandomValues(values);
    if (values[0] < limit) return String(values[0] % range).padStart(6, "0");
  }
}

export async function pairCodeHmac(secret, code) {
  return keyedDigest(secret, "pair-code:v1", String(code || ""));
}

export async function relayEnrollmentTokenHmac(secret, requestId, token) {
  return keyedDigest(secret, "relay-enrollment-token:v1", `${requestId}\u0000${token}`);
}

export async function pairActorHmac(secret, actor) {
  return keyedDigest(secret, "pair-actor:v1", String(actor || ""));
}

export async function deviceCredentialHmac(secret, deviceId, credential) {
  return keyedDigest(secret, "device-credential:v1", `${deviceId}\u0000${credential}`);
}

export async function targetFingerprint(secret, targetKind, targetValue) {
  return keyedDigest(secret, "device-target-fingerprint:v1", `${targetKind}\u0000${targetValue}`);
}

export async function encryptDeviceTarget(secret, deviceId, targetKind, targetValue) {
  const key = await targetEncryptionKey(secret, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = textEncoder.encode(targetAdditionalData(deviceId, targetKind));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData, tagLength: 128 },
    key,
    textEncoder.encode(String(targetValue || ""))
  );
  return `v1.${base64Url(iv)}.${base64Url(encrypted)}`;
}

export async function decryptDeviceTarget(secret, deviceId, targetKind, ciphertext) {
  const parts = String(ciphertext || "").split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("Unsupported notification target encryption version");
  const key = await targetEncryptionKey(secret, ["decrypt"]);
  const additionalData = textEncoder.encode(targetAdditionalData(deviceId, targetKind));
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(parts[1]), additionalData, tagLength: 128 },
    key,
    base64UrlToBytes(parts[2])
  );
  return new TextDecoder().decode(decrypted);
}

export async function encryptRelayClientSecret(
  secret,
  siteId,
  siteOrigin,
  relayBaseUrl,
  keyId,
  relaySecret
) {
  const key = await relayCredentialEncryptionKey(secret, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = textEncoder.encode(
    relayCredentialAdditionalData(siteId, siteOrigin, relayBaseUrl, keyId)
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData, tagLength: 128 },
    key,
    textEncoder.encode(String(relaySecret || ""))
  );
  return `v1.${base64Url(iv)}.${base64Url(encrypted)}`;
}

export async function decryptRelayClientSecret(
  secret,
  siteId,
  siteOrigin,
  relayBaseUrl,
  keyId,
  ciphertext
) {
  const parts = String(ciphertext || "").split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw new Error("Unsupported relay credential encryption version");
  }
  const key = await relayCredentialEncryptionKey(secret, ["decrypt"]);
  const additionalData = textEncoder.encode(
    relayCredentialAdditionalData(siteId, siteOrigin, relayBaseUrl, keyId)
  );
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlToBytes(parts[1]),
      additionalData,
      tagLength: 128
    },
    key,
    base64UrlToBytes(parts[2])
  );
  return new TextDecoder().decode(decrypted);
}

export function constantTimeStringEqual(actual, expected) {
  const a = String(actual || "");
  const b = String(expected || "");
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function base64Url(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(value) {
  const base64 = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function keyedDigest(secret, purpose, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(String(secret || "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(`${purpose}\u0000${value}`)
  );
  return base64Url(digest);
}

async function targetEncryptionKey(secret, usages) {
  const material = await keyedDigest(secret, "device-target-encryption-key:v1", "derive");
  return crypto.subtle.importKey(
    "raw",
    base64UrlToBytes(material),
    { name: "AES-GCM" },
    false,
    usages
  );
}

async function relayCredentialEncryptionKey(secret, usages) {
  const material = await keyedDigest(secret, "relay-client-credential-encryption-key:v1", "derive");
  return crypto.subtle.importKey(
    "raw",
    base64UrlToBytes(material),
    { name: "AES-GCM" },
    false,
    usages
  );
}

function targetAdditionalData(deviceId, targetKind) {
  return `call-note-device-target\u0000v1\u0000${deviceId}\u0000${targetKind}`;
}

function relayCredentialAdditionalData(siteId, siteOrigin, relayBaseUrl, keyId) {
  return `call-note-relay-credential\u0000v1\u0000${siteId}\u0000${siteOrigin}\u0000${relayBaseUrl}\u0000${keyId}`;
}
