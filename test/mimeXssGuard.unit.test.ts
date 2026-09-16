// Security regression: MIME injection → same-origin XSS via inline attachment serving.
//
// Attack: upload a file with HTML/JS content, declare Content-Type: text/html in the
// multipart part. Pre-fix, the server stores text/html verbatim and serves the download
// with Content-Type: text/html + Content-Disposition: inline → browser inline-executes
// the HTML on the same origin → XSS, steals localStorage JWT.
//
// Fix contract:
//   - sanitizeMimeType() normalises client-declared MIME before storage (strips params,
//     lowercase, rejects malformed types).
//   - safeDownloadHeaders() four-tier whitelist:
//       • SAFE_INLINE_TYPES (jpeg/png/gif/webp/pdf/audio/video): inline, no extra headers.
//       • SAFE_INLINE_WITH_CSP_TYPES (image/svg+xml): inline with declared MIME + CSP sandbox
//         (default-src 'none'; style-src 'unsafe-inline'; sandbox) so browser image elements
//         can render it but direct navigation is sandboxed (no script execution, unique origin).
//       • SANDBOXED_INLINE_TYPES (text/html, application/xhtml+xml): inline with declared MIME
//         + CSP sandbox (default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox)
//         + referrer-policy: no-referrer. The sandbox directive gives the document a unique
//         opaque origin — scripts/forms/popups blocked, no same-origin data access — so HTML
//         preview is safe both in an iframe and on direct URL navigation (GitHub-preview model).
//       • Everything else (text/javascript, text/xml, …):
//         Content-Type: application/octet-stream + Content-Disposition: attachment.
//
// These tests will FAIL before the fix (the exported functions do not exist yet),
// and PASS after.
//
// Run: npx tsx --test --test-force-exit test/mimeXssGuard.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeMimeType } from "../src/server/attachments.ts";
import { safeDownloadHeaders } from "../src/server/routes-api/attachments.ts";

// ── sanitizeMimeType ────────────────────────────────────────────────────────

test("sanitizeMimeType: strips params from declared MIME type", () => {
  assert.equal(sanitizeMimeType("text/plain; charset=utf-8"), "text/plain");
  assert.equal(sanitizeMimeType("image/jpeg; name=photo.jpg"), "image/jpeg");
});

test("sanitizeMimeType: normalises to lowercase", () => {
  assert.equal(sanitizeMimeType("TEXT/HTML"), "text/html");
  assert.equal(sanitizeMimeType("Image/PNG"), "image/png");
});

test("sanitizeMimeType: keeps well-formed types unchanged", () => {
  assert.equal(sanitizeMimeType("application/octet-stream"), "application/octet-stream");
  assert.equal(sanitizeMimeType("application/pdf"), "application/pdf");
});

test("sanitizeMimeType: falls back to octet-stream for empty input", () => {
  assert.equal(sanitizeMimeType(""), "application/octet-stream");
});

test("sanitizeMimeType: falls back to octet-stream for malformed / injection input", () => {
  assert.equal(sanitizeMimeType("not-a-mime"), "application/octet-stream");
  assert.equal(sanitizeMimeType("inject\r\nX-Header: bad"), "application/octet-stream");
  assert.equal(sanitizeMimeType("/nosubtype"), "application/octet-stream");
});

// ── safeDownloadHeaders: javascript/xml → attachment + octet-stream ────────

test("safeDownloadHeaders: text/html → inline + CSP sandbox (Tier 4, sandboxed HTML preview)", () => {
  // Supersedes the old "attachment + octet-stream" contract: the defense changed shape, not strength.
  // Scripts are blocked by CSP 'sandbox' (unique opaque origin — no access to same-origin
  // localStorage/cookies), external loads by default-src 'none'. Direct URL navigation and
  // iframe embedding are both covered (response-header CSP applies either way).
  const h = safeDownloadHeaders("text/html", "page.html");
  assert.equal(h["content-type"], "text/html",
    "Tier 4 keeps the declared content-type so the browser parses it as a document");
  assert.match(h["content-disposition"], /^inline;/,
    "Tier 4 is inline so the preview iframe renders instead of triggering a download");
  assert.match(h["content-security-policy"]!, /\bsandbox\b/,
    "CSP must include 'sandbox' — unique origin, scripts/forms/popups/top-nav all blocked");
  assert.match(h["content-security-policy"]!, /default-src 'none'/,
    "no external resource loads (scripts, sub-frames, XHR, tracking pixels)");
  assert.match(h["content-security-policy"]!, /style-src 'unsafe-inline'/,
    "inline styles must render for visual fidelity");
  assert.match(h["content-security-policy"]!, /img-src data:/,
    "embedded base64 images must render");
  // Exact pin: the tripwire against a silent relaxation (e.g. `sandbox allow-scripts
  // allow-same-origin` or `img-src data: https:`) that would still satisfy the matches above.
  assert.equal(h["content-security-policy"],
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
  assert.equal(h["referrer-policy"], "no-referrer",
    "token lives in the query string — never leak it as a referrer");
  assert.equal(h["x-content-type-options"], "nosniff");
});

test("safeDownloadHeaders: text/javascript → attachment", () => {
  const h = safeDownloadHeaders("text/javascript", "evil.js");
  assert.equal(h["content-type"], "application/octet-stream");
  assert.match(h["content-disposition"], /^attachment;/);
});

test("safeDownloadHeaders: application/javascript → attachment", () => {
  const h = safeDownloadHeaders("application/javascript", "evil.js");
  assert.equal(h["content-type"], "application/octet-stream");
  assert.match(h["content-disposition"], /^attachment;/);
});

test("safeDownloadHeaders: application/xhtml+xml → inline + CSP sandbox (Tier 4)", () => {
  const h = safeDownloadHeaders("application/xhtml+xml", "page.xhtml");
  assert.equal(h["content-type"], "application/xhtml+xml");
  assert.match(h["content-disposition"], /^inline;/);
  assert.match(h["content-security-policy"]!, /\bsandbox\b/);
  assert.match(h["content-security-policy"]!, /default-src 'none'/);
  assert.equal(h["content-security-policy"],
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
  assert.equal(h["referrer-policy"], "no-referrer");
});

// ── SVG: inline with CSP sandbox (avatar rendering must work; scripts must not execute) ──

test("safeDownloadHeaders: image/svg+xml → inline with correct content-type (avatar renders)", () => {
  // SVG avatars are fetched by browser image elements (src="/api/attachments/<id>") — they
  // must be inline with image/svg+xml so the browser renders them as images.
  const h = safeDownloadHeaders("image/svg+xml", "avatar.svg");
  assert.equal(h["content-type"], "image/svg+xml",
    "SVG must keep its content-type so browser image elements can render it");
  assert.match(h["content-disposition"], /^inline;/,
    "SVG must be inline so browser image elements do not trigger a download dialog");
});

test("safeDownloadHeaders: image/svg+xml → CSP sandbox (no same-origin script exec on direct nav)", () => {
  // When a user navigates to the attachment URL directly, the browser renders the SVG as
  // a document. Without CSP the <script> inside would execute on the same origin.
  // The 'sandbox' directive creates a unique origin (no access to the parent page's
  // localStorage/cookies) and blocks scripts; combined with default-src 'none' it also
  // prevents external resource loads.
  const h = safeDownloadHeaders("image/svg+xml", "evil.svg");
  assert.ok(h["content-security-policy"], "CSP header must be present for SVG");
  assert.match(h["content-security-policy"]!, /\bsandbox\b/,
    "CSP must include 'sandbox' to block script execution and isolate the origin");
  assert.match(h["content-security-policy"]!, /default-src 'none'/,
    "CSP must include default-src 'none' to block external resource loads");
});

test("safeDownloadHeaders: image/svg+xml → nosniff present", () => {
  const h = safeDownloadHeaders("image/svg+xml", "icon.svg");
  assert.equal(h["x-content-type-options"], "nosniff");
});

test("safeDownloadHeaders: text/xml → attachment", () => {
  const h = safeDownloadHeaders("text/xml", "data.xml");
  assert.equal(h["content-type"], "application/octet-stream");
  assert.match(h["content-disposition"], /^attachment;/);
});

test("safeDownloadHeaders: application/xml → attachment", () => {
  const h = safeDownloadHeaders("application/xml", "data.xml");
  assert.equal(h["content-type"], "application/octet-stream");
  assert.match(h["content-disposition"], /^attachment;/);
});

test("safeDownloadHeaders: unknown/exotic type → attachment", () => {
  const h = safeDownloadHeaders("application/x-executable", "malware.exe");
  assert.equal(h["content-type"], "application/octet-stream");
  assert.match(h["content-disposition"], /^attachment;/);
});

test("safeDownloadHeaders: empty/falsy MIME → attachment + octet-stream", () => {
  const h = safeDownloadHeaders("", "file.dat");
  assert.equal(h["content-type"], "application/octet-stream");
  assert.match(h["content-disposition"], /^attachment;/);
});

// ── safeDownloadHeaders: safe image/media types remain inline ───────────────

test("safeDownloadHeaders: image/jpeg → inline (safe for display)", () => {
  const h = safeDownloadHeaders("image/jpeg", "photo.jpg");
  assert.equal(h["content-type"], "image/jpeg");
  assert.match(h["content-disposition"], /^inline;/);
});

test("safeDownloadHeaders: image/png → inline", () => {
  const h = safeDownloadHeaders("image/png", "img.png");
  assert.equal(h["content-type"], "image/png");
  assert.match(h["content-disposition"], /^inline;/);
});

test("safeDownloadHeaders: image/gif → inline", () => {
  const h = safeDownloadHeaders("image/gif", "anim.gif");
  assert.equal(h["content-type"], "image/gif");
  assert.match(h["content-disposition"], /^inline;/);
});

test("safeDownloadHeaders: image/webp → inline", () => {
  const h = safeDownloadHeaders("image/webp", "img.webp");
  assert.equal(h["content-type"], "image/webp");
  assert.match(h["content-disposition"], /^inline;/);
});

test("safeDownloadHeaders: image/avif → inline", () => {
  const h = safeDownloadHeaders("image/avif", "img.avif");
  assert.equal(h["content-type"], "image/avif");
  assert.match(h["content-disposition"], /^inline;/);
});

test("safeDownloadHeaders: application/pdf → inline", () => {
  const h = safeDownloadHeaders("application/pdf", "doc.pdf");
  assert.equal(h["content-type"], "application/pdf");
  assert.match(h["content-disposition"], /^inline;/);
});

test("safeDownloadHeaders: video/mp4 → inline", () => {
  const h = safeDownloadHeaders("video/mp4", "clip.mp4");
  assert.equal(h["content-type"], "video/mp4");
  assert.match(h["content-disposition"], /^inline;/);
});

test("safeDownloadHeaders: audio/mpeg → inline", () => {
  const h = safeDownloadHeaders("audio/mpeg", "track.mp3");
  assert.equal(h["content-type"], "audio/mpeg");
  assert.match(h["content-disposition"], /^inline;/);
});

// ── filename encoding preserved ─────────────────────────────────────────────

test("safeDownloadHeaders: filename is RFC 5987 encoded in content-disposition", () => {
  const h = safeDownloadHeaders("image/jpeg", "héllo wörld.jpg");
  assert.match(h["content-disposition"], /filename\*=UTF-8''h%C3%A9llo%20w%C3%B6rld\.jpg/);
});

// ── nosniff header always present ───────────────────────────────────────────

test("safeDownloadHeaders: x-content-type-options: nosniff on safe inline type", () => {
  const h = safeDownloadHeaders("image/jpeg", "photo.jpg");
  assert.equal(h["x-content-type-options"], "nosniff",
    "nosniff must prevent browser from sniffing a declared image/jpeg as text/html");
});

test("safeDownloadHeaders: x-content-type-options: nosniff on forced attachment type", () => {
  const h = safeDownloadHeaders("text/javascript", "evil.js");
  assert.equal(h["x-content-type-options"], "nosniff");
});
