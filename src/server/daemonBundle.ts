// Serves the self-contained daemon bundles (packages/daemon/dist/cli.mjs + agent-cli.mjs, built by
// scripts/build-daemon-pkg.mjs) over HTTP so target machines install from THIS server instead of
// npm. Both files must be downloaded into ONE directory: at runtime the daemon resolves the agent-side
// CLI as a sibling `agent-cli.mjs` next to itself (src/daemon/openTagBin.ts), so a lone cli.mjs would
// fall back to repo mode (npx tsx, absent on target machines) and break agents' `open-tag` command.
// Public like /health: the bundles embed no secrets (same trust level as the public npm package).
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendErr } from "./util.js";
import { createLogger } from "../log.js";

const log = createLogger("server");

export const DAEMON_BUNDLE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/daemon/dist");
export const DAEMON_BUNDLE_PATH = path.join(DAEMON_BUNDLE_DIR, "cli.mjs");
export const DAEMON_AGENT_CLI_PATH = path.join(DAEMON_BUNDLE_DIR, "agent-cli.mjs");

/** Which bundle an endpoint serves: the daemon proper (`cli`) or its agent-side CLI sibling (`agent-cli`). */
export type DaemonBundleKind = "cli" | "agent-cli";

export function daemonBundlePath(which: DaemonBundleKind): string {
  return which === "agent-cli" ? DAEMON_AGENT_CLI_PATH : DAEMON_BUNDLE_PATH;
}

/** Test seam: serve a bundle file (or 404 when absent) from an explicit path. Returns true = route handled. */
export async function serveDaemonBundleFrom(res: import("node:http").ServerResponse, filePath: string, head = false): Promise<boolean> {
  let data: Buffer;
  try { data = await readFile(filePath); }
  catch (e) {
    // ENOENT is the expected "not built here" case → plain 404; anything else (EACCES, EMFILE, …)
    // means the file exists but couldn't be read — warn so it isn't mistaken for a missing build.
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code && code !== "ENOENT") log.warn("daemon bundle read failed", { path: filePath, code });
    sendErr(res, 404, "daemon bundle not built — run npm run pkg:daemon:build on the server host");
    return true;
  }
  res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "content-length": data.length });
  res.end(head ? undefined : data);
  return true;
}

/** Endpoint entry behind GET/HEAD /daemon/cli.mjs and /daemon/agent-cli.mjs. Returns true = route handled. */
export async function serveDaemonBundle(res: import("node:http").ServerResponse, which: DaemonBundleKind, head = false): Promise<boolean> {
  return serveDaemonBundleFrom(res, daemonBundlePath(which), head);
}

/** True only when BOTH bundles stat OK (baseDir injectable for tests): a half-present pair would serve
 *  a daemon whose agent-side CLI falls back to repo mode and breaks on target machines. */
export async function daemonBundleExists(baseDir = DAEMON_BUNDLE_DIR): Promise<boolean> {
  try {
    await stat(path.join(baseDir, "cli.mjs"));
    await stat(path.join(baseDir, "agent-cli.mjs"));
    return true;
  } catch { return false; }
}
