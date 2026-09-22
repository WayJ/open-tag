// CLI-side --attach argument normalization (src/cli/attach.ts).
//
// Regression lock for tech-debt I123: with a non-variadic option, commander
// silently kept only the LAST `--attach` repeat, so `--attach a --attach b`
// dropped attachment `a` and agents read it as "multi-attach unsupported".
// The flag is now variadic (`--attach <ids...>`); attachmentIdsFrom merges
// repeats AND still accepts the legacy single comma-separated string.
//
// Run: JWT_SECRET=x DAEMON_BOOTSTRAP_KEY=y npx tsx --test --test-force-exit test/cliAttach.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { attachmentIdsFrom } from "../src/cli/attach.ts";

test("repeated variadic flags merge (the I123 regression)", () => {
  assert.deepEqual(attachmentIdsFrom(["a", "b"]), ["a", "b"]);
});

test("comma-separated entries split, single-string shape still accepted", () => {
  assert.deepEqual(attachmentIdsFrom("a,b,c"), ["a", "b", "c"]);
  assert.deepEqual(attachmentIdsFrom(["a", "b,c"]), ["a", "b", "c"]);
});

test("trims whitespace and drops empties", () => {
  assert.deepEqual(attachmentIdsFrom([" a , b", "", ",,"]), ["a", "b"]);
  assert.deepEqual(attachmentIdsFrom(undefined), []);
  assert.deepEqual(attachmentIdsFrom(""), []);
});

test("dedupes repeated ids", () => {
  assert.deepEqual(attachmentIdsFrom(["a", "a,b"]), ["a", "b"]);
});

test("end-to-end: commander variadic option feeds the helper (same spec as message send)", () => {
  const p = new Command().option("--attach <ids...>");
  p.parse(["node", "x", "--attach", "a", "--attach", "b,c"]);
  assert.deepEqual(attachmentIdsFrom(p.opts().attach), ["a", "b", "c"]);
});
