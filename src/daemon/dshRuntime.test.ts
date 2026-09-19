// Pure-function layer for the DSH runtime (ACP client helpers) — no process/IO here.
// Shapes ground-truthed against real captures in
// dsh-work-opentag/plugins/dsh-opentag-agent-runtime/tests/fixtures/ (session-updates.ndjson,
// prompt-response.json). Task D2 wires these into the Runtime implementation.
// Run: npx tsx --test src/daemon/dshRuntime.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acpActivity,
  buildDshArgs,
  createDeliverQueue,
  mapAcpUpdate,
  parseAcpPromptStopReason,
  permissionAnswer,
} from "./dshRuntime.js";

test("buildDshArgs passes profile and auth token", () => {
  assert.deepEqual(buildDshArgs({ authToken: "tok-1" }), [
    "--profile",
    "opentag",
    "--opentag-auth-token",
    "tok-1",
  ]);
});

test("mapAcpUpdate maps real captured shapes (fixtures/session-updates.ndjson)", () => {
  assert.deepEqual(
    mapAcpUpdate({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "SMOKE_OK" } }),
    [{ kind: "text", text: "SMOKE_OK" }],
  );
  assert.deepEqual(
    mapAcpUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "pondering" } }),
    [{ kind: "thinking", text: "pondering" }],
  );
  assert.deepEqual(mapAcpUpdate({ sessionUpdate: "usage_update", used: 8076, size: 1000000 }), []);
});

test("mapAcpUpdate maps tool_call (ACP v1) to a tool entry", () => {
  const update = {
    sessionUpdate: "tool_call",
    toolCallId: "tc-1",
    title: "Read file",
    kind: "read",
    status: "in_progress",
    content: [{ type: "content", content: { type: "text", text: "src/a.ts" } }],
  };
  assert.deepEqual(mapAcpUpdate(update), [{ kind: "tool", toolName: "Read file", toolInput: "" }]);
  // title may be missing → empty toolName, never undefined
  assert.deepEqual(mapAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "tc-2", status: "completed" }), [
    { kind: "tool", toolName: "", toolInput: "" },
  ]);
});

test("mapAcpUpdate drops non-text content blocks instead of emitting empty text entries", () => {
  // ACP content blocks may be image/resource blocks with no .text — nothing trajectory-worthy.
  assert.deepEqual(mapAcpUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "…" } }), []);
  assert.deepEqual(mapAcpUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "image", data: "…" } }), []);
  assert.deepEqual(mapAcpUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text" } }), []);
});

test("mapAcpUpdate ignores unknown/shapeless updates and clips long text", () => {
  assert.deepEqual(mapAcpUpdate({ sessionUpdate: "plan" }), []);
  assert.deepEqual(mapAcpUpdate({ nope: true }), []);
  assert.deepEqual(mapAcpUpdate(null), []);
  const long = "x".repeat(3000);
  const entries = mapAcpUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: long } });
  assert.equal(entries[0]?.text?.length, 2000);
  // long tool titles clip in both the trajectory entry and the activity detail
  const longTitle = "t".repeat(3000);
  const toolUpdate = { sessionUpdate: "tool_call", toolCallId: "tc-long", title: longTitle, status: "in_progress" };
  assert.equal(mapAcpUpdate(toolUpdate)[0]?.toolName?.length, 2000);
  assert.equal(acpActivity(toolUpdate)?.detail.length, 2000);
});

test("acpActivity surfaces in-progress tool calls as working and message chunks as thinking", () => {
  assert.deepEqual(
    acpActivity({ sessionUpdate: "tool_call", toolCallId: "t", title: "Bash", status: "in_progress" }),
    { activity: "working", detail: "Bash" },
  );
  assert.deepEqual(
    acpActivity({ sessionUpdate: "tool_call", toolCallId: "t", title: "Bash", status: "pending" }),
    { activity: "working", detail: "Bash" },
  );
  assert.deepEqual(acpActivity({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }), {
    activity: "thinking",
    detail: "",
  });
  assert.equal(acpActivity({ sessionUpdate: "tool_call", toolCallId: "t", title: "Bash", status: "completed" }), null);
  assert.equal(acpActivity({ sessionUpdate: "usage_update", used: 1, size: 2 }), null);
  assert.equal(acpActivity(null), null);
});

test("permissionAnswer picks the first allow-kind option, else null", () => {
  assert.deepEqual(
    permissionAnswer([
      { optionId: "no", kind: "reject_once" },
      { optionId: "yes", kind: "allow_once" },
    ]),
    { outcome: "selected", optionId: "yes" },
  );
  assert.deepEqual(permissionAnswer([{ optionId: "a", kind: "allow_always" }]), {
    outcome: "selected",
    optionId: "a",
  });
  assert.equal(permissionAnswer([{ optionId: "no", kind: "reject_once" }]), null);
  assert.equal(permissionAnswer([]), null);
  assert.equal(permissionAnswer(undefined), null);
});

test("createDeliverQueue runs tasks strictly serially", async () => {
  const queue = createDeliverQueue();
  const started: number[] = [];
  let release1: (() => void) | undefined;
  const gate1 = new Promise<void>((resolve) => { release1 = resolve; });

  const p1 = queue.run(async () => {
    started.push(1);
    await gate1;
    return "one";
  });
  const p2 = queue.run(async () => {
    started.push(2);
    return "two";
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(started, [1], "second task must not start while the first is in flight");
  release1?.();
  assert.equal(await p1, "one");
  assert.equal(await p2, "two");
  assert.deepEqual(started, [1, 2]);
});

test("createDeliverQueue propagates rejection to its caller and keeps draining", async () => {
  const queue = createDeliverQueue();
  const started: number[] = [];
  let release1: (() => void) | undefined;
  const gate1 = new Promise<void>((resolve) => { release1 = resolve; });

  const p1 = queue.run(async () => {
    started.push(1);
    await gate1;
    throw new Error("boom");
  });
  const p2 = queue.run(async () => {
    started.push(2);
    return "after-failure";
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(started, [1], "a pending task must not start because an earlier one will fail");
  release1?.();
  await assert.rejects(p1, /boom/);
  assert.equal(await p2, "after-failure");
  assert.deepEqual(started, [1, 2]);
});

test("createDeliverQueue propagates a sync-throwing task to its caller and keeps draining", async () => {
  const queue = createDeliverQueue();
  const started: number[] = [];
  // The run signature promises a Promise return; a task that throws synchronously is still
  // invoked inside the chain, so its caller rejects and the queue moves on unharmed.
  const bad = queue.run((() => {
    throw new Error("sync boom");
  }) as () => Promise<string>);
  const next = queue.run(async () => {
    started.push(2);
    return "after-sync-throw";
  });

  await assert.rejects(bad, /sync boom/);
  assert.equal(await next, "after-sync-throw");
  assert.deepEqual(started, [2]);
});

test("createDeliverQueue drains a three-task chain in order", async () => {
  const queue = createDeliverQueue();
  const order: string[] = [];
  const results = await Promise.all([
    queue.run(async () => { order.push("a"); return "a"; }),
    queue.run(async () => { order.push("b"); return "b"; }),
    queue.run(async () => { order.push("c"); return "c"; }),
  ]);
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.deepEqual(results, ["a", "b", "c"]);
});

test("parseAcpPromptStopReason extracts result.stopReason, null-safe", () => {
  assert.equal(parseAcpPromptStopReason({ jsonrpc: "2.0", id: 7, result: { stopReason: "end_turn" } }), "end_turn");
  assert.equal(parseAcpPromptStopReason({ result: { stopReason: "cancelled" } }), "cancelled");
  assert.equal(parseAcpPromptStopReason({ result: {} }), null);
  assert.equal(parseAcpPromptStopReason({ result: { stopReason: 42 } }), null);
  assert.equal(parseAcpPromptStopReason(null), null);
  assert.equal(parseAcpPromptStopReason(undefined), null);
});
