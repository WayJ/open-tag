// Unit test (CI layer, no infra) for the SPA shell allowlist: every client-routed entry point the
// web app defines (main.tsx Routes) must be served index.html on direct hit / refresh, or a hard
// reload of that URL 404s in production. New top-level client routes MUST be added here and to
// staticRoutes.ts in the same change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldServeAppShell } from "../src/server/staticRoutes.js";

test("app shell is served for every top-level client route (direct hit / refresh)", () => {
  for (const p of ["/", "/features", "/login", "/register", "/admin"]) {
    assert.ok(shouldServeAppShell(p), `expected app shell for ${p}`);
  }
});

test("app shell is served for prefixed client routes and trailing-slash variants", () => {
  for (const p of ["/s/open-tag/channel", "/join/inv_token", "/invite/inv_token", "/admin/users", "/login/"]) {
    assert.ok(shouldServeAppShell(p), `expected app shell for ${p}`);
  }
});

test("app shell is NOT served for unknown paths or asset-like paths", () => {
  for (const p of ["/api/health", "/administer", "/invite", "/whatever", "/assets/index.js"]) {
    assert.ok(!shouldServeAppShell(p), `expected no app shell for ${p}`);
  }
});
