import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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

test("wiring contract: store lazy-caches per channel and wipes on members-updated; Composer fails closed", () => {
  const store = fs.readFileSync(new URL("../web/src/store.tsx", import.meta.url), "utf8");
  const composer = fs.readFileSync(new URL("../web/src/views/Composer.tsx", import.meta.url), "utf8");
  assert.match(store, /mentionCandidatesByChannel/, "per-channel cache in store (survives Composer remounts)");
  assert.match(store, /channel:members-updated[\s\S]{0,200}putMentionCandidates\(\{\}\)/, "any membership change wipes the WHOLE cache (thread pools derive from parent members)");
  assert.match(composer, /filterMentionCandidates\(/, "candidates come from the cached server pool");
  assert.doesNotMatch(composer, /\.\.\.agents\.map\(\(a\) => \(\{ name: a\.name/, "no workspace-wide candidate map remains");
  assert.doesNotMatch(composer, /\.\.\.humans\.map\(/, "no whole-workspace humans map remains");
});
