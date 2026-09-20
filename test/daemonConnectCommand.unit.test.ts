// Run: npx tsx --test --test-force-exit test/daemonConnectCommand.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { daemonConnectCommand } from "../web/src/machineUi.ts";

test("daemonConnectCommand embeds origin and key", () => {
  const cmd = daemonConnectCommand("https://x.test", "sk_machine_abc");
  assert.equal(cmd, "npx @fancyboi999/open-tag-daemon@latest --server-url https://x.test --api-key sk_machine_abc");
});

test("daemonConnectCommand renders a custom template when provided", () => {
  const tpl = "npx tsx D:/OpenSource/open-tag/src/daemon/index.ts --server-url {origin} --api-key {key}";
  const cmd = daemonConnectCommand("https://x.test", "sk_machine_abc", tpl);
  assert.equal(cmd, "npx tsx D:/OpenSource/open-tag/src/daemon/index.ts --server-url https://x.test --api-key sk_machine_abc");
});

test("daemonConnectCommand falls back to @latest when template is null/blank", () => {
  assert.equal(daemonConnectCommand("https://x.test", "k", null),
    "npx @fancyboi999/open-tag-daemon@latest --server-url https://x.test --api-key k");
  assert.equal(daemonConnectCommand("https://x.test", "k", "   "),
    "npx @fancyboi999/open-tag-daemon@latest --server-url https://x.test --api-key k");
});
