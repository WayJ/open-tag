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
  assert.equal(maskEmail("a@b.co"), "a@b.co"); // too-short local/domain fall through unchanged
});
test("inviteStatus: not_found / expired / used / valid", () => {
  assert.equal(inviteStatus(null), "not_found");
  assert.equal(inviteStatus({ expiresAt: new Date(Date.now() - 1000), acceptedAt: null }), "expired");
  assert.equal(inviteStatus({ expiresAt: null, acceptedAt: new Date() }), "used");
  assert.equal(inviteStatus({ expiresAt: new Date(Date.now() + 60_000), acceptedAt: null }), "valid");
});
