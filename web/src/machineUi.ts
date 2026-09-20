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
// Placeholders: {origin} and {key}. Blank/unset falls back to the @latest-pinned npm command.
export const DEFAULT_DAEMON_COMMAND = "npx @fancyboi999/open-tag-daemon@latest --server-url {origin} --api-key {key}";
export const KEY_PLACEHOLDER = "<your sk_machine_... key>";

function renderDaemonCommand(template: string | null | undefined, origin: string, key: string): string {
  const tpl = typeof template === "string" && template.trim() ? template : DEFAULT_DAEMON_COMMAND;
  return tpl.split("{origin}").join(origin).split("{key}").join(key);
}

export function daemonUpdateCommandTemplate(origin: string, template?: string | null): string {
  return renderDaemonCommand(template, origin, KEY_PLACEHOLDER);
}

// The runnable connect command with a real machine key filled in (the connect-computer wizard has the
// freshly-minted key; daemonUpdateCommandTemplate keeps a placeholder for the key-not-shown update flow).
export function daemonConnectCommand(origin: string, key: string, template?: string | null): string {
  return renderDaemonCommand(template, origin, key);
}
