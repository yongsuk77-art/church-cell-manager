import assert from "node:assert/strict";
import test from "node:test";
import { onRequest as middleware } from "../functions/_middleware.js";

const ID = "11111111-1111-4111-8111-111111111111";

test("only exact Relay enrollment callback POST paths bypass login and the Korea gate", async () => {
  for (const operation of ["inspect", "complete"]) {
    const result = await dispatch(`/api/integrations/call-note/relay-enrollments/${ID}/${operation}`, "POST");
    assert.equal(result.reachedNext, true, operation);
    assert.equal(result.response.status, 204);
  }

  for (const [path, method] of [
    [`/api/integrations/call-note/relay-enrollments/${ID}/inspect`, "GET"],
    [`/api/integrations/call-note/relay-enrollments/${ID}/complete/extra`, "POST"],
    ["/api/integrations/call-note/relay-enrollments/not-a-uuid/inspect", "POST"],
    [`/api/integrations/call-note/admin/relay-enrollments/${ID}/inspect`, "POST"]
  ]) {
    const result = await dispatch(path, method);
    assert.equal(result.reachedNext, false, `${method} ${path}`);
    assert.equal(result.response.status, 403, `${method} ${path}`);
  }
});

async function dispatch(path, method) {
  let reachedNext = false;
  const response = await middleware({
    request: new Request(`https://site.example${path}`, {
      method,
      headers: { "CF-IPCountry": "US", "Content-Type": "application/json" }
    }),
    env: {},
    data: {},
    next: async () => {
      reachedNext = true;
      return new Response(null, { status: 204 });
    }
  });
  return { reachedNext, response };
}
