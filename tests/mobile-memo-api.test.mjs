import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { onRequest } from "../functions/api/[[path]].js";
import { createMobileMemoAccessToken } from "../lib/mobile-memo-auth.js";

const SITE_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const NOTE_ID = "33333333-3333-4333-8333-333333333333";
const LEGACY_NOTE_ID = "44444444-4444-4444-8444-444444444444";
const ARCHIVED_NOTE_ID = "55555555-5555-4555-8555-555555555555";
const CATEGORY_NOTE_ID = "66666666-6666-4666-8666-666666666666";
const REPLAY_NOTE_ID = "77777777-7777-4777-8777-777777777777";
const CONCURRENT_REPLAY_NOTE_ID = "88888888-8888-4888-8888-888888888888";
const PURGE_NOTE_ID = "99999999-9999-4999-8999-999999999999";
const BULK_PURGE_NOTE_ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BULK_PURGE_NOTE_ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AUDIT_FAILURE_NOTE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MUTATION_AUDIT_NOTE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PURGE_AUDIT_NOTE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const BULK_AUDIT_NOTE_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const ERROR_CONTRACT_NOTE_ID = "12121212-1212-4212-8212-121212121212";
const INVALID_CATEGORY_NOTE_ID = "34343434-3434-4434-8434-343434343434";
const SECRET = "mobile-memo-test-secret-that-is-at-least-32-bytes";
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7]);

test("mobile memo API supports secure CRUD, member lookup, photos, conflicts, and tombstone sync", async () => {
  const fixture = await createFixture();
  try {
    const directDeviceCredential = await apiRequest(fixture, ["notes"], "GET", undefined, {
      Authorization: "Bearer dvc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    });
    assert.equal(directDeviceCredential.status, 401);

    const createdResponse = await apiRequest(fixture, ["notes"], "POST", {
      id: NOTE_ID,
      body: "첫 줄 제목\n모바일에서 작성한 내용",
      color: "mint",
      memberId: "member-1"
    }, { "X-Actor": "spoofed-admin" });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.id, NOTE_ID);
    assert.equal(created.title, "첫 줄 제목");
    assert.equal(created.revision, 1);
    assert.equal(created.categoryId, "");
    assert.equal(created.categoryName, "");
    assert.ok(latestD1Changes(fixture, /^\s*INSERT INTO notes\b/i) > 1);

    const createAudit = fixture.sqlite.prepare(
      `SELECT actor, after_json AS afterJson
       FROM audit_logs WHERE action = 'note.create' ORDER BY created_at DESC LIMIT 1`
    ).get();
    assert.equal(createAudit.actor, "mobile");
    const createAuditShape = JSON.parse(createAudit.afterJson);
    assert.equal(createAuditShape.bodyLength, created.body.length);
    for (const privateField of ["title", "categoryName", "memberId", "groupId", "remindAt", "reminderId"]) {
      assert.equal(Object.hasOwn(createAuditShape, privateField), false);
    }
    assert.equal(createAudit.afterJson.includes(created.body), false);
    assert.equal(createAudit.afterJson.includes(DEVICE_ID), false);
    assert.equal(createAudit.afterJson.includes("spoofed-admin"), false);

    const detail = await (await apiRequest(fixture, ["notes", NOTE_ID], "GET")).json();
    assert.equal(detail.body, created.body);
    assert.equal(detail.createdAt, created.createdAt);

    const updatedResponse = await apiRequest(fixture, ["notes", NOTE_ID], "PATCH", {
      expectedRevision: created.revision,
      body: "수정된 첫 줄\n최신 내용",
      color: "lavender"
    });
    assert.equal(updatedResponse.status, 200);
    const updated = await updatedResponse.json();
    assert.equal(updated.revision, 2);
    assert.equal(updated.createdAt, created.createdAt);
    assert.ok(latestD1Changes(fixture, /^\s*UPDATE notes\s+SET category\b/i) > 1);

    const conflict = await apiRequest(fixture, ["notes", NOTE_ID], "PATCH", {
      expectedRevision: 1,
      body: "오래된 수정"
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).note.revision, 2);

    const memberSearch = await apiRequest(fixture, ["mobile", "members"], "GET", undefined, {}, "?query=소망&limit=20");
    assert.equal(memberSearch.status, 200);
    const memberPayload = await memberSearch.json();
    assert.equal(memberPayload.members.length, 1);
    assert.deepEqual(Object.keys(memberPayload.members[0]).sort(), [
      "cellId", "cellName", "groups", "id", "name", "photoUrl"
    ]);
    assert.deepEqual(memberPayload.members[0].groups, [{ id: "group-1", name: "소망구역" }]);

    const form = new FormData();
    form.append("photo", new File([PNG_BYTES], "memo.png", { type: "image/png" }));
    const uploadedResponse = await apiRequest(
      fixture,
      ["notes", NOTE_ID, "attachments"],
      "POST",
      form,
      { "If-Match": String(updated.revision) }
    );
    assert.equal(uploadedResponse.status, 201);
    const uploaded = await uploadedResponse.json();
    assert.equal(uploaded.revision, 3);
    assert.equal(uploaded.attachments.length, 1);
    assert.equal(uploaded.attachments[0].byteSize, PNG_BYTES.length);
    assert.equal(uploaded.attachments[0].sizeBytes, PNG_BYTES.length);
    assert.ok(latestD1Changes(fixture, /^\s*UPDATE notes SET revision\b/i) > 1);

    const photoKey = uploaded.attachments[0].objectKey;
    const photoResponse = await apiRequest(
      fixture,
      ["photos", encodeURIComponent(photoKey)],
      "GET",
      undefined,
      {},
      `/api/photos/${encodeURIComponent(photoKey)}`
    );
    assert.equal(photoResponse.status, 200);
    assert.deepEqual(new Uint8Array(await photoResponse.arrayBuffer()), PNG_BYTES);

    const deletedResponse = await apiRequest(
      fixture,
      ["notes", NOTE_ID],
      "DELETE",
      undefined,
      { "If-Match": String(uploaded.revision) }
    );
    assert.equal(deletedResponse.status, 200);
    const deleted = await deletedResponse.json();
    assert.equal(deleted.revision, 4);
    assert.ok(deleted.deletedAt);
    assert.ok(latestD1Changes(fixture, /^\s*UPDATE notes\s+SET deleted_at\b/i) > 1);
    assert.equal(fixture.r2.objects.size, 1);
    assert.equal(fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM note_attachments").get().count, 1);

    const trashedPhotoResponse = await apiRequest(
      fixture,
      ["photos", encodeURIComponent(photoKey)],
      "GET",
      undefined,
      {},
      `/api/photos/${encodeURIComponent(photoKey)}`
    );
    assert.equal(trashedPhotoResponse.status, 200);
    const unauthorizedTrashedPhoto = await apiRequest(
      fixture,
      ["photos", encodeURIComponent(photoKey)],
      "GET",
      undefined,
      { Authorization: "" },
      `/api/photos/${encodeURIComponent(photoKey)}`
    );
    assert.equal(unauthorizedTrashedPhoto.status, 401);
    const guestPhotoRequest = new Request(`https://example.test/api/photos/${encodeURIComponent(photoKey)}`);
    const guestTrashedPhoto = await onRequest({
      request: guestPhotoRequest,
      env: fixture.env,
      params: { path: ["photos", encodeURIComponent(photoKey)] },
      data: { viewerRole: "guest" }
    });
    assert.equal(guestTrashedPhoto.status, 401);

    const retryDelete = await apiRequest(
      fixture,
      ["notes", NOTE_ID],
      "DELETE",
      undefined,
      { "If-Match": String(uploaded.revision) }
    );
    assert.equal(retryDelete.status, 200);
    assert.deepEqual(await retryDelete.json(), deleted);

    const list = await (await apiRequest(fixture, ["notes"], "GET")).json();
    assert.deepEqual(list.notes, []);
    assert.equal((await apiRequest(fixture, ["notes", NOTE_ID], "GET")).status, 404);

    const syncResponse = await apiRequest(
      fixture,
      ["mobile", "notes", "sync"],
      "GET",
      undefined,
      {},
      "?cursor=0&limit=100"
    );
    assert.equal(syncResponse.status, 200);
    const sync = await syncResponse.json();
    assert.equal(sync.hasMore, false);
    assert.equal(sync.changes.length, 4);
    assert.equal(sync.changes.at(-1).type, "delete");
    assert.equal(sync.changes.at(-1).noteId, NOTE_ID);
    assert.equal(sync.changes.at(-1).note.id, NOTE_ID);
    assert.equal(sync.changes.at(-1).note.revision, 4);
    assert.equal(sync.changes.at(-1).note.updatedAt, deleted.updatedAt);
    assert.equal(sync.changes.at(-1).note.deletedAt, deleted.deletedAt);
    assert.equal(sync.changes.at(-1).note.body, uploaded.body);
    assert.equal(sync.changes.at(-1).note.attachments.length, 1);
    assert.equal(sync.changes.at(-1).note.attachments[0].objectKey, photoKey);

    fixture.sqlite.prepare("DELETE FROM notes WHERE id = ?").run(NOTE_ID);
    const purgedPhotoResponse = await apiRequest(
      fixture,
      ["photos", encodeURIComponent(photoKey)],
      "GET",
      undefined,
      {},
      `/api/photos/${encodeURIComponent(photoKey)}`
    );
    assert.equal(purgedPhotoResponse.status, 404);
    await fixture.r2.delete(photoKey);
    assert.equal(fixture.r2.objects.size, 0);
    const purgedSync = await (await apiRequest(
      fixture,
      ["mobile", "notes", "sync"],
      "GET",
      undefined,
      {},
      "?cursor=0&limit=100"
    )).json();
    assert.equal(purgedSync.changes.at(-1).type, "delete");
    assert.equal(purgedSync.changes.at(-1).noteId, NOTE_ID);
    assert.deepEqual(purgedSync.changes.at(-1).note, {
      id: NOTE_ID,
      revision: 4,
      updatedAt: deleted.updatedAt,
      deletedAt: deleted.deletedAt
    });
  } finally {
    fixture.sqlite.close();
  }
});

test("mobile notes:write can restore a trashed note with If-Match and a non-identifying audit actor", async () => {
  const fixture = await createFixture();
  try {
    const created = await (await apiRequest(fixture, ["notes"], "POST", {
      id: NOTE_ID,
      body: "Restore from mobile"
    })).json();
    const deletedResponse = await apiRequest(
      fixture,
      ["notes", NOTE_ID],
      "DELETE",
      undefined,
      { "If-Match": String(created.revision) }
    );
    assert.equal(deletedResponse.status, 200);
    const deleted = await deletedResponse.json();

    const trashList = await apiRequest(fixture, ["notes"], "GET", undefined, {}, "?view=trash");
    assert.equal(trashList.status, 200);
    assert.deepEqual((await trashList.json()).notes.map((note) => note.id), [NOTE_ID]);

    const missingPrecondition = await apiRequest(fixture, ["notes", NOTE_ID, "restore"], "POST");
    assert.equal(missingPrecondition.status, 428);

    const restoredResponse = await apiRequest(
      fixture,
      ["notes", NOTE_ID, "restore"],
      "POST",
      undefined,
      { "If-Match": String(deleted.revision) }
    );
    assert.equal(restoredResponse.status, 200);
    const restored = await restoredResponse.json();
    assert.equal(restored.deletedAt, "");
    assert.equal(restored.revision, deleted.revision + 1);
    assert.equal(restored.body, created.body);
    assert.ok(latestD1Changes(fixture, /^\s*UPDATE notes\s+SET deleted_at = ''/i) > 1);

    const restoreReplayResponse = await apiRequest(
      fixture,
      ["notes", NOTE_ID, "restore"],
      "POST",
      undefined,
      { "If-Match": String(deleted.revision) }
    );
    assert.equal(restoreReplayResponse.status, 200);
    assert.deepEqual(await restoreReplayResponse.json(), restored);
    assert.equal(auditCount(fixture, "note.restore", NOTE_ID), 1);

    // The historical delete is the last row of this page while the restore upsert is on
    // the next page. Because the current server row is already active, the first page must
    // never make the client transiently delete the restored memo.
    const firstSyncPage = await (await apiRequest(
      fixture,
      ["mobile", "notes", "sync"],
      "GET",
      undefined,
      {},
      "?cursor=0&limit=2"
    )).json();
    assert.equal(firstSyncPage.hasMore, true);
    assert.equal(firstSyncPage.changes.length, 2);
    assert.equal(firstSyncPage.changes.at(-1).type, "upsert");
    assert.equal(firstSyncPage.changes.at(-1).note.id, NOTE_ID);
    assert.equal(firstSyncPage.changes.at(-1).note.revision, restored.revision);
    assert.equal(firstSyncPage.changes.at(-1).note.deletedAt, "");

    const secondSyncPage = await (await apiRequest(
      fixture,
      ["mobile", "notes", "sync"],
      "GET",
      undefined,
      {},
      `?cursor=${encodeURIComponent(firstSyncPage.nextCursor)}&limit=2`
    )).json();
    assert.equal(secondSyncPage.hasMore, false);
    assert.equal(secondSyncPage.changes.length, 1);
    assert.equal(secondSyncPage.changes[0].type, "upsert");
    assert.equal(secondSyncPage.changes[0].note.revision, restored.revision);

    const restoreAudit = fixture.sqlite.prepare(
      "SELECT actor FROM audit_logs WHERE action = 'note.restore' ORDER BY created_at DESC LIMIT 1"
    ).get();
    assert.equal(restoreAudit.actor, "mobile");
  } finally {
    fixture.sqlite.close();
  }
});

test("mobile note create replay is idempotent and a changed payload keeps the id conflict", async () => {
  const fixture = await createFixture();
  try {
    const requestBody = {
      id: REPLAY_NOTE_ID,
      body: "Idempotent mobile memo\nThe response may have been lost.",
      categoryId: "visitation",
      color: "mint",
      pinned: true,
      status: "active",
      memberId: "member-1",
      groupId: "group-1",
      remindAt: "2030-01-02T03:04:05Z",
      reminderState: "scheduled"
    };

    const createdResponse = await apiRequest(fixture, ["notes"], "POST", requestBody);
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    const countsAfterCreate = replayCounts(fixture, REPLAY_NOTE_ID);
    assert.deepEqual(countsAfterCreate, { notes: 1, syncChanges: 1, createAudits: 1 });

    const replayResponse = await apiRequest(fixture, ["notes"], "POST", requestBody);
    assert.equal(replayResponse.status, 200);
    assert.deepEqual(await replayResponse.json(), created);
    assert.deepEqual(replayCounts(fixture, REPLAY_NOTE_ID), countsAfterCreate);

    const changedResponse = await apiRequest(fixture, ["notes"], "POST", {
      ...requestBody,
      body: `${requestBody.body}\nChanged after retry`
    });
    assert.equal(changedResponse.status, 409);
    assert.equal((await changedResponse.json()).code, "NOTE_ID_CONFLICT");
    assert.deepEqual(replayCounts(fixture, REPLAY_NOTE_ID), countsAfterCreate);
  } finally {
    fixture.sqlite.close();
  }
});

test("mobile memo errors use stable codes and identical update retries converge on the latest revision", async () => {
  const fixture = await createFixture();
  try {
    const invalidCreate = await apiRequest(fixture, ["notes"], "POST", {
      id: "not-a-uuid",
      body: "Invalid id"
    });
    assert.equal(invalidCreate.status, 400);
    assert.equal((await invalidCreate.json()).code, "NOTE_ID_INVALID");

    const invalidPath = await apiRequest(fixture, ["notes", "not-a-uuid"], "GET");
    assert.equal(invalidPath.status, 400);
    assert.equal((await invalidPath.json()).code, "NOTE_ID_INVALID");

    const invalidCategoryId = await apiRequest(fixture, ["notes"], "POST", {
      id: INVALID_CATEGORY_NOTE_ID,
      body: "Invalid category id",
      categoryId: "not-a-category-id"
    });
    assert.equal(invalidCategoryId.status, 400);
    assert.equal((await invalidCategoryId.json()).code, "NOTE_CATEGORY_ID_INVALID");

    const missingCategory = await apiRequest(fixture, ["notes"], "POST", {
      id: INVALID_CATEGORY_NOTE_ID,
      body: "Missing category",
      categoryId: "56565656-5656-4656-8656-565656565656"
    });
    assert.equal(missingCategory.status, 400);
    assert.equal((await missingCategory.json()).code, "NOTE_CATEGORY_NOT_FOUND");

    const created = await (await apiRequest(fixture, ["notes"], "POST", {
      id: ERROR_CONTRACT_NOTE_ID,
      body: "Original contract memo",
      color: "mint"
    })).json();

    const missingPrecondition = await apiRequest(fixture, ["notes", ERROR_CONTRACT_NOTE_ID], "PATCH", {
      body: "Updated contract memo"
    });
    assert.equal(missingPrecondition.status, 428);
    assert.equal((await missingPrecondition.json()).code, "NOTE_PRECONDITION_REQUIRED");

    const invalidPrecondition = await apiRequest(fixture, ["notes", ERROR_CONTRACT_NOTE_ID], "PATCH", {
      expectedRevision: "invalid",
      body: "Updated contract memo"
    });
    assert.equal(invalidPrecondition.status, 400);
    assert.equal((await invalidPrecondition.json()).code, "NOTE_PRECONDITION_INVALID");

    const conflictingHeaders = await apiRequest(
      fixture,
      ["notes", ERROR_CONTRACT_NOTE_ID],
      "DELETE",
      undefined,
      { "If-Match": String(created.revision), "X-Expected-Revision": String(created.revision + 1) }
    );
    assert.equal(conflictingHeaders.status, 400);
    assert.equal((await conflictingHeaders.json()).code, "NOTE_PRECONDITION_INVALID");

    const conflictingBodyAndHeader = await apiRequest(
      fixture,
      ["notes", ERROR_CONTRACT_NOTE_ID],
      "PATCH",
      { expectedRevision: created.revision, body: "Updated contract memo" },
      { "If-Match": String(created.revision + 1) }
    );
    assert.equal(conflictingBodyAndHeader.status, 400);
    assert.equal((await conflictingBodyAndHeader.json()).code, "NOTE_PRECONDITION_INVALID");

    const invalidUpdatedAt = await apiRequest(fixture, ["notes", ERROR_CONTRACT_NOTE_ID], "PATCH", {
      expectedUpdatedAt: "2026-02-30T01:23:45Z",
      body: "Updated contract memo"
    });
    assert.equal(invalidUpdatedAt.status, 400);
    assert.equal((await invalidUpdatedAt.json()).code, "NOTE_PRECONDITION_INVALID");

    const updateBody = {
      body: "Updated contract memo",
      color: "lavender"
    };
    const updatedResponse = await apiRequest(
      fixture,
      ["notes", ERROR_CONTRACT_NOTE_ID],
      "PATCH",
      updateBody,
      { "If-Match": String(created.revision) }
    );
    assert.equal(updatedResponse.status, 200);
    const updated = await updatedResponse.json();
    assert.equal(updated.revision, created.revision + 1);
    const syncChangesAfterUpdate = replayCounts(fixture, ERROR_CONTRACT_NOTE_ID).syncChanges;
    const auditsAfterUpdate = auditCount(fixture, "note.update", ERROR_CONTRACT_NOTE_ID);

    const responseLossRetry = await apiRequest(
      fixture,
      ["notes", ERROR_CONTRACT_NOTE_ID],
      "PATCH",
      updateBody,
      { "If-Match": String(created.revision) }
    );
    assert.equal(responseLossRetry.status, 200);
    assert.deepEqual(await responseLossRetry.json(), updated);
    assert.equal(replayCounts(fixture, ERROR_CONTRACT_NOTE_ID).syncChanges, syncChangesAfterUpdate);
    assert.equal(auditCount(fixture, "note.update", ERROR_CONTRACT_NOTE_ID), auditsAfterUpdate);

    const staleDifferentUpdate = await apiRequest(
      fixture,
      ["notes", ERROR_CONTRACT_NOTE_ID],
      "PATCH",
      { body: "A different stale update" },
      { "If-Match": String(created.revision) }
    );
    assert.equal(staleDifferentUpdate.status, 409);
    const conflict = await staleDifferentUpdate.json();
    assert.equal(conflict.code, "NOTE_VERSION_CONFLICT");
    assert.equal(conflict.note.revision, updated.revision);
  } finally {
    fixture.sqlite.close();
  }
});

test("concurrent identical mobile note creates produce one row, sync change, and audit", async () => {
  const fixture = await createFixture();
  try {
    const requestBody = {
      id: CONCURRENT_REPLAY_NOTE_ID,
      body: "Concurrent replay",
      color: "lavender",
      pinned: false
    };
    const responses = await Promise.all([
      apiRequest(fixture, ["notes"], "POST", requestBody),
      apiRequest(fixture, ["notes"], "POST", requestBody)
    ]);

    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 201]);
    const payloads = await Promise.all(responses.map((response) => response.json()));
    assert.deepEqual(payloads[0], payloads[1]);
    assert.deepEqual(replayCounts(fixture, CONCURRENT_REPLAY_NOTE_ID), {
      notes: 1,
      syncChanges: 1,
      createAudits: 1
    });
  } finally {
    fixture.sqlite.close();
  }
});

test("mobile note create rolls back the note and sync change when its audit insert fails, then retries cleanly", async () => {
  const fixture = await createFixture();
  const requestBody = {
    id: AUDIT_FAILURE_NOTE_ID,
    body: "Audit failure must not leave a ghost memo",
    color: "coral"
  };
  try {
    rejectAuditAction(fixture, "note.create");
    const failedResponse = await apiRequest(fixture, ["notes"], "POST", requestBody);
    assert.equal(failedResponse.status, 500);
    assert.deepEqual(replayCounts(fixture, AUDIT_FAILURE_NOTE_ID), {
      notes: 0,
      syncChanges: 0,
      createAudits: 0
    });

    allowAuditActions(fixture);
    const retryResponse = await apiRequest(fixture, ["notes"], "POST", requestBody);
    assert.equal(retryResponse.status, 201);
    assert.deepEqual(replayCounts(fixture, AUDIT_FAILURE_NOTE_ID), {
      notes: 1,
      syncChanges: 1,
      createAudits: 1
    });
  } finally {
    allowAuditActions(fixture);
    fixture.sqlite.close();
  }
});

test("mobile update, trash, and restore roll back their note revision and sync change when auditing fails", async () => {
  const fixture = await createFixture();
  try {
    const created = await (await apiRequest(fixture, ["notes"], "POST", {
      id: MUTATION_AUDIT_NOTE_ID,
      body: "Original memo"
    })).json();

    rejectAuditAction(fixture, "note.update");
    const failedUpdate = await apiRequest(fixture, ["notes", MUTATION_AUDIT_NOTE_ID], "PATCH", {
      expectedRevision: created.revision,
      body: "Updated memo"
    });
    assert.equal(failedUpdate.status, 500);
    assert.deepEqual({ ...fixture.sqlite.prepare(
      "SELECT body, revision FROM notes WHERE id = ?"
    ).get(MUTATION_AUDIT_NOTE_ID) }, { body: "Original memo", revision: 1 });
    assert.equal(auditCount(fixture, "note.update", MUTATION_AUDIT_NOTE_ID), 0);
    assert.equal(replayCounts(fixture, MUTATION_AUDIT_NOTE_ID).syncChanges, 1);

    allowAuditActions(fixture);
    const updated = await (await apiRequest(fixture, ["notes", MUTATION_AUDIT_NOTE_ID], "PATCH", {
      expectedRevision: created.revision,
      body: "Updated memo"
    })).json();
    assert.equal(updated.revision, 2);
    assert.equal(auditCount(fixture, "note.update", MUTATION_AUDIT_NOTE_ID), 1);

    rejectAuditAction(fixture, "note.delete");
    const failedDelete = await apiRequest(
      fixture,
      ["notes", MUTATION_AUDIT_NOTE_ID],
      "DELETE",
      undefined,
      { "If-Match": String(updated.revision) }
    );
    assert.equal(failedDelete.status, 500);
    assert.deepEqual({ ...fixture.sqlite.prepare(
      "SELECT deleted_at AS deletedAt, revision FROM notes WHERE id = ?"
    ).get(MUTATION_AUDIT_NOTE_ID) }, { deletedAt: "", revision: 2 });
    assert.equal(auditCount(fixture, "note.delete", MUTATION_AUDIT_NOTE_ID), 0);
    assert.equal(replayCounts(fixture, MUTATION_AUDIT_NOTE_ID).syncChanges, 2);

    allowAuditActions(fixture);
    const deleted = await (await apiRequest(
      fixture,
      ["notes", MUTATION_AUDIT_NOTE_ID],
      "DELETE",
      undefined,
      { "If-Match": String(updated.revision) }
    )).json();
    assert.equal(deleted.revision, 3);
    assert.equal(auditCount(fixture, "note.delete", MUTATION_AUDIT_NOTE_ID), 1);

    rejectAuditAction(fixture, "note.restore");
    const failedRestore = await apiRequest(
      fixture,
      ["notes", MUTATION_AUDIT_NOTE_ID, "restore"],
      "POST",
      undefined,
      { "If-Match": String(deleted.revision) }
    );
    assert.equal(failedRestore.status, 500);
    const afterFailedRestore = fixture.sqlite.prepare(
      "SELECT deleted_at AS deletedAt, revision FROM notes WHERE id = ?"
    ).get(MUTATION_AUDIT_NOTE_ID);
    assert.ok(afterFailedRestore.deletedAt);
    assert.equal(afterFailedRestore.revision, 3);
    assert.equal(auditCount(fixture, "note.restore", MUTATION_AUDIT_NOTE_ID), 0);
    assert.equal(replayCounts(fixture, MUTATION_AUDIT_NOTE_ID).syncChanges, 3);

    allowAuditActions(fixture);
    const restoredResponse = await apiRequest(
      fixture,
      ["notes", MUTATION_AUDIT_NOTE_ID, "restore"],
      "POST",
      undefined,
      { "If-Match": String(deleted.revision) }
    );
    assert.equal(restoredResponse.status, 200);
    assert.equal((await restoredResponse.json()).revision, 4);
    assert.equal(auditCount(fixture, "note.restore", MUTATION_AUDIT_NOTE_ID), 1);
  } finally {
    allowAuditActions(fixture);
    fixture.sqlite.close();
  }
});

test("mobile permanent deletion rolls back D1 on audit failure and successful retries are idempotent", async () => {
  const fixture = await createFixture();
  try {
    const created = await (await apiRequest(fixture, ["notes"], "POST", {
      id: PURGE_AUDIT_NOTE_ID,
      body: "Purge with an attachment"
    })).json();
    const form = new FormData();
    form.append("photo", new File([PNG_BYTES], "purge.png", { type: "image/png" }));
    const uploaded = await (await apiRequest(
      fixture,
      ["notes", PURGE_AUDIT_NOTE_ID, "attachments"],
      "POST",
      form,
      { "If-Match": String(created.revision) }
    )).json();
    const deleted = await (await apiRequest(
      fixture,
      ["notes", PURGE_AUDIT_NOTE_ID],
      "DELETE",
      undefined,
      { "If-Match": String(uploaded.revision) }
    )).json();

    rejectAuditAction(fixture, "note.purge");
    const failedPurge = await apiRequest(
      fixture,
      ["notes", PURGE_AUDIT_NOTE_ID, "permanent"],
      "DELETE",
      undefined,
      { "If-Match": String(deleted.revision) }
    );
    assert.equal(failedPurge.status, 500);
    assert.equal(fixture.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM notes WHERE id = ?"
    ).get(PURGE_AUDIT_NOTE_ID).count, 1);
    assert.equal(fixture.sqlite.prepare(
      "SELECT purge_started_at AS claim FROM notes WHERE id = ?"
    ).get(PURGE_AUDIT_NOTE_ID).claim, "");
    assert.equal(fixture.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM note_attachments WHERE note_id = ?"
    ).get(PURGE_AUDIT_NOTE_ID).count, 1);
    assert.equal(fixture.r2.objects.size, 0);
    assert.equal(auditCount(fixture, "note.purge", PURGE_AUDIT_NOTE_ID), 0);

    allowAuditActions(fixture);
    const retryResponse = await apiRequest(
      fixture,
      ["notes", PURGE_AUDIT_NOTE_ID, "permanent"],
      "DELETE",
      undefined,
      { "If-Match": String(deleted.revision) }
    );
    assert.equal(retryResponse.status, 200);
    assert.equal(auditCount(fixture, "note.purge", PURGE_AUDIT_NOTE_ID), 1);
    assert.equal(fixture.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM notes WHERE id = ?"
    ).get(PURGE_AUDIT_NOTE_ID).count, 0);

    const responseLossRetry = await apiRequest(
      fixture,
      ["notes", PURGE_AUDIT_NOTE_ID, "permanent"],
      "DELETE",
      undefined,
      { "If-Match": String(deleted.revision) }
    );
    assert.equal(responseLossRetry.status, 200);
    assert.deepEqual(await responseLossRetry.json(), {
      ok: true,
      id: PURGE_AUDIT_NOTE_ID,
      permanentlyDeleted: true
    });
    assert.equal(auditCount(fixture, "note.purge", PURGE_AUDIT_NOTE_ID), 1);
  } finally {
    allowAuditActions(fixture);
    fixture.sqlite.close();
  }
});

test("mobile empty trash keeps per-note purge audits atomic and treats summary audit failure as best effort", async () => {
  const fixture = await createFixture();
  try {
    const created = await (await apiRequest(fixture, ["notes"], "POST", {
      id: BULK_AUDIT_NOTE_ID,
      body: "Bulk purge audit"
    })).json();
    await apiRequest(
      fixture,
      ["notes", BULK_AUDIT_NOTE_ID],
      "DELETE",
      undefined,
      { "If-Match": String(created.revision) }
    );

    rejectAuditAction(fixture, "note.trash.empty");
    const firstResponse = await apiRequest(fixture, ["notes", "trash"], "DELETE");
    assert.equal(firstResponse.status, 200);
    assert.deepEqual((await firstResponse.json()).purgedIds, [BULK_AUDIT_NOTE_ID]);
    assert.equal(auditCount(fixture, "note.purge", BULK_AUDIT_NOTE_ID), 1);
    assert.equal(auditCount(fixture, "note.trash.empty", "trash"), 0);

    allowAuditActions(fixture);
    const responseLossRetry = await apiRequest(fixture, ["notes", "trash"], "DELETE");
    assert.equal(responseLossRetry.status, 200);
    assert.deepEqual(await responseLossRetry.json(), {
      ok: true,
      purgedIds: [],
      failed: 0,
      remaining: 0
    });
    assert.equal(auditCount(fixture, "note.purge", BULK_AUDIT_NOTE_ID), 1);
    assert.equal(auditCount(fixture, "note.trash.empty", "trash"), 1);
  } finally {
    allowAuditActions(fixture);
    fixture.sqlite.close();
  }
});

test("mobile notes:write can permanently delete one trashed note and empty trash, but guests cannot", async () => {
  const fixture = await createFixture();
  try {
    const created = await (await apiRequest(fixture, ["notes"], "POST", {
      id: PURGE_NOTE_ID,
      body: "Purge this memo"
    })).json();
    const deleted = await (await apiRequest(
      fixture,
      ["notes", PURGE_NOTE_ID],
      "DELETE",
      undefined,
      { "If-Match": String(created.revision) }
    )).json();
    const permanentResponse = await apiRequest(
      fixture,
      ["notes", PURGE_NOTE_ID, "permanent"],
      "DELETE",
      undefined,
      { "If-Match": String(deleted.revision) }
    );
    assert.equal(permanentResponse.status, 200);
    assert.deepEqual(await permanentResponse.json(), {
      ok: true,
      id: PURGE_NOTE_ID,
      permanentlyDeleted: true
    });
    assert.equal(fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM notes WHERE id = ?").get(PURGE_NOTE_ID).count, 0);
    assert.equal(fixture.sqlite.prepare(
      "SELECT actor FROM audit_logs WHERE action = 'note.purge' ORDER BY created_at DESC LIMIT 1"
    ).get().actor, "mobile");

    for (const [id, body] of [
      [BULK_PURGE_NOTE_ID_A, "Bulk purge A"],
      [BULK_PURGE_NOTE_ID_B, "Bulk purge B"]
    ]) {
      const bulkCreated = await (await apiRequest(fixture, ["notes"], "POST", { id, body })).json();
      const bulkDeleted = await apiRequest(
        fixture,
        ["notes", id],
        "DELETE",
        undefined,
        { "If-Match": String(bulkCreated.revision) }
      );
      assert.equal(bulkDeleted.status, 200);
    }

    const guestResponse = await onRequest({
      request: new Request("https://example.test/api/notes/trash", { method: "DELETE" }),
      env: fixture.env,
      params: { path: ["notes", "trash"] },
      data: { viewerRole: "guest" }
    });
    assert.equal(guestResponse.status, 401);

    const emptyResponse = await apiRequest(fixture, ["notes", "trash"], "DELETE");
    assert.equal(emptyResponse.status, 200);
    const emptied = await emptyResponse.json();
    assert.equal(emptied.ok, true);
    assert.deepEqual(new Set(emptied.purgedIds), new Set([BULK_PURGE_NOTE_ID_A, BULK_PURGE_NOTE_ID_B]));
    assert.equal(emptied.failed, 0);
    assert.equal(emptied.remaining, 0);
    assert.equal(fixture.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM notes WHERE id IN (?, ?)"
    ).get(BULK_PURGE_NOTE_ID_A, BULK_PURGE_NOTE_ID_B).count, 0);
    assert.equal(fixture.sqlite.prepare(
      "SELECT actor FROM audit_logs WHERE action = 'note.trash.empty' ORDER BY created_at DESC LIMIT 1"
    ).get().actor, "mobile");
  } finally {
    fixture.sqlite.close();
  }
});

test("mobile notes scopes can list, create, use, sync, and safely delete persistent categories", async () => {
  const fixture = await createFixture();
  try {
    const listedResponse = await apiRequest(fixture, ["note-categories"], "GET");
    assert.equal(listedResponse.status, 200);
    const listed = await listedResponse.json();
    assert.deepEqual(listed.categories.map((category) => category.id), ["personal", "visitation", "admin"]);

    const renamedDefault = await apiRequest(fixture, ["note-categories", "admin"], "PATCH", {
      name: "사역"
    });
    assert.equal(renamedDefault.status, 200);
    assert.equal((await renamedDefault.json()).name, "사역");

    const createdCategoryResponse = await apiRequest(fixture, ["note-categories"], "POST", {
      name: "기도"
    });
    assert.equal(createdCategoryResponse.status, 201);
    const category = await createdCategoryResponse.json();
    assert.equal(category.name, "기도");
    assert.equal(category.isSystem, false);

    const createdNoteResponse = await apiRequest(fixture, ["notes"], "POST", {
      id: CATEGORY_NOTE_ID,
      body: "기도 분류 모바일 메모",
      categoryId: category.id
    });
    assert.equal(createdNoteResponse.status, 201);
    const note = await createdNoteResponse.json();
    assert.equal(note.categoryId, category.id);
    assert.equal(note.categoryName, "기도");
    assert.equal(note.category, "personal");

    const sync = await (await apiRequest(
      fixture,
      ["mobile", "notes", "sync"],
      "GET",
      undefined,
      {},
      "?cursor=0&limit=100"
    )).json();
    const categoryChange = sync.changes.find((change) => change.note?.id === CATEGORY_NOTE_ID);
    assert.equal(categoryChange.note.categoryId, category.id);
    assert.equal(categoryChange.note.categoryName, "기도");

    const inUse = await apiRequest(fixture, ["note-categories", category.id], "DELETE");
    assert.equal(inUse.status, 409);
    assert.equal((await inUse.json()).code, "NOTE_CATEGORY_IN_USE");
    const deletedDefault = await apiRequest(fixture, ["note-categories", "personal"], "DELETE");
    assert.equal(deletedDefault.status, 200);

    fixture.sqlite.prepare("DELETE FROM notes WHERE id = ?").run(CATEGORY_NOTE_ID);
    const deleted = await apiRequest(fixture, ["note-categories", category.id], "DELETE");
    assert.equal(deleted.status, 200);
    const deleteReplay = await apiRequest(fixture, ["note-categories", category.id], "DELETE");
    assert.equal(deleteReplay.status, 200);
    assert.deepEqual(await deleteReplay.json(), { ok: true, deleted: true, id: category.id });
    assert.equal(auditCount(fixture, "note_category.delete", category.id), 1);
    const categoryAudit = fixture.sqlite.prepare(
      "SELECT actor FROM audit_logs WHERE action = 'note_category.delete' ORDER BY created_at DESC LIMIT 1"
    ).get();
    assert.equal(categoryAudit.actor, "mobile");
  } finally {
    fixture.sqlite.close();
  }
});

test("mobile note categories normalize legacy SQLite timestamps to RFC3339 UTC", async () => {
  const fixture = await createFixture();
  try {
    fixture.sqlite.prepare(
      "UPDATE note_categories SET created_at = ?, updated_at = ? WHERE id = 'personal'"
    ).run("2026-07-16 01:23:45", "2026-07-16 02:34:56");
    const response = await apiRequest(fixture, ["note-categories"], "GET");
    assert.equal(response.status, 200);
    const category = (await response.json()).categories.find((item) => item.id === "personal");
    assert.equal(category.createdAt, "2026-07-16T01:23:45.000Z");
    assert.equal(category.updatedAt, "2026-07-16T02:34:56.000Z");
  } finally {
    fixture.sqlite.close();
  }
});

test("mobile note categories return new RFC3339 timestamps as canonical UTC", async () => {
  const fixture = await createFixture();
  try {
    fixture.sqlite.prepare(
      "UPDATE note_categories SET created_at = ?, updated_at = ? WHERE id = 'visitation'"
    ).run("2026-07-16T01:23:45.123Z", "2026-07-16T03:04:05+09:00");
    const response = await apiRequest(fixture, ["note-categories"], "GET");
    assert.equal(response.status, 200);
    const category = (await response.json()).categories.find((item) => item.id === "visitation");
    assert.equal(category.createdAt, "2026-07-16T01:23:45.123Z");
    assert.equal(category.updatedAt, "2026-07-15T18:04:05.000Z");
  } finally {
    fixture.sqlite.close();
  }
});

test("mobile note categories reject impossible or malformed stored timestamps", async () => {
  for (const invalidTimestamp of [
    "2026-02-30 01:23:45",
    " 2026-07-16T01:23:45Z",
    "0000-01-01T00:00:00Z",
    "0001-01-01T00:00:00+23:59"
  ]) {
    const fixture = await createFixture();
    try {
      fixture.sqlite.prepare(
        "UPDATE note_categories SET created_at = ? WHERE id = 'admin'"
      ).run(invalidTimestamp);
      const response = await apiRequest(fixture, ["note-categories"], "GET");
      assert.equal(response.status, 500);
      assert.equal((await response.json()).code, "NOTE_CATEGORY_TIMESTAMP_INVALID");
    } finally {
      fixture.sqlite.close();
    }
  }
});

test("mobile memo API normalizes legacy notes and archived status", async () => {
  const fixture = await createFixture();
  try {
    const createdAt = "2026-07-15T00:00:00.000Z";
    fixture.sqlite.prepare(
      `INSERT INTO notes
        (id, category, category_id, title, body, color, pinned, status, remind_at,
         reminder_state, reminder_id, dismissed_at, revision, deleted_at, created_at, updated_at)
       VALUES (?, 'personal', 'personal', ?, '', 'default', 0, 'active', '',
         'none', '', '', 1, '', ?, ?)`
    ).run(LEGACY_NOTE_ID, "Legacy title only", createdAt, createdAt);

    const listResponse = await apiRequest(fixture, ["notes"], "GET");
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json();
    assert.equal(
      list.notes.find((note) => note.id === LEGACY_NOTE_ID)?.body,
      "Legacy title only"
    );

    const archivedResponse = await apiRequest(fixture, ["notes"], "POST", {
      id: ARCHIVED_NOTE_ID,
      body: "Archived from legacy Android",
      status: "archived"
    });
    assert.equal(archivedResponse.status, 201);
    const archived = await archivedResponse.json();
    assert.equal(archived.status, "done");
    assert.equal(archived.reminderState, "none");

    const syncResponse = await apiRequest(
      fixture,
      ["mobile", "notes", "sync"],
      "GET",
      undefined,
      {},
      "?cursor=0&limit=100"
    );
    assert.equal(syncResponse.status, 200);
    const sync = await syncResponse.json();
    const legacyChange = sync.changes.find((change) => change.note?.id === LEGACY_NOTE_ID);
    assert.equal(legacyChange?.type, "upsert");
    assert.equal(legacyChange.note.body, "Legacy title only");
    assert.equal(
      sync.changes.find((change) => change.note?.id === ARCHIVED_NOTE_ID)?.note.status,
      "done"
    );
  } finally {
    fixture.sqlite.close();
  }
});

async function createFixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '');
    CREATE TABLE call_note_devices (id TEXT PRIMARY KEY, status TEXT NOT NULL, generation INTEGER NOT NULL);
    CREATE TABLE cells (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE members (
      id TEXT PRIMARY KEY,
      cell_id TEXT NOT NULL,
      name TEXT NOT NULL,
      photo_key TEXT NOT NULL DEFAULT '',
      archived_at TEXT NOT NULL DEFAULT '',
      trashed_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE managed_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE managed_group_members (
      group_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      PRIMARY KEY (group_id, member_id)
    );
    CREATE TABLE note_categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      category_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT 'default',
      pinned INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
      group_id TEXT REFERENCES managed_groups(id) ON DELETE SET NULL,
      remind_at TEXT NOT NULL DEFAULT '',
      reminder_state TEXT NOT NULL DEFAULT 'none',
      reminder_id TEXT NOT NULL DEFAULT '',
      dismissed_at TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT NOT NULL DEFAULT '',
      purge_started_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE note_attachments (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      object_key TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL DEFAULT '',
      content_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL DEFAULT 0,
      client_attachment_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_note_attachments_note_client_id
      ON note_attachments(note_id, client_attachment_id)
      WHERE client_attachment_id <> '';
    CREATE TABLE note_sync_changes (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      change_type TEXT NOT NULL,
      changed_at TEXT NOT NULL
    );
    CREATE TRIGGER notes_sync_after_insert
    AFTER INSERT ON notes
    BEGIN
      INSERT INTO note_sync_changes (note_id, revision, change_type, changed_at)
      VALUES (NEW.id, NEW.revision, CASE WHEN NEW.deleted_at = '' THEN 'upsert' ELSE 'delete' END, NEW.updated_at);
    END;
    CREATE TRIGGER notes_sync_after_revision_update
    AFTER UPDATE OF revision ON notes
    WHEN NEW.revision <> OLD.revision
    BEGIN
      INSERT INTO note_sync_changes (note_id, revision, change_type, changed_at)
      VALUES (NEW.id, NEW.revision, CASE WHEN NEW.deleted_at = '' THEN 'upsert' ELSE 'delete' END, NEW.updated_at);
    END;
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY,
      actor TEXT DEFAULT '',
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      before_json TEXT DEFAULT '',
      after_json TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TRIGGER notes_category_id_before_insert
    BEFORE INSERT ON notes
    WHEN NEW.category_id <> ''
      AND NOT EXISTS (SELECT 1 FROM note_categories WHERE id = NEW.category_id)
    BEGIN
      SELECT RAISE(ABORT, 'NOTE_CATEGORY_INVALID');
    END;
    CREATE TRIGGER notes_category_id_before_update
    BEFORE UPDATE OF category_id ON notes
    WHEN NEW.category_id <> ''
      AND NOT EXISTS (SELECT 1 FROM note_categories WHERE id = NEW.category_id)
    BEGIN
      SELECT RAISE(ABORT, 'NOTE_CATEGORY_INVALID');
    END;
    CREATE TRIGGER note_categories_in_use_before_delete
    BEFORE DELETE ON note_categories
    WHEN EXISTS (SELECT 1 FROM notes WHERE category_id = OLD.id)
    BEGIN
      SELECT RAISE(ABORT, 'NOTE_CATEGORY_IN_USE');
    END;
    INSERT INTO note_categories (id, name, normalized_name, is_system, created_at, updated_at) VALUES
      ('personal', '개인', '개인', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('visitation', '심방', '심방', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('admin', '행정', '행정', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    INSERT INTO app_settings (key, value) VALUES ('notification.siteId', '${SITE_ID}');
    INSERT INTO call_note_devices (id, status, generation) VALUES ('${DEVICE_ID}', 'active', 1);
    INSERT INTO cells (id, name) VALUES ('cell-1', '사랑셀');
    INSERT INTO members (id, cell_id, name) VALUES ('member-1', 'cell-1', '김사랑');
    INSERT INTO managed_groups (id, name, sort_order) VALUES ('group-1', '소망구역', 1);
    INSERT INTO managed_group_members (group_id, member_id) VALUES ('group-1', 'member-1');
  `);
  const r2 = new MockR2Bucket();
  const d1Changes = [];
  const env = { DB: d1Adapter(sqlite, d1Changes), PHOTOS: r2, NOTIFICATION_SECRET: SECRET };
  const token = await createMobileMemoAccessToken({
    env,
    siteId: SITE_ID,
    deviceId: DEVICE_ID,
    generation: 1
  });
  return { sqlite, r2, env, accessToken: token.accessToken, d1Changes };
}

async function apiRequest(fixture, path, method, body, headers = {}, suffix = "") {
  const isForm = body instanceof FormData;
  const pathname = suffix.startsWith("/api/") ? suffix : `/api/${path.join("/")}${suffix}`;
  const request = new Request(`https://example.test${pathname}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${fixture.accessToken}`,
      ...(body === undefined || isForm ? {} : { "Content-Type": "application/json" }),
      ...headers
    },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body)
  });
  return onRequest({ request, env: fixture.env, params: { path }, data: {} });
}

function replayCounts(fixture, noteId) {
  return {
    notes: fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM notes WHERE id = ?").get(noteId).count,
    syncChanges: fixture.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM note_sync_changes WHERE note_id = ?"
    ).get(noteId).count,
    createAudits: fixture.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'note.create' AND entity_id = ?"
    ).get(noteId).count
  };
}

function rejectAuditAction(fixture, action) {
  if (!/^[a-z_.]+$/.test(action)) throw new Error("Unsafe test audit action");
  fixture.sqlite.exec(`
    DROP TRIGGER IF EXISTS reject_selected_audit;
    CREATE TRIGGER reject_selected_audit
    BEFORE INSERT ON audit_logs
    WHEN NEW.action = '${action}'
    BEGIN
      SELECT RAISE(ABORT, 'TEST_AUDIT_REJECTED');
    END;
  `);
}

function allowAuditActions(fixture) {
  fixture.sqlite.exec("DROP TRIGGER IF EXISTS reject_selected_audit");
}

function auditCount(fixture, action, entityId) {
  return fixture.sqlite.prepare(
    "SELECT COUNT(*) AS count FROM audit_logs WHERE action = ? AND entity_id = ?"
  ).get(action, entityId).count;
}

function latestD1Changes(fixture, pattern) {
  return [...fixture.d1Changes].reverse().find((entry) => pattern.test(entry.sql))?.changes || 0;
}

class MockR2Bucket {
  constructor() {
    this.objects = new Map();
  }

  async put(key, value, options) {
    const bytes = new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, { bytes, options });
  }

  async get(key) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      body: new Response(stored.bytes).body,
      httpEtag: '"test-etag"',
      writeHttpMetadata(headers) {
        headers.set("Content-Type", stored.options?.httpMetadata?.contentType || "application/octet-stream");
      }
    };
  }

  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
}

function d1Adapter(sqlite, observedChanges = []) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      const bound = [];
      return {
        bind(...values) {
          bound.splice(0, bound.length, ...values);
          return this;
        },
        async first() {
          return statement.get(...bound) || null;
        },
        async all() {
          return { results: statement.all(...bound) };
        },
        async run() {
          const before = Number(sqlite.prepare("SELECT total_changes() AS count").get().count || 0);
          const results = /\bRETURNING\b/i.test(sql) ? statement.all(...bound) : [];
          if (!/\bRETURNING\b/i.test(sql)) statement.run(...bound);
          const after = Number(sqlite.prepare("SELECT total_changes() AS count").get().count || 0);
          const changes = after - before;
          observedChanges.push({ sql, changes });
          return { results, meta: { changes } };
        }
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  };
}
