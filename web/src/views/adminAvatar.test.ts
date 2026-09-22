import { test } from "node:test";
import assert from "node:assert/strict";
import { avatarInitial, avatarTone } from "./admin/avatar.ts";

test("avatarTone: stable per email, distributes over 4 tones", () => {
  assert.equal(avatarTone("you@open-tag.local"), avatarTone("you@open-tag.local"));
  const tones = new Set(["you@open-tag.local", "admin@local.com", "lao@wang.cn", "a@b.co", "c@d.ef"].map(avatarTone));
  assert.ok(tones.size >= 2 && tones.size <= 4);
  for (const t of tones) assert.ok(["g-mint", "g-lav", "g-sky", "g-peach"].includes(t));
});
test("avatarInitial: first char uppercased, tolerant of weird input", () => {
  assert.equal(avatarInitial("you@open-tag.local"), "Y");
  assert.equal(avatarInitial("老王@wang.cn"), "老");
  assert.equal(avatarInitial(""), "?");
});
