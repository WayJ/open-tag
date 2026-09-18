// Agent Memory Sync Task 4 (daemon-side debounced managed-memory uplink on turn end) and
// Task 5 (three-state memory restore before seed). Mirrors the mock runtime/conn style of
// test/agentManagerScope.unit.test.ts; the uploaded/restored `files` come from REAL whitelist
// reads of a tmp stateDir (MEMORY.md / notes/x.md preset).
// Run: npx tsx --test test/agentMemory.unit.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentManager, type AgentConfig, type AgentScope } from "../src/daemon/agentManager.js";
import { ResourceBudget } from "../src/daemon/resourceBudget.js";
import { seedMemory } from "../src/daemon/memory.js";
import { EMPTY_MEMORY_DIGEST, memoryFilesDigest } from "../src/daemonProtocol.js";
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
  extra: {
    memoryUploadDebounceMs?: number;
    machineId?: string;
    fetchMemory?: (agentId: string) => Promise<Record<string, string> | undefined>;
  } = {},
): AgentManager {
  return new AgentManager(sent ?? (() => {}), {
    dataDir: root,
    binDir: root,
    deliverDebounceMs: 0,
    budget: noPressureBudget,
    runtimeResolver: () => runtime,
    ...(extra.memoryUploadDebounceMs !== undefined ? { memoryUploadDebounceMs: extra.memoryUploadDebounceMs } : {}),
    ...(extra.machineId !== undefined ? { machineId: extra.machineId } : {}),
    ...(extra.fetchMemory !== undefined ? { fetchMemory: extra.fetchMemory } : {}),
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

// ── Task 5: three-state memory restore before seed ───────────────────────────────────────────

const stateDirOf = (root: string, agentId: string) => path.join(root, agentId);
const readDisk = (root: string, agentId: string, rel: string) =>
  readFileSync(path.join(stateDirOf(root, agentId), rel), "utf8");

test("state 1: empty workspace + server digest → memory:get restores the whitelist files and the seed is skipped", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-memory-restore1-"));
  const { runtime } = fakeRuntime();
  const serverFiles = { "MEMORY.md": "# Memory\n\nserver fact\n", "notes/srv.md": "server note\n" };
  const fetches: string[] = [];
  const mgr = newManager(root, runtime, () => {}, {
    fetchMemory: async (agentId) => { fetches.push(agentId); return serverFiles; },
  });
  try {
    const agentId = "agent-mem-restore1";
    await mgr.start(agentId, baseConfig(agentId, { memoryDigest: memoryFilesDigest(serverFiles) }));

    assert.equal(fetches.length, 1, "exactly one memory:get for a pull decision");
    assert.equal(readDisk(root, agentId, "MEMORY.md"), serverFiles["MEMORY.md"], "server MEMORY.md restored in place");
    assert.equal(readDisk(root, agentId, "notes/srv.md"), serverFiles["notes/srv.md"], "server notes restored in place");
    assert.notEqual(
      readDisk(root, agentId, "MEMORY.md"),
      seedMemory("Agent", "test agent"),
      "restore precedes the seed: the ENOENT check now finds a file and never writes the template",
    );
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("state 2: local digest == config.memoryDigest → no memory:get, nothing written", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-memory-restore2-"));
  const { runtime } = fakeRuntime();
  const preset = seedWorkspace(root, "agent-mem-restore2");
  const localDigest = memoryFilesDigest({ "MEMORY.md": preset, "notes/x.md": "note content\n" });
  let fetches = 0;
  const mgr = newManager(root, runtime, () => {}, {
    fetchMemory: async () => { fetches += 1; return { "MEMORY.md": "overwritten!\n" }; },
  });
  try {
    const agentId = "agent-mem-restore2";
    await mgr.start(agentId, baseConfig(agentId, { memoryDigest: localDigest }));

    assert.equal(fetches, 0, "in-sync must not fetch");
    assert.equal(readDisk(root, agentId, "MEMORY.md"), preset, "zero writes: MEMORY.md untouched");
    assert.equal(readDisk(root, agentId, "notes/x.md"), "note content\n", "zero writes: notes untouched");
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("no-row sentinel: config without memoryDigest → no RPC, local files untouched", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-memory-restore3-"));
  const { runtime } = fakeRuntime();
  const preset = seedWorkspace(root, "agent-mem-restore3");
  let fetches = 0;
  const mgr = newManager(root, runtime, () => {}, {
    fetchMemory: async () => { fetches += 1; return {}; },
  });
  try {
    const agentId = "agent-mem-restore3";
    await mgr.start(agentId, baseConfig(agentId)); // no memoryDigest key

    assert.equal(fetches, 0, "no server row must not fetch");
    assert.equal(readDisk(root, agentId, "MEMORY.md"), preset, "local memory wins by default");
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("empty-map sentinel: config.memoryDigest == EMPTY_MEMORY_DIGEST → no RPC, local files untouched", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-memory-restore4-"));
  const { runtime } = fakeRuntime();
  const preset = seedWorkspace(root, "agent-mem-restore4");
  let fetches = 0;
  const mgr = newManager(root, runtime, () => {}, {
    fetchMemory: async () => { fetches += 1; return {}; },
  });
  try {
    const agentId = "agent-mem-restore4";
    await mgr.start(agentId, baseConfig(agentId, { memoryDigest: EMPTY_MEMORY_DIGEST }));

    assert.equal(fetches, 0, "an empty server row must not fetch (nor wipe the local memory)");
    assert.equal(readDisk(root, agentId, "MEMORY.md"), preset);
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("state 3: diverged local memory → server version imported under notes/imported/<stamp>.md (colon-free) + index line appended", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-memory-restore5-"));
  const { runtime } = fakeRuntime();
  const agentId = "agent-mem-restore5";
  const preset = seedWorkspace(root, agentId); // "# Memory\n\nremembered fact\n" + notes/x.md
  const serverFiles = { "MEMORY.md": "# Memory\n\nserver fact\n", "notes/srv.md": "server note\n" };
  const mgr = newManager(root, runtime, () => {}, {
    fetchMemory: async () => serverFiles,
  });
  try {
    await mgr.start(agentId, baseConfig(agentId, { memoryDigest: memoryFilesDigest(serverFiles) }));

    const importedDir = path.join(stateDirOf(root, agentId), "notes", "imported");
    const imported = readdirSync(importedDir);
    assert.equal(imported.length, 1, "one stamped import file");
    assert.doesNotMatch(imported[0]!, /:/, "import filename must be colon-free (NTFS-safe)");
    assert.match(imported[0]!, /^\d{8}T\d{6}Z\.md$/, "import filename is the yyyymmddTHHMMSSZ stamp");
    const importPath = `notes/imported/${imported[0]}`;
    const importedContent = readFileSync(path.join(importedDir, imported[0]!), "utf8");
    assert.ok(importedContent.includes(serverFiles["MEMORY.md"]!), "the server MEMORY.md content is preserved in the import");

    const memoryOnDisk = readDisk(root, agentId, "MEMORY.md");
    assert.ok(memoryOnDisk.startsWith(preset), "original MEMORY.md content preserved verbatim (append-only)");
    assert.ok(memoryOnDisk.includes(`- Imported server memory snapshot: ${importPath}`), "an index line pointing at the import is appended");
    assert.equal(readDisk(root, agentId, "notes/x.md"), "note content\n", "local notes are never overwritten");
    assert.throws(() => readDisk(root, agentId, "notes/srv.md"), "server notes are imported, not written over the local whitelist");
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("EPERM tolerance: sibling scopes of one agent concurrently importing the same snapshot both start", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-memory-restore6-"));
  const { runtime, sessions } = fakeRuntime();
  const agentId = "agent-mem-restore6";
  seedWorkspace(root, agentId);
  const serverFiles = { "MEMORY.md": "# Memory\n\nserver fact\n" };
  const mgr = newManager(root, runtime, () => {}, {
    fetchMemory: async () => serverFiles, // both scopes get the same answer → same-second import name
  });
  try {
    await Promise.all([
      mgr.start(agentId, baseConfig(agentId, { scope: scopeOf("ch-a"), memoryDigest: memoryFilesDigest(serverFiles) })),
      mgr.start(agentId, baseConfig(agentId, { scope: scopeOf("ch-b"), memoryDigest: memoryFilesDigest(serverFiles) })),
    ]);
    assert.equal(sessions.length, 2, "both sibling scopes started despite the concurrent import");
    assert.ok(readdirSync(path.join(stateDirOf(root, agentId), "notes", "imported")).length >= 1, "at least one import landed (a double import is accepted as harmless)");
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("memory:get abandoned (no answer) → restore gives up and the seed takes the original path", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-memory-restore7-"));
  const { runtime } = fakeRuntime();
  const serverDigest = "d".repeat(64);
  const mgr = newManager(root, runtime, () => {}, {
    fetchMemory: async () => undefined, // what the index.ts waiter resolves after its timeout
  });
  try {
    const agentId = "agent-mem-restore7";
    await mgr.start(agentId, baseConfig(agentId, { memoryDigest: serverDigest }));

    assert.equal(
      readDisk(root, agentId, "MEMORY.md"),
      seedMemory("Agent", "test agent"),
      "an abandoned restore is treated as no-row: the seed template is written as usual",
    );
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});
