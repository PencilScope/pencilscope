import assert from "node:assert/strict";
import {
  TURNSTILE_TEST_SITE_KEY,
  turnstileErrorMessage,
  turnstileSiteKey,
  verifyTurnstile
} from "../src/lib/turnstile.ts";

const production = { ENVIRONMENT: "production", TURNSTILE_SECRET_KEY: "secret" };
const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" }
});

assert.equal(turnstileSiteKey({ ENVIRONMENT: "development" }), TURNSTILE_TEST_SITE_KEY);
assert.equal(turnstileSiteKey({ ENVIRONMENT: "production" }), "");
assert.equal((await verifyTurnstile(production, {
  token: null, expectedAction: "register", expectedHostname: "pencilscope.com"
})).reason, "missing");
assert.equal((await verifyTurnstile({ ENVIRONMENT: "production" }, {
  token: "token", expectedAction: "register", expectedHostname: "pencilscope.com"
})).reason, "unavailable");

let submitted;
const passed = await verifyTurnstile(production, {
  token: "valid-token",
  remoteIp: "203.0.113.10",
  expectedAction: "register",
  expectedHostname: "pencilscope.com"
}, async (_url, init) => {
  submitted = JSON.parse(String(init?.body));
  return response({ success: true, action: "register", hostname: "pencilscope.com" });
});
assert.equal(passed.success, true);
assert.equal(submitted.response, "valid-token");
assert.equal(submitted.remoteip, "203.0.113.10");
assert.ok(submitted.idempotency_key);

for (const payload of [
  { success: false, "error-codes": ["invalid-input-response"] },
  { success: true, action: "login", hostname: "pencilscope.com" },
  { success: true, action: "register" },
  { success: true, action: "register", hostname: "unauthorized.example" }
]) {
  const result = await verifyTurnstile(production, {
    token: "invalid-token", expectedAction: "register", expectedHostname: "pencilscope.com"
  }, async () => response(payload));
  assert.equal(result.reason, "invalid");
}

const unavailable = await verifyTurnstile(production, {
  token: "token", expectedAction: "register", expectedHostname: "pencilscope.com"
}, async () => response({}, 503));
assert.equal(turnstileErrorMessage(unavailable), "Security verification is temporarily unavailable. Please try again later.");

process.stdout.write("Turnstile integration passed: configuration, token limits, Siteverify payload, action, hostname and fail-closed handling.\n");
