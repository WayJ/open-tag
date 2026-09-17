// Agent Memory Sync Task 4: daemon-side debounced managed-memory uplink on turn end.
// Mirrors the mock runtime/conn style of test/agentManagerScope.unit.test.ts; the uploaded
// `files` come from REAL whitelist reads of a tmp stateDir (MEMORY.md / notes/x.md preset).
// Run: npx tsx --test test/agentMemory.unit.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentManager, type AgentConfig, type AgentScope } from "../src/daemon/agentManager.js";
import { ResourceBudget } from "../src/daemon/resourceBudget.js";
import type { Runtime, RuntimeCallbacks, RuntimeSession, StartOpts } from "../src/daemon/runtime.js";

const noPressureBudget = new ResourceBudget({ availableMemMB: () => 999999 });

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const baseConfig = (agentId: string, extra: Partial<AgentConfig> = {}): AgentConfig => ({
  agentId,
  name: "agent",
  displayName: "Agent",
  description: "test agent",
  runtime: "fake",
  model: "default",
  serverUrl: "http://localhost:7777",
  serverId: "server-1",
  agentToken: "test-token",
  ...extra,
});

const scopeOf = (id: string): AgentScope => ({ type: "channel", id, sessionId: null });

interface FakeSession extends RuntimeSession { delivered: string[]; }

function fakeRuntime() {
  const spawns: StartOpts[] = [];
  const sessions: FakeSession[] = [];
  const callbacks: RuntimeCallbacks[] = [];
  const runtime: Runtime = {
    name: "fake",
    start(opts: StartOpts, cb: RuntimeCallbacks) {
      spawns.push(opts);
      callbacks.push(cb);
      cb.onInitialTurnAdmission();
      cb.onActivity("online"); // completes the initial turn → schedules the first memory upload
      const session: FakeSession = {
        delivered: [],
        deliver: async (text) => { session.delivered.push(text); },
        stop: () => { cb.onExit(0); },
      };
      sessions.push(session);
      return session;
    },
  };
  return { runtime, spawns, sessions, callbacks };
}

/** Preset the agent workspace's whitelist memory files BEFORE start (so startNow's seed is skipped
 *  and the upload reads exactly these bytes back). Returns the preset MEMORY.md content. */
function seedWorkspace(root: string, agentId: string): string {
  const stateDir = path.join(root, agentId);
  mkdirSync(path.join(stateDir, "notes"), { recursive: true });
  const memory = "# Memory\n\nremembered fact\n";
  writeFileSync(path.join(stateDir, "MEMORY.md"), memory);
  writeFileSync(path.join(stateDir, "notes", "x.md"), "note content\n");
  return memory;
}

function newManager(
  root: string,
  runtime: Runtime,
  sent?: (msg: unknown) => void,
  extra: { memoryUploadDebounceMs?: number; machineId?: string } = {},
): AgentManager {
  return new AgentManager(sent ?? (() => {}), {
    dataDir: root,
    binDir: root,
    deliverDebounceMs: 0,
    budget: noPressureBudget,
    runtimeResolver: () => runtime,
    ...(extra.memoryUploadDebounceMs !== undefined ? { memoryUploadDebounceMs: extra.memoryUploadDebounceMs } : {}),
    ...(extra.machineId !== undefined ? { machineId: extra.machineId } : {}),
  });
}

test("a finished turn uploads one agent:memory with the real whitelist files after the debounce window", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-memory-upload-"));
  const { runtime, callbacks } = fakeRuntime();
  const sent: any[] = [];
  const mgr = newManager(root, runtime, (m) => sent.push(m), { memoryUploadDebounceMs: 30 });
  try {
    const agentId = "agent-mem-upload";
    const preset = seedWorkspace(root, agentId);
    await mgr.start(agentId, baseConfig(agentId));
    await wait(80); // initial turn-end upload window elapses
    sent.length = 0;

    // The agent writes new memory, then the turn ends (completeTurn) → debounce → upload.
    writeFileSync(path.join(root, agentId, "MEMORY.md"), "# Memory\n\nupdated fact\n");
    await mgr.deliver(agentId, "Alice", "general", false, { targetName: "#general", msgShort: "hi", turnId: "turn-1" });
    callbacks[0]!.onActivity("online"); // settle the turn
    await wait(80);

    const ups = sent.filter((m) => m.type === "agent:memory");
    assert.equal(ups.length, 1, "exactly one agent:memory per debounce window");
    assert.equal(ups[0]!.agentId, agentId);
    assert.equal(ups[0]!.files["MEMORY.md"], "# Memory\n\nupdated fact\n", "MEMORY.md is read at fire time, not schedule time");
    assert.equal(ups[0]!.files["notes/x.md"], "note content\n", "notes/*.md is enumerated and read");
    assert.equal(preset, "# Memory\n\nremembered fact\n");
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second turn end with unchanged memory sends nothing (in-memory digest cache hit)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-memory-dedup-"));
  const { runtime, callbacks } = fakeRuntime();
  const sent: any[] = [];
  const mgr = newManager(root, runtime, (m) => sent.push(m), { memoryUploadDebounceMs: 30 });
  try {
    const agentId = "agent-mem-dedup";
    seedWorkspace(root, agentId);
    await mgr.start(agentId, baseConfig(agentId));
    await wait(80); // upload #1 (initial turn end) primes the digest cache
    sent.length = 0;

    await mgr.deliver(agentId, "Alice", "general", false, { targetName: "#general", msgShort: "hi", turnId: "turn-2" });
    callbacks[0]!.onActivity("online");
    await wait(80);

    assert.equal(sent.filter((m) => m.type === "agent:memory").length, 0, "unchanged content must not re-upload");
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("two scopes of one agent finishing turns merge into a single upload (debounce keyed by agentId)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-memory-scope-merge-"));
  const { runtime } = fakeRuntime();
  const sent: any[] = [];
  const mgr = newManager(root, runtime, (m) => sent.push(m), { memoryUploadDebounceMs: 300 });
  try {
    const agentId = "agent-mem-merge";
    seedWorkspace(root, agentId);
    await mgr.start(agentId, baseConfig(agentId, { scope: scopeOf("ch-a") }));
    await mgr.start(agentId, baseConfig(agentId, { scope: scopeOf("ch-b") }));
    await wait(600); // both scopes' initial turn ends land inside one debounce window
    const ups = sent.filter((m) => m.type === "agent:memory");
    assert.equal(ups.length, 1, "one agent, one debounce window, one upload");
    assert.equal(ups[0]!.agentId, agentId);
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the agent:memory uplink carries the injected machineId", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-memory-machine-"));
  const { runtime, callbacks } = fakeRuntime();
  const sent: any[] = [];
  const mgr = newManager(root, runtime, (m) => sent.push(m), { memoryUploadDebounceMs: 30, machineId: "mid-test-123" });
  try {
    const agentId = "agent-mem-machine";
    seedWorkspace(root, agentId);
    await mgr.start(agentId, baseConfig(agentId));
    await wait(80);
    assert.equal(sent.filter((m) => m.type === "agent:memory")[0]!.machineId, "mid-test-123");
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("reset(clearMemory) cancels the pending upload; the next turn end uploads the real post-reset whitelist", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-memory-reset-"));
  const { runtime, callbacks } = fakeRuntime();
  const sent: any[] = [];
  const mgr = newManager(root, runtime, (m) => sent.push(m), { memoryUploadDebounceMs: 100 });
  try {
    const agentId = "agent-mem-reset";
    seedWorkspace(root, agentId);
    await mgr.start(agentId, baseConfig(agentId));
    await wait(200); // upload #1 primes the cache with the pre-reset content
    sent.length = 0;

    // Schedule a pending upload, then reset before the window fires.
    await mgr.deliver(agentId, "Alice", "general", false, { targetName: "#general", msgShort: "hi", turnId: "turn-r" });
    callbacks[0]!.onActivity("online");
    await mgr.reset(agentId, false, true);
    await wait(200);
    assert.equal(sent.filter((m) => m.type === "agent:memory").length, 0, "reset must cancel the pending debounce timer");

    // Restart on the same workspace (MEMORY.md is now the reset stub) → next turn end uploads the
    // actual whitelist content: the stub replaces the server's pre-reset snapshot (never {}).
    await mgr.start(agentId, baseConfig(agentId));
    await wait(200);
    const ups = sent.filter((m) => m.type === "agent:memory");
    assert.equal(ups.length, 1, "exactly one post-reset upload");
    assert.equal(ups[0]!.files["MEMORY.md"], "# Memory\n\n(reset)\n", "the reset stub is what is on disk and what gets uploaded");
    assert.equal(ups[0]!.files["notes/x.md"], "note content\n", "clearMemory only resets MEMORY.md — the rest of the whitelist uploads as-is");
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});
