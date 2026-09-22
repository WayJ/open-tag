// Serves the self-contained daemon bundle (packages/daemon/dist/cli.mjs, built by
// scripts/build-daemon-pkg.mjs) over HTTP so target machines install from THIS server
// instead of npm. Public like /health: the bundle embeds no secrets (same trust level
// as the public npm package it replaces).
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendErr } from "./util.js";
import { createLogger } from "../log.js";

const log = createLogger("server");

export const DAEMON_BUNDLE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/daemon/dist/cli.mjs");

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

export async function serveDaemonBundle(res: import("node:http").ServerResponse, head = false): Promise<boolean> {
  return serveDaemonBundleFrom(res, DAEMON_BUNDLE_PATH, head);
}

export async function daemonBundleExists(): Promise<boolean> {
  try { await stat(DAEMON_BUNDLE_PATH); return true; } catch { return false; }
}
