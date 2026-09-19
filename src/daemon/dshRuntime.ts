// DSH runtime, pure-function layer: ACP (Agent Client Protocol) client helpers with no
// process/IO — the daemon hand-rolls a ~60-line JSON-RPC client over stdio in D2 instead of
// importing @agentclientprotocol/sdk, so these helpers stay dependency-free.
// Shapes ground-truthed against real captures in
// dsh-work-opentag/plugins/dsh-opentag-agent-runtime/tests/fixtures/ (session-updates.ndjson,
// prompt-response.json). D2 wires mapAcpUpdate → onTrajectory, acpActivity → onActivity,
// createDeliverQueue → serial turn delivery.
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
