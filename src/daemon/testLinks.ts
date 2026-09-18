// Test-only link helpers — NOT imported by any production entry, so the esbuild daemon/cli bundle
// never sees this file. Purpose: exercise the symlink-based security paths (state-dir rejection,
// workspace escape detection, root canonicalization) on Windows WITHOUT the symlink privilege.
//
// A directory junction needs no SeCreateSymbolicLinkPrivilege, yet node:lstat reports it as
// `isSymbolicLink() === true` and realpath resolves through it — exactly the signals the guards
// check — so the assertions run for real on both platforms (POSIX keeps a true symlink).
//
// File symlinks have no unprivileged Windows equivalent (a hard link is not a symlink to lstat,
// which is precisely what the MEMORY.md guards test), so linkFileSync surfaces "eperm" and the
// caller skips with a reason instead of failing.
import { symlinkSync } from "node:fs";
import * as path from "node:path";

export function linkDirSync(target: string, link: string): void {
  if (process.platform === "win32") symlinkSync(path.resolve(target), link, "junction"); // junction targets must be absolute
  else symlinkSync(target, link, "dir");
}

export type FileLinkResult = "ok" | "eperm";

export function linkFileSync(target: string, link: string): FileLinkResult {
  try {
    symlinkSync(target, link, "file");
    return "ok";
  } catch (e: any) {
    if (e?.code === "EPERM") return "eperm"; // Windows without Developer Mode / admin
    throw e;
  }
}
