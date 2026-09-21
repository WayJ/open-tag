// Unit tests for knowledge-base pure helpers (no DB imports; run in isolation).
// Run: npx tsx --test --test-force-exit test/knowledge.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildSearchText, escapeLike, makeSnippet, KNOWLEDGE_TITLE_MAX, KNOWLEDGE_CONTENT_MAX } from "../src/server/knowledge.ts";

test("buildSearchText composes title + blank line + content", () => {
  assert.equal(buildSearchText("T", "C"), "T\n\nC");
});
test("escapeLike escapes LIKE wildcards and the escape char", () => {
  assert.equal(escapeLike("100%_a\\b"), "100\\%\\_a\\\\b");
});
test("makeSnippet centers the hit with radius ellipses", () => {
  const s = makeSnippet("x".repeat(100) + "NEEDLE" + "y".repeat(100), "needle", 10);
  assert.ok(s.startsWith("…") && s.endsWith("…") && s.includes("NEEDLE"));
  assert.ok(!s.includes("NEEDLENEEDLE"));
});
test("makeSnippet hit at start/end: no leading/trailing ellipsis", () => {
  assert.equal(makeSnippet("NEEDLE tail", "needle", 3), "NEEDLE ta…");
  assert.equal(makeSnippet("head NEEDLE", "needle", 3), "…ead NEEDLE");
});
test("makeSnippet no hit: head truncation only", () => {
  assert.equal(makeSnippet("abcdefgh", "zz", 3), "abcdefg".slice(0, 6) + "…");
});
test("makeSnippet CJK counts chars not bytes", () => {
  const s = makeSnippet("前" + "数" + "据库设计很重要".slice(0, 3) + "NEEDLE尾", "needle", 5);
  assert.ok(s.includes("NEEDLE") && s.length < 20);
});
test("limits: title 200, content 32KB", () => {
  assert.equal(KNOWLEDGE_TITLE_MAX, 200);
  assert.equal(KNOWLEDGE_CONTENT_MAX, 32 * 1024);
});
