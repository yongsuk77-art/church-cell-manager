import assert from "node:assert/strict";
import test from "node:test";
import {
  createDeviceCredential,
  createSixDigitPairCode,
  decryptDeviceTarget,
  deviceCredentialHmac,
  encryptDeviceTarget,
  isDeviceCredentialShape,
  pairCodeHmac,
  requireNotificationSecret,
  targetFingerprint
} from "../lib/notification-crypto.js";

const secret = "test-notification-secret-that-is-longer-than-32-characters";

test("pair codes and device credentials have the required shape", () => {
  for (let index = 0; index < 100; index += 1) {
    assert.match(createSixDigitPairCode(), /^\d{6}$/);
  }
  const credential = createDeviceCredential();
  assert.equal(isDeviceCredentialShape(credential), true);
  assert.equal(isDeviceCredentialShape("dvc_v1_short"), false);
});

test("notification hashes are purpose-bound and deterministic", async () => {
  const pairA = await pairCodeHmac(secret, "123456");
  const pairB = await pairCodeHmac(secret, "123456");
  const credential = await deviceCredentialHmac(secret, "device-id", "123456");
  const fingerprint = await targetFingerprint(secret, "fid", "123456");
  assert.equal(pairA, pairB);
  assert.notEqual(pairA, credential);
  assert.notEqual(pairA, fingerprint);
});

test("Firebase targets encrypt at rest and bind to device and target kind", async () => {
  const ciphertext = await encryptDeviceTarget(secret, "device-1", "fid", "firebase-installation-id-value");
  assert.equal(ciphertext.includes("firebase-installation-id-value"), false);
  assert.equal(
    await decryptDeviceTarget(secret, "device-1", "fid", ciphertext),
    "firebase-installation-id-value"
  );
  await assert.rejects(() => decryptDeviceTarget(secret, "device-2", "fid", ciphertext));
  await assert.rejects(() => decryptDeviceTarget(secret, "device-1", "registration_token", ciphertext));
});

test("notification secret must be at least 32 characters", () => {
  assert.throws(() => requireNotificationSecret({ NOTIFICATION_SECRET: "too-short" }));
  assert.equal(requireNotificationSecret({ NOTIFICATION_SECRET: secret }), secret);
});
