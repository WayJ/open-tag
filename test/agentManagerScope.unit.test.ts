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
        stop: () => {},
      };
      sessions.push(session);
      return session;
    },
  };
  return { runtime, spawns, sessions, callbacks };
}

function newManager(root: string, runtime: Runtime, sent?: (msg: unknown) => void): AgentManager {
  return new AgentManager(sent ?? (() => {}), {
    dataDir: root,
    binDir: root,
    deliverDebounceMs: 0,
    budget: noPressureBudget,
    runtimeResolver: () => runtime,
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
  try {
    const mgr = newManager(root, runtime);
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
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second start and deliver for the same scope reuse the running runtime", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-scope-reuse-"));
  const { runtime, spawns, sessions, callbacks } = fakeRuntime();
  try {
    const mgr = newManager(root, runtime);
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
    rmSync(root, { recursive: true, force: true });
  }
});

test("running() deduplicates agents running in multiple scopes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-scope-running-"));
  const { runtime } = fakeRuntime();
  try {
    const mgr = newManager(root, runtime);
    const agentId = "agent-scope-running";
    await mgr.start(agentId, scopedConfig(agentId, scopeOf("channel", "ch-a")));
    await mgr.start(agentId, scopedConfig(agentId, scopeOf("thread", "th-b")));
    assert.equal(mgr.running().length, 1, "two scopes of one agent must report once");
    assert.equal(mgr.running()[0], agentId);
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scoped config resumes the scope session; LEGACY config resumes the agent-wide session", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-scope-session-"));
  const { runtime, spawns } = fakeRuntime();
  try {
    const mgr = newManager(root, runtime);
    const agentId = "agent-scope-session";

    await mgr.start(agentId, scopedConfig(agentId, scopeOf("channel", "ch-s", "sess-scope"), { sessionId: "sess-legacy" }));
    assert.equal(spawns[0]!.sessionId, "sess-scope", "scope.sessionId wins over the legacy top-level sessionId");

    await mgr.start(agentId, scopedConfig(agentId, scopeOf("thread", "th-s", null), { sessionId: "sess-legacy" }));
    assert.equal(spawns[1]!.sessionId, null, "a fresh scope session must not fall back to the legacy sessionId");

    await mgr.start(agentId, { ...baseConfig(agentId), sessionId: "sess-legacy" });
    assert.equal(spawns[2]!.sessionId, "sess-legacy", "LEGACY (no scope) keeps using the top-level sessionId");
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent:session uplink carries the running scope and omits it for LEGACY", async () => {
  const scopedRoot = mkdtempSync(path.join(tmpdir(), "open-tag-agent-scope-uplink-"));
  const scoped = fakeRuntime();
  const sentScoped: any[] = [];
  try {
    const mgr = newManager(scopedRoot, scoped.runtime, (m) => sentScoped.push(m));
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
    rmSync(scopedRoot, { recursive: true, force: true });
  }

  const legacyRoot = mkdtempSync(path.join(tmpdir(), "open-tag-agent-scope-uplink-legacy-"));
  const legacy = fakeRuntime();
  const sentLegacy: any[] = [];
  try {
    const mgr = newManager(legacyRoot, legacy.runtime, (m) => sentLegacy.push(m));
    await mgr.start("agent-legacy-uplink", baseConfig("agent-legacy-uplink"));
    legacy.callbacks[0]!.onSession("sess-legacy-new");
    const up = sentLegacy.find((m) => m.type === "agent:session");
    assert.ok(up, "expected an agent:session uplink");
    assert.equal(up.sessionId, "sess-legacy-new");
    assert.equal("scope" in up, false, "LEGACY uplinks must not carry a scope field");
    mgr.stopAll();
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true });
  }
});
