import { test } from "node:test";
import assert from "node:assert/strict";
import { adminRouteDecision } from "./adminGuard.ts";

test("admin route gate: skeleton while bootstrapping, deny non-admin, allow sysadmin", () => {
  assert.equal(adminRouteDecision({ ready: false, authState: "loading", systemRole: null }), "skeleton");
  assert.equal(adminRouteDecision({ ready: true, authState: "anon", systemRole: null }), "login");
  assert.equal(adminRouteDecision({ ready: true, authState: "authed", systemRole: null }), "workspace");
  assert.equal(adminRouteDecision({ ready: true, authState: "authed", systemRole: "system_admin" }), "admin");
});
