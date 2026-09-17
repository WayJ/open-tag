// Scoped sessions Task 4: daemon scopeKey routing — one runtime per (agent, scope); no scope → LEGACY.
// Mirrors the mock runtime/conn style of src/daemon/agentManager.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentManager, scopeKey, type AgentConfig, type AgentScope } from "../src/daemon/agentManager.js";
import { ResourceBudget } from "../src/daemon/resourceBudget.js";
import type { Runtime, RuntimeCallbacks, RuntimeSession, StartOpts } from "../src/daemon/runtime.js";

const noPressureBudget = new ResourceBudget({ availableMemMB: () => 999999 });

const baseConfig = (agentId: string): AgentConfig => ({
  agentId,
  name: "agent",
  displayName: "Agent",
  description: "test agent",
  runtime: "fake",
  model: "default",
  serverUrl: "http://localhost:7777",
  serverId: "server-1",
  agentToken: "test-token",
});

const scopeOf = (type: "channel" | "thread", id: string, sessionId: string | null = null): AgentScope => ({ type, id, sessionId });

const scopedConfig = (agentId: string, scope: AgentScope, extra: Partial<AgentConfig> = {}): AgentConfig => ({
  ...baseConfig(agentId),
  scope,
  ...extra,
});

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
      cb.onActivity("online");
      const session: FakeSession = {
        delivered: [],
        deliver: async (text) => { session.delivered.push(text); },
        stop: () => { cb.onExit(0); }, // real runtimes report exit on stop; awaited teardown needs it settled
      };
      sessions.push(session);
      return session;
    },
  };
  return { runtime, spawns, sessions, callbacks };
}

function newManager(
  root: string,
  runtime: Runtime,
  sent?: (msg: unknown) => void,
  extra: { budget?: ResourceBudget; idleMs?: number } = {},
): AgentManager {
  return new AgentManager(sent ?? (() => {}), {
    dataDir: root,
    binDir: root,
    deliverDebounceMs: 0,
    budget: extra.budget ?? noPressureBudget,
    runtimeResolver: () => runtime,
    ...(extra.idleMs !== undefined ? { idleMs: extra.idleMs } : {}),
  });
}

test("scopeKey maps channel/thread scopes and the LEGACY fallback", () => {
  assert.equal(scopeKey("aid", scopeOf("channel", "ch-1")), "aid:channel:ch-1");
  assert.equal(scopeKey("aid", scopeOf("thread", "th-1")), "aid:thread:th-1");
  assert.equal(scopeKey("aid"), "aid:legacy");
  assert.equal(scopeKey("aid", undefined), "aid:legacy");
});

test("two different scopes spawn two runtimes and each deliver reaches its own session", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-scope-two-"));
  const { runtime, spawns, sessions } = fakeRuntime();
  const mgr = newManager(root, runtime);
  try {
    const agentId = "agent-scope-two";
    const scopeA = scopeOf("channel", "ch-a");
    const scopeB = scopeOf("channel", "ch-b");
    await mgr.start(agentId, scopedConfig(agentId, scopeA));
    assert.equal(spawns.length, 1);
    const deliverA = mgr.deliver(agentId, "Alice", "ch-a", false, { scope: scopeA, targetName: "#a", msgShort: "a1", turnId: "turn-a" });
    await mgr.start(agentId, scopedConfig(agentId, scopeB));
    assert.equal(spawns.length, 2, "a second scope must spawn its own runtime");
    await deliverA;
    await mgr.deliver(agentId, "Bob", "ch-b", false, { scope: scopeB, targetName: "#b", msgShort: "b1", turnId: "turn-b" });

    assert.equal(sessions[0]!.delivered.length, 1, "the scope A deliver must reach the scope A runtime");
    assert.equal(sessions[1]!.delivered.length, 1, "the scope B deliver must reach the scope B runtime");
    assert.deepEqual(mgr.running(), [agentId], "running() reports agents, not scope keys");
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second start and deliver for the same scope reuse the running runtime", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-scope-reuse-"));
  const { runtime, spawns, sessions, callbacks } = fakeRuntime();
  const mgr = newManager(root, runtime);
  try {
    const agentId = "agent-scope-reuse";
    const scopeA = scopeOf("channel", "ch-a");
    await mgr.start(agentId, scopedConfig(agentId, scopeA));
    await mgr.deliver(agentId, "Alice", "ch-a", false, { scope: scopeA, targetName: "#a", msgShort: "a1", turnId: "turn-1" });
    callbacks[0]!.onActivity("online"); // settle the first runtime turn so the next deliver is admitted
    await mgr.start(agentId, scopedConfig(agentId, scopeA));
    await mgr.deliver(agentId, "Bob", "ch-a", false, { scope: scopeA, targetName: "#a", msgShort: "b1", turnId: "turn-2" });

    assert.equal(spawns.length, 1, "a same-scope start must reuse the running runtime");
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.delivered.length, 2, "same-scope delivers must reach the same runtime session");
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("running() deduplicates agents running in multiple scopes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-scope-running-"));
  const { runtime } = fakeRuntime();
  const mgr = newManager(root, runtime);
  try {
    const agentId = "agent-scope-running";
    await mgr.start(agentId, scopedConfig(agentId, scopeOf("channel", "ch-a")));
    await mgr.start(agentId, scopedConfig(agentId, scopeOf("thread", "th-b")));
    assert.equal(mgr.running().length, 1, "two scopes of one agent must report once");
    assert.equal(mgr.running()[0], agentId);
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("scoped config resumes the scope session; LEGACY config resumes the agent-wide session", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-scope-session-"));
  const { runtime, spawns } = fakeRuntime();
  const mgr = newManager(root, runtime);
  try {
    const agentId = "agent-scope-session";

    await mgr.start(agentId, scopedConfig(agentId, scopeOf("channel", "ch-s", "sess-scope"), { sessionId: "sess-legacy" }));
    assert.equal(spawns[0]!.sessionId, "sess-scope", "scope.sessionId wins over the legacy top-level sessionId");

    await mgr.start(agentId, scopedConfig(agentId, scopeOf("thread", "th-s", null), { sessionId: "sess-legacy" }));
    assert.equal(spawns[1]!.sessionId, null, "a fresh scope session must not fall back to the legacy sessionId");

    await mgr.start(agentId, { ...baseConfig(agentId), sessionId: "sess-legacy" });
    assert.equal(spawns[2]!.sessionId, "sess-legacy", "LEGACY (no scope) keeps using the top-level sessionId");
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent:session uplink carries the running scope and omits it for LEGACY", async () => {
  const scopedRoot = mkdtempSync(path.join(tmpdir(), "open-tag-agent-scope-uplink-"));
  const scoped = fakeRuntime();
  const sentScoped: any[] = [];
  const mgr = newManager(scopedRoot, scoped.runtime, (m) => sentScoped.push(m));
  try {
    const agentId = "agent-scope-uplink";
    const scopeA = scopeOf("channel", "ch-up", "sess-up");
    await mgr.start(agentId, scopedConfig(agentId, scopeA));
    scoped.callbacks[0]!.onSession("sess-up-new");
    const up = sentScoped.find((m) => m.type === "agent:session");
    assert.ok(up, "expected an agent:session uplink");
    assert.equal(up.sessionId, "sess-up-new");
    assert.deepEqual(up.scope, scopeA, "the uplink must carry the running config's scope");
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(scopedRoot, { recursive: true, force: true });
  }

  const legacyRoot = mkdtempSync(path.join(tmpdir(), "open-tag-agent-scope-uplink-legacy-"));
  const legacy = fakeRuntime();
  const sentLegacy: any[] = [];
  const mgrLegacy = newManager(legacyRoot, legacy.runtime, (m) => sentLegacy.push(m));
  try {
    await mgrLegacy.start("agent-legacy-uplink", baseConfig("agent-legacy-uplink"));
    legacy.callbacks[0]!.onSession("sess-legacy-new");
    const up = sentLegacy.find((m) => m.type === "agent:session");
    assert.ok(up, "expected an agent:session uplink");
    assert.equal(up.sessionId, "sess-legacy-new");
    assert.equal("scope" in up, false, "LEGACY uplinks must not carry a scope field");
    mgrLegacy.stopAll();
  } finally {
    mgrLegacy.stopAll();
    rmSync(legacyRoot, { recursive: true, force: true });
  }
});

// ── Task 5: per-scope keyed state migration (startQueue / starting / pendingDelivers / five Maps / previews / dequeue) ──

test("queue/dequeue of one scope stays silent on agent-level status while a sibling scope runs", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-scope-quiet-queue-"));
  let availableMemMB = 999999;
  const budget = new ResourceBudget({ availableMemMB: () => availableMemMB });
  const sent: any[] = [];
  const { runtime } = fakeRuntime();
  const mgr = newManager(root, runtime, (m) => sent.push(m), { budget });
  try {
    const agentId = "agent-quiet-queue";
    await mgr.start(agentId, scopedConfig(agentId, scopeOf("channel", "ch-a"))); // scope A runs
    sent.length = 0;

    // (a) memory-pressure queue of scope B: no agent-level queued/offline flip
    availableMemMB = 0;
    await mgr.start(agentId, scopedConfig(agentId, scopeOf("channel", "ch-b", "sess-b")));
    assert.equal(mgr.queuedAgents().length, 1, "scope B is queued");
    assert.equal(sent.filter((m) => m.type === "agent:status" || m.type === "agent:activity").length, 0, "queueing must not flip the agent-level status while scope A runs");

    // (b) dequeue→start of the queued scope: no agent-level inactive flip
    availableMemMB = 999999;
    await mgr.start("agent-quiet-trigger", baseConfig("agent-quiet-trigger")); // its start drains the queue
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(mgr.queuedAgents(), [], "queue drained");
    const statuses = sent.filter((m) => m.type === "agent:status");
    assert.ok(!statuses.some((m) => m.agentId === agentId && (m.status === "inactive" || m.status === "queued")), "dequeue must not flip the agent to inactive while scope A runs");
    assert.ok(statuses.some((m) => m.agentId === "agent-quiet-trigger"), "the trigger agent's own status still flows");

    // (c) dequeue of a queued scope: no agent-level inactive/offline flip
    availableMemMB = 0;
    await mgr.start(agentId, scopedConfig(agentId, scopeOf("thread", "th-c", "sess-c")));
    assert.equal(mgr.queuedAgents().length, 1, "scope C is queued");
    sent.length = 0; // drop step (b)'s legit "active" frames for agentId
    mgr.dequeue(agentId);
    assert.deepEqual(mgr.queuedAgents(), [], "scope C dropped");
    assert.equal(sent.filter((m) => m.agentId === agentId && (m.type === "agent:status" || m.type === "agent:activity")).length, 0, "dequeue must not flip the agent-level status while scope A runs");
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("pressure-queued scoped starts keep their own configs (startQueue deduped by scopeKey)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-scope-queue-"));
  let availableMemMB = 0;
  const budget = new ResourceBudget({ availableMemMB: () => availableMemMB });
  const { runtime, spawns } = fakeRuntime();
  const mgr = newManager(root, runtime, undefined, { budget });
  try {
    const agentId = "agent-queue-scope";
    await mgr.start(agentId, scopedConfig(agentId, scopeOf("channel", "ch-a", "sess-a")));
    await mgr.start(agentId, scopedConfig(agentId, scopeOf("channel", "ch-b", "sess-b")));
    assert.equal(mgr.queuedAgents().length, 2, "each scope must keep its own queued start (no config overwrite)");

    availableMemMB = 999999;
    await mgr.start("agent-queue-trigger", baseConfig("agent-queue-trigger")); // its start completion drains the queue
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(mgr.queuedAgents(), [], "queue must drain once memory recovers");
    const sessionIds = spawns.map((s) => s.sessionId);
    assert.ok(sessionIds.includes("sess-a"), "scope A must spawn with its own queued config");
    assert.ok(sessionIds.includes("sess-b"), "scope B must spawn with its own queued config");
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a concurrent different-scope start gets its own promise and spawns its own runtime", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-scope-concurrent-"));
  const { runtime, spawns } = fakeRuntime();
  const mgr = newManager(root, runtime);
  try {
    const agentId = "agent-concurrent-scope";
    const startA = mgr.start(agentId, scopedConfig(agentId, scopeOf("channel", "ch-a")));
    const startB = mgr.start(agentId, scopedConfig(agentId, scopeOf("channel", "ch-b")));
    assert.notEqual(startA, startB, "scope B must not join scope A's in-flight attempt");
    await Promise.all([startA, startB]);
    assert.equal(spawns.length, 2, "both scopes must actually spawn");
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("pending delivers are consumed per scope — one startup must not swallow a sibling scope's queue", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-scope-pending-"));
  const { runtime, sessions } = fakeRuntime();
  const mgr = newManager(root, runtime);
  try {
    const agentId = "agent-pending-scope";
    const scopeA = scopeOf("channel", "ch-a");
    const scopeB = scopeOf("channel", "ch-b");
    const startA = mgr.start(agentId, scopedConfig(agentId, scopeA));
    const dA = mgr.deliver(agentId, "Alice", "ch-a", false, { scope: scopeA, targetName: "#a", msgShort: "hello-a", turnId: "turn-a" });
    const startB = mgr.start(agentId, scopedConfig(agentId, scopeB));
    const dB = mgr.deliver(agentId, "Bob", "ch-b", false, { scope: scopeB, targetName: "#b", msgShort: "hello-b", turnId: "turn-b" });
    await Promise.all([startA, startB, dA, dB]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const aTexts = sessions[0]!.delivered.join("|");
    const bTexts = sessions[1]!.delivered.join("|");
    assert.ok(!aTexts.includes("#b"), "scope A's session must not receive scope B's message");
    assert.ok(!bTexts.includes("#a"), "scope B's session must not receive scope A's message");
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("stop(agentId) clears every running scope and cancels in-flight scoped starts", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-scope-stopall-"));
  const { runtime, spawns } = fakeRuntime();
  const mgr = newManager(root, runtime);
  try {
    const agentId = "agent-stop-all-scopes";
    await mgr.start(agentId, scopedConfig(agentId, scopeOf("channel", "ch-a")));
    await mgr.start(agentId, scopedConfig(agentId, scopeOf("channel", "ch-b")));
    assert.equal(spawns.length, 2);
    const startC = mgr.start(agentId, scopedConfig(agentId, scopeOf("thread", "th-c")));
    const startCCancelled = assert.rejects(startC, /start cancelled/, "the in-flight scoped start must be cancelled"); // attach before stop: the cancellation lands mid-teardown
    await mgr.stop(agentId);
    await startCCancelled;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(mgr.running(), [], "no scope may survive a whole-agent stop");
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("reset uplinks one null agent:session per known scope plus the legacy null", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-scope-reset-"));
  const sent: any[] = [];
  const { runtime } = fakeRuntime();
  const mgr = newManager(root, runtime, (m) => sent.push(m));
  try {
    const agentId = "agent-reset-scopes";
    await mgr.start(agentId, scopedConfig(agentId, scopeOf("channel", "ch-r1")));
    await mgr.start(agentId, scopedConfig(agentId, scopeOf("thread", "th-r2")));
    sent.length = 0;
    await mgr.reset(agentId);
    const ups = sent.filter((m) => m.type === "agent:session");
    assert.equal(ups.length, 3, "one null uplink per scope + the legacy null");
    const scoped = ups.filter((m) => "scope" in m);
    assert.equal(scoped.length, 2);
    assert.ok(scoped.some((m) => JSON.stringify(m.scope) === JSON.stringify({ type: "channel", id: "ch-r1" }) && m.sessionId === null));
    assert.ok(scoped.some((m) => JSON.stringify(m.scope) === JSON.stringify({ type: "thread", id: "th-r2" }) && m.sessionId === null));
    const legacy = ups.filter((m) => !("scope" in m));
    assert.equal(legacy.length, 1, "the scope-less legacy null (agents.session_id clear) must still be sent");
    assert.equal(legacy[0]!.sessionId, null);
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("reset for a LEGACY agent keeps the single scope-less null uplink", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-scope-reset-legacy-"));
  const sent: any[] = [];
  const { runtime } = fakeRuntime();
  const mgr = newManager(root, runtime, (m) => sent.push(m));
  try {
    const agentId = "agent-reset-legacy";
    await mgr.start(agentId, baseConfig(agentId));
    sent.length = 0;
    await mgr.reset(agentId);
    const ups = sent.filter((m) => m.type === "agent:session");
    assert.equal(ups.length, 1, "a LEGACY agent resets with exactly one scope-less null uplink");
    assert.equal(ups[0]!.sessionId, null);
    assert.equal("scope" in ups[0]!, false);
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an idle scope sleeps silently while a sibling scope is alive; only the last scope reports sleeping", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-scope-idle-"));
  const sent: any[] = [];
  const { runtime } = fakeRuntime();
  const mgr = newManager(root, runtime, (m) => sent.push(m), { idleMs: 15 });
  try {
    const agentId = "agent-idle-scopes";
    await mgr.start(agentId, scopedConfig(agentId, scopeOf("channel", "ch-a")));
    await mgr.start(agentId, scopedConfig(agentId, scopeOf("channel", "ch-b")));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const sleeping = sent.filter((m) => m.type === "agent:status" && m.status === "sleeping");
    assert.equal(sleeping.length, 1, "only the last surviving scope's idle sleep may report agent-level sleeping");
    assert.deepEqual(mgr.running(), [], "both idle scopes must be stopped");
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a crashed scope reports error/offline only when it is the last surviving scope", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-scope-crash-"));
  const sent: any[] = [];
  const { runtime, callbacks } = fakeRuntime();
  const mgr = newManager(root, runtime, (m) => sent.push(m));
  try {
    const agentId = "agent-crash-scopes";
    await mgr.start(agentId, scopedConfig(agentId, scopeOf("channel", "ch-a")));
    await mgr.start(agentId, scopedConfig(agentId, scopeOf("channel", "ch-b")));
    sent.length = 0;
    callbacks[0]!.onExit(1); // scope A crashes while scope B is still alive
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sent.filter((m) => m.type === "agent:activity").length, 0, "no agent-level error/offline while a sibling scope survives");
    assert.equal(sent.filter((m) => m.type === "agent:status").length, 0, "no agent-level status while a sibling scope survives");
    callbacks[1]!.onExit(1); // the last surviving scope crashes
    await new Promise((resolve) => setTimeout(resolve, 10));
    const err = sent.find((m) => m.type === "agent:activity");
    assert.ok(err, "the last scope's crash must report activity");
    assert.equal(err!.activity, "error");
    assert.equal(sent.filter((m) => m.type === "agent:status").length, 1, "the last scope's crash reports the agent-level status once");
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("one scope's exit must not invalidate a sibling scope's in-flight durable admission (epoch isolation)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-scope-epoch-"));
  const { runtime, sessions, callbacks } = fakeRuntime();
  const mgr = newManager(root, runtime);
  try {
    const agentId = "agent-epoch-scope";
    const scopeA = scopeOf("channel", "ch-a");
    const scopeB = scopeOf("channel", "ch-b");
    await mgr.start(agentId, scopedConfig(agentId, scopeA));
    await mgr.start(agentId, scopedConfig(agentId, scopeB));
    const dB = mgr.deliver(agentId, "Bob", "ch-b", false, { scope: scopeB, targetName: "#b", msgShort: "b1", turnId: "turn-b", deliveryId: `turn-b:${agentId}` });
    callbacks[0]!.onExit(0); // scope A's runtime dies on its own while B's durable admission is in flight
    await dB; // must NOT be NACKed by scope A's teardown
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sessions[1]!.delivered.length, 1, "scope B's delivery must still reach its runtime");
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent scopes keep independent reply previews and activity attribution", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-scope-preview-"));
  const sent: any[] = [];
  const { runtime, callbacks } = fakeRuntime();
  const mgr = newManager(root, runtime, (m) => sent.push(m));
  try {
    const agentId = "agent-preview-scopes";
    const scopeA = scopeOf("channel", "ch-a");
    const scopeB = scopeOf("channel", "ch-b");
    await mgr.start(agentId, scopedConfig(agentId, scopeA));
    await mgr.start(agentId, scopedConfig(agentId, scopeB));
    const dA = mgr.deliver(agentId, "Alice", "ch-a", false, { scope: scopeA, targetName: "#a", msgShort: "a1", turnId: "turn-a" });
    const dB = mgr.deliver(agentId, "Bob", "ch-b", false, { scope: scopeB, targetName: "#b", msgShort: "b1", turnId: "turn-b" });
    await Promise.all([dA, dB]);
    const replyStarts = sent.filter((m) => m.type === "agent:reply" && m.op === "start");
    const channels = new Set(replyStarts.map((m) => m.channelId));
    assert.ok(channels.has("ch-a") && channels.has("ch-b"), "both scopes' typing indicators must be open concurrently");
    callbacks[0]!.onActivity("working", "tool-a");
    const actA = sent.filter((m) => m.type === "agent:activity").pop()!;
    assert.equal(actA.channelId, "ch-a", "activity must attribute to the emitting scope's channel");
    assert.equal(actA.detail, "tool-a");
    callbacks[1]!.onActivity("working", "tool-b");
    const actB = sent.filter((m) => m.type === "agent:activity").pop()!;
    assert.equal(actB.channelId, "ch-b", "sibling scope's activity must not cross-attribute");
    callbacks[0]!.onTrajectory([{ kind: "text", text: "from-a" }]);
    const traj = sent.filter((m) => m.type === "agent:trajectory").pop()!;
    assert.equal(traj.channelId, "ch-a", "trajectory must attribute to the emitting scope's channel");
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("dequeue(agentId) drops every queued scope and rejects every scope's pending delivers", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-scope-dequeue-"));
  let availableMemMB = 0;
  const budget = new ResourceBudget({ availableMemMB: () => availableMemMB });
  const { runtime } = fakeRuntime();
  const mgr = newManager(root, runtime, undefined, { budget });
  try {
    const agentId = "agent-dequeue-scopes";
    const scopeA = scopeOf("channel", "ch-a", "sess-a");
    await mgr.start(agentId, scopedConfig(agentId, scopeA));
    await mgr.start(agentId, scopedConfig(agentId, scopeOf("channel", "ch-b", "sess-b")));
    assert.equal(mgr.queuedAgents().length, 2, "both scoped starts are queued");
    const dA = mgr.deliver(agentId, "Alice", "ch-a", false, { scope: scopeA, targetName: "#a", msgShort: "a1", turnId: "turn-a", deliveryId: `turn-a:${agentId}` });
    mgr.dequeue(agentId);
    await assert.rejects(dA, /dequeued before delivery admission/, "the queued scope's pending deliver must be rejected");
    assert.equal(mgr.queuedAgents().length, 0, "every queued scope must be dropped");
    assert.equal(budget.queueLength, 0);

    availableMemMB = 999999;
    const retry = mgr.deliver(agentId, "Alice", "ch-a", false, { scope: scopeA, targetName: "#a", msgShort: "a1", turnId: "turn-a", deliveryId: `turn-a:${agentId}` });
    assert.notEqual(retry, dA, "cancellation must clear the durable delivery fence for all scopes");
    await mgr.start(agentId, scopedConfig(agentId, scopeA)); // the retry is consumed by this startup's wake nudge
    await retry;
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});
