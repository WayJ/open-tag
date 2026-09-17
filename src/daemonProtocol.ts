// Shared daemon ↔ server control-plane protocol — WebSocket constants AND the managed-memory
// serialization/digest contract. Imported by BOTH src/server/* and src/daemon/* so the two planes
// can never drift on the wire contract. See ARCHITECTURE.md "Control plane is always the backbone".
import { createHash } from "node:crypto";

// WS close code (RFC 6455 §7.4.2 private range 4000–4999) the server sends when it cannot authenticate or
// identify a machine: an unknown key, or a key whose machine row was deleted or rotated via …/reconnect.
// This is a permanent rejection, not a transient drop — retrying the same key can never succeed — so the
// daemon backs off to its cap and surfaces an actionable error instead of reconnecting once a second forever.
export const MACHINE_REJECTED_CODE = 4001;

// A daemon advertising this in its ready frame uses the two-phase ready/admitted barrier: the server
// durably opens the recipient inbox before the daemon writes the Turn notification into the runtime.
export const DELIVERY_ADMISSION_CAPABILITY = "delivery-admission-v2";

// A daemon advertising this capability acknowledges agent lifecycle RPCs only after the requested
// start/stop/reset operation has settled. Servers use it to avoid reporting a successful reset while
// workspace cleanup is still running on an older fire-and-forget daemon.
export const AGENT_CONTROL_ACK_CAPABILITY = "agent-control-ack-v1";
/** Daemon can canonicalize a machine-local project directory and separate runtime cwd from agent state. */
export const PROJECT_DIRECTORY_CAPABILITY = "project-directory-v2";
/** Daemon can expose an allowlisted, metadata-only project directory picker over machine-targeted RPC. */
export const PROJECT_BROWSER_CAPABILITY = "project-browser-v1";

// ── Managed memory sync (agent MEMORY.md / personality.md / notes/) ──────────────────────────
// The daemon owns the agent's managed-memory files on disk; the server stores the latest snapshot
// (jsonb, one row per agent). Both sides compute the same canonical serialization + digest so a
// single equality check decides pull/push/skip. The separator is the literal SOH byte (U+0001),
// written as the backslash-u0001 escape — never paste a raw control byte into this file.

// One agent's managed-memory snapshot is small markdown, stored inline as path → content.
// Keys are relative paths under the agent workspace, matched against this whitelist.
const MEMORY_PATH_RE = /^(MEMORY\.md|personality\.md|notes\/[A-Za-z0-9_.\-]+\.md)$/;

// Canonical-serialization separator: the literal SOH byte (U+0001), written in source as the
// escape sequence backslash-u0001 — never paste a raw control byte into this file.
const SEP = "\u0001";

/** Max total size (UTF-8 bytes) of one snapshot's file contents. */
const MEMORY_MAX_TOTAL_BYTES = 512 * 1024;
/** Max number of files in one snapshot. */
const MEMORY_MAX_FILES = 64;

// Compare two strings by their UTF-8 byte sequence (JS default sort is UTF-16 code-unit order,
// which diverges for astral code points — the canonical form must be byte-order stable).
function utf8ByteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Canonical serialization of a managed-memory snapshot: keys sorted by UTF-8 byte order,
 * each entry as path + SEP + content + SEP (SEP = backslash-u0001), concatenated. Contents are used
 * verbatim (CRLF / trailing newlines preserved). Shared by server and daemon — never
 * reimplement this on one side only.
 */
export function canonicalMemoryFiles(files: Record<string, string>): string {
  return Object.entries(files)
    .sort(([a], [b]) => utf8ByteCompare(a, b))
    .map(([path, content]) => `${path}${SEP}${content}${SEP}`)
    .join("");
}

/** sha256 hex digest of the canonical serialization — the snapshot's identity. */
export function memoryFilesDigest(files: Record<string, string>): string {
  return createHash("sha256").update(canonicalMemoryFiles(files), "utf8").digest("hex");
}

/** Digest of the empty snapshot — what a freshly-created (never-uploaded) server row holds. */
export const EMPTY_MEMORY_DIGEST = memoryFilesDigest({});

/**
 * Validate a snapshot against the managed-memory file whitelist and size limits.
 * Returns `{ ok: true }` or `{ ok: false, reason }` — reason strings are stable protocol values.
 */
export function validateMemoryFiles(
  files: Record<string, string>,
): { ok: true } | { ok: false; reason: string } {
  if (Object.keys(files).length > MEMORY_MAX_FILES) return { ok: false, reason: "too-many-files" };
  let totalBytes = 0;
  for (const [path, content] of Object.entries(files)) {
    if (!MEMORY_PATH_RE.test(path)) return { ok: false, reason: `invalid-path:${path}` };
    totalBytes += Buffer.byteLength(content, "utf8");
    if (totalBytes > MEMORY_MAX_TOTAL_BYTES) return { ok: false, reason: "too-large" };
  }
  return { ok: true };
}

/**
 * Pure restore decision given the local files and the server row's digest.
 * - no server row → skip (nothing to sync against)
 * - server row is empty → skip (server never had a snapshot; local wins by default)
 * - digests equal → skip (states 1–3 collapse: already in sync)
 * - differ + local empty → pull and write server files in place (local has nothing to lose)
 * - differ + local non-empty → pull and run the merge/import path (both sides have content)
 */
export type MemoryRestoreDecision =
  | { action: "skip"; reason: "no-server-row" | "server-empty" | "in-sync" }
  | { action: "pull"; then: "restoreInPlace" | "import" };

export function decideMemoryRestore(
  localFiles: Record<string, string>,
  serverDigest?: string,
): MemoryRestoreDecision {
  if (serverDigest === undefined) return { action: "skip", reason: "no-server-row" };
  if (serverDigest === EMPTY_MEMORY_DIGEST) return { action: "skip", reason: "server-empty" };
  if (serverDigest === memoryFilesDigest(localFiles)) return { action: "skip", reason: "in-sync" };
  if (Object.keys(localFiles).length === 0) return { action: "pull", then: "restoreInPlace" };
  return { action: "pull", then: "import" };
}
