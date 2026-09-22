// Unit test: daemon bundle HTTP serving (the logic behind public GET/HEAD /daemon/cli.mjs).
// Pure function with an injectable path — no DB, no server, no built bundle required
// (packages/daemon/dist/cli.mjs is gitignored, so tests must not depend on it).
// Run: npx tsx --test --test-force-exit test/daemonBundle.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { serveDaemonBundleFrom } from "../src/server/daemonBundle.ts";

// ── Mock res (same capture shape as test/channelAccess.integration.ts makeRes) ──
// writeHead also records the headers map so content-type / cache-control are assertable.
function makeRes(): {
  res: ServerResponse;
  getStatus: () => number;
  getBody: () => string;
  getRawBody: () => string | Buffer | undefined;
  getHeaders: () => Record<string, string>;
} {
  let status = 0;
  let raw: string | Buffer | undefined;
  let headers: Record<string, string> = {};
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    statusCode: 0,
    headersSent: false,
    setHeader(_n: string, _v: unknown) {},
    writeHead(code: number, hdrs: Record<string, string> = {}) {
      status = code;
      this.statusCode = code;
      headers = hdrs;
    },
    end(d?: string | Buffer) {
      raw = d;
      emitter.emit("finish");
    },
  }) as unknown as ServerResponse;
  return {
    res,
    getStatus: () => status,
    getBody: () => (raw === undefined ? "" : String(raw)),
    getRawBody: () => raw,
    getHeaders: () => headers,
  };
}

// ── Fixture: temp dir holding a small fake bundle ─────────────────────────────
const dir = mkdtempSync(path.join(tmpdir(), "daemonbundle-"));
const bundlePath = path.join(dir, "cli.mjs");
const missingPath = path.join(dir, "does-not-exist.mjs");
const BUNDLE_BYTES = Buffer.from("// fake daemon bundle\nconsole.log('open-tag daemon');\n");
writeFileSync(bundlePath, BUNDLE_BYTES);
test.after(() => rmSync(dir, { recursive: true, force: true }));

test("GET existing bundle: handled, 200, text/javascript, no-cache, exact file bytes", async () => {
  const { res, getStatus, getRawBody, getHeaders } = makeRes();
  const handled = await serveDaemonBundleFrom(res, bundlePath, false);
  assert.equal(handled, true);
  assert.equal(getStatus(), 200);
  assert.ok(getHeaders()["content-type"]?.startsWith("text/javascript"), `content-type was ${getHeaders()["content-type"]}`);
  assert.equal(getHeaders()["cache-control"], "no-cache");
  assert.deepEqual(getRawBody(), BUNDLE_BYTES); // body equals file bytes
});

test("GET missing bundle: handled, 404, JSON error body (sendErr shape)", async () => {
  const { res, getStatus, getBody, getHeaders } = makeRes();
  const handled = await serveDaemonBundleFrom(res, missingPath, false);
  assert.equal(handled, true);
  assert.equal(getStatus(), 404);
  assert.ok(getHeaders()["content-type"]?.startsWith("application/json"));
  const parsed = JSON.parse(getBody()) as { error?: string };
  assert.equal(typeof parsed.error, "string");
  assert.ok(parsed.error!.length > 0);
});

test("HEAD existing bundle: same 200 + headers, end() called with NO data", async () => {
  const { res, getStatus, getRawBody, getHeaders } = makeRes();
  const handled = await serveDaemonBundleFrom(res, bundlePath, true);
  assert.equal(handled, true);
  assert.equal(getStatus(), 200);
  assert.ok(getHeaders()["content-type"]?.startsWith("text/javascript"));
  assert.equal(getHeaders()["cache-control"], "no-cache");
  assert.equal(getRawBody(), undefined); // empty body on HEAD
});
