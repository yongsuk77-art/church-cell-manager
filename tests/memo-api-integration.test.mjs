import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { onRequest } from "../functions/api/[[path]].js";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x04, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const CLIENT_ATTACHMENT_ID = "66666666-6666-4666-8666-666666666666";
const SECOND_CLIENT_ATTACHMENT_ID = "77777777-7777-4777-8777-777777777777";

test("content-only notes derive titles and persist color, person, and reminder data", async () => {
  const fixture = createFixture();
  try {
    const createdResponse = await apiRequest(fixture.env, ["notes"], "POST", {
      body: "첫 줄이 제목입니다\n두 번째 줄은 메모 내용입니다.",
      color: "sage",
      memberId: "member-1",
      remindAt: "2026-07-20T09:30:00+09:00",
      reminderState: "scheduled"
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.title, "첫 줄이 제목입니다");
    assert.equal(created.body, "첫 줄이 제목입니다\n두 번째 줄은 메모 내용입니다.");
    assert.equal(created.color, "sage");
    assert.equal(created.memberId, "member-1");
    assert.equal(created.remindAt, "2026-07-20T00:30:00.000Z");
    assert.equal(created.reminderState, "scheduled");
    assert.equal(created.revision, 1);
    assert.equal(created.deletedAt, "");
    assert.deepEqual(created.attachments, []);

    const updatedResponse = await apiRequest(fixture.env, ["notes", created.id], "PATCH", {
      expectedUpdatedAt: created.updatedAt,
      expectedRevision: created.revision,
      body: "바뀐 첫 줄\n새 내용",
      color: "lavender"
    });
    assert.equal(updatedResponse.status, 200);
    const updated = await updatedResponse.json();
    assert.equal(updated.title, "바뀐 첫 줄");
    assert.equal(updated.color, "lavender");
    assert.equal(updated.createdAt, created.createdAt);
    assert.equal(updated.revision, 2);
    assert.ok(Date.parse(updated.updatedAt) > Date.parse(created.updatedAt));
  } finally {
    fixture.sqlite.close();
  }
});

test("note photos stream through R2 and can be listed and removed", async () => {
  const fixture = createFixture();
  try {
    const created = await (await apiRequest(fixture.env, ["notes"], "POST", {
      body: "사진이 있는 메모",
      color: "blue"
    })).json();

    const form = new FormData();
    form.append("photo", new File([PNG_BYTES], "방문 사진.png", { type: "image/png" }));
    const uploadedResponse = await apiRequest(
      fixture.env,
      ["notes", created.id, "attachments"],
      "POST",
      form,
      {
        "If-Match": String(created.revision),
        "X-Client-Attachment-Id": CLIENT_ATTACHMENT_ID
      }
    );
    assert.equal(uploadedResponse.status, 201);
    const uploaded = await uploadedResponse.json();
    assert.equal(uploaded.attachments.length, 1);
    assert.equal(uploaded.attachments[0].contentType, "image/png");
    assert.equal(uploaded.attachments[0].byteSize, PNG_BYTES.length);
    assert.match(uploaded.attachments[0].url, /^\/api\/photos\//);
    assert.equal(fixture.r2.objects.size, 1);
    assert.equal(uploaded.attachments[0].objectKey, `notes/${created.id}/${CLIENT_ATTACHMENT_ID}`);
    assert.equal(
      fixture.sqlite.prepare("SELECT client_attachment_id FROM note_attachments WHERE note_id = ?").get(created.id)
        .client_attachment_id,
      CLIENT_ATTACHMENT_ID
    );

    const replayedResponse = await apiRequest(
      fixture.env,
      ["notes", created.id, "attachments"],
      "POST",
      undefined,
      {
        "If-Match": String(created.revision),
        "X-Client-Attachment-Id": CLIENT_ATTACHMENT_ID
      }
    );
    assert.equal(replayedResponse.status, 200);
    const replayed = await replayedResponse.json();
    assert.equal(replayed.revision, uploaded.revision);
    assert.equal(replayed.attachments.length, 1);
    assert.equal(fixture.r2.objects.size, 1);
    assert.equal(fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM note_attachments").get().count, 1);

    const listed = await (await apiRequest(fixture.env, ["notes"], "GET")).json();
    assert.equal(listed.notes[0].attachments.length, 1);

    const attachmentId = uploaded.attachments[0].id;
    const deletedResponse = await apiRequest(
      fixture.env,
      ["notes", created.id, "attachments", attachmentId],
      "DELETE",
      undefined,
      { "If-Match": String(uploaded.revision) }
    );
    assert.equal(deletedResponse.status, 200);
    assert.deepEqual((await deletedResponse.json()).attachments, []);
    assert.equal(fixture.r2.objects.size, 0);
  } finally {
    fixture.sqlite.close();
  }
});

test("photo create and delete keep D1 audit atomic while R2 compensation and retries stay safe", async () => {
  const fixture = createFixture();
  try {
    const created = await (await apiRequest(fixture.env, ["notes"], "POST", {
      body: "Photo audit transaction"
    })).json();

    rejectAuditAction(fixture, "note.attachment.create");
    const failedUploadForm = new FormData();
    failedUploadForm.append("photo", new File([PNG_BYTES], "audit.png", { type: "image/png" }));
    const failedUpload = await apiRequest(
      fixture.env,
      ["notes", created.id, "attachments"],
      "POST",
      failedUploadForm,
      {
        "If-Match": String(created.revision),
        "X-Client-Attachment-Id": SECOND_CLIENT_ATTACHMENT_ID
      }
    );
    assert.equal(failedUpload.status, 503);
    assert.equal((await failedUpload.json()).code, "NOTE_ATTACHMENT_DB_WRITE_FAILED");
    assert.equal(fixture.r2.objects.size, 0);
    assert.deepEqual({ ...fixture.sqlite.prepare(
      `SELECT revision,
        (SELECT COUNT(*) FROM note_attachments WHERE note_id = notes.id) AS attachmentCount
       FROM notes WHERE id = ?`
    ).get(created.id) }, { revision: 1, attachmentCount: 0 });
    assert.equal(syncCount(fixture, created.id), 1);
    assert.equal(auditCount(fixture, "note.attachment.create", created.id), 0);

    allowAuditActions(fixture);
    const retryUploadForm = new FormData();
    retryUploadForm.append("photo", new File([PNG_BYTES], "audit.png", { type: "image/png" }));
    const uploadedResponse = await apiRequest(
      fixture.env,
      ["notes", created.id, "attachments"],
      "POST",
      retryUploadForm,
      {
        "If-Match": String(created.revision),
        "X-Client-Attachment-Id": SECOND_CLIENT_ATTACHMENT_ID
      }
    );
    assert.equal(uploadedResponse.status, 201);
    const uploaded = await uploadedResponse.json();
    assert.equal(uploaded.revision, 2);
    assert.equal(uploaded.attachments.length, 1);
    assert.equal(fixture.r2.objects.size, 1);
    assert.equal(syncCount(fixture, created.id), 2);
    assert.equal(auditCount(fixture, "note.attachment.create", created.id), 1);

    const uploadResponseLossRetry = await apiRequest(
      fixture.env,
      ["notes", created.id, "attachments"],
      "POST",
      undefined,
      {
        "If-Match": String(created.revision),
        "X-Client-Attachment-Id": SECOND_CLIENT_ATTACHMENT_ID
      }
    );
    assert.equal(uploadResponseLossRetry.status, 200);
    assert.equal((await uploadResponseLossRetry.json()).revision, 2);
    assert.equal(syncCount(fixture, created.id), 2);
    assert.equal(auditCount(fixture, "note.attachment.create", created.id), 1);

    const attachmentId = uploaded.attachments[0].id;
    rejectAuditAction(fixture, "note.attachment.delete");
    const failedDelete = await apiRequest(
      fixture.env,
      ["notes", created.id, "attachments", attachmentId],
      "DELETE",
      undefined,
      { "If-Match": String(uploaded.revision) }
    );
    assert.equal(failedDelete.status, 500);
    assert.equal(fixture.r2.objects.size, 0);
    assert.deepEqual({ ...fixture.sqlite.prepare(
      `SELECT revision,
        (SELECT COUNT(*) FROM note_attachments WHERE note_id = notes.id) AS attachmentCount
       FROM notes WHERE id = ?`
    ).get(created.id) }, { revision: 2, attachmentCount: 1 });
    assert.equal(syncCount(fixture, created.id), 2);
    assert.equal(auditCount(fixture, "note.attachment.delete", created.id), 0);

    allowAuditActions(fixture);
    const retriedDelete = await apiRequest(
      fixture.env,
      ["notes", created.id, "attachments", attachmentId],
      "DELETE",
      undefined,
      { "If-Match": String(uploaded.revision) }
    );
    assert.equal(retriedDelete.status, 200);
    const afterDelete = await retriedDelete.json();
    assert.equal(afterDelete.revision, 3);
    assert.deepEqual(afterDelete.attachments, []);
    assert.equal(syncCount(fixture, created.id), 3);
    assert.equal(auditCount(fixture, "note.attachment.delete", created.id), 1);

    const deleteResponseLossRetry = await apiRequest(
      fixture.env,
      ["notes", created.id, "attachments", attachmentId],
      "DELETE",
      undefined,
      { "If-Match": String(uploaded.revision) }
    );
    assert.equal(deleteResponseLossRetry.status, 200);
    assert.equal((await deleteResponseLossRetry.json()).revision, 3);
    assert.equal(syncCount(fixture, created.id), 3);
    assert.equal(auditCount(fixture, "note.attachment.delete", created.id), 1);
  } finally {
    allowAuditActions(fixture);
    fixture.sqlite.close();
  }
});

test("persistent note categories support additive note fields, normalized uniqueness, and reference-safe deletion", async () => {
  const fixture = createFixture();
  try {
    const initialResponse = await apiRequest(fixture.env, ["note-categories"], "GET");
    assert.equal(initialResponse.status, 200);
    const initial = await initialResponse.json();
    assert.deepEqual(initial.categories.map((category) => [category.id, category.name, category.isSystem]), [
      ["personal", "개인", true],
      ["visitation", "심방", true],
      ["admin", "행정", true]
    ]);

    const renamedDefaultResponse = await apiRequest(fixture.env, ["note-categories", "personal"], "PATCH", {
      name: "개인 관리"
    });
    assert.equal(renamedDefaultResponse.status, 200);
    assert.equal((await renamedDefaultResponse.json()).name, "개인 관리");
    const duplicateRename = await apiRequest(fixture.env, ["note-categories", "visitation"], "PATCH", {
      name: "개인 관리"
    });
    assert.equal(duplicateRename.status, 409);
    assert.equal((await duplicateRename.json()).code, "NOTE_CATEGORY_DUPLICATE");

    const defaultCategoryNote = await (await apiRequest(fixture.env, ["notes"], "POST", {
      body: "기본 분류 사용 중",
      categoryId: "personal"
    })).json();
    const inUseDefault = await apiRequest(fixture.env, ["note-categories", "personal"], "DELETE");
    assert.equal(inUseDefault.status, 409);
    assert.equal((await inUseDefault.json()).code, "NOTE_CATEGORY_IN_USE");
    fixture.sqlite.prepare("DELETE FROM notes WHERE id = ?").run(defaultCategoryNote.id);
    const deletedDefault = await apiRequest(fixture.env, ["note-categories", "personal"], "DELETE");
    assert.equal(deletedDefault.status, 200);

    const uncategorizedResponse = await apiRequest(fixture.env, ["notes"], "POST", {
      body: "분류 없는 메모"
    });
    assert.equal(uncategorizedResponse.status, 201);
    const uncategorized = await uncategorizedResponse.json();
    assert.equal(uncategorized.categoryId, "");
    assert.equal(uncategorized.categoryName, "");

    const createdCategoryResponse = await apiRequest(fixture.env, ["note-categories"], "POST", {
      name: "  Prayer  "
    });
    assert.equal(createdCategoryResponse.status, 201);
    const customCategory = await createdCategoryResponse.json();
    assert.match(customCategory.id, /^[0-9a-f-]{36}$/);
    assert.equal(customCategory.name, "Prayer");
    assert.equal(customCategory.isSystem, false);

    const duplicateResponse = await apiRequest(fixture.env, ["note-categories"], "POST", {
      name: " pRaYeR "
    });
    assert.equal(duplicateResponse.status, 409);
    assert.equal((await duplicateResponse.json()).code, "NOTE_CATEGORY_DUPLICATE");
    const emptyName = await apiRequest(fixture.env, ["note-categories"], "POST", { name: "   " });
    assert.equal(emptyName.status, 400);
    assert.equal((await emptyName.json()).code, "NOTE_CATEGORY_NAME_REQUIRED");
    const longName = await apiRequest(fixture.env, ["note-categories"], "POST", { name: "x".repeat(81) });
    assert.equal(longName.status, 400);
    assert.equal((await longName.json()).code, "NOTE_CATEGORY_NAME_TOO_LONG");

    const missingCategoryNote = await apiRequest(fixture.env, ["notes"], "POST", {
      body: "Missing category",
      categoryId: "88888888-8888-4888-8888-888888888888"
    });
    assert.equal(missingCategoryNote.status, 400);
    assert.equal((await missingCategoryNote.json()).code, "NOTE_CATEGORY_NOT_FOUND");

    const createdNoteResponse = await apiRequest(fixture.env, ["notes"], "POST", {
      body: "Custom category note",
      categoryId: customCategory.id
    });
    assert.equal(createdNoteResponse.status, 201);
    const createdNote = await createdNoteResponse.json();
    assert.equal(createdNote.categoryId, customCategory.id);
    assert.equal(createdNote.categoryName, "Prayer");
    assert.equal(createdNote.category, "personal");
    const storedCategory = fixture.sqlite.prepare(
      "SELECT category, category_id AS categoryId FROM notes WHERE id = ?"
    ).get(createdNote.id);
    assert.deepEqual({ ...storedCategory }, { category: "personal", categoryId: customCategory.id });

    const legacyPatch = await apiRequest(fixture.env, ["notes", createdNote.id], "PATCH", {
      expectedRevision: createdNote.revision,
      body: "Legacy update keeps custom category",
      category: "admin"
    });
    assert.equal(legacyPatch.status, 200);
    const legacyUpdated = await legacyPatch.json();
    assert.equal(legacyUpdated.categoryId, customCategory.id);
    assert.equal(legacyUpdated.categoryName, "Prayer");
    assert.equal(legacyUpdated.category, "personal");

    const listed = await (await apiRequest(fixture.env, ["notes"], "GET")).json();
    assert.equal(listed.notes[0].categoryId, customCategory.id);
    assert.equal(listed.notes[0].categoryName, "Prayer");
    const detail = await (await apiRequest(fixture.env, ["notes", createdNote.id], "GET")).json();
    assert.equal(detail.categoryId, customCategory.id);

    const inUseResponse = await apiRequest(
      fixture.env,
      ["note-categories", customCategory.id],
      "DELETE"
    );
    assert.equal(inUseResponse.status, 409);
    assert.equal((await inUseResponse.json()).code, "NOTE_CATEGORY_IN_USE");
    const deletedNote = await apiRequest(
      fixture.env,
      ["notes", createdNote.id],
      "DELETE",
      undefined,
      { "If-Match": String(legacyUpdated.revision) }
    );
    assert.equal(deletedNote.status, 200);
    const stillInUse = await apiRequest(fixture.env, ["note-categories", customCategory.id], "DELETE");
    assert.equal(stillInUse.status, 409);
    assert.equal((await stillInUse.json()).code, "NOTE_CATEGORY_IN_USE");

    fixture.sqlite.prepare("DELETE FROM notes WHERE id = ?").run(createdNote.id);
    const deletedCategoryResponse = await apiRequest(
      fixture.env,
      ["note-categories", customCategory.id],
      "DELETE"
    );
    assert.equal(deletedCategoryResponse.status, 200);
    assert.deepEqual(await deletedCategoryResponse.json(), { ok: true, deleted: true, id: customCategory.id });
  } finally {
    fixture.sqlite.close();
  }
});

test("note category create, update, and delete roll back when their audit insert fails", async () => {
  const fixture = createFixture();
  try {
    rejectAuditAction(fixture, "note_category.create");
    const failedCreate = await apiRequest(fixture.env, ["note-categories"], "POST", {
      name: "Atomic Category"
    });
    assert.equal(failedCreate.status, 503);
    assert.equal((await failedCreate.json()).code, "NOTE_CATEGORY_WRITE_FAILED");
    assert.equal(fixture.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM note_categories WHERE normalized_name = ?"
    ).get("atomic category").count, 0);
    assert.equal(auditCount(fixture, "note_category.create"), 0);

    allowAuditActions(fixture);
    const createdResponse = await apiRequest(fixture.env, ["note-categories"], "POST", {
      name: "Atomic Category"
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(auditCount(fixture, "note_category.create", created.id), 1);

    rejectAuditAction(fixture, "note_category.update");
    const failedUpdate = await apiRequest(
      fixture.env,
      ["note-categories", created.id],
      "PATCH",
      { name: "Atomic Category Updated" }
    );
    assert.equal(failedUpdate.status, 503);
    assert.equal((await failedUpdate.json()).code, "NOTE_CATEGORY_WRITE_FAILED");
    assert.equal(fixture.sqlite.prepare(
      "SELECT name FROM note_categories WHERE id = ?"
    ).get(created.id).name, "Atomic Category");
    assert.equal(auditCount(fixture, "note_category.update", created.id), 0);

    allowAuditActions(fixture);
    const updatedResponse = await apiRequest(
      fixture.env,
      ["note-categories", created.id],
      "PATCH",
      { name: "Atomic Category Updated" }
    );
    assert.equal(updatedResponse.status, 200);
    assert.equal((await updatedResponse.json()).name, "Atomic Category Updated");
    assert.equal(auditCount(fixture, "note_category.update", created.id), 1);

    rejectAuditAction(fixture, "note_category.delete");
    const failedDelete = await apiRequest(
      fixture.env,
      ["note-categories", created.id],
      "DELETE"
    );
    assert.equal(failedDelete.status, 503);
    assert.equal((await failedDelete.json()).code, "NOTE_CATEGORY_DELETE_FAILED");
    assert.equal(fixture.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM note_categories WHERE id = ?"
    ).get(created.id).count, 1);
    assert.equal(auditCount(fixture, "note_category.delete", created.id), 0);

    allowAuditActions(fixture);
    const deletedResponse = await apiRequest(
      fixture.env,
      ["note-categories", created.id],
      "DELETE"
    );
    assert.equal(deletedResponse.status, 200);
    assert.equal(auditCount(fixture, "note_category.delete", created.id), 1);
  } finally {
    allowAuditActions(fixture);
    fixture.sqlite.close();
  }
});

test("category triggers close create/delete races and API responses expose only stable error codes", async () => {
  const fixture = createFixture();
  try {
    const createRaceCategory = await (await apiRequest(fixture.env, ["note-categories"], "POST", {
      name: "Create race"
    })).json();
    const baseDb = fixture.env.DB;
    const createRaceDb = {
      prepare(sql) {
        const statement = baseDb.prepare(sql);
        if (/^\s*INSERT INTO notes\b/i.test(sql)) {
          const run = statement.run.bind(statement);
          statement.run = async () => {
            fixture.sqlite.prepare("DELETE FROM note_categories WHERE id = ?").run(createRaceCategory.id);
            return run();
          };
        }
        return statement;
      },
      batch: baseDb.batch.bind(baseDb)
    };
    const createRaceResponse = await apiRequest(createRaceDb === baseDb ? fixture.env : {
      ...fixture.env,
      DB: createRaceDb
    }, ["notes"], "POST", {
      body: "Category disappears during create",
      categoryId: createRaceCategory.id
    });
    assert.equal(createRaceResponse.status, 409);
    assert.equal((await createRaceResponse.json()).code, "NOTE_CATEGORY_INVALID");

    const deleteRaceCategory = await (await apiRequest(fixture.env, ["note-categories"], "POST", {
      name: "Delete race"
    })).json();
    const deleteRaceDb = {
      prepare(sql) {
        const statement = baseDb.prepare(sql);
        if (/^\s*DELETE FROM note_categories\b/i.test(sql)) {
          const run = statement.run.bind(statement);
          statement.run = async () => {
            const now = "2026-07-15T12:00:00.000Z";
            fixture.sqlite.prepare(
              `INSERT INTO notes
                (id, category, category_id, title, body, color, pinned, status, remind_at, reminder_state,
                 reminder_id, dismissed_at, revision, deleted_at, purge_started_at, created_at, updated_at)
               VALUES (?, 'personal', ?, 'race', 'race', 'default', 0, 'active', '', 'none', '', '', 1, '', '', ?, ?)`
            ).run("99999999-9999-4999-8999-999999999999", deleteRaceCategory.id, now, now);
            return run();
          };
        }
        return statement;
      },
      batch: baseDb.batch.bind(baseDb)
    };
    const deleteRaceResponse = await apiRequest(
      { ...fixture.env, DB: deleteRaceDb },
      ["note-categories", deleteRaceCategory.id],
      "DELETE"
    );
    assert.equal(deleteRaceResponse.status, 409);
    assert.equal((await deleteRaceResponse.json()).code, "NOTE_CATEGORY_IN_USE");
  } finally {
    fixture.sqlite.close();
  }
});

test("note upload consumes the original incoming Request.formData exactly once", async () => {
  const fixture = createFixture();
  try {
    const created = await (await apiRequest(fixture.env, ["notes"], "POST", {
      body: "Native multipart request"
    })).json();
    const form = new FormData();
    form.append("photo", new File([PNG_BYTES], "native.png", { type: "image/png" }));
    const request = new Request(`https://example.test/api/notes/${created.id}/attachments`, {
      method: "POST",
      headers: {
        "If-Match": String(created.revision),
        "X-Client-Attachment-Id": CLIENT_ATTACHMENT_ID
      },
      body: form
    });
    const nativeFormData = request.formData.bind(request);
    let formDataCalls = 0;
    Object.defineProperty(request, "formData", {
      configurable: true,
      value: async () => {
        formDataCalls += 1;
        return nativeFormData();
      }
    });

    const response = await onRequest({
      request,
      env: fixture.env,
      params: { path: ["notes", created.id, "attachments"] },
      data: { viewerRole: "admin" }
    });
    assert.equal(response.status, 201);
    assert.equal(formDataCalls, 1);
  } finally {
    fixture.sqlite.close();
  }
});

test("note uploads normalize browser MIME aliases and missing MIME while rejecting signature mismatches", async () => {
  const fixture = createFixture();
  try {
    const created = await (await apiRequest(fixture.env, ["notes"], "POST", {
      body: "MIME compatibility"
    })).json();
    const jpegForm = new FormData();
    jpegForm.append("photo", new File([JPEG_BYTES], "camera.jpg", { type: "image/pjpeg" }));
    const jpegResponse = await apiRequest(
      fixture.env,
      ["notes", created.id, "attachments"],
      "POST",
      jpegForm,
      {
        "If-Match": String(created.revision),
        "X-Client-Attachment-Id": CLIENT_ATTACHMENT_ID
      }
    );
    assert.equal(jpegResponse.status, 201);
    const withJpeg = await jpegResponse.json();
    assert.equal(withJpeg.attachments[0].contentType, "image/jpeg");

    const missingMimeForm = new FormData();
    missingMimeForm.append("photo", new File([PNG_BYTES], "browser-capture.PNG", { type: "" }));
    const pngResponse = await apiRequest(
      fixture.env,
      ["notes", created.id, "attachments"],
      "POST",
      missingMimeForm,
      {
        "If-Match": String(withJpeg.revision),
        "X-Client-Attachment-Id": SECOND_CLIENT_ATTACHMENT_ID
      }
    );
    assert.equal(pngResponse.status, 201);
    const withPng = await pngResponse.json();
    assert.equal(withPng.attachments.find((item) => item.fileName === "browser-capture.PNG").contentType, "image/png");

    const mismatchForm = new FormData();
    mismatchForm.append("photo", new File([JPEG_BYTES], "private-name.png", { type: "image/x-png" }));
    const capturedLogs = [];
    const originalConsoleError = console.error;
    let mismatchResponse;
    try {
      console.error = (entry) => capturedLogs.push(String(entry));
      mismatchResponse = await apiRequest(
        fixture.env,
        ["notes", created.id, "attachments"],
        "POST",
        mismatchForm,
        { "If-Match": String(withPng.revision) }
      );
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(mismatchResponse.status, 415);
    assert.equal((await mismatchResponse.json()).code, "NOTE_ATTACHMENT_SIGNATURE_INVALID");
    assert.ok(capturedLogs.length >= 1);
    const logEntry = JSON.parse(capturedLogs.at(-1));
    assert.equal(logEntry.stage, "validate");
    assert.equal(logEntry.code, "NOTE_ATTACHMENT_SIGNATURE_INVALID");
    assert.equal(logEntry.contentType, "image/png");
    assert.doesNotMatch(capturedLogs.join("\n"), /private-name|camera\.jpg|browser-capture|66666666/);

    const unsafeExtensionForm = new FormData();
    unsafeExtensionForm.append("photo", new File([PNG_BYTES], "not-an-image.txt", { type: "" }));
    const unsafeExtensionResponse = await apiRequest(
      fixture.env,
      ["notes", created.id, "attachments"],
      "POST",
      unsafeExtensionForm,
      { "If-Match": String(withPng.revision) }
    );
    assert.equal(unsafeExtensionResponse.status, 415);
    assert.equal((await unsafeExtensionResponse.json()).code, "NOTE_ATTACHMENT_TYPE_UNSUPPORTED");
    assert.equal(fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM note_attachments").get().count, 2);
    assert.equal(fixture.r2.objects.size, 2);
  } finally {
    fixture.sqlite.close();
  }
});

test("note upload enforces UUID, multipart envelope, exact 8 MiB boundary, and eight-photo limit with stable codes", async () => {
  const fixture = createFixture();
  try {
    const created = await (await apiRequest(fixture.env, ["notes"], "POST", {
      body: "Upload boundaries"
    })).json();

    const invalidIdResponse = await apiRequest(
      fixture.env,
      ["notes", created.id, "attachments"],
      "POST",
      undefined,
      { "X-Client-Attachment-Id": "not-a-uuid" }
    );
    assert.equal(invalidIdResponse.status, 400);
    assert.equal((await invalidIdResponse.json()).code, "NOTE_ATTACHMENT_ID_INVALID");

    const missingMultipartResponse = await apiRequest(
      fixture.env,
      ["notes", created.id, "attachments"],
      "POST",
      undefined,
      { "If-Match": String(created.revision) }
    );
    assert.equal(missingMultipartResponse.status, 415);
    assert.equal((await missingMultipartResponse.json()).code, "NOTE_ATTACHMENT_MULTIPART_REQUIRED");

    const envelopeRequest = new Request(`https://example.test/api/notes/${created.id}/attachments`, {
      method: "POST",
      headers: {
        "Content-Type": "multipart/form-data; boundary=bounded-request",
        "Content-Length": String(10 * 1024 * 1024 + 1),
        "If-Match": String(created.revision)
      },
      body: "x"
    });
    const envelopeResponse = await onRequest({
      request: envelopeRequest,
      env: fixture.env,
      params: { path: ["notes", created.id, "attachments"] },
      data: { viewerRole: "admin" }
    });
    assert.equal(envelopeResponse.status, 413);
    assert.equal((await envelopeResponse.json()).code, "NOTE_ATTACHMENT_REQUEST_TOO_LARGE");

    const oversizedBytes = new Uint8Array(8 * 1024 * 1024 + 1);
    oversizedBytes.set(PNG_BYTES);
    const exactForm = new FormData();
    exactForm.append("photo", new File([oversizedBytes.subarray(0, 8 * 1024 * 1024)], "exact.png", { type: "image/png" }));
    const exactResponse = await apiRequest(
      fixture.env,
      ["notes", created.id, "attachments"],
      "POST",
      exactForm,
      { "If-Match": String(created.revision) }
    );
    assert.equal(exactResponse.status, 201);
    const exact = await exactResponse.json();
    assert.equal(exact.attachments[0].byteSize, 8 * 1024 * 1024);

    const oversizedForm = new FormData();
    oversizedForm.append("photo", new File([oversizedBytes], "too-large.png", { type: "image/png" }));
    const oversizedResponse = await apiRequest(
      fixture.env,
      ["notes", created.id, "attachments"],
      "POST",
      oversizedForm,
      { "If-Match": String(exact.revision) }
    );
    assert.equal(oversizedResponse.status, 413);
    assert.equal((await oversizedResponse.json()).code, "NOTE_ATTACHMENT_TOO_LARGE");

    const insertAttachment = fixture.sqlite.prepare(
      `INSERT INTO note_attachments
        (id, note_id, object_key, file_name, content_type, byte_size, client_attachment_id, created_at)
       VALUES (?, ?, ?, 'seed.png', 'image/png', 8, '', ?)`
    );
    for (let index = 1; index < 8; index += 1) {
      insertAttachment.run(`seed-${index}`, created.id, `seed/${index}`, `2026-07-15T00:00:0${index}.000Z`);
    }
    const limitResponse = await apiRequest(
      fixture.env,
      ["notes", created.id, "attachments"],
      "POST",
      undefined,
      { "If-Match": String(exact.revision) }
    );
    assert.equal(limitResponse.status, 400);
    assert.equal((await limitResponse.json()).code, "NOTE_ATTACHMENT_LIMIT_REACHED");
  } finally {
    fixture.sqlite.close();
  }
});

test("note upload reports R2 and D1 stages safely and compensates R2 after a metadata failure", async () => {
  const r2Fixture = createFixture();
  try {
    const created = await (await apiRequest(r2Fixture.env, ["notes"], "POST", {
      body: "R2 failure"
    })).json();
    r2Fixture.env.PHOTOS.put = async () => { throw new Error("sensitive-r2-detail"); };
    const form = new FormData();
    form.append("photo", new File([PNG_BYTES], "r2.png", { type: "image/png" }));
    const response = await apiRequest(
      r2Fixture.env,
      ["notes", created.id, "attachments"],
      "POST",
      form,
      { "If-Match": String(created.revision) }
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "NOTE_ATTACHMENT_R2_WRITE_FAILED");
    assert.equal(r2Fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM note_attachments").get().count, 0);
    assert.equal(r2Fixture.sqlite.prepare("SELECT revision FROM notes WHERE id = ?").get(created.id).revision, 1);
  } finally {
    r2Fixture.sqlite.close();
  }

  const d1Fixture = createFixture();
  try {
    const created = await (await apiRequest(d1Fixture.env, ["notes"], "POST", {
      body: "D1 failure"
    })).json();
    const failingDb = {
      prepare: d1Fixture.env.DB.prepare.bind(d1Fixture.env.DB),
      async batch() {
        throw new Error("sensitive-d1-detail");
      }
    };
    const form = new FormData();
    form.append("photo", new File([PNG_BYTES], "d1.png", { type: "image/png" }));
    const response = await apiRequest(
      { ...d1Fixture.env, DB: failingDb },
      ["notes", created.id, "attachments"],
      "POST",
      form,
      {
        "If-Match": String(created.revision),
        "X-Client-Attachment-Id": CLIENT_ATTACHMENT_ID
      }
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "NOTE_ATTACHMENT_DB_WRITE_FAILED");
    assert.equal(d1Fixture.r2.objects.size, 0);
    assert.equal(d1Fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM note_attachments").get().count, 0);
    assert.equal(d1Fixture.sqlite.prepare("SELECT revision FROM notes WHERE id = ?").get(created.id).revision, 1);
  } finally {
    d1Fixture.sqlite.close();
  }
});

test("deleted notes keep their content and photos in trash until an If-Match restore", async () => {
  const fixture = createFixture();
  try {
    const created = await (await apiRequest(fixture.env, ["notes"], "POST", {
      body: "Trash retention memo",
      color: "sage",
      remindAt: "2026-07-20T00:30:00.000Z",
      reminderState: "scheduled"
    })).json();
    const form = new FormData();
    form.append("photo", new File([WEBP_BYTES], "photo.webp", { type: "image/webp" }));
    const uploaded = await (await apiRequest(
      fixture.env,
      ["notes", created.id, "attachments"],
      "POST",
      form,
      { "If-Match": String(created.revision) }
    )).json();
    assert.equal(fixture.r2.objects.size, 1);

    const deleted = await apiRequest(
      fixture.env,
      ["notes", created.id],
      "DELETE",
      undefined,
      { "If-Match": String(uploaded.revision) }
    );
    assert.equal(deleted.status, 200);
    const tombstone = await deleted.json();
    assert.deepEqual(Object.keys(tombstone).sort(), ["deletedAt", "id", "ok", "revision", "updatedAt"]);
    assert.equal(fixture.r2.objects.size, 1);
    assert.equal(fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM notes").get().count, 1);
    const stored = fixture.sqlite.prepare(
      `SELECT revision, deleted_at AS deletedAt, status, remind_at AS remindAt,
        reminder_state AS reminderState FROM notes WHERE id = ?`
    ).get(created.id);
    assert.equal(stored.revision, uploaded.revision + 1);
    assert.ok(stored.deletedAt);
    assert.equal(stored.status, uploaded.status);
    assert.equal(stored.remindAt, uploaded.remindAt);
    assert.equal(stored.reminderState, uploaded.reminderState);
    assert.equal(fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM note_attachments").get().count, 1);
    const listed = await (await apiRequest(fixture.env, ["notes"], "GET")).json();
    assert.deepEqual(listed.notes, []);

    const trashResponse = await apiRequest(fixture.env, ["notes"], "GET", undefined, {}, "?view=trash");
    assert.equal(trashResponse.status, 200);
    const trash = await trashResponse.json();
    assert.equal(trash.notes.length, 1);
    assert.equal(trash.notes[0].id, created.id);
    assert.equal(trash.notes[0].body, uploaded.body);
    assert.equal(trash.notes[0].attachments.length, 1);
    assert.equal(trash.notes[0].trashDaysRemaining, 30);
    assert.ok(trash.notes[0].trashExpiresAt);

    const missingPrecondition = await apiRequest(
      fixture.env, ["notes", created.id, "restore"], "POST"
    );
    assert.equal(missingPrecondition.status, 428);
    const conflict = await apiRequest(
      fixture.env,
      ["notes", created.id, "restore"],
      "POST",
      undefined,
      { "If-Match": String(uploaded.revision) }
    );
    assert.equal(conflict.status, 409);

    fixture.sqlite.prepare("UPDATE notes SET purge_started_at = ? WHERE id = ?")
      .run("2026-07-15T12:00:00.000Z", created.id);
    const purgeConflict = await apiRequest(
      fixture.env,
      ["notes", created.id, "restore"],
      "POST",
      undefined,
      { "If-Match": String(tombstone.revision) }
    );
    assert.equal(purgeConflict.status, 409);
    assert.equal((await purgeConflict.json()).code, "NOTE_PURGE_IN_PROGRESS");
    fixture.sqlite.prepare("UPDATE notes SET purge_started_at = '' WHERE id = ?").run(created.id);

    const restoredResponse = await apiRequest(
      fixture.env,
      ["notes", created.id, "restore"],
      "POST",
      undefined,
      { "If-Match": String(tombstone.revision) }
    );
    assert.equal(restoredResponse.status, 200);
    const restored = await restoredResponse.json();
    assert.equal(restored.revision, tombstone.revision + 1);
    assert.equal(restored.deletedAt, "");
    assert.equal(restored.status, uploaded.status);
    assert.equal(restored.remindAt, uploaded.remindAt);
    assert.equal(restored.attachments.length, 1);
    assert.equal(fixture.r2.objects.size, 1);

    const emptyTrash = await (await apiRequest(
      fixture.env, ["notes"], "GET", undefined, {}, "?view=trash"
    )).json();
    assert.deepEqual(emptyTrash.notes, []);
    const finalChange = fixture.sqlite.prepare(
      "SELECT change_type AS changeType FROM note_sync_changes ORDER BY sequence DESC LIMIT 1"
    ).get();
    assert.equal(finalChange.changeType, "upsert");
  } finally {
    fixture.sqlite.close();
  }
});

test("administrators can permanently delete one trashed note or empty the full trash", async () => {
  const fixture = createFixture();
  try {
    const created = await (await apiRequest(fixture.env, ["notes"], "POST", {
      body: "Permanent delete with photo"
    })).json();
    const form = new FormData();
    form.append("photo", new File([PNG_BYTES], "delete-me.png", { type: "image/png" }));
    const uploaded = await (await apiRequest(
      fixture.env,
      ["notes", created.id, "attachments"],
      "POST",
      form,
      { "If-Match": String(created.revision) }
    )).json();
    const tombstone = await (await apiRequest(
      fixture.env,
      ["notes", created.id],
      "DELETE",
      undefined,
      { "If-Match": String(uploaded.revision) }
    )).json();

    const missingPrecondition = await apiRequest(
      fixture.env, ["notes", created.id, "permanent"], "DELETE"
    );
    assert.equal(missingPrecondition.status, 428);
    assert.equal(fixture.r2.objects.size, 1);

    const purgedResponse = await apiRequest(
      fixture.env,
      ["notes", created.id, "permanent"],
      "DELETE",
      undefined,
      { "If-Match": String(tombstone.revision) }
    );
    assert.equal(purgedResponse.status, 200);
    assert.equal((await purgedResponse.json()).permanentlyDeleted, true);
    assert.equal(fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM notes").get().count, 0);
    assert.equal(fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM note_attachments").get().count, 0);
    assert.equal(fixture.r2.objects.size, 0);

    for (const body of ["Bulk trash one", "Bulk trash two"]) {
      const note = await (await apiRequest(fixture.env, ["notes"], "POST", { body })).json();
      await apiRequest(
        fixture.env,
        ["notes", note.id],
        "DELETE",
        undefined,
        { "If-Match": String(note.revision) }
      );
    }
    const emptiedResponse = await apiRequest(fixture.env, ["notes", "trash"], "DELETE");
    assert.equal(emptiedResponse.status, 200);
    const emptied = await emptiedResponse.json();
    assert.equal(emptied.purgedIds.length, 2);
    assert.equal(emptied.failed, 0);
    assert.equal(emptied.remaining, 0);
    assert.equal(fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM notes").get().count, 0);
  } finally {
    fixture.sqlite.close();
  }
});

async function apiRequest(env, path, method, body, headers = {}, query = "") {
  const isForm = body instanceof FormData;
  const request = new Request(`https://example.test/api/${path.join("/")}${query}`, {
    method,
    headers: {
      ...(body === undefined || isForm ? {} : { "Content-Type": "application/json" }),
      ...headers
    },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body)
  });
  return onRequest({ request, env, params: { path }, data: { viewerRole: "admin" } });
}

function createFixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE members (id TEXT PRIMARY KEY);
    CREATE TABLE managed_groups (id TEXT PRIMARY KEY);
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
    INSERT INTO members (id) VALUES ('member-1');
    INSERT INTO managed_groups (id) VALUES ('group-1');
  `);
  const r2 = new MockR2Bucket();
  return { sqlite, r2, env: { DB: d1Adapter(sqlite), PHOTOS: r2 } };
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

function auditCount(fixture, action, entityId = null) {
  return entityId === null
    ? fixture.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = ?"
    ).get(action).count
    : fixture.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = ? AND entity_id = ?"
    ).get(action, entityId).count;
}

function syncCount(fixture, noteId) {
  return fixture.sqlite.prepare(
    "SELECT COUNT(*) AS count FROM note_sync_changes WHERE note_id = ?"
  ).get(noteId).count;
}

class MockR2Bucket {
  constructor() {
    this.objects = new Map();
  }

  async put(key, value, options) {
    const bytes = new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, { bytes, options });
  }

  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
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
          return { results, meta: { changes: after - before } };
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
