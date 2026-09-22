// test/systemAdminPolicy.unit.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { inviteStatus, maskEmail, registrationDecision } from "../src/server/systemAdminPolicy.js";

test("registrationDecision: empty users table bootstraps the first sysadmin", () => {
  assert.equal(registrationDecision(0, true), "bootstrap");
  assert.equal(registrationDecision(0, false), "bootstrap"); // bootstrap wins even if the setting says closed
});
test("registrationDecision: existing users obey the toggle", () => {
  assert.equal(registrationDecision(3, true), "allow");
  assert.equal(registrationDecision(3, false), "reject");
});
test("maskEmail hides the local part and domain middle", () => {
  assert.equal(maskEmail("alice@example.com"), "a***e@e***.com");
  assert.equal(maskEmail("abc@ab.com"), "a***c@a***.com"); // 3-char local / 2-char domain-head boundary: full form
});
test("maskEmail never returns plaintext for short local/domain parts", () => {
  assert.equal(maskEmail("abc@a.io"), "a***@a***.io"); // short domain-head → minimal first-char-only mask
  assert.equal(maskEmail("a@b.co"), "a***@b***.co");    // short local + short domain-head → minimal mask
});
test("inviteStatus: not_found / expired / used / valid", () => {
  assert.equal(inviteStatus(null), "not_found");
  assert.equal(inviteStatus({ expiresAt: new Date(Date.now() - 1000), acceptedAt: null }), "expired");
  assert.equal(inviteStatus({ expiresAt: null, acceptedAt: new Date() }), "used");
  assert.equal(inviteStatus({ expiresAt: new Date(Date.now() + 60_000), acceptedAt: null }), "valid");
});
test("inviteStatus: accepts ISO string dates (drizzle jsonb / API payloads)", () => {
  assert.equal(inviteStatus({ expiresAt: new Date(Date.now() - 1000).toISOString(), acceptedAt: null }), "expired");
  assert.equal(inviteStatus({ expiresAt: new Date(Date.now() + 60_000).toISOString(), acceptedAt: null }), "valid");
  assert.equal(inviteStatus({ expiresAt: null, acceptedAt: new Date().toISOString() }), "used");
});
