// Unit regression for online outdated daemon update guidance.
// Run: npx tsx --test --test-force-exit test/machineUpdateGuide.unit.test.ts
//
// The browser cannot update or kill a user's local daemon process. It also cannot recover a
// machine key after the one-time connect/reconnect modal closes because the server stores only
// the hash/prefix. The UI helper must therefore classify only online stale machines as needing
// update guidance, and the generated command set (npx fallback or server-bundle platform
// commands) must keep the key position as a visible placeholder, never an invented key.
import test from "node:test";
import assert from "node:assert/strict";
import { daemonUpdateCommands, isDaemonUpdateAvailable } from "../web/src/machineUi.ts";

test("online machine on an older daemon version needs update guidance", () => {
  assert.equal(isDaemonUpdateAvailable({ status: "online", daemonVersion: "0.5.0" }, "0.6.0"), true);
});

test("update guidance is not shown for offline, current, newer, unknown, or no-latest states", () => {
  assert.equal(isDaemonUpdateAvailable({ status: "offline", daemonVersion: "0.5.0" }, "0.6.0"), false);
  assert.equal(isDaemonUpdateAvailable({ status: "online", daemonVersion: "0.6.0" }, "0.6.0"), false);
  assert.equal(isDaemonUpdateAvailable({ status: "online", daemonVersion: "0.7.0" }, "0.6.0"), false);
  assert.equal(isDaemonUpdateAvailable({ status: "online", daemonVersion: "" }, "0.6.0"), false);
  assert.equal(isDaemonUpdateAvailable({ status: "online", daemonVersion: "dev" }, "0.6.0"), false);
  assert.equal(isDaemonUpdateAvailable({ status: "online", daemonVersion: "0.5.0" }, ""), false);
});

test("bundle available → platform two-file download commands with the key placeholder, not a real key", () => {
  const set = daemonUpdateCommands("https://tag.example.com", { bundleAvailable: true });
  assert.deepEqual(set, {
    kind: "platform",
    bash: "mkdir -p /tmp/open-tag && curl -fsSL https://tag.example.com/daemon/cli.mjs -o /tmp/open-tag/cli.mjs && curl -fsSL https://tag.example.com/daemon/agent-cli.mjs -o /tmp/open-tag/agent-cli.mjs && node /tmp/open-tag/cli.mjs --server-url https://tag.example.com --api-key <your sk_machine_... key>",
    powershell: 'New-Item -Force -ItemType Directory $env:TEMP\\open-tag | Out-Null; Invoke-WebRequest -Uri https://tag.example.com/daemon/cli.mjs -OutFile $env:TEMP\\open-tag\\cli.mjs; Invoke-WebRequest -Uri https://tag.example.com/daemon/agent-cli.mjs -OutFile $env:TEMP\\open-tag\\agent-cli.mjs; node "$env:TEMP\\open-tag\\cli.mjs" --server-url https://tag.example.com --api-key <your sk_machine_... key>',
  });
  assert.doesNotMatch(set.bash + set.powershell, /sk_machine_[A-Za-z0-9]{8,}/, "update flow must not pretend to know the stored machine key");
});

test("bundle unavailable or blank template → npx @latest fallback with the key placeholder", () => {
  const expected = {
    kind: "custom",
    command: "npx @fancyboi999/open-tag-daemon@latest --server-url https://tag.example.com --api-key <your sk_machine_... key>",
  };
  assert.deepEqual(daemonUpdateCommands("https://tag.example.com", { bundleAvailable: false }), expected);
  assert.deepEqual(daemonUpdateCommands("https://tag.example.com", { template: "   " }), expected);
  assert.deepEqual(daemonUpdateCommands("https://tag.example.com", {}), expected);
});

test("custom update template wins over the bundle flag and keeps the key placeholder", () => {
  const tpl = "npx tsx D:/src/daemon/index.ts --server-url {origin} --api-key {key}";
  assert.deepEqual(daemonUpdateCommands("https://tag.example.com", { template: tpl, bundleAvailable: true }), {
    kind: "custom",
    command: "npx tsx D:/src/daemon/index.ts --server-url https://tag.example.com --api-key <your sk_machine_... key>",
  });
});
