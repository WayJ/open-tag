// CLI-side MIME inference for attachment upload (src/cli/mime.ts).
//
// The CLI sends multipart parts as Blob + filename; undici stamps a Blob without { type }
// as application/octet-stream, which made every CLI-uploaded file a forced download on
// serve. mimeFor(name) infers a sensible Content-Type from the file extension so agent
// uploads keep their inline preview behavior (images inline, HTML → Tier 4 sandbox).
// Unknown extensions fail closed to application/octet-stream — the server-side
// magic-byte sniff (mimeSniff.unit.test.ts) remains the backstop for other clients.
//
// Run: JWT_SECRET=x DAEMON_BOOTSTRAP_KEY=y npx tsx --test --test-force-exit test/cliMime.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { mimeFor } from "../src/cli/mime.ts";

test("mimeFor: common image extensions", () => {
  assert.equal(mimeFor("photo.png"), "image/png");
  assert.equal(mimeFor("photo.jpg"), "image/jpeg");
  assert.equal(mimeFor("photo.jpeg"), "image/jpeg");
  assert.equal(mimeFor("anim.gif"), "image/gif");
  assert.equal(mimeFor("img.webp"), "image/webp");
});

test("mimeFor: documents", () => {
  assert.equal(mimeFor("report.pdf"), "application/pdf");
  assert.equal(mimeFor("notes.md"), "text/markdown");
  assert.equal(mimeFor("notes.markdown"), "text/markdown");
  assert.equal(mimeFor("page.html"), "text/html");
  assert.equal(mimeFor("page.htm"), "text/html");
  assert.equal(mimeFor("data.json"), "application/json");
  assert.equal(mimeFor("log.txt"), "text/plain");
});

test("mimeFor: case-insensitive extension, any path shape", () => {
  assert.equal(mimeFor("PHOTO.PNG"), "image/png");
  assert.equal(mimeFor("/tmp/some dir/Photo.JpG"), "image/jpeg");
  assert.equal(mimeFor("C:\\Users\\me\\Desktop\\report.pdf"), "application/pdf");
});

test("mimeFor: unknown or missing extension → application/octet-stream", () => {
  assert.equal(mimeFor("archive.zip"), "application/octet-stream");
  assert.equal(mimeFor("data.bin"), "application/octet-stream");
  assert.equal(mimeFor("noext"), "application/octet-stream");
  assert.equal(mimeFor(""), "application/octet-stream");
});

test("mimeFor: no double-dot / query tricks — only the final extension counts", () => {
  assert.equal(mimeFor("evil.png.txt"), "text/plain");
  assert.equal(mimeFor("archive.tar.gz"), "application/octet-stream");
});
