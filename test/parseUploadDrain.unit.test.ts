// Regression: parseUpload must REJECT (not hang forever) when storage fails mid-upload.
//
// Bug (introduced with the sniff Transform tee): stream.pipe(sniffed) sends upload bytes
// through a Transform before saveObject. If saveObject rejects before consuming (S3
// misconfig, mkdir EACCES, ENOSPC mid-write), the old `stream.resume()` drain can no
// longer flush the source — the Transform's readable side has no consumer, backpressure
// pauses the source at the 16KB highWaterMark, busboy never emits "close", and the
// parseUpload promise never settles: the HTTP request hangs until client timeout and
// leaks a socket + pending promise per retry. Fix: destroy the sniffed Transform in the
// catch (unpipes, releasing backpressure), then resume the source.
//
// This test forces saveObject to fail pre-consume by pointing OPEN_TAG_HOME at an
// existing FILE (uploadsDir() becomes un-mkdir-able), streams ~100KB through, and
// requires parseUpload to settle (rejection) within the per-test timeout. Pre-fix it
// times out (hang); post-fix it rejects in milliseconds.
//
// Run: npx tsx --test --test-force-exit test/parseUploadDrain.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("parseUpload rejects when storage fails (drain not stalled by sniff tee)", { timeout: 4000 }, async () => {
  process.env.JWT_SECRET ??= "x";
  process.env.DAEMON_BOOTSTRAP_KEY ??= "y";
  // OPEN_TAG_HOME points at a FILE → uploadsDir() mkdir fails inside saveObject.
  const jail = mkdtempSync(path.join(tmpdir(), "ot-drain-"));
  const blocker = path.join(jail, "blocker");
  writeFileSync(blocker, "not a directory");
  process.env.OPEN_TAG_HOME = blocker;

  const { parseUpload } = await import("../src/server/attachments.ts");

  // Minimal multipart body: one file part with ~160KB payload delivered in 8KB chunks —
  // multi-chunk matters: a single big chunk never backpressures the Transform (the source
  // has nothing left to pause), while chunked delivery stalls it at the 16KB highWaterMark.
  const boundary = "----otdrain";
  const chunks: Buffer[] = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="big.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    ...Array.from({ length: 20 }, () => Buffer.alloc(8 * 1024, 0x61)),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];
  const req = Readable.from(chunks) as any;
  req.headers = { "content-type": `multipart/form-data; boundary=${boundary}` };

  const t0 = Date.now();
  await assert.rejects(
    () => parseUpload(req),
    (e: unknown) => { void e; return true; }, // any rejection — we only care that it settles
  );
  assert.ok(Date.now() - t0 < 3500, "settled quickly, not via test timeout");
});
