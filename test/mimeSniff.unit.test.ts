// Magic-number MIME sniffing fallback for attachments uploaded without a usable Content-Type.
//
// Bug this fixes: the agent CLI (src/cli/index.ts) used to send every multipart part as
// application/octet-stream (Blob without { type }), so every CLI-uploaded file was stored
// octet-stream and served as a forced download (Tier 3) — no inline preview, even for PNGs.
// Third-party clients can hit the same path. Server-side fallback: when the declared/stored
// type is octet-stream, sniff a small set of unambiguous magic-byte signatures.
//
// Security contract:
//   - Sniffing only ever REPLACES "application/octet-stream" — a declared type is never
//     overridden (a client that says image/png but sends HTML keeps image/png; serve-time
//     safeDownloadHeaders() whitelist still gates everything).
//   - The sniffed set contains only types already in SAFE_INLINE_TYPES (png/jpeg/gif/pdf).
//     No text/html, no svg, no scriptable type — a wrong sniff can at worst show a broken
//     image, never execute anything.
//
// Run: JWT_SECRET=x DAEMON_BOOTSTRAP_KEY=y npx tsx --test --test-force-exit test/mimeSniff.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { sniffMimeType } from "../src/server/attachments.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from("GIF89a" + "\x00\x00\x00", "latin1");
const PDF = Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3", "latin1");
const TEXT = Buffer.from("hello world, definitely not a binary format");

// ── magic detection when stored type is octet-stream ────────────────────────

test("sniffMimeType: PNG magic → image/png", () => {
  assert.equal(sniffMimeType("application/octet-stream", PNG), "image/png");
});

test("sniffMimeType: JPEG magic → image/jpeg", () => {
  assert.equal(sniffMimeType("application/octet-stream", JPEG), "image/jpeg");
});

test("sniffMimeType: GIF magic → image/gif", () => {
  assert.equal(sniffMimeType("application/octet-stream", GIF), "image/gif");
});

test("sniffMimeType: PDF magic → application/pdf", () => {
  assert.equal(sniffMimeType("application/octet-stream", PDF), "application/pdf");
});

// ── no match / no bytes → stays octet-stream (fail-closed) ─────────────────

test("sniffMimeType: non-matching bytes → application/octet-stream", () => {
  assert.equal(sniffMimeType("application/octet-stream", TEXT), "application/octet-stream");
});

test("sniffMimeType: empty buffer → application/octet-stream", () => {
  assert.equal(sniffMimeType("application/octet-stream", Buffer.alloc(0)), "application/octet-stream");
});

test("sniffMimeType: truncated head (2 bytes of PNG) → application/octet-stream", () => {
  assert.equal(sniffMimeType("application/octet-stream", PNG.subarray(0, 2)), "application/octet-stream");
});

// ── declared type is never overridden ──────────────────────────────────────

test("sniffMimeType: declared non-octet-stream type passes through unchanged", () => {
  // Even when bytes say PNG, a client-declared type wins: we only fill the gap,
  // never second-guess an explicit declaration (serve-time whitelist still gates).
  assert.equal(sniffMimeType("text/html", PNG), "text/html");
  assert.equal(sniffMimeType("image/png", TEXT), "image/png");
  assert.equal(sniffMimeType("application/pdf", JPEG), "application/pdf");
});
