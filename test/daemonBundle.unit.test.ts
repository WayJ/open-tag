// Unit test: daemon bundle HTTP serving (the logic behind public GET/HEAD /daemon/cli.mjs and
// /daemon/agent-cli.mjs). Pure functions with injectable paths — no DB, no server, no built bundle
// required (packages/daemon/dist/* is gitignored, so tests must not depend on it).
// Run: npx tsx --test --test-force-exit test/daemonBundle.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { serveDaemonBundleFrom, daemonBundlePath, daemonBundleExists, DAEMON_BUNDLE_PATH, DAEMON_AGENT_CLI_PATH } from "../src/server/daemonBundle.ts";

// ── Mock res (same capture shape as test/channelAccess.integration.ts makeRes) ──
// writeHead also records the headers map so content-type / cache-control / content-length are assertable.
function makeRes(): {
  res: ServerResponse;
  getStatus: () => number;
  getBody: () => string;
  getRawBody: () => string | Buffer | undefined;
  getHeaders: () => Record<string, string | number>;
} {
  let status = 0;
  let raw: string | Buffer | undefined;
  let headers: Record<string, string | number> = {};
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    statusCode: 0,
    headersSent: false,
    setHeader(_n: string, _v: unknown) {},
    writeHead(code: number, hdrs: Record<string, string | number> = {}) {
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

// ── Fixture: temp dir holding small fake bundles + exists() matrix subdirs ──────
const dir = mkdtempSync(path.join(tmpdir(), "daemonbundle-"));
const bundlePath = path.join(dir, "cli.mjs");
const agentCliPath = path.join(dir, "agent-cli.mjs");
const missingPath = path.join(dir, "does-not-exist.mjs");
const BUNDLE_BYTES = Buffer.from("// fake daemon bundle\nconsole.log('open-tag daemon');\n");
const AGENT_CLI_BYTES = Buffer.from("// fake agent-side CLI\nconsole.log('open-tag');\n");
writeFileSync(bundlePath, BUNDLE_BYTES);
writeFileSync(agentCliPath, AGENT_CLI_BYTES);
// exists() matrix: a dir with only one of the two bundles is NOT distributable (the daemon resolves
// agent-cli.mjs as a sibling of itself — a lone cli.mjs breaks the agent-side `open-tag` command).
const onlyCliDir = path.join(dir, "only-cli");
const onlyAgentCliDir = path.join(dir, "only-agent-cli");
const emptyDir = path.join(dir, "empty");
mkdirSync(onlyCliDir); writeFileSync(path.join(onlyCliDir, "cli.mjs"), BUNDLE_BYTES);
mkdirSync(onlyAgentCliDir); writeFileSync(path.join(onlyAgentCliDir, "agent-cli.mjs"), AGENT_CLI_BYTES);
mkdirSync(emptyDir);
test.after(() => rmSync(dir, { recursive: true, force: true }));

test("GET existing bundle: handled, 200, text/javascript, no-cache, content-length, exact file bytes", async () => {
  const { res, getStatus, getRawBody, getHeaders } = makeRes();
  const handled = await serveDaemonBundleFrom(res, bundlePath, false);
  assert.equal(handled, true);
  assert.equal(getStatus(), 200);
  assert.ok(String(getHeaders()["content-type"]).startsWith("text/javascript"), `content-type was ${getHeaders()["content-type"]}`);
  assert.equal(getHeaders()["cache-control"], "no-cache");
  assert.equal(getHeaders()["content-length"], BUNDLE_BYTES.length);
  assert.deepEqual(getRawBody(), BUNDLE_BYTES); // body equals file bytes
});

test("GET existing agent-cli bundle: same serving behavior, its own bytes", async () => {
  const { res, getStatus, getRawBody, getHeaders } = makeRes();
  const handled = await serveDaemonBundleFrom(res, agentCliPath, false);
  assert.equal(handled, true);
  assert.equal(getStatus(), 200);
  assert.ok(String(getHeaders()["content-type"]).startsWith("text/javascript"));
  assert.equal(getHeaders()["content-length"], AGENT_CLI_BYTES.length);
  assert.deepEqual(getRawBody(), AGENT_CLI_BYTES);
});

test("GET missing bundle: handled, 404, JSON error body (sendErr shape)", async () => {
  const { res, getStatus, getBody, getHeaders } = makeRes();
  const handled = await serveDaemonBundleFrom(res, missingPath, false);
  assert.equal(handled, true);
  assert.equal(getStatus(), 404);
  assert.ok(String(getHeaders()["content-type"]).startsWith("application/json"));
  const parsed = JSON.parse(getBody()) as { error?: string };
  assert.equal(typeof parsed.error, "string");
  assert.ok(parsed.error!.length > 0);
});

test("HEAD missing bundle: same 404 as GET", async () => {
  const { res, getStatus, getBody } = makeRes();
  const handled = await serveDaemonBundleFrom(res, missingPath, true);
  assert.equal(handled, true);
  assert.equal(getStatus(), 404);
  const parsed = JSON.parse(getBody()) as { error?: string };
  assert.equal(typeof parsed.error, "string");
});

test("HEAD existing bundle: same 200 + headers (incl. content-length), end() called with NO data", async () => {
  const { res, getStatus, getRawBody, getHeaders } = makeRes();
  const handled = await serveDaemonBundleFrom(res, bundlePath, true);
  assert.equal(handled, true);
  assert.equal(getStatus(), 200);
  assert.ok(String(getHeaders()["content-type"]).startsWith("text/javascript"));
  assert.equal(getHeaders()["cache-control"], "no-cache");
  assert.equal(getHeaders()["content-length"], BUNDLE_BYTES.length); // HEAD metadata parity
  assert.equal(getRawBody(), undefined); // empty body on HEAD
});

test("default bundle paths point at packages/daemon/dist/{cli,agent-cli}.mjs as siblings", () => {
  assert.ok(DAEMON_BUNDLE_PATH.endsWith(path.join("packages", "daemon", "dist", "cli.mjs")), `path was ${DAEMON_BUNDLE_PATH}`);
  assert.ok(DAEMON_AGENT_CLI_PATH.endsWith(path.join("packages", "daemon", "dist", "agent-cli.mjs")), `path was ${DAEMON_AGENT_CLI_PATH}`);
  // Sibling invariant: the daemon resolves agent-cli.mjs NEXT TO cli.mjs, so both must share a dir.
  assert.equal(path.dirname(DAEMON_AGENT_CLI_PATH), path.dirname(DAEMON_BUNDLE_PATH));
});

test("daemonBundlePath maps each endpoint kind to its bundle file", () => {
  assert.equal(daemonBundlePath("cli"), DAEMON_BUNDLE_PATH);
  assert.equal(daemonBundlePath("agent-cli"), DAEMON_AGENT_CLI_PATH);
});

test("daemonBundleExists: true only when BOTH bundles are present in the dir", async () => {
  assert.equal(await daemonBundleExists(dir), true);
  assert.equal(await daemonBundleExists(onlyCliDir), false, "cli.mjs alone must not count as distributable");
  assert.equal(await daemonBundleExists(onlyAgentCliDir), false, "agent-cli.mjs alone must not count as distributable");
  assert.equal(await daemonBundleExists(emptyDir), false);
});
