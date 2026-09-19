// Runtime registry and local detection. Concrete implementations live in claudeRuntime.ts / codexRuntime.ts / copilotRuntime.ts / opencodeRuntime.ts / kimiRuntime.ts / piRuntime.ts / cursorRuntime.ts / hermesRuntime.ts / reasonixRuntime.ts / dshRuntime.ts.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeRuntime } from "./claudeRuntime.js";
import { codexRuntime } from "./codexRuntime.js";
import { copilotRuntime } from "./copilotRuntime.js";
import { opencodeRuntime } from "./opencodeRuntime.js";
import { kimiRuntime } from "./kimiRuntime.js";
import { piRuntime } from "./piRuntime.js";
import { cursorRuntime } from "./cursorRuntime.js";
import { hermesRuntime } from "./hermesRuntime.js";
import { reasonixRuntime } from "./reasonixRuntime.js";
import { dshRuntime } from "./dshRuntime.js";
import type { Runtime } from "./runtime.js";

export type { Runtime, RuntimeSession, RuntimeCallbacks, StartOpts, TrajectoryEntry } from "./runtime.js";

function has(tool: string): boolean {
  try {
    if (process.platform === "win32") {
      execSync(`where ${tool} 2>nul`, { stdio: "pipe" });
    } else {
      execSync(`command -v ${tool}`, { stdio: "pipe" });
    }
    return true;
  } catch { return false; }
}
// dsh is gated on TWO conditions: the binary on PATH AND an opentag profile provisioned under
// DSH_HOME (default ~/.dsh) — a bare dsh install without the profile can't serve open-tag agents.
function dshHome(): string { return process.env.DSH_HOME ?? join(homedir(), ".dsh"); }
function hasDshProfile(): boolean { return existsSync(join(dshHome(), "profiles", "opentag")); }
export function detectRuntimes(): string[] {
  return ["claude", "codex", "copilot", "kimi", "opencode", "pi", "cursor-agent", "hermes", "reasonix"]
    .filter(has)
    .concat(has("dsh") && hasDshProfile() ? ["dsh"] : [])
    .map((t) => (t === "cursor-agent" ? "cursor" : t));
}

const REG: Record<string, Runtime> = { claude: claudeRuntime, codex: codexRuntime, copilot: copilotRuntime, opencode: opencodeRuntime, kimi: kimiRuntime, pi: piRuntime, cursor: cursorRuntime, hermes: hermesRuntime, reasonix: reasonixRuntime, dsh: dshRuntime };
export function getRuntime(name: string): Runtime | null { return REG[name] ?? null; }
