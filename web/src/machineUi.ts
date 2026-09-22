export interface MachineVersionState {
  status?: string;
  daemonVersion?: string;
}

export function isDaemonOutdated(current: string | undefined, latest: string | undefined): boolean {
  const cur = parseSemver(current);
  const next = parseSemver(latest);
  if (!cur || !next) return false;
  for (let i = 0; i < 3; i++) {
    if (cur[i]! < next[i]!) return true;
    if (cur[i]! > next[i]!) return false;
  }
  return false;
}

function parseSemver(v: string | undefined): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v ?? "");
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function isDaemonUpdateAvailable(machine: MachineVersionState | null | undefined, latestDaemonVersion: string): boolean {
  return !!machine
    && machine.status === "online"
    && isDaemonOutdated(machine.daemonVersion, latestDaemonVersion);
}

// Optional server-provided override (env OPEN_TAG_DAEMON_CMD_TEMPLATE) — local checkouts ahead of the
// npm package use it to surface a runnable command (e.g. `npx tsx <repo>/src/daemon/index.ts …`).
// Placeholders: {origin} and {key}. Blank/unset falls through to the server-bundle platform commands
// when the server distributes the daemon bundle, and finally to this @latest-pinned npm command
// (the fallback when the bundle is unavailable — e.g. a server built without the bundle on disk).
export const DEFAULT_DAEMON_COMMAND = "npx @fancyboi999/open-tag-daemon@latest --server-url {origin} --api-key {key}";
export const KEY_PLACEHOLDER = "<your sk_machine_... key>";

// Server-distributed bundle commands (GET {origin}/daemon/cli.mjs): download once, run with node —
// no npm round-trip, and the daemon version always matches the server. Same {origin}/{key} placeholders
// as any other template, rendered by renderDaemonCommand.
const BUNDLE_CMD_BASH = "curl -fsSL {origin}/daemon/cli.mjs -o /tmp/open-tag-daemon.mjs && node /tmp/open-tag-daemon.mjs --server-url {origin} --api-key {key}";
const BUNDLE_CMD_POWERSHELL = "Invoke-WebRequest -Uri {origin}/daemon/cli.mjs -OutFile $env:TEMP\\open-tag-daemon.mjs; node \"$env:TEMP\\open-tag-daemon.mjs\" --server-url {origin} --api-key {key}";

function renderDaemonCommand(template: string | null | undefined, origin: string, key: string): string {
  const tpl = typeof template === "string" && template.trim() ? template : DEFAULT_DAEMON_COMMAND;
  return tpl.split("{origin}").join(origin).split("{key}").join(key);
}

// What the UI renders to install/run a daemon: either one custom command string (env template override,
// or the npx fallback) or per-platform commands that download the server-distributed bundle.
export type DaemonCommandSet =
  | { kind: "custom"; command: string }
  | { kind: "platform"; bash: string; powershell: string };

function buildDaemonCommandSet(origin: string, key: string, opts: { template?: string | null; bundleAvailable?: boolean }): DaemonCommandSet {
  const template = typeof opts.template === "string" && opts.template.trim() ? opts.template : null;
  if (template) return { kind: "custom", command: renderDaemonCommand(template, origin, key) };
  if (opts.bundleAvailable) return {
    kind: "platform",
    bash: renderDaemonCommand(BUNDLE_CMD_BASH, origin, key),
    powershell: renderDaemonCommand(BUNDLE_CMD_POWERSHELL, origin, key),
  };
  return { kind: "custom", command: renderDaemonCommand(DEFAULT_DAEMON_COMMAND, origin, key) };
}

// The connect command set with a real machine key filled in (the connect-computer wizard has the
// freshly-minted key; daemonUpdateCommands keeps a placeholder for the key-not-shown update flow).
export function daemonConnectCommands(origin: string, key: string, opts: { template?: string | null; bundleAvailable?: boolean }): DaemonCommandSet {
  return buildDaemonCommandSet(origin, key, opts);
}

export function daemonUpdateCommands(origin: string, opts: { template?: string | null; bundleAvailable?: boolean }): DaemonCommandSet {
  return buildDaemonCommandSet(origin, KEY_PLACEHOLDER, opts);
}
