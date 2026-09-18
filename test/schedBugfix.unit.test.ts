// Regression tests for the scheduler bugfix batch (idle-vs-turn, admission timeout).
// Mirrors the fake-runtime harness of test/agentManagerScope.unit.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentManager, type AgentConfig } from "../src/daemon/agentManager.js";
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface FakeSession extends RuntimeSession { delivered: string[]; }

function newManager(
  root: string,
  runtime: Runtime,
  sent?: (msg: unknown) => void,
  extra: { budget?: ResourceBudget; idleMs?: number; admissionTimeoutMs?: number } = {},
): AgentManager {
  return new AgentManager(sent ?? (() => {}), {
    dataDir: root,
    binDir: root,
    deliverDebounceMs: 0,
    budget: extra.budget ?? noPressureBudget,
    runtimeResolver: () => runtime,
    ...(extra.idleMs !== undefined ? { idleMs: extra.idleMs } : {}),
    ...(extra.admissionTimeoutMs !== undefined ? { admissionTimeoutMs: extra.admissionTimeoutMs } : {}),
  });
}

// Fake runtime that admits the initial turn but never completes it (no "online" activity):
// the scope stays turnActive=true — a quiet mid-turn scope (long tool call, slow codex turn).
function stuckTurnRuntime() {
  const spawns: StartOpts[] = [];
  const sessions: FakeSession[] = [];
  const callbacks: RuntimeCallbacks[] = [];
  const runtime: Runtime = {
    name: "stuck-turn",
    start(opts: StartOpts, cb: RuntimeCallbacks) {
      spawns.push(opts);
      callbacks.push(cb);
      cb.onInitialTurnAdmission();
      cb.onActivity("working", "turn"); // turn starts, never settles in this test unless poked
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

function doneTurnRuntime() {
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
        stop: () => { cb.onExit(0); },
      };
      sessions.push(session);
      return session;
    },
  };
  return { runtime, spawns, sessions, callbacks };
}

// ── Bug 1: idle-sleep must not kill a mid-turn scope ──

test("the idle timer re-arms instead of sleeping a scope whose turn is still active", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-sched-idle-midturn-"));
  const sent: any[] = [];
  const { runtime, callbacks } = stuckTurnRuntime();
  const mgr = newManager(root, runtime, (m) => sent.push(m), { idleMs: 30 });
  try {
    const agentId = "agent-idle-midturn";
    await mgr.start(agentId, baseConfig(agentId));
    // Several idle windows pass while the turn is quietly running (e.g. one long tool call):
    await sleep(100);
    assert.deepEqual(mgr.running(), [agentId], "a quiet mid-turn scope must NOT be idle-slept");
    assert.equal(sent.filter((m) => m.type === "agent:status" && m.status === "sleeping").length, 0,
      "no agent-level sleeping may be reported for a scope that is mid-turn");

    callbacks[0]!.onActivity("online"); // the long turn finally completes
    await sleep(100); // one more idle window: now the between-turns idle semantic applies
    assert.deepEqual(mgr.running(), [], "once the turn is done, the idle timer must sleep the scope");
    assert.ok(sent.some((m) => m.type === "agent:status" && m.status === "sleeping"),
      "the idle sleep reports agent-level sleeping");
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("onTrajectory re-arms the idle timer (codex emits only trajectory during turns)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-sched-idle-trajectory-"));
  const { runtime, callbacks } = doneTurnRuntime();
  const mgr = newManager(root, runtime, undefined, { idleMs: 40 });
  try {
    const agentId = "agent-idle-trajectory";
    await mgr.start(agentId, baseConfig(agentId)); // turn completes at t≈0; idle timer armed
    await sleep(25);
    callbacks[0]!.onTrajectory([{ kind: "text", text: "late trajectory output" }]);
    await sleep(25); // t≈50 > idleMs(40): only a trajectory re-arm keeps the scope alive here
    assert.deepEqual(mgr.running(), [agentId], "trajectory output must re-arm the idle timer");
    await sleep(40); // t≈90 > the re-armed deadline (≈65)
    assert.deepEqual(mgr.running(), [], "the re-armed idle timer still sleeps the scope once quiet");
    mgr.stopAll();
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});
