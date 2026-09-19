// DSH runtime: pure ACP helpers (D1) + Runtime wiring tests (D2, integration with a fake `dsh`
// over stdio). Shapes ground-truthed against real captures in
// dsh-work-opentag/plugins/dsh-opentag-agent-runtime/tests/fixtures/ (session-updates.ndjson,
// prompt-response.json) and the committed copy src/daemon/__fixtures__/dsh-session-new.json.
// Run: npx tsx --test src/daemon/dshRuntime.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StartOpts, TrajectoryEntry } from "./runtime.js";
import { detectRuntimes, getRuntime } from "./runtimes.js";
import {
  acpActivity,
  buildDshArgs,
  createDeliverQueue,
  dshRuntime,
  mapAcpUpdate,
  parseAcpPromptStopReason,
  permissionAnswer,
  resolveDshEffortValue,
  resolveDshModelValue,
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

// resolveDshModelValue / resolveDshEffortValue narrow opts.model / reasoningEffort to the exact
// select `value` a session offered. Fixture shape: grouped model select with JSON [provider,model]
// pair leaves + flat reasoning_effort select (src/daemon/__fixtures__/dsh-session-new.json).
const MODEL_OPTIONS = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: '["deepseek-official","deepseek-v4-flash"]',
    options: [
      {
        group: "deepseek-official",
        name: "DeepSeek",
        options: [
          { value: '["deepseek-official","deepseek-v4-flash"]', name: "deepseek-v4-flash" },
          { value: '["deepseek-official","deepseek-v4-pro"]', name: "DeepSeek-V4-Pro" },
        ],
      },
      {
        group: "zai-coding-cn",
        name: "zai-coding-cn",
        options: [{ value: '["zai-coding-cn","glm-5.3"]', name: "GLM-5.3" }],
      },
    ],
  },
  {
    id: "reasoning_effort",
    name: "Reasoning effort",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [
      { value: "off", name: "Off" },
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
      { value: "max", name: "Max" },
    ],
  },
];

test("resolveDshModelValue matches by model part, provider/model, raw value, and display name", () => {
  assert.equal(resolveDshModelValue(MODEL_OPTIONS, "glm-5.3"), '["zai-coding-cn","glm-5.3"]');
  assert.equal(resolveDshModelValue(MODEL_OPTIONS, "zai-coding-cn/glm-5.3"), '["zai-coding-cn","glm-5.3"]');
  assert.equal(resolveDshModelValue(MODEL_OPTIONS, '["zai-coding-cn","glm-5.3"]'), '["zai-coding-cn","glm-5.3"]');
  assert.equal(resolveDshModelValue(MODEL_OPTIONS, "DeepSeek-V4-Pro"), '["deepseek-official","deepseek-v4-pro"]');
  // not offered / shapeless input → null (caller keeps the session default)
  assert.equal(resolveDshModelValue(MODEL_OPTIONS, "gpt-9"), null);
  assert.equal(resolveDshModelValue(MODEL_OPTIONS, ""), null);
  assert.equal(resolveDshModelValue(null, "glm-5.3"), null);
  assert.equal(resolveDshModelValue([{ id: "model", options: [{ value: 42 }] }], "glm-5.3"), null);
});

test("resolveDshEffortValue matches an offered value (or display name), null when unoffered", () => {
  assert.equal(resolveDshEffortValue(MODEL_OPTIONS, "max"), "max");
  assert.equal(resolveDshEffortValue(MODEL_OPTIONS, "High"), "high"); // name match, case-insensitive
  assert.equal(resolveDshEffortValue(MODEL_OPTIONS, "medium"), null); // dsh offers off/low/high/max only
  assert.equal(resolveDshEffortValue(null, "max"), null);
  assert.equal(resolveDshEffortValue([{ id: "reasoning_effort", options: [] }], "max"), null);
});

// ------------------------------------------------------------ Runtime wiring --
// Integration tests against a fake `dsh` executable (node script with a shebang, resolved via a
// PATH-only env — same mechanism as codexRuntime.test.ts). The fake speaks the ACP wire protocol
// captured from the real derived server: initialize → authenticate → opentag/auth →
// opentag/setSystemPrompt → session/new|resume → session/prompt (+ session/update notifications
// and session/request_permission server requests). Behavior switches ride in via FAKE_DSH_* env.

const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any;
const waitFor = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for runtime callback");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

interface FakeRun {
  session: ReturnType<typeof dshRuntime.start>;
  admissions: Array<Error | undefined>;
  activities: Array<{ activity: string; detail?: string }>;
  trajectory: TrajectoryEntry[];
  sessionIds: Array<string | null>;
  exitCodes: Array<number | null>;
}

function writeFakeDsh(root: string): void {
  const script = [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const readline = require("node:readline");',
    'const recordFile = path.join(process.cwd(), "requests.jsonl");',
    'const record = (line) => { try { fs.appendFileSync(recordFile, line + "\\n"); } catch {} };',
    'const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");',
    'const ok = (id, result) => send({ jsonrpc: "2.0", id, result });',
    'const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });',
    'const argvToken = (() => { const i = process.argv.indexOf("--opentag-auth-token"); return i >= 0 ? process.argv[i + 1] : null; })();',
    'const MODE = process.env.FAKE_DSH_MODE ?? "";',
    `const configOptions = ${JSON.stringify(MODEL_OPTIONS)};`,
    "let authed = false;",
    "let promptCount = 0;",
    "let permissionWaiter = null;",
    'const waitFlag = (flag, fn) => { const t = setInterval(() => { if (fs.existsSync(path.join(process.cwd(), flag))) { clearInterval(t); fn(); } }, 2); };',
    "const runTurn = (id, params) => {",
    '  const update = (update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update } });',
    "  if (process.env.FAKE_DSH_TOOLS) {",
    '    update({ sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Read file", kind: "read", status: "pending" });',
    '    update({ sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Read file", kind: "read", status: "in_progress" });',
    "  }",
    '  update({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "hello" } });',
    "  if (process.env.FAKE_DSH_PERM) {",
    "    const permId = 900 + promptCount;",
    "    permissionWaiter = { id: permId, fn: () => ok(id, { stopReason: \"end_turn\" }) };",
    '    send({ jsonrpc: "2.0", id: permId, method: "session/request_permission", params: { sessionId: params.sessionId, options: [',
    '      { optionId: "reject_once", kind: "reject_once", name: "Reject" },',
    '      { optionId: "allow_once", kind: "allow_once", name: "Allow" },',
    "    ] } });",
    "    return;",
    "  }",
    '  ok(id, { stopReason: "end_turn" });',
    "};",
    'const rl = readline.createInterface({ input: process.stdin });',
    'rl.on("line", (line) => {',
    "  let msg; try { msg = JSON.parse(line); } catch { return; }",
    '  if (msg.id !== undefined && msg.method === undefined) { // client reply to a server request',
    "    if (permissionWaiter && msg.id === permissionWaiter.id) {",
    '      record(JSON.stringify({ method: "permission_reply", params: msg }));',
    "      const fn = permissionWaiter.fn; permissionWaiter = null; fn(msg);",
    "    }",
    "    return;",
    "  }",
    "  record(line);",
    "  if (msg.id === undefined) return; // client notification (session/cancel) — recorded only",
    '  if (process.env.FAKE_DSH_HANG && msg.method === "initialize") return; // swallow: handshake never completes',
    "  const p = msg.params ?? {};",
    '  if (msg.method === "initialize") {',
    "    const authMethods = process.env.FAKE_DSH_AUTH_ID ? [{ id: process.env.FAKE_DSH_AUTH_ID, description: \"\" }] : [];",
    '    ok(msg.id, { protocolVersion: 1, agentCapabilities: {}, authMethods });',
    '  } else if (msg.method === "authenticate") {',
    "    ok(msg.id, {});",
    '  } else if (msg.method === "opentag/auth") {',
    '    if (MODE === "auth-fail" || p.token !== argvToken) fail(msg.id, -32000, "opentag: authentication failed");',
    "    else { authed = true; ok(msg.id, {}); }",
    '  } else if (msg.method === "opentag/setSystemPrompt") {',
    '    if (!authed) fail(msg.id, -32000, "opentag: not authenticated");',
    '    else if (typeof p.text !== "string" || p.text.length === 0) fail(msg.id, -32602, "opentag: text parameter required");',
    "    else ok(msg.id, {});",
    '  } else if (msg.method === "session/new") {',
    '    ok(msg.id, { sessionId: "s1", configOptions });',
    '  } else if (msg.method === "session/resume") {',
    "    ok(msg.id, { configOptions });",
    '  } else if (msg.method === "session/set_config_option") {',
    "    ok(msg.id, { configOptions });",
    '  } else if (msg.method === "session/prompt") {',
    "    promptCount += 1;",
    "    if (process.env.FAKE_DSH_GATE && promptCount === 1) {",
    '      fs.writeFileSync(path.join(process.cwd(), "turn1-started"), "1");',
    '      waitFlag("release-turn1", () => runTurn(msg.id, p));',
    "      return;",
    "    }",
    "    runTurn(msg.id, p);",
    '  } else if (msg.method === "session/close") {',
    "    ok(msg.id, {});",
    "  } else {",
    '    fail(msg.id, -32601, "no such method: " + msg.method);',
    "  }",
    "});",
    'rl.on("close", () => process.exit(0));',
    "",
  ].join("\n");
  const executable = path.join(root, "dsh");
  writeFileSync(executable, script);
  chmodSync(executable, 0o755);
}

function startFake(
  root: string,
  opts: Partial<StartOpts> = {},
  envExtra: Record<string, string> = {},
): FakeRun {
  writeFakeDsh(root);
  const run: FakeRun = {
    session: undefined as unknown as FakeRun["session"],
    admissions: [],
    activities: [],
    trajectory: [],
    sessionIds: [],
    exitCodes: [],
  };
  run.session = dshRuntime.start({
    cwd: root,
    stateDir: root,
    env: { PATH: root, ...envExtra },
    systemPrompt: "system-prompt",
    initialPrompt: "start-nudge",
    ...opts,
  }, {
    onSession: (sessionId) => run.sessionIds.push(sessionId),
    onInitialTurnAdmission: (error) => run.admissions.push(error),
    onActivity: (activity, detail) => run.activities.push({ activity, detail }),
    onTrajectory: (entries) => run.trajectory.push(...entries),
    onExit: (code) => run.exitCodes.push(code),
    log,
  });
  return run;
}

function readRequests(root: string): Array<Record<string, any>> {
  try {
    return readFileSync(path.join(root, "requests.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
}

/** stop() then wait for the child to actually exit before rmSync — the fake's cwd is the temp
 * dir, and Windows refuses to delete the cwd of a live process (EPERM). Never stop() twice: the
 * second call would only schedule another killTree whose synchronous taskkill lands in the next
 * test and blocks its event loop. */
async function cleanup(run: FakeRun | undefined, root: string): Promise<void> {
  try {
    if (run && run.exitCodes.length === 0) {
      run.session.stop();
      await waitFor(() => run.exitCodes.length > 0, 5_000).catch(() => {});
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const request = (root: string, method: string) => readRequests(root).filter((r) => r.method === method);
const promptTexts = (root: string) => request(root, "session/prompt").map((r) => r.params?.prompt?.[0]?.text);

test("dsh handshake completes: session id, initial prompt, trajectory, activity", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-dsh-happy-"));
  let run: FakeRun | undefined;
  try {
    run = startFake(root);
    await waitFor(() => run!.admissions.length > 0);
    assert.equal(run.admissions[0], undefined, "initial turn must be admitted");
    assert.deepEqual(run.sessionIds, ["s1"]);

    const methods = readRequests(root).filter((r) => r.method).map((r) => r.method);
    // Handshake order is load-bearing: authenticate must precede opentag/auth, persona precede session/new.
    assert.deepEqual(
      methods.filter((m) => ["initialize", "authenticate", "opentag/auth", "opentag/setSystemPrompt", "session/new", "session/prompt"].includes(m)),
      ["initialize", "authenticate", "opentag/auth", "opentag/setSystemPrompt", "session/new", "session/prompt"],
    );
    // authMethods was empty in the initialize response → authenticate falls back to "open-tag"
    assert.equal(request(root, "authenticate")[0]?.params?.methodId, "open-tag");
    const auth = request(root, "opentag/auth")[0];
    assert.match(auth?.params?.token ?? "", /^[0-9a-f]{64}$/, "spawn token is 32B hex and is echoed over the protocol");
    assert.equal(request(root, "opentag/setSystemPrompt")[0]?.params?.text, "system-prompt");
    assert.equal(request(root, "session/new")[0]?.params?.cwd, root);
    assert.deepEqual(promptTexts(root), ["start-nudge"]);

    assert.ok(run.trajectory.some((e) => e.kind === "text" && e.text === "hello"));
    assert.ok(run.activities.some((e) => e.activity === "thinking"));
    assert.equal(run.activities.at(-1)?.activity, "online");
  } finally {
    await cleanup(run, root);
  }
});

test("authenticate uses the first offered authMethod id when the server advertises one", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-dsh-authid-"));
  let run: FakeRun | undefined;
  try {
    run = startFake(root, {}, { FAKE_DSH_AUTH_ID: "method-x" });
    await waitFor(() => run!.admissions.length > 0);
    assert.equal(run.admissions[0], undefined);
    assert.equal(request(root, "authenticate")[0]?.params?.methodId, "method-x");
  } finally {
    await cleanup(run, root);
  }
});

test("session/resume replaces session/new and keeps the resumed session id", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-dsh-resume-"));
  let run: FakeRun | undefined;
  try {
    run = startFake(root, { sessionId: "s1" });
    await waitFor(() => run!.admissions.length > 0);
    assert.equal(run.admissions[0], undefined);
    assert.equal(request(root, "session/new").length, 0);
    assert.equal(request(root, "session/resume")[0]?.params?.sessionId, "s1");
    assert.equal(request(root, "session/resume")[0]?.params?.cwd, root);
    assert.deepEqual(run.sessionIds, ["s1"]);
  } finally {
    await cleanup(run, root);
  }
});

test("deliver resolves when the turn completes and the queue serializes turns", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-dsh-queue-"));
  let run: FakeRun | undefined;
  try {
    run = startFake(root, {}, { FAKE_DSH_GATE: "1" });
    const second = run.session.deliver("second-turn");
    await waitFor(() => existsSync(path.join(root, "turn1-started")));
    assert.equal(request(root, "session/prompt").length, 1, "turn 2 must not start while turn 1 is in flight");
    writeFileSync(path.join(root, "release-turn1"), "go");
    await second;
    await waitFor(() => run!.admissions.length > 0);
    assert.equal(run.admissions[0], undefined);
    assert.deepEqual(promptTexts(root), ["start-nudge", "second-turn"]);
    assert.equal(run.activities.at(-1)?.activity, "online");
  } finally {
    await cleanup(run, root);
  }
});

test("tool_call re-emissions map to one trajectory entry but keep feeding activity", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-dsh-tooldup-"));
  let run: FakeRun | undefined;
  try {
    run = startFake(root, {}, { FAKE_DSH_TOOLS: "1" });
    await waitFor(() => run!.admissions.length > 0);
    const toolEntries = run.trajectory.filter((e) => e.kind === "tool");
    assert.equal(toolEntries.length, 1, "pending + in_progress for the same toolCallId → ONE trajectory entry");
    assert.equal(toolEntries[0]?.toolName, "Read file");
    assert.ok(run.trajectory.some((e) => e.kind === "text" && e.text === "hello"));
    const working = run.activities.filter((e) => e.activity === "working" && e.detail === "Read file");
    assert.equal(working.length, 2, "both status emissions still surface as working activity");
  } finally {
    await cleanup(run, root);
  }
});

test("session/request_permission is answered with the first allow option", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-dsh-perm-"));
  let run: FakeRun | undefined;
  try {
    run = startFake(root, {}, { FAKE_DSH_PERM: "1" });
    await waitFor(() => run!.admissions.length > 0);
    assert.equal(run.admissions[0], undefined, "the turn completes after the permission is answered");
    const reply = request(root, "permission_reply")[0]?.params;
    assert.deepEqual(reply?.result?.outcome, { outcome: "selected", optionId: "allow_once" });
  } finally {
    await cleanup(run, root);
  }
});

test("model and reasoning effort are applied via session/set_config_option before the first prompt", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-dsh-config-"));
  let run: FakeRun | undefined;
  try {
    run = startFake(root, { model: "glm-5.3", runtimeConfig: { reasoningEffort: "max" } });
    await waitFor(() => run!.admissions.length > 0);
    assert.equal(run.admissions[0], undefined);
    const configs = request(root, "session/set_config_option");
    assert.equal(configs.length, 2);
    assert.deepEqual(
      configs.map((c) => ({ configId: c.params.configId, value: c.params.value })),
      [
        { configId: "model", value: '["zai-coding-cn","glm-5.3"]' },
        { configId: "reasoning_effort", value: "max" },
      ],
    );
    // both config calls land between session/new and the first session/prompt
    const order = readRequests(root).map((r) => r.method);
    assert.ok(order.indexOf("session/set_config_option") < order.indexOf("session/prompt"));
  } finally {
    await cleanup(run, root);
  }
});

test("an unoffered model is skipped without failing the session", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-dsh-nomodel-"));
  let run: FakeRun | undefined;
  try {
    run = startFake(root, { model: "gpt-9-turbo" });
    await waitFor(() => run!.admissions.length > 0);
    assert.equal(run.admissions[0], undefined, "unresolvable model keeps the session default and still admits the turn");
    assert.equal(request(root, "session/set_config_option").length, 0);
    assert.deepEqual(promptTexts(root), ["start-nudge"]);
  } finally {
    await cleanup(run, root);
  }
});

test("opentag/auth failure rejects initial admission and reports offline", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-dsh-authfail-"));
  let run: FakeRun | undefined;
  try {
    run = startFake(root, {}, { FAKE_DSH_MODE: "auth-fail" });
    const queued = assert.rejects(run.session.deliver("queued while starting"), /authentication failed/);
    await waitFor(() => run!.admissions.length > 0);
    await queued;
    assert.ok(run.admissions[0] instanceof Error);
    assert.match(run.admissions[0]!.message, /opentag: authentication failed/);
    await waitFor(() => run!.activities.some((e) => e.activity === "offline"));
    await waitFor(() => run!.exitCodes.length > 0);
    assert.equal(run.admissions.length, 1, "cleanup after the fatal handshake must not settle admission twice");
  } finally {
    await cleanup(run, root);
  }
});

test("stop() sends session/cancel then session/close and the process exits", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-dsh-stop-"));
  let run: FakeRun | undefined;
  try {
    run = startFake(root);
    await waitFor(() => run!.admissions.length > 0);
    run.session.stop();
    await waitFor(() => run!.exitCodes.length > 0);
    const order = readRequests(root).map((r) => r.method);
    const cancelAt = order.lastIndexOf("session/cancel");
    const closeAt = order.lastIndexOf("session/close");
    assert.ok(cancelAt >= 0, "session/cancel notification is sent");
    assert.ok(closeAt >= 0, "session/close request is sent");
    assert.ok(cancelAt < closeAt, "cancel precedes close");
    const close = request(root, "session/close")[0];
    assert.equal(close?.params?.sessionId, "s1");
  } finally {
    await cleanup(run, root);
  }
});

test("stop() during handshake sends no cancel/close, kills the process, and rejects admission", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-dsh-stopmid-"));
  let run: FakeRun | undefined;
  try {
    run = startFake(root, {}, { FAKE_DSH_HANG: "1" }); // initialize is swallowed — handshake never completes
    await waitFor(() => request(root, "initialize").length > 0);
    run.session.stop();
    await waitFor(() => run!.exitCodes.length > 0);
    await waitFor(() => run!.admissions.length > 0);
    assert.equal(request(root, "session/cancel").length, 0, "no session exists yet — nothing to cancel");
    assert.equal(request(root, "session/close").length, 0);
    assert.equal(request(root, "session/new").length, 0, "handshake never got past initialize");
    assert.ok(run.admissions[0] instanceof Error, "the dead runtime must reject the initial admission");
    assert.match(run.admissions[0]!.message, /dsh exited/);
    assert.equal(run.activities.some((e) => e.activity === "offline"), false, "intentional stop stays quiet — no offline noise");
    // completing without an unhandled stdin 'error' is itself the no-crash assertion
  } finally {
    await cleanup(run, root);
  }
});

// ---------------------------------------------- registry registration (D3) --
// detectRuntimes shells out (`where dsh` / `command -v dsh`) against the CURRENT process env, so
// these tests fake `dsh` by writing an executable into a tmpdir and temporarily prepending that
// dir to process.env.PATH (restored in finally). The opentag profile dir gate is exercised via
// DSH_HOME overrides so the real ~/.dsh is never touched.

/** Writes a fake `dsh` executable into dir (extension per platform so `where`/`command -v` finds it). */
function writeFakeDshBinary(dir: string): void {
  if (process.platform === "win32") {
    writeFileSync(path.join(dir, "dsh.cmd"), "@echo off\r\n");
  } else {
    const executable = path.join(dir, "dsh");
    writeFileSync(executable, "#!/bin/sh\n");
    chmodSync(executable, 0o755);
  }
}

/** Runs fn with PATH (and optionally DSH_HOME) temporarily overridden; always restores.
 * When DSH_HOME is unset, HOME/USERPROFILE are also pointed at the fake dir so the default
 * `homedir()/.dsh` fallback is hermetic (a real ~/.dsh on the dev machine would leak in). */
function withFakeEnv<T>(fakeDir: string, dshHome: string | undefined, fn: () => T): T {
  const orig: Record<"PATH" | "DSH_HOME" | "HOME" | "USERPROFILE", string | undefined> = {
    PATH: process.env.PATH,
    DSH_HOME: process.env.DSH_HOME,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  process.env.PATH = `${fakeDir}${path.delimiter}${orig.PATH ?? ""}`;
  if (dshHome === undefined) {
    delete process.env.DSH_HOME;
    process.env.HOME = fakeDir;
    process.env.USERPROFILE = fakeDir;
  } else {
    process.env.DSH_HOME = dshHome;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(orig)) {
      if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
      else (process.env as Record<string, string | undefined>)[key] = value;
    }
  }
}

test("getRuntime('dsh') returns the dshRuntime from the registry", () => {
  assert.equal(getRuntime("dsh"), dshRuntime);
  // sanity: registry lookup semantics unchanged for known/unknown names
  assert.equal(getRuntime("no-such-runtime"), null);
});

test("detectRuntimes includes dsh when the binary AND the opentag profile dir exist", () => {
  const binDir = mkdtempSync(path.join(tmpdir(), "open-tag-dsh-det-bin-"));
  const home = mkdtempSync(path.join(tmpdir(), "open-tag-dsh-det-home-"));
  try {
    writeFakeDshBinary(binDir);
    const profileDir = path.join(home, "profiles", "opentag");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(path.join(profileDir, ".keep"), "");
    const detected = withFakeEnv(binDir, home, detectRuntimes);
    assert.ok(detected.includes("dsh"), `expected dsh in ${JSON.stringify(detected)}`);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("detectRuntimes omits dsh when the opentag profile dir is missing (binary present)", () => {
  const binDir = mkdtempSync(path.join(tmpdir(), "open-tag-dsh-noprofile-bin-"));
  const home = mkdtempSync(path.join(tmpdir(), "open-tag-dsh-noprofile-home-"));
  try {
    writeFakeDshBinary(binDir); // binary on PATH…
    // …but DSH_HOME has no profiles/opentag → not detected
    const detected = withFakeEnv(binDir, home, detectRuntimes);
    assert.equal(detected.includes("dsh"), false, `expected no dsh in ${JSON.stringify(detected)}`);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("detectRuntimes omits dsh when the binary is absent (profile dir present)", () => {
  const binDir = mkdtempSync(path.join(tmpdir(), "open-tag-dsh-nobin-"));
  const home = mkdtempSync(path.join(tmpdir(), "open-tag-dsh-nobin-home-"));
  try {
    // DSH_HOME points at a dir containing profiles/opentag, but nothing named dsh on PATH
    mkdirSync(path.join(home, "profiles", "opentag"), { recursive: true });
    writeFileSync(path.join(home, "profiles", "opentag", ".keep"), "");
    const detected = withFakeEnv(binDir, home, detectRuntimes);
    assert.equal(detected.includes("dsh"), false, `expected no dsh in ${JSON.stringify(detected)}`);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("detectRuntimes respects the DSH_HOME env override", () => {
  const binDir = mkdtempSync(path.join(tmpdir(), "open-tag-dsh-override-bin-"));
  const home = mkdtempSync(path.join(tmpdir(), "open-tag-dsh-override-home-"));
  try {
    writeFakeDshBinary(binDir);
    // profile exists under DSH_HOME, NOT under the default ~/.dsh → only the override makes it visible
    mkdirSync(path.join(home, "profiles", "opentag"), { recursive: true });
    writeFileSync(path.join(home, "profiles", "opentag", ".keep"), "");
    const withOverride = withFakeEnv(binDir, home, detectRuntimes);
    assert.ok(withOverride.includes("dsh"), `expected dsh in ${JSON.stringify(withOverride)}`);
    // same fake binary, no DSH_HOME → falls back to ~/.dsh which has no profiles/opentag
    const withoutOverride = withFakeEnv(binDir, undefined, detectRuntimes);
    assert.equal(withoutOverride.includes("dsh"), false, `expected no dsh in ${JSON.stringify(withoutOverride)}`);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("detectRuntimes still reports non-dsh runtimes through the unchanged pipeline", () => {
  // No fake dsh, no DSH_HOME: "dsh" must be absent, and the result must still be a filtered
  // subset of the registry names (cursor-agent is still mapped to cursor) — regression guard
  // that the dsh special-case did not break the shared filter chain.
  const binDir = mkdtempSync(path.join(tmpdir(), "open-tag-dsh-regression-bin-"));
  try {
    const detected = withFakeEnv(binDir, undefined, detectRuntimes);
    assert.equal(detected.includes("dsh"), false);
    assert.equal(detected.includes("cursor-agent"), false, "cursor-agent must keep mapping to cursor");
    for (const name of detected) {
      assert.notEqual(getRuntime(name), null, `detected runtime ${name} must be registered`);
    }
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});
