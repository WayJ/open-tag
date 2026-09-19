// DSH runtime: ACP (Agent Client Protocol) client over stdio for DeepSeek Harness.
// Pure helpers (D1) live at the top; the `dshRuntime: Runtime` wiring (D2) below hand-rolls a
// JSON-RPC NDJSON client instead of importing @agentclientprotocol/sdk (same stance as
// codexRuntime's CodexClient — no new daemon dependency for a ~60-line framing layer).
// Shapes ground-truthed against real captures in
// dsh-work-opentag/plugins/dsh-opentag-agent-runtime/tests/fixtures/ (session-updates.ndjson,
// prompt-response.json, session-new-response.json — copy committed at
// src/daemon/__fixtures__/dsh-session-new.json).
import { type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { killTree } from "./killTree.js";
import { spawnSafe } from "./spawnSafe.js";
import {
  initialTurnAdmission,
  protocolAdmission,
  type Runtime,
  type RuntimeCallbacks,
  type RuntimeSession,
  type StartOpts,
} from "./runtime.js";
import type { TrajectoryEntry } from "./runtime.js";

const MAX = 2000;
const clip = (s: unknown) => String(s ?? "").slice(0, MAX);

// ACP chunk content is a content block ({type:"text", text}); only the text is trajectory-worthy.
const textOf = (content: unknown): string => {
  const c = content as { text?: unknown } | undefined;
  return typeof c?.text === "string" ? c.text : "";
};

export function buildDshArgs(p: { authToken: string }): string[] {
  return ["--profile", "opentag", "--opentag-auth-token", p.authToken];
}

/** Inner update of a session/update notification → trajectory entries ([] for anything unmappable). */
export function mapAcpUpdate(update: unknown): TrajectoryEntry[] {
  const u = update as { sessionUpdate?: string; content?: unknown; title?: unknown } | null;
  if (!u || typeof u.sessionUpdate !== "string") return [];
  if (u.sessionUpdate === "agent_message_chunk") {
    const text = textOf(u.content);
    return text ? [{ kind: "text", text: clip(text) }] : []; // non-text blocks (image/…) → nothing to say
  }
  if (u.sessionUpdate === "agent_thought_chunk") {
    const text = textOf(u.content);
    return text ? [{ kind: "thinking", text: clip(text) }] : [];
  }
  if (u.sessionUpdate === "tool_call") return [{ kind: "tool", toolName: clip(u.title), toolInput: "" }];
  return []; // usage_update, plan, anything unknown — not trajectory
}

/** Coarse activity signal for onActivity (working|thinking); null when the update is not activity. */
export function acpActivity(update: unknown): { activity: string; detail: string } | null {
  const u = update as { sessionUpdate?: string; title?: unknown; status?: string } | null;
  if (!u || typeof u.sessionUpdate !== "string") return null;
  if (u.sessionUpdate === "tool_call" && (u.status === "in_progress" || u.status === "pending")) {
    return { activity: "working", detail: clip(u.title) };
  }
  if (u.sessionUpdate === "agent_message_chunk") return { activity: "thinking", detail: "" };
  return null;
}

/** First allow-ish request option (ACP permission), or null when nothing allows. */
export function permissionAnswer(
  options: Array<{ optionId: string; kind: string } | undefined> | undefined,
): { outcome: "selected"; optionId: string } | null {
  const allow = (options ?? []).find((o) => o && typeof o.kind === "string" && o.kind.startsWith("allow"));
  return allow ? { outcome: "selected", optionId: allow.optionId } : null;
}

/** Strictly serial task queue: each task starts only after the previous one settles
 * (resolution and rejection alike — a rejection reaches only its own caller). */
export function createDeliverQueue(): { run<T>(task: () => Promise<T>): Promise<T> } {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const result = tail.then(task, task);
      // The next task waits on settlement, but never inherits the failure.
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}

/** result.stopReason of a session/prompt response, or null when absent/not a string. */
export function parseAcpPromptStopReason(response: unknown): string | null {
  const r = response as { result?: { stopReason?: unknown } } | null;
  return typeof r?.result?.stopReason === "string" ? r.result.stopReason : null;
}

/** A config-option select from a session/new|resume response, or null when not offered. */
function configSelect(configOptions: unknown, id: string): { options?: unknown } | null {
  const list = Array.isArray(configOptions) ? configOptions : [];
  const found = list.find((c) => (c as { id?: unknown } | null)?.id === id);
  return found && Array.isArray((found as { options?: unknown }).options) ? (found as { options?: unknown }) : null;
}

/** opts.model → the `model` select leaf `value` the session offered (a JSON [provider, model]
 * pair string), matched by model part, provider/model, raw value, or display name — or null when
 * this deployment does not offer the model (caller keeps the session default). */
export function resolveDshModelValue(configOptions: unknown, model: string): string | null {
  const select = configSelect(configOptions, "model");
  if (!select || !model) return null;
  for (const group of select.options as Array<{ options?: unknown } | undefined>) {
    const leaves = Array.isArray(group?.options) ? group.options : [];
    for (const leaf of leaves as Array<{ value?: unknown; name?: unknown } | undefined>) {
      if (typeof leaf?.value !== "string") continue;
      if (leaf.value === model || leaf.name === model) return leaf.value;
      try {
        const pair = JSON.parse(leaf.value);
        if (Array.isArray(pair) && (pair[1] === model || `${pair[0]}/${pair[1]}` === model)) return leaf.value;
      } catch { /* leaf value is not a JSON [provider, model] pair */ }
    }
  }
  return null;
}

/** reasoningEffort → the `reasoning_effort` select value when the session offers it (value or
 * display-name match), else null — dsh offers off/low/high/max; an unoffered level is skipped
 * rather than sent as an invalid value. */
export function resolveDshEffortValue(configOptions: unknown, effort: string): string | null {
  const select = configSelect(configOptions, "reasoning_effort");
  if (!select || !effort) return null;
  const leaf = (select.options as Array<{ value?: unknown; name?: unknown } | undefined>).find(
    (o) => (typeof o?.value === "string" && o.value === effort)
      || (typeof o?.name === "string" && o.name.toLowerCase() === effort.toLowerCase()),
  );
  return typeof leaf?.value === "string" ? leaf.value : null;
}

interface PendingRpc { resolve: (value: any) => void; reject: (error: Error) => void }

/** Hand-rolled JSON-RPC 2.0 NDJSON client (mirrors codexRuntime's CodexClient): line buffer on
 * stdout, id→pending map, notifications dispatched, server→client requests answered inline. */
class DshClient {
  private nextId = 0;
  private pending = new Map<number, PendingRpc>();
  private buf = "";
  onNotification: ((method: string, params: any) => void) | null = null;

  constructor(private proc: ChildProcess) {
    proc.stdout?.on("data", (c: Buffer) => {
      this.buf += c.toString(); const lines = this.buf.split("\n"); this.buf = lines.pop() ?? "";
      for (const ln of lines) { const t = ln.trim(); if (t) this.handleLine(t); }
    });
    // Sink async EPIPE from a child that died between the write guard and the OS: the daemon has
    // no uncaughtException handler, so a single unhandled stdin 'error' event kills every agent.
    proc.stdin?.on("error", () => {});
  }

  request(method: string, params: unknown): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method: string, params?: unknown): void { this.write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }); }
  private respond(id: number, result: unknown): void { this.write({ jsonrpc: "2.0", id, result }); }
  private write(o: unknown): void {
    // Never write to a ended/destroyed stdin: the async ERR_STREAM_WRITE_AFTER_END 'error' event
    // has no listener and would take the daemon down; the pending entry is rejected on exit instead.
    const stdin = this.proc.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) return;
    try { stdin.write(JSON.stringify(o) + "\n"); } catch { /* */ }
  }
  closeAllPending(error: Error): void { for (const [, p] of this.pending) p.reject(error); this.pending.clear(); }

  private handleLine(line: string): void {
    let raw: any; try { raw = JSON.parse(line); } catch { return; }
    if (raw.id !== undefined && (raw.result !== undefined || raw.error !== undefined)) {
      const p = this.pending.get(raw.id); if (!p) return; this.pending.delete(raw.id);
      raw.error ? p.reject(new Error(raw.error.message || "rpc error")) : p.resolve(raw.result);
      return;
    }
    if (raw.id !== undefined && raw.method) { this.handleServerRequest(raw.id, raw.method, raw.params || {}); return; }
    if (raw.method) this.onNotification?.(raw.method, raw.params || {});
  }

  /** Daemon mode: permissions auto-select the first allow-ish option; everything without one is
   * rejected so the server never blocks on a human answer. */
  private handleServerRequest(id: number, method: string, params: any): void {
    if (method === "session/request_permission") {
      this.respond(id, { outcome: permissionAnswer(params?.options) ?? { outcome: "rejected" } });
      return;
    }
    this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: "unhandled: " + method } });
  }
}

export const dshRuntime: Runtime = {
  name: "dsh",
  experimental: true,
  start(opts: StartOpts, cb: RuntimeCallbacks): RuntimeSession {
    // Per-spawn token: passed by argv, must be echoed via opentag/auth before the server honors
    // any opentag/* method (fail-loud contract with the derived server).
    const token = randomBytes(32).toString("hex");
    const proc = spawnSafe("dsh", buildDshArgs({ authToken: token }), { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], env: opts.env });
    const client = new DshClient(proc);
    const admission = initialTurnAdmission(cb);
    const queue = createDeliverQueue();
    let sessionId: string | null = opts.sessionId ?? null;
    let configOptions: unknown = null;
    let lastSentModel: string | null = null;
    let lastSentEffort: string | null = null;
    const seenToolCalls = new Set<string>();
    const stderrTail: string[] = []; // last few stderr lines — crash diagnostics for the offline detail
    let spawnFailed = false;
    let reportedExit = false;
    let stopped = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    // Deliveries await this gate: it resolves once the ACP handshake + session are ready and
    // rejects on any handshake/spawn failure (each queued deliver then rejects with the cause).
    let settleReady!: (error?: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      settleReady = (error) => { if (error) reject(error); else resolve(); };
    });

    const finish = (code: number | null): void => {
      if (reportedExit) return;
      reportedExit = true;
      cb.onExit(code);
    };

    function absorbConfigOptions(response: any): void {
      if (Array.isArray(response?.configOptions)) configOptions = response.configOptions;
    }

    /** Send session/set_config_option for model/effort when the caller asked for something not
     * already applied. Unresolvable values warn and keep the session default (never an invalid
     * send); an RPC failure propagates — fatal during handshake, turn-rejecting mid-session. */
    async function applySessionConfig(): Promise<void> {
      const model = typeof opts.model === "string" && opts.model ? opts.model : null;
      const effortRaw = opts.runtimeConfig?.reasoningEffort;
      const effort = typeof effortRaw === "string" && effortRaw ? effortRaw : null;
      if (model && model !== lastSentModel) {
        const value = resolveDshModelValue(configOptions, model);
        if (value === null) cb.log.warn("dsh model not offered; keeping session default", { model });
        else {
          absorbConfigOptions(await client.request("session/set_config_option", { sessionId, configId: "model", value }));
          lastSentModel = model;
          cb.log.info("dsh model applied", { model });
        }
      }
      if (effort && effort !== lastSentEffort) {
        const value = resolveDshEffortValue(configOptions, effort);
        if (value === null) cb.log.warn("dsh reasoning effort not offered; keeping session default", { effort });
        else {
          absorbConfigOptions(await client.request("session/set_config_option", { sessionId, configId: "reasoning_effort", value }));
          lastSentEffort = effort;
          cb.log.debug("dsh reasoning effort applied", { effort });
        }
      }
    }

    client.onNotification = (method, params) => {
      if (method !== "session/update") return;
      if (typeof params?.sessionId === "string" && params.sessionId !== sessionId) return; // stale/other session
      const update = params?.update as { sessionUpdate?: unknown; toolCallId?: unknown } | null;
      if (update?.sessionUpdate === "config_option_update") {
        absorbConfigOptions(update); // catalog/selection changed server-side — keep resolution fresh
        return;
      }
      const entries = mapAcpUpdate(update);
      // ACP re-emits tool_call per status change (pending → in_progress → completed). Only the
      // first occurrence per toolCallId is trajectory-worthy; later ones feed onActivity only.
      let emitTrajectory = true;
      if (update?.sessionUpdate === "tool_call" && typeof update.toolCallId === "string") {
        if (seenToolCalls.has(update.toolCallId)) emitTrajectory = false;
        else seenToolCalls.add(update.toolCallId);
      }
      if (entries.length && emitTrajectory) cb.onTrajectory(entries);
      const act = acpActivity(update);
      if (act) cb.onActivity(act.activity, act.detail);
    };

    function deliver(text: string): Promise<void> {
      const input = protocolAdmission();
      void queue.run(async () => {
        await ready; // handshake gate — rejects with the handshake/spawn cause
        if (stopped) throw new Error("dsh stopped before prompt");
        await applySessionConfig();
        cb.onActivity("working", "turn");
        // session/prompt responds only when the turn ends (stopReason) — that response is the
        // admission boundary for this delivery.
        await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
      }).then(
        () => { input.accept(); cb.onActivity("online", ""); },
        (error) => { input.reject(error instanceof Error ? error : new Error(String(error))); },
      );
      return input.promise;
    }
    void deliver(opts.initialPrompt).then(() => admission.accept(), (error) => admission.reject(error));

    (async () => {
      try {
        const init = await client.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
          clientInfo: { name: "open-tag", version: "0.1.0" },
        });
        const authMethods = Array.isArray(init?.authMethods) ? init.authMethods : [];
        const methodId = typeof authMethods[0]?.id === "string" ? authMethods[0].id : "open-tag";
        await client.request("authenticate", { methodId });
        await client.request("opentag/auth", { token });
        await client.request("opentag/setSystemPrompt", { text: opts.systemPrompt });
        if (opts.sessionId) {
          absorbConfigOptions(await client.request("session/resume", { sessionId: opts.sessionId, cwd: opts.cwd }));
        } else {
          const r = await client.request("session/new", { cwd: opts.cwd, mcpServers: [] });
          if (typeof r?.sessionId !== "string" || !r.sessionId) throw new Error("dsh session/new returned no sessionId");
          sessionId = r.sessionId;
          absorbConfigOptions(r);
        }
        cb.onSession(sessionId);
        if (Array.isArray(configOptions)) cb.log.debug("dsh config options available", { count: configOptions.length });
        await applySessionConfig();
        settleReady();
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        settleReady(error);
        admission.reject(error);
        // A dead/stopped process rejects every in-flight handshake request via closeAllPending;
        // its own handler already owned the reporting (offline detail + onExit) — don't double up.
        if (spawnFailed || reportedExit) return;
        cb.log.error("dsh init failed", { detail: error.message });
        cb.onActivity("offline", `dsh init failed: ${error.message.slice(0, 200)}`);
        killTree(proc); // fail loud: exit handler finishes cleanup (closeAllPending + onExit)
      }
    })();

    proc.stderr?.on("data", (c: Buffer) => {
      const t = c.toString().trim();
      if (!t) return;
      stderrTail.push(t.slice(0, 200));
      if (stderrTail.length > 3) stderrTail.shift();
      cb.log.debug("dsh stderr", { t: t.slice(0, 300) });
    });
    proc.on("error", (e: NodeJS.ErrnoException) => {
      admission.reject(e);
      spawnFailed = true;
      const detail = e.code === "ENOENT" ? "dsh not found" : "dsh spawn failed";
      const error = new Error(detail);
      settleReady(error);
      client.closeAllPending(error);
      cb.log.error("dsh spawn failed", { detail: String(e?.message ?? e), code: e.code ?? "" });
      cb.onActivity("offline", detail);
      finish(1);
    });
    proc.on("exit", (code) => {
      if (killTimer) { clearTimeout(killTimer); killTimer = undefined; } // already dead — no pointless taskkill (or PID-reuse misfire)
      const tail = stderrTail.join(" | ").slice(-200);
      const detail = `dsh exited (${code ?? "signal"})${tail ? `: ${tail}` : ""}`;
      const error = new Error(detail);
      settleReady(error);
      admission.reject(error);
      client.closeAllPending(error); // rejects any in-flight prompt → its deliver rejects
      if (!stopped) cb.onActivity("offline", detail); // a crash's stderr is the only clue; intentional stops stay quiet
      finish(code);
    });

    return {
      pid: proc.pid,
      deliver,
      stop: () => {
        // Graceful teardown: cancel + close (unawaited, best-effort), then EOF — dsh persists the
        // session on clean stdin close, which is what makes the next wake resumable. killTree
        // after a short grace backs up a hung server.
        if (stopped) return; // idempotent: a second call would only re-arm killTree's taskkill
        stopped = true;
        try {
          if (sessionId) {
            client.notify("session/cancel", { sessionId });
            client.request("session/close", { sessionId }).catch(() => {});
          }
          if (proc.stdin && !proc.stdin.writableEnded) proc.stdin.end();
        } catch { /* best effort */ }
        killTimer = setTimeout(() => killTree(proc), 1_000);
        killTimer.unref?.();
      },
    };
  },
};
