// Model/profile discovery for CLI runtimes that can report local choices.
// The daemon shells out to the runtime's list command on its own machine and parses stdout, so the
// candidates reflect what that machine + login can actually use (not a hard-coded server table).
//
// Scope: opencode / cursor / pi enumerate models; Hermes enumerates local profiles; reasonix
// enumerates the providers/models of its resolved config via `reasonix doctor --json`; dsh drives an
// ACP (JSON-RPC over stdio) handshake and reads the session/new configOptions.
//  - claude / codex have no "list models" command — their catalogs stay static, server-side, but
//    supported thinking/reasoning controls are probed dynamically.
//  - dsh probes its providers/models via an ACP (JSON-RPC over stdio) handshake (same wire protocol
//    as its runtime), while copilot / kimi stay static — they would need a protocol-specific
//    discovery handshake, not yet built.
//  Both gaps are tracked in docs/tech-debt-tracker.md.
//
// The parse functions are pure (unit-tested against fixtures captured from multica's discovery
// research) and mirror multica's server/pkg/agent/models.go field-for-field.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

export interface ThinkingLevel { value: string; label: string; description?: string }
export interface ModelThinking { levels: ThinkingLevel[]; default?: string }
export interface DiscoveredModel {
  id: string;
  label: string;
  provider?: string;
  default?: boolean;
  thinking?: ModelThinking; // reasoning-effort levels this model supports (claude/codex)
}

const titleCase = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

// A model id is a token that starts with a letter and holds only [A-Za-z0-9-_./] (mirrors multica's
// isOpenclawIdentifier) — used to reject prose/header lines that happen to contain a separator.
function isModelId(s: string): boolean {
  return /^[A-Za-z][A-Za-z0-9\-_./]*$/.test(s);
}

// claude/codex have no "list models" command — their catalog is static, but each model's reasoning-effort
// levels ARE probed (so the UI offers exactly what the installed CLI supports, not a guess).

// `claude --help` advertises the effort *superset* on one `--effort` line:
//   `--effort <level>   Effort level for the current session (low, medium, high, xhigh, max)`
// (the help wraps across lines; [^(] in the regex spans newlines, so the multi-line form still matches).
// But that superset has per-model gaps the CLI does NOT express programmatically — xhigh is Opus-only,
// max is not offered on Haiku. So we parse the superset, then project it through a per-model allow-list
// (multica's hand-maintained claudeModelEffortAllow, MUL-2339, thinking.go — collapsed to our short ids).
// Over-offering a level the model rejects would defeat the point of discovery, so we filter, not flatten.
const CLAUDE_MODELS: { id: string; label: string }[] = [
  { id: "sonnet", label: "Sonnet" }, { id: "opus", label: "Opus" }, { id: "haiku", label: "Haiku" },
];

// Friendly labels for Claude's effort tokens (matches Anthropic's own slash UI; titleCase would give "Xhigh").
const CLAUDE_EFFORT_LABEL: Record<string, string> = {
  low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max",
};

// Per-model effort allow-list. A model absent from this map keeps the full parsed superset (defensive:
// a newly-shipped alias still gets a usable picker until the table is updated). Update when Anthropic
// ships a model with a different effort surface.
const CLAUDE_MODEL_EFFORT_ALLOW: Record<string, Set<string>> = {
  opus: new Set(["low", "medium", "high", "xhigh", "max"]),
  sonnet: new Set(["low", "medium", "high", "max"]),
  haiku: new Set(["low", "medium", "high"]),
};

export function parseClaudeEffortLevels(helpText: string): string[] {
  const m = /--effort\s*(?:<[^>]+>)?\s*(?:Effort level[^(]*)?\(([^)]+)\)/.exec(helpText);
  if (!m) return [];
  return m[1]!.split(",").map((s) => s.trim()).filter((s) => /^[a-z]+$/i.test(s));
}

// Project the parsed effort superset onto one model: keep only the levels the model supports (∩ allow-list),
// label them, and default to medium when offered. Returns undefined when nothing survives (UI hides the picker).
export function claudeThinkingForModel(modelId: string, superset: string[]): ModelThinking | undefined {
  const allow = CLAUDE_MODEL_EFFORT_ALLOW[modelId];
  const levels: ThinkingLevel[] = superset
    .filter((v) => !allow || allow.has(v))
    .map((v) => ({ value: v, label: CLAUDE_EFFORT_LABEL[v] ?? titleCase(v) }));
  if (!levels.length) return undefined;
  return { levels, default: levels.some((l) => l.value === "medium") ? "medium" : levels[0]!.value };
}

// codex: `codex debug models` emits the raw catalog as JSON. Each model carries per-model
// supported_reasoning_levels + default_reasoning_level; visibility "list" = shown (drop "hide").
export function parseCodexModels(jsonStr: string): DiscoveredModel[] {
  let parsed: any;
  try { parsed = JSON.parse(jsonStr); } catch { return []; }
  const models = Array.isArray(parsed?.models) ? parsed.models : [];
  const out: DiscoveredModel[] = [];
  for (const m of models) {
    if (m?.visibility !== "list") continue; // whitelist: only explicitly "list" models show — a hidden/unmarked one never leaks
    const slug = typeof m?.slug === "string" ? m.slug : "";
    if (!slug) continue;
    const raw = Array.isArray(m?.supported_reasoning_levels) ? m.supported_reasoning_levels : [];
    const levels: ThinkingLevel[] = raw
      .map((l: any) => ({ value: String(l?.effort ?? ""), label: titleCase(String(l?.effort ?? "")), description: typeof l?.description === "string" ? l.description : undefined }))
      .filter((l: ThinkingLevel) => l.value);
    const thinking = levels.length ? { levels, default: typeof m?.default_reasoning_level === "string" ? m.default_reasoning_level : undefined } : undefined;
    out.push({ id: slug, label: typeof m?.display_name === "string" && m.display_name ? m.display_name : slug, provider: "openai", ...(thinking ? { thinking } : {}) });
  }
  return out;
}

// reasonix has no "list models" command — its catalog is config-driven (reasonix.toml /
// ~/.reasonix/config.toml). `reasonix doctor --json` emits the RESOLVED config, which is more
// faithful than re-parsing TOML ourselves (project > user > built-in defaults already applied).
// Each provider carries `models` (or a single `model`).
//
// The resolved default lives in `config.default_model`, NOT in a per-provider `is_default` flag:
// v1.18.0 emits `is_default: false` on every provider even when one is the default, so keying off
// it left the whole list unmarked and the modal preselected whatever provider came first in config
// order. `default_model` is either `"<provider>/<model>"` or a bare provider/model name — match a
// provider by name or a model id by its trailing segment.
export function parseReasonixModels(jsonStr: string): DiscoveredModel[] {
  let parsed: any;
  try { parsed = JSON.parse(jsonStr); } catch { return []; }
  const providers = Array.isArray(parsed?.providers) ? parsed.providers : [];
  const rawDefault = typeof parsed?.config?.default_model === "string" ? parsed.config.default_model : "";
  const slash = rawDefault.indexOf("/");
  const defProvider = slash >= 0 ? rawDefault.slice(0, slash) : rawDefault;
  const defModel = slash >= 0 ? rawDefault.slice(slash + 1) : "";
  // Each provider contributes its `models` list (or its single `model`), in config order.
  const entries: { id: string; provider: any }[] = [];
  for (const p of providers) {
    const list = Array.isArray(p?.models) && p.models.length ? p.models : (typeof p?.model === "string" && p.model ? [p.model] : []);
    for (const m of list) entries.push({ id: String(m), provider: p });
  }
  // Resolve default_model to exactly ONE model id: an explicit `is_default` provider wins, else a
  // `<provider>/<model>` or bare-provider-name match, else a bare model id. Nothing matches → no default.
  const flagged = entries.find((e) => e.provider?.is_default === true);
  const defaultId = flagged?.id
    ?? (defModel ? entries.find((e) => e.provider?.name === defProvider && e.id === defModel)?.id : undefined)
    ?? entries.find((e) => e.provider?.name === defProvider)?.id // bare provider name (default_model = "hy3")
    ?? entries.find((e) => e.id === rawDefault)?.id;            // bare model id (default_model = "hy3-ioa")
  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const { id, provider } of entries) {
    if (!isModelId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: id, provider: provider?.name ?? "reasonix", ...(id === defaultId ? { default: true } : {}) });
  }
  return out;
}

// dsh (DeepSeek Harness) has no list command — its catalog is the `model` select inside an ACP
// session/new response (`result.configOptions`). Shape ground truth: the live capture committed at
// src/daemon/__fixtures__/dsh-session-new.json (copied from
// dsh-work-opentag/plugins/dsh-opentag-agent-runtime/tests/fixtures/session-new-response.json).
//  - The model select's options are provider groups; each leaf's `value` is a JSON-encoded
//    [provider, model] pair (e.g. '["deepseek-official","deepseek-v4-flash"]') — that pair is what
//    the CLI would actually run, so it is the source of truth for id/provider (group `name` is
//    display-only).
//  - `currentValue` names the session's resolved default model (matched against the raw value).
//  - A separate session-level `reasoning_effort` select carries the thinking levels; they apply to
//    every model (same projection as claude/codex), defaulting to its own currentValue.
export function parseDshConfigOptions(response: unknown): DiscoveredModel[] {
  const configOptions = (response as any)?.result?.configOptions;
  if (!Array.isArray(configOptions)) return [];
  const modelSelect = configOptions.find((c: any) => c?.id === "model" && c?.type === "select");
  if (!modelSelect || !Array.isArray(modelSelect.options)) return [];

  // Session-level reasoning_effort select → thinking levels shared by every model.
  const effortSelect = configOptions.find((c: any) => c?.id === "reasoning_effort" && c?.type === "select");
  let thinking: ModelThinking | undefined;
  if (effortSelect && Array.isArray(effortSelect.options)) {
    const levels: ThinkingLevel[] = effortSelect.options
      .map((o: any) => ({
        value: typeof o?.value === "string" ? o.value : "",
        label: typeof o?.name === "string" ? o.name : "",
        description: typeof o?.description === "string" ? o.description : undefined,
      }))
      .filter((l: ThinkingLevel) => l.value && l.label);
    if (levels.length) {
      const cur = effortSelect.currentValue;
      thinking = { levels, ...(typeof cur === "string" && levels.some((l) => l.value === cur) ? { default: cur } : {}) };
    }
  }

  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const group of modelSelect.options) {
    const leaves = Array.isArray(group?.options) ? group.options : [];
    for (const leaf of leaves) {
      let pair: unknown;
      try { pair = JSON.parse(typeof leaf?.value === "string" ? leaf.value : ""); } catch { continue; } // not a [provider, model] pair → not a model choice
      const [provider, model] = Array.isArray(pair) ? pair : [];
      if (typeof provider !== "string" || !provider || typeof model !== "string" || !model) continue;
      const key = `${provider}/${model}`;
      if (seen.has(key)) continue; // the same model can appear in two groups — list it once
      seen.add(key);
      const isDefault = leaf.value === modelSelect.currentValue;
      out.push({
        id: model,
        label: typeof leaf.name === "string" && leaf.name ? leaf.name : model,
        provider,
        ...(isDefault ? { default: true } : {}),
        ...(thinking ? { thinking } : {}),
      });
    }
  }
  return out;
}

// `opencode models [--verbose]`: one `provider/model` per line. In --verbose a JSON block (reasoning
// variants — not consumed in this slice) follows each id. Skip the `PROVIDER/MODEL` header and any
// line that starts a JSON block (`{` / `"`).
export function parseOpencodeModels(stdout: string): DiscoveredModel[] {
  const out: DiscoveredModel[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("{") || line.startsWith('"') || line.startsWith("}")) continue; // verbose JSON block
    if (line === line.toUpperCase() && /[A-Z]/.test(line)) continue; // PROVIDER/MODEL header
    const id = line.split(/\s+/)[0]!; // defensive: a verbose line could trail metadata
    const slash = id.indexOf("/");
    if (slash <= 0 || slash >= id.length - 1) continue; // need a non-empty provider AND model
    out.push({ id, label: id, provider: id.slice(0, slash) });
  }
  return out;
}

// `cursor-agent --list-models`: `<id> - <label>` lines under an "Available models" header. A
// `(current, default)`-style suffix marks the default; provider is always "cursor".
export function parseCursorModels(stdout: string): DiscoveredModel[] {
  const out: DiscoveredModel[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const sep = line.indexOf(" - ");
    if (sep < 0) continue; // skip the "Available models" header & blank lines
    const id = line.slice(0, sep).trim();
    if (!isModelId(id)) continue;
    let label = line.slice(sep + 3).trim();
    const isDefault = /default/i.test(label);
    const paren = label.indexOf("("); // strip "(current, default)" and the like
    if (paren >= 0) label = label.slice(0, paren).trim();
    out.push({ id, label: label || id, provider: "cursor", ...(isDefault ? { default: true } : {}) });
  }
  return out;
}

// `pi --list-models`: either `provider:model` lines (old) or a whitespace `provider model …` table
// (new). Skip the `provider …` header row and warning/error/info noise lines.
export function parsePiModels(out: string): DiscoveredModel[] {
  const res: DiscoveredModel[] = [];
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (isPiNoise(line)) continue;
    const fields = line.split(/\s+/);
    const first = fields[0]!;
    if (first.toLowerCase() === "provider") continue; // table header row
    let id: string;
    if (first.includes(":") || first.includes("/")) id = first.replace(":", "/");
    else if (fields.length >= 2) id = `${first}/${fields[1]}`;
    else continue;
    const slash = id.indexOf("/");
    if (slash <= 0 || slash >= id.length - 1) continue; // both sides non-empty
    res.push({ id, label: id, provider: id.slice(0, slash) });
  }
  return res;
}

function isPiNoise(line: string): boolean {
  const l = line.toLowerCase();
  return l.includes("no models match pattern") || l.startsWith("warning:") || l.startsWith("error:") || l.startsWith("info:");
}

function labelFromId(id: string): string {
  return id.split(/[-_]/).filter(Boolean).map(titleCase).join(" ") || id;
}

function firstYamlString(text: string, keys: string[]): string | null {
  for (const key of keys) {
    const re = new RegExp(`^${key}:\\s*["']?([^"'\\n#]+)`, "m");
    const m = re.exec(text);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return null;
}

function hermesProfileLabel(dir: string, id: string): string {
  for (const filename of ["profile.yaml", "config.yaml"]) {
    const file = path.join(dir, filename);
    if (!existsSync(file)) continue;
    try {
      const text = readFileSync(file, "utf8").slice(0, 4096);
      const label = firstYamlString(text, ["display_name", "displayName", "name", "title"]);
      if (label) return label;
    } catch {
      // Fall through to id-derived label.
    }
  }
  return labelFromId(id);
}

function isHermesProfileDir(dir: string): boolean {
  return ["profile.yaml", "SOUL.md", "config.yaml"].some((name) => existsSync(path.join(dir, name)));
}

export function discoverHermesProfilesFromRoots(roots: string[]): DiscoveredModel[] {
  const found = new Map<string, DiscoveredModel>([
    ["default", { id: "default", label: "Default profile", provider: "hermes", default: true }],
  ]);
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    let entries: string[];
    try { entries = readdirSync(root); } catch { continue; }
    for (const entry of entries) {
      const dir = path.join(root, entry);
      try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
      if (!isHermesProfileDir(dir)) continue;
      if (!isModelId(entry)) continue;
      if (!found.has(entry)) found.set(entry, { id: entry, label: hermesProfileLabel(dir, entry), provider: "hermes" });
    }
  }
  return [...found.values()].sort((a, b) => {
    if (a.id === "default") return -1;
    if (b.id === "default") return 1;
    return a.id.localeCompare(b.id);
  });
}

function discoverHermesProfiles(): DiscoveredModel[] {
  const home = homedir();
  const roots = [
    process.env.HERMES_PROFILE_DIR,
    path.join(home, ".hermes", "profiles"),
  ].filter((v): v is string => !!v);
  return discoverHermesProfilesFromRoots(roots);
}

// ── shelling out (not unit-tested — covered by the live E2E run) ──

const LIST_TIMEOUT_MS = 7_000; // a single probe must stay under runtimeModels' 8s WS-RPC budget, else the server gives up while the daemon keeps spawning
// Per-runtime overrides of LIST_TIMEOUT_MS. dsh is not one-shot: the probe spawns the harness and
// drives a full ACP handshake (initialize → authenticate → opentag/auth → setSystemPrompt →
// session/new), so 7s is not enough. Must stay under runtimeModels' PROBE_BUDGET_MS.dsh = 30s —
// the pair is load-bearing; if either side changes, change both (server gives up first otherwise,
// the modal falls back to static, and the dsh dropdown renders empty).
const LIST_BUDGET_MS: Record<string, number> = { dsh: 25_000 };
const OUT_CAP = 256 * 1024; // bound memory if a CLI floods stdout

// Run a runtime's list command and capture stdout/stderr. Uses the daemon's own env (so the CLI sees
// the same login/config the agent runs use) minus NODE_OPTIONS — a proxy flag there makes some
// bundled CLIs refuse to start (same gotcha the opencode/cursor/pi runtimes guard against).
function runList(bin: string, args: string[], timeoutMs: number = LIST_TIMEOUT_MS): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    let proc: ChildProcess;
    try {
      proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env });
    } catch (e) {
      return resolve({ stdout: "", stderr: String((e as any)?.message ?? e), code: 1 });
    }
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (c: Buffer) => { if (stdout.length < OUT_CAP) stdout += c.toString(); });
    proc.stderr?.on("data", (c: Buffer) => { if (stderr.length < OUT_CAP) stderr += c.toString(); });
    const timer = setTimeout(() => { try { proc.kill(process.platform === "win32" ? undefined : "SIGKILL"); } catch { /* */ } }, timeoutMs);
    proc.on("error", (e) => { clearTimeout(timer); resolve({ stdout, stderr: stderr || String((e as any)?.message ?? e), code: 1 }); });
    proc.on("exit", (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
  });
}

// dsh probe system prompt: opentag/setSystemPrompt is one-shot per process and session/new refuses
// to run without it — this throwaway process only needs the gate satisfied, never a real persona.
const DSH_PROBE_PROMPT = "probe";

// dsh is not one-shot: it speaks ACP (JSON-RPC over NDJSON stdio) and only exposes its catalog after
// the full handshake. This driver mirrors the plugin's verified smoke client
// (dsh-work-opentag/plugins/dsh-opentag-agent-runtime/tools/smoke.mjs): initialize → authenticate →
// opentag/auth → opentag/setSystemPrompt → session/new → (capture configOptions) → session/close.
// Binary resolution: `dsh` on PATH, or an absolute path via OPEN_TAG_DSH_BIN (the harness CLI is a
// `node apps/cli/lib/bin.js` checkout, often not on PATH). Whole exchange bounded by timeoutMs —
// a hung handshake, a non-NDJSON-flooded stdout, or an early exit all settle null. Never throws.
export function probeDshModels(timeoutMs: number): Promise<DiscoveredModel[] | null> {
  return new Promise((resolve) => {
    const bin = process.env.OPEN_TAG_DSH_BIN || "dsh";
    const token = randomBytes(16).toString("hex"); // per-spawn secret; opentag/auth echoes it back
    const env = { ...process.env };
    delete env.NODE_OPTIONS; // same proxy-flag gotcha runList guards against
    let proc: ChildProcess;
    try {
      proc = spawn(bin, ["--profile", "opentag", "--opentag-auth-token", token], { stdio: ["pipe", "pipe", "pipe"], env, windowsHide: true });
    } catch {
      return resolve(null);
    }
    const pending = new Map<number, (m: any) => void>();
    let nextId = 1;
    let done = false;
    const finish = (v: DiscoveredModel[] | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { proc.kill(); } catch { /* already gone */ }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const write = (msg: unknown): boolean => {
      try { proc.stdin?.write(JSON.stringify(msg) + "\n"); return true; } catch { return false; }
    };
    createInterface({ input: proc.stdout! }).on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: any;
      try { msg = JSON.parse(trimmed); } catch { return; } // stdout pollution (banners) — ignore
      if (msg?.method !== undefined && msg?.id !== undefined) {
        // server→client request (session/request_permission, fs reads…): a probe implements nothing;
        // method-not-found so the agent never blocks on us (same answer the smoke client gives).
        write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "open-tag probe client" } });
        return;
      }
      if (msg?.id === undefined || msg?.method !== undefined) return; // notification (session/update…) — not a response
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    });
    proc.on("error", () => finish(null)); // spawn ENOENT (no dsh, bad OPEN_TAG_DSH_BIN)
    proc.on("exit", () => finish(null)); // died before session/new answered
    const request = (method: string, params: unknown): Promise<any> =>
      new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, res);
        if (!write({ jsonrpc: "2.0", id, method, params })) { pending.delete(id); rej(new Error("dsh stdin closed")); }
        // No per-request timer: the single deadline above kills the process, and either the response
        // arrives or "exit" settles the whole probe null.
      });
    void (async () => {
      try {
        await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
        await request("authenticate", { methodId: "opentag" });
        await request("opentag/auth", { token });
        await request("opentag/setSystemPrompt", { text: DSH_PROBE_PROMPT });
        const sessionNew = await request("session/new", { cwd: tmpdir(), mcpServers: [] });
        const models = parseDshConfigOptions(sessionNew);
        if (!models.length) return finish(null);
        write({ jsonrpc: "2.0", id: nextId++, method: "session/close", params: { sessionId: sessionNew?.result?.sessionId } }); // best-effort cleanup
        proc.stdin?.end(); // profile exits on EOF (same graceful end as the smoke client)
        finish(models);
      } catch {
        finish(null);
      }
    })();
  });
}

// Probe the live model list for a runtime on this machine. Returns null for runtimes we can't probe
// (claude/codex/copilot/kimi) or when the probe yields nothing — the caller falls back to a static
// list. Never throws; a missing CLI surfaces as the spawn "error" event → empty output → null.
export async function listModels(runtime: string): Promise<DiscoveredModel[] | null> {
  switch (runtime) {
    case "opencode": {
      // Two attempts share the server's probe budget: verbose first, then a quick non-verbose retry.
      // 5s + 2s stays under runtimeModels' 8s WS-RPC timeout so the server never waits on a probe it
      // already gave up on (the retry hits a now-warm CLI, so 2s suffices).
      let r = await runList("opencode", ["models", "--verbose"], 5_000);
      let models = parseOpencodeModels(r.stdout);
      if (!models.length) { r = await runList("opencode", ["models"], 2_000); models = parseOpencodeModels(r.stdout); }
      return models.length ? models : null;
    }
    case "cursor": {
      const r = await runList("cursor-agent", ["--list-models"]);
      const models = parseCursorModels(r.stdout);
      return models.length ? models : null;
    }
    case "pi": {
      const r = await runList("pi", ["--list-models"]);
      const models = parsePiModels(r.stdout || r.stderr); // older pi writes the list to stderr
      return models.length ? models : null;
    }
    case "claude": {
      const r = await runList("claude", ["--help"]);
      const superset = parseClaudeEffortLevels(r.stdout || r.stderr);
      if (!superset.length) return null; // no effort info → static fallback (no thinking)
      return CLAUDE_MODELS.map((m) => {
        const thinking = claudeThinkingForModel(m.id, superset); // per-model effort subset, not the flat superset
        return { ...m, provider: "anthropic", ...(thinking ? { thinking } : {}) };
      });
    }
    case "codex": {
      const r = await runList("codex", ["debug", "models"]);
      const models = parseCodexModels(r.stdout);
      return models.length ? models : null;
    }
    case "reasonix": {
      const r = await runList("reasonix", ["doctor", "--json"]);
      const models = parseReasonixModels(r.stdout || r.stderr);
      return models.length ? models : null;
    }
    case "hermes": {
      const profiles = discoverHermesProfiles();
      return profiles.length ? profiles : null;
    }
    case "dsh": {
      // ACP handshake probe — the budget override above keeps it alive long enough for the harness
      // to boot and answer session/new (server-side pair: PROBE_BUDGET_MS.dsh = 30s).
      const models = await probeDshModels(LIST_BUDGET_MS[runtime] ?? LIST_TIMEOUT_MS);
      return models?.length ? models : null;
    }
    default:
      return null;
  }
}
