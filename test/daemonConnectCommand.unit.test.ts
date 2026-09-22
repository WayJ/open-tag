// Run: npx tsx --test --test-force-exit test/daemonConnectCommand.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { daemonConnectCommands } from "../web/src/machineUi.ts";

// bundleAvailable mirrors the server's daemonBundleAvailable flag (GET /daemon/cli.mjs + /daemon/agent-cli.mjs
// serve the two-bundle set the install scripts download). When true the connect wizard shows per-platform
// one-pipe install commands — the server generates the script (GET /daemon/install.sh|install.ps1) with
// origin+key baked in — instead of the npx fallback.

test("bundle available and no template → per-platform one-pipe install commands with the real machine key", () => {
  const set = daemonConnectCommands("https://x.test", "sk_machine_abc", { bundleAvailable: true });
  assert.deepEqual(set, {
    kind: "platform",
    bash: 'curl -fsSL "https://x.test/daemon/install.sh?server=https://x.test&key=sk_machine_abc" | bash',
    powershell: 'iwr -useb "https://x.test/daemon/install.ps1?server=https://x.test&key=sk_machine_abc" | iex',
  });
});

test("bundle unavailable (flag false or omitted) and no template → npx @latest fallback with origin and key embedded", () => {
  assert.deepEqual(daemonConnectCommands("https://x.test", "k", { bundleAvailable: false }), {
    kind: "custom",
    command: "npx @fancyboi999/open-tag-daemon@latest --server-url https://x.test --api-key k",
  });
  assert.deepEqual(daemonConnectCommands("https://x.test", "k", {}), {
    kind: "custom",
    command: "npx @fancyboi999/open-tag-daemon@latest --server-url https://x.test --api-key k",
  });
});

test("custom template wins over the bundle flag (local checkout ahead of the npm package)", () => {
  const tpl = "npx tsx D:/OpenSource/open-tag/src/daemon/index.ts --server-url {origin} --api-key {key}";
  const set = daemonConnectCommands("https://x.test", "sk_machine_abc", { template: tpl, bundleAvailable: true });
  assert.deepEqual(set, {
    kind: "custom",
    command: "npx tsx D:/OpenSource/open-tag/src/daemon/index.ts --server-url https://x.test --api-key sk_machine_abc",
  });
});

test("null/blank template behaves as no template (platform when bundle available, npx fallback otherwise)", () => {
  assert.equal(daemonConnectCommands("https://x.test", "sk_machine_abc", { template: null, bundleAvailable: true }).kind, "platform");
  assert.deepEqual(daemonConnectCommands("https://x.test", "k", { template: "   ", bundleAvailable: false }), {
    kind: "custom",
    command: "npx @fancyboi999/open-tag-daemon@latest --server-url https://x.test --api-key k",
  });
});
