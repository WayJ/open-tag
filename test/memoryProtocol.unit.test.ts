// Unit tests for the shared memory-sync protocol module (no DB / no disk).
// Run: npx tsx --test test/memoryProtocol.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  canonicalMemoryFiles,
  memoryFilesDigest,
  EMPTY_MEMORY_DIGEST,
  validateMemoryFiles,
  decideMemoryRestore,
} from "../src/daemonProtocol.ts";

// ── canonicalMemoryFiles ─────────────────────────────────────────

test("canonicalMemoryFiles sorts keys by UTF-8 byte order", () => {
  const canonical = canonicalMemoryFiles({ "b.md": "1", "a.md": "2", "notes/z.md": "3" });
  const SEP = String.fromCharCode(1);
  const expected = ["a.md", "2", "b.md", "1", "notes/z.md", "3", ""].join(SEP);
  assert.equal(canonical, expected);
});

test("canonicalMemoryFiles separator is the literal SOH byte (U+0001)", () => {
  const canonical = canonicalMemoryFiles({ "a.md": "x" });
  assert.ok(canonical.includes("\u0001"), "expected canonical output to contain U+0001 (SOH)");
});

test("canonicalMemoryFiles preserves content verbatim (CRLF / trailing newlines untouched)", () => {
  const content = "# Title\r\n\r\nline with trailing spaces   \n";
  const canonical = canonicalMemoryFiles({ "MEMORY.md": content });
  assert.ok(canonical.includes(content), "expected content to appear verbatim in canonical output");
});

// ── memoryFilesDigest ────────────────────────────────────────────

test("memoryFilesDigest is deterministic for the same map", () => {
  const files = { "MEMORY.md": "hello", "personality.md": "world" };
  assert.equal(memoryFilesDigest(files), memoryFilesDigest(files));
});

test("memoryFilesDigest ignores JS key insertion order (jsonb trap)", () => {
  const a = memoryFilesDigest({ "MEMORY.md": "one", "notes/b.md": "two", "personality.md": "three" });
  const b = memoryFilesDigest({ "personality.md": "three", "notes/b.md": "two", "MEMORY.md": "one" });
  assert.equal(a, b, "equivalent maps with different insertion order must produce the same digest");
});

test("EMPTY_MEMORY_DIGEST pins sha256 of the empty concatenation", () => {
  const expected = createHash("sha256").update("", "utf8").digest("hex");
  assert.equal(EMPTY_MEMORY_DIGEST, expected);
  assert.equal(memoryFilesDigest({}), expected);
});

// ── validateMemoryFiles ──────────────────────────────────────────

test("validateMemoryFiles accepts the three whitelisted classes", () => {
  const ok = validateMemoryFiles({
    "MEMORY.md": "# me",
    "personality.md": "persona",
    "notes/2026-09-17.md": "note",
  });
  assert.deepEqual(ok, { ok: true });
});

test("validateMemoryFiles rejects path traversal", () => {
  const r = validateMemoryFiles({ "../evil.md": "x" });
  assert.equal(r.ok, false);
  assert.ok(typeof (r as { reason: string }).reason === "string" && (r as { reason: string }).reason.length > 0);
});

test("validateMemoryFiles rejects nested note paths", () => {
  assert.equal(validateMemoryFiles({ "notes/a/b.md": "x" }).ok, false);
});

test("validateMemoryFiles rejects non-markdown extensions", () => {
  assert.equal(validateMemoryFiles({ "x.txt": "x" }).ok, false);
});

test("validateMemoryFiles rejects non-whitelisted root-level names", () => {
  assert.equal(validateMemoryFiles({ "README.md": "x" }).ok, false);
});

test("validateMemoryFiles rejects non-ASCII subdirectory / file names", () => {
  assert.equal(validateMemoryFiles({ "notes/笔记.md": "x" }).ok, false);
  assert.equal(validateMemoryFiles({ "notes/café.md": "x" }).ok, false);
});

test("validateMemoryFiles rejects total size above 512KB", () => {
  const big = "x".repeat(300 * 1024);
  const r = validateMemoryFiles({ "MEMORY.md": big, "personality.md": big });
  assert.equal(r.ok, false);
});

test("validateMemoryFiles accepts total size at exactly 512KB", () => {
  const content = "x".repeat(512 * 1024);
  assert.deepEqual(validateMemoryFiles({ "MEMORY.md": content }), { ok: true });
});

test("validateMemoryFiles rejects more than 64 files", () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 65; i++) files[`notes/f${i}.md`] = "x";
  assert.equal(validateMemoryFiles(files).ok, false);
});

test("validateMemoryFiles accepts exactly 64 files", () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 64; i++) files[`notes/f${i}.md`] = "x";
  assert.deepEqual(validateMemoryFiles(files), { ok: true });
});

// ── decideMemoryRestore ──────────────────────────────────────────

test("no server row → skip / no-server-row", () => {
  assert.deepEqual(decideMemoryRestore({ "MEMORY.md": "x" }, undefined), {
    action: "skip",
    reason: "no-server-row",
  });
});

test("server row empty (EMPTY_MEMORY_DIGEST) → skip", () => {
  assert.deepEqual(decideMemoryRestore({ "MEMORY.md": "x" }, EMPTY_MEMORY_DIGEST), {
    action: "skip",
    reason: "server-empty",
  });
  assert.deepEqual(decideMemoryRestore({}, EMPTY_MEMORY_DIGEST), {
    action: "skip",
    reason: "server-empty",
  });
});

test("digests equal → skip (state 2: in sync)", () => {
  const files = { "MEMORY.md": "same", "notes/a.md": "note" };
  assert.deepEqual(decideMemoryRestore(files, memoryFilesDigest(files)), {
    action: "skip",
    reason: "in-sync",
  });
});

test("digests differ, local empty → pull + restoreInPlace (state 1)", () => {
  assert.deepEqual(decideMemoryRestore({}, "deadbeef"), {
    action: "pull",
    then: "restoreInPlace",
  });
});

test("digests differ, local non-empty → pull + import (state 3)", () => {
  assert.deepEqual(decideMemoryRestore({ "MEMORY.md": "local" }, "deadbeef"), {
    action: "pull",
    then: "import",
  });
});
