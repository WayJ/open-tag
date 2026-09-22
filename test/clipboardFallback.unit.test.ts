// Run: npx tsx --test --test-force-exit test/clipboardFallback.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyText } from "../web/src/lib/clipboard.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const consumers = [
  "web/src/messageRender.tsx",
  "web/src/views/Chat.tsx",
  "web/src/views/CommandTabs.tsx",
  "web/src/views/Members.tsx",
  "web/src/views/misc.tsx",
];
// Views that copy via an embedded CommandTabs instead of inline (8f63c68 extracted the copy UI).
const embedders = ["web/src/views/ConnectComputerWizard.tsx", "web/src/views/misc.tsx"];

test("copy actions share the LAN-compatible clipboard fallback", () => {
  for (const path of consumers) {
    const source = readFileSync(resolve(repo, path), "utf8");
    assert.doesNotMatch(source, /navigator\.clipboard/, `${path} bypasses the shared fallback`);
    assert.match(source, /import \{ copyText \} from ["'][^"']*lib\/clipboard(?:\.ts)?["'];/, `${path} does not import the shared fallback`);
  }

  for (const path of embedders) {
    const source = readFileSync(resolve(repo, path), "utf8");
    assert.match(source, /import \{ CommandTabs \} from ["'][^"']*CommandTabs(?:\.tsx)?["'];/, `${path} no longer embeds the shared command box`);
  }
  const cmdbox = readFileSync(resolve(repo, "web/src/views/CommandTabs.tsx"), "utf8");
  const copyAttempt = cmdbox.indexOf("if (!await copyText(command))");
  const successFeedback = cmdbox.indexOf("setCopied(true)", copyAttempt);
  assert.ok(copyAttempt >= 0 && successFeedback > copyAttempt, "command box does not await the shared copy result");
  assert.match(cmdbox.slice(copyAttempt, successFeedback), /window\.prompt[\s\S]*\breturn\b/, "command box can report success after a failed copy");
});

function installClipboardEnvironment({
  secure,
  writeText,
  execResult = true,
}: {
  secure: boolean;
  writeText?: (text: string) => Promise<void>;
  execResult?: boolean;
}) {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  };
  const calls: string[] = [];
  const textarea = {
    value: "",
    style: {} as Record<string, string>,
    setAttribute: (name: string) => calls.push(`attr:${name}`),
    focus: () => calls.push("focus"),
    select: () => calls.push("select"),
    setSelectionRange: (start: number, end: number) => calls.push(`range:${start}:${end}`),
  };
  setGlobal("navigator", writeText ? { clipboard: { writeText } } : {});
  setGlobal("window", { isSecureContext: secure });
  setGlobal("document", {
    createElement: (tag: string) => { calls.push(`create:${tag}`); return textarea; },
    body: {
      appendChild: () => calls.push("append"),
      removeChild: () => calls.push("remove"),
    },
    execCommand: (command: string) => { calls.push(`exec:${command}`); return execResult; },
  });
  return {
    calls,
    textarea,
    restore() {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as Record<string, unknown>)[name];
      }
    },
  };
}

test("copyText falls back to a hidden textarea on a plain-HTTP LAN origin", async () => {
  const env = installClipboardEnvironment({ secure: false });
  try {
    assert.equal(await copyText("daemon command"), true);
    assert.equal(env.textarea.value, "daemon command");
    assert.deepEqual(env.calls, ["create:textarea", "attr:readonly", "append", "focus", "select", "range:0:14", "exec:copy", "remove"]);
  } finally {
    env.restore();
  }
});

test("copyText falls back when the secure Clipboard API rejects", async () => {
  let attempted = "";
  const env = installClipboardEnvironment({
    secure: true,
    writeText: async (text) => { attempted = text; throw new Error("not allowed"); },
  });
  try {
    assert.equal(await copyText("retry me"), true);
    assert.equal(attempted, "retry me");
    assert.ok(env.calls.includes("exec:copy"));
    assert.equal(env.calls.at(-1), "remove");
  } finally {
    env.restore();
  }
});

test("copyText returns false when both clipboard paths fail", async () => {
  const env = installClipboardEnvironment({ secure: false, execResult: false });
  try {
    assert.equal(await copyText("copy manually"), false);
    assert.equal(env.calls.at(-1), "remove");
  } finally {
    env.restore();
  }
});

test("copyText uses the secure Clipboard API without creating a textarea", async () => {
  let copied = "";
  const env = installClipboardEnvironment({
    secure: true,
    writeText: async (text) => { copied = text; },
  });
  try {
    assert.equal(await copyText("secure copy"), true);
    assert.equal(copied, "secure copy");
    assert.deepEqual(env.calls, []);
  } finally {
    env.restore();
  }
});
