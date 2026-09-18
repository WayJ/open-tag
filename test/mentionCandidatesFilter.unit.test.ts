import test from "node:test";
import assert from "node:assert/strict";
import { filterMentionCandidates, handleKey } from "../web/src/lib/mentionCandidates.ts";

test("filter matches by normalized handle, members first, capped at 8, empty query matches all", () => {
  const pool = [
    { id: "a2", name: "Zed", displayName: "Zed", kind: "agent", member: false },
    { id: "a1", name: "ada", displayName: "Ada", kind: "agent", member: true },
    { id: "h1", name: "Ada-Human", displayName: "AH", kind: "human", member: true },
  ];
  const out = filterMentionCandidates(pool, "");
  assert.deepEqual(out.map((c) => c.id), ["a1", "h1", "a2"], "member:true outranks non-member regardless of name order");
  assert.equal(filterMentionCandidates(pool, "ada").length, 2);
  assert.equal(filterMentionCandidates([{ id: "x", name: "ADA", kind: "agent", member: true }], "ad").length, 1, "NFC+casefold matching");
  assert.equal(filterMentionCandidates(Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, name: `m${i}`, kind: "agent", member: true })), "").length, 8, "cap 8");
  assert.equal(handleKey("ＡＢ"), "ａｂ", "NFC+lowercase only — fullwidth is NOT folded (document the exact semantics we ship)");
});
