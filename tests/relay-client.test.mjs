import assert from "node:assert/strict";
import test from "node:test";
import { verifyRelayAuthSignature } from "../lib/relay-auth.js";
import {
  RelayClientError,
  inspectRelayClientConfiguration,
  sendRelayDelivery,
  upsertRelayTarget
} from "../lib/relay-client.js";

const SITE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KEY_ID = "rkey_v1_AAAAAAAAAAAAAAAAAAAAAA";
const DEVICE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TARGET_HANDLE = "rth_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SECRET = "relay-test-hmac-secret-that-is-long-enough";

test("relay target registration is HTTPS, signed, and scoped to one site", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = new Request(url, init);
    return jsonResponse({
      targetHandle: TARGET_HANDLE,
      status: "active",
      deviceGeneration: 2,
      targetRevision: 4
    });
  };
  try {
    const result = await upsertRelayTarget({
      env: relayEnv(),
      siteId: SITE_ID,
      deviceId: DEVICE_ID,
      targetKind: "fid",
      targetValue: "firebase-installation-id",
      deviceGeneration: 2,
      targetRevision: 4
    });
    assert.equal(result.targetHandle, TARGET_HANDLE);
    assert.equal(captured.url, `https://relay.example.com/v1/targets/${DEVICE_ID}`);
    assert.equal(captured.method, "PUT");
    assert.equal(captured.redirect, "error");
    const rawBody = await captured.text();
    const verified = await verifyRelayAuthSignature({
      request: captured,
      rawBody,
      secret: SECRET
    });
    assert.equal(verified.siteId, SITE_ID);
    assert.equal(verified.keyId, KEY_ID);
    assert.deepEqual(JSON.parse(rawBody), {
      targetKind: "fid",
      targetValue: "firebase-installation-id",
      deviceGeneration: 2,
      targetRevision: 4
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normal relay delivery contains only an opaque target handle and schema-v2 routing data", async () => {
  const originalFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init.body || "{}"));
    return jsonResponse({
      outcome: "accepted",
      httpStatus: 200,
      errorCode: "",
      retryAfterMs: 0,
      messageName: "projects/test/messages/1"
    });
  };
  try {
    await sendRelayDelivery({
      env: relayEnv(),
      siteId: SITE_ID,
      device: {
        relayTargetHandle: TARGET_HANDLE,
        generation: 2,
        targetRevision: 4
      },
      delivery: {
        notificationId: "11111111-1111-4111-8111-111111111111",
        kind: "visit_alarm",
        reminderId: "22222222-2222-4222-8222-222222222222",
        scheduledAt: "2026-07-14T03:00:00.000Z",
        memberName: "must-not-leave-site",
        content: "must-not-leave-site"
      }
    });
    assert.deepEqual(body, {
      schemaVersion: "2",
      targetHandle: TARGET_HANDLE,
      deviceGeneration: 2,
      targetRevision: 4,
      notificationId: "11111111-1111-4111-8111-111111111111",
      type: "visit_alarm",
      reminderId: "22222222-2222-4222-8222-222222222222",
      scheduledAt: "2026-07-14T03:00:00.000Z",
      route: "reminders/11111111-1111-4111-8111-111111111111"
    });
    assert.equal(JSON.stringify(body).includes("must-not-leave-site"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("malformed successful relay responses are retryable instead of losing a reminder", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("not-json", {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
  try {
    await assert.rejects(
      () => sendRelayDelivery({
        env: relayEnv(),
        siteId: SITE_ID,
        device: {
          relayTargetHandle: TARGET_HANDLE,
          generation: 2,
          targetRevision: 4
        },
        delivery: {
          notificationId: "11111111-1111-4111-8111-111111111111",
          kind: "connection_test",
          reminderId: "",
          scheduledAt: "2026-07-14T03:00:00.000Z"
        }
      }),
      (error) => error instanceof RelayClientError
        && error.code === "RELAY_RESPONSE_INVALID"
        && error.status === 502
        && error.retryable === true
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relay configuration rejects non-origin URLs and weak site secrets", () => {
  assert.equal(inspectRelayClientConfiguration({
    RELAY_BASE_URL: "https://relay.example.com/path",
    RELAY_KEY_ID: KEY_ID,
    RELAY_HMAC_SECRET: SECRET
  }).errorCode, "RELAY_BASE_URL_INVALID");
  assert.equal(inspectRelayClientConfiguration({
    RELAY_BASE_URL: "https://relay.example.com",
    RELAY_KEY_ID: KEY_ID,
    RELAY_HMAC_SECRET: "short"
  }).errorCode, "RELAY_HMAC_SECRET_INVALID");
});

function relayEnv() {
  return {
    RELAY_BASE_URL: "https://relay.example.com",
    RELAY_KEY_ID: KEY_ID,
    RELAY_HMAC_SECRET: SECRET
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
