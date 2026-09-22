// Unit test: daemon bundle HTTP serving (the logic behind public GET/HEAD /daemon/cli.mjs and
// /daemon/agent-cli.mjs) plus the server-generated install scripts behind GET /daemon/install.sh
// and /daemon/install.ps1. Pure functions with injectable paths — no DB, no server, no built bundle
// required (packages/daemon/dist/* is gitignored, so tests must not depend on it).
// Run: npx tsx --test --test-force-exit test/daemonBundle.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { serveDaemonBundleFrom, daemonBundlePath, daemonBundleExists, DAEMON_BUNDLE_PATH, DAEMON_AGENT_CLI_PATH, installSh, installPs1, shQuote, psQuote, serveDaemonInstallScript } from "../src/server/daemonBundle.ts";

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

// ── Server-generated install scripts (GET /daemon/install.sh|install.ps1?server=&key=) ──
// The script embeds the requester's origin+key, so quoting must keep hostile-looking values
// (quotes, spaces, &) inert inside single-quoted words in both sh and PowerShell.

test("shQuote / psQuote: wrap in single quotes, escaping embedded quotes the way each shell parses", () => {
  assert.equal(shQuote("plain"), "'plain'");
  assert.equal(shQuote("sk'ab c&d"), "'sk'\\''ab c&d'"); // ' → '\'' — the only escape sh single quotes need
  assert.equal(psQuote("plain"), "'plain'");
  assert.equal(psQuote("sk'ab c&d"), "'sk''ab c&d'"); // ' → '' — PowerShell doubling
});

test("installSh: embeds origin (as download URLs + --server-url) and key inside single quotes", () => {
  const sh = installSh("https://x.test", "sk_machine_abc");
  assert.ok(sh.startsWith("#!/bin/sh\n"));
  assert.ok(sh.includes("set -e"));
  assert.ok(sh.includes('DIR="$HOME/.open-tag/daemon"'), "must install into ONE stable dir");
  assert.ok(sh.includes('mkdir -p "$DIR"'));
  assert.ok(sh.includes('curl -fsSL -o "$DIR/cli.mjs" \'https://x.test/daemon/cli.mjs\''));
  assert.ok(sh.includes('curl -fsSL -o "$DIR/agent-cli.mjs" \'https://x.test/daemon/agent-cli.mjs\''));
  assert.ok(sh.includes("exec node \"$DIR/cli.mjs\" --server-url 'https://x.test' --api-key 'sk_machine_abc'"));
});

test("installPs1: embeds origin and key inside single quotes", () => {
  const ps1 = installPs1("https://x.test", "sk_machine_abc");
  assert.ok(ps1.includes("$ErrorActionPreference = 'Stop'"));
  assert.ok(ps1.includes("$Dir = Join-Path $env:USERPROFILE '.open-tag\\daemon'"), "must install into ONE stable dir");
  assert.ok(ps1.includes("New-Item -Force -ItemType Directory $Dir | Out-Null"));
  assert.ok(ps1.includes("Invoke-WebRequest -UseBasicParsing -Uri 'https://x.test/daemon/cli.mjs' -OutFile (Join-Path $Dir 'cli.mjs')"));
  assert.ok(ps1.includes("Invoke-WebRequest -UseBasicParsing -Uri 'https://x.test/daemon/agent-cli.mjs' -OutFile (Join-Path $Dir 'agent-cli.mjs')"));
  assert.ok(ps1.includes("& node (Join-Path $Dir 'cli.mjs') --server-url 'https://x.test' --api-key 'sk_machine_abc'"));
});

test("installers keep injection-shaped values inert: quote/space/& values stay one quoted word", () => {
  const sh = installSh("https://x.test/a&b", "k'y sp&ce");
  // The escaped form 'k'\''y sp&ce' parses back to the literal k'y sp&ce — one single-quoted word,
  // so the space can't split args and & can't background a command.
  assert.ok(sh.includes("--api-key 'k'\\''y sp&ce'"));
  assert.ok(sh.includes("--server-url 'https://x.test/a&b'"));
  const ps1 = installPs1("https://x.test/a&b", "k'y sp&ce");
  // PS doubling: 'k''y sp&ce' parses back to the literal k'y sp&ce inside one quoted argument.
  assert.ok(ps1.includes("--api-key 'k''y sp&ce'"));
  assert.ok(ps1.includes("--server-url 'https://x.test/a&b'"));
});

test("install endpoint: missing server or key query param → handled, 400 JSON (sendErr shape)", () => {
  for (const qs of ["", "?server=https://x.test", "?key=sk_machine_abc"]) {
    const { res, getStatus, getBody, getHeaders } = makeRes();
    const handled = serveDaemonInstallScript(res, new URL(`http://x/daemon/install.sh${qs}`), "sh");
    assert.equal(handled, true);
    assert.equal(getStatus(), 400);
    assert.ok(String(getHeaders()["content-type"]).startsWith("application/json"), `qs=${qs}`);
    const parsed = JSON.parse(getBody()) as { error?: string };
    assert.equal(typeof parsed.error, "string");
    assert.ok(parsed.error!.length > 0);
  }
});

test("install endpoint (sh): both params present → 200, text/x-shellscript, no-store, body = installSh", () => {
  const { res, getStatus, getBody, getHeaders } = makeRes();
  const url = new URL("http://x/daemon/install.sh?server=https%3A%2F%2Fx.test&key=sk_machine_abc");
  const handled = serveDaemonInstallScript(res, url, "sh");
  assert.equal(handled, true);
  assert.equal(getStatus(), 200);
  assert.ok(String(getHeaders()["content-type"]).startsWith("text/x-shellscript"));
  assert.equal(getHeaders()["cache-control"], "no-store");
  assert.equal(getBody(), installSh("https://x.test", "sk_machine_abc"));
});

test("install endpoint (ps1): both params present → 200, text/x-powershell, no-store, body = installPs1", () => {
  const { res, getStatus, getBody, getHeaders } = makeRes();
  const url = new URL("http://x/daemon/install.ps1?server=https%3A%2F%2Fx.test&key=sk_machine_abc");
  const handled = serveDaemonInstallScript(res, url, "ps1");
  assert.equal(handled, true);
  assert.equal(getStatus(), 200);
  assert.ok(String(getHeaders()["content-type"]).startsWith("text/x-powershell"));
  assert.equal(getHeaders()["cache-control"], "no-store");
  assert.equal(getBody(), installPs1("https://x.test", "sk_machine_abc"));
});
