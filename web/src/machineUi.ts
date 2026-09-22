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

// Server-generated install scripts (GET {origin}/daemon/install.sh|install.ps1?server={origin}&key={key}):
// the server bakes origin+key into the script it returns, so the whole install is ONE pipe. The script
// downloads BOTH bundles into one stable dir (~/.open-tag/daemon — the daemon resolves agent-cli.mjs as
// a sibling of itself, so the two files must share it) and starts the daemon: no npm round-trip, version
// always matches the server. Same {origin}/{key} placeholders as any other template, rendered by
// renderDaemonCommand.
const BUNDLE_CMD_BASH = 'curl -fsSL "{origin}/daemon/install.sh?server={origin}&key={key}" | bash';
const BUNDLE_CMD_POWERSHELL = 'iwr -useb "{origin}/daemon/install.ps1?server={origin}&key={key}" | iex';

function renderDaemonCommand(template: string, origin: string, key: string): string {
  return template.split("{origin}").join(origin).split("{key}").join(key);
}

// What the UI renders to install/run a daemon: either one custom command string (env template override,
// or the npx fallback) or per-platform commands that download the server-distributed bundle.
export type DaemonCommandSet =
  | { kind: "custom"; command: string }
  | { kind: "platform"; bash: string; powershell: string };

// Shared opts for the public command builders: `template` = OPEN_TAG_DAEMON_CMD_TEMPLATE override
// (blank/null = none), `bundleAvailable` = the server's daemonBundleAvailable flag.
export type DaemonCommandOpts = { template?: string | null; bundleAvailable?: boolean };

function buildDaemonCommandSet(origin: string, key: string, opts: DaemonCommandOpts): DaemonCommandSet {
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
export function daemonConnectCommands(origin: string, key: string, opts: DaemonCommandOpts): DaemonCommandSet {
  return buildDaemonCommandSet(origin, key, opts);
}

export function daemonUpdateCommands(origin: string, opts: DaemonCommandOpts): DaemonCommandSet {
  return buildDaemonCommandSet(origin, KEY_PLACEHOLDER, opts);
}
