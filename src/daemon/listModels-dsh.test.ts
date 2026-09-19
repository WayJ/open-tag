// dsh dynamic model discovery: pure parser over the ACP session/new response + the budget-pair
// regression that keeps the daemon probe (LIST_BUDGET_MS.dsh) under the server WS-RPC budget
// (PROBE_BUDGET_MS.dsh) — a silent fallback to the 7s/8s defaults would empty the UI dropdown.
// Response shape ground truth:
// dsh-work-opentag/plugins/dsh-opentag-agent-runtime/tests/fixtures/session-new-response.json
// (captured live by the plugin's tools/smoke.mjs).
// Run: npx tsx --test src/daemon/listModels-dsh.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDshConfigOptions } from "./listModels.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// Trimmed live capture: model select (3 provider groups) + session-level reasoning_effort select.
const FIXTURE = {
  jsonrpc: "2.0",
  id: 5,
  result: {
    sessionId: "2fb35ef8-e91e-40a1-b83f-72fac56657a7",
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: '["deepseek-official","deepseek-v4-flash"]',
        options: [
          {
            group: "deepseek-official",
            name: "DeepSeek",
            options: [
              { value: '["deepseek-official","deepseek-v4-flash"]', name: "deepseek-v4-flash" },
              {
                value: '["deepseek-official","deepseek-v4-pro"]',
                name: "DeepSeek-V4-Pro",
                description: "Stronger agentic coding, knowledge, and difficult reasoning.",
              },
            ],
          },
          {
            group: "zai-coding-cn",
            name: "zai-coding-cn",
            options: [
              { value: '["zai-coding-cn","glm-4.6v"]', name: "GLM-4.6V" },
              { value: '["zai-coding-cn","glm-5.3-flash"]', name: "GLM-5.3-Flash" },
            ],
          },
          {
            group: "minimax-cn",
            name: "minimax-cn",
            options: [{ value: '["minimax-cn","MiniMax-M3"]', name: "MiniMax-M3" }],
          },
        ],
      },
      {
        id: "reasoning_effort",
        name: "Reasoning effort",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          { value: "off", name: "Off", description: "Use for simple tasks that do not need reasoning." },
          { value: "low", name: "Low", description: "Prefer for routine or latency-sensitive tasks." },
          { value: "high", name: "High", description: "The default balance for most tasks." },
          { value: "max", name: "Max", description: "Reserve for the hardest quality-first tasks." },
        ],
      },
    ],
  },
};

test("parseDshConfigOptions maps the captured session/new response field-for-field", () => {
  const models = parseDshConfigOptions(FIXTURE);
  assert.equal(models.length, 5);
  // currentValue marks the default; id/model come from the JSON-encoded [provider, model] pair.
  assert.deepEqual(models[0], {
    id: "deepseek-v4-flash",
    label: "deepseek-v4-flash",
    provider: "deepseek-official",
    default: true,
    thinking: {
      levels: [
        { value: "off", label: "Off", description: "Use for simple tasks that do not need reasoning." },
        { value: "low", label: "Low", description: "Prefer for routine or latency-sensitive tasks." },
        { value: "high", label: "High", description: "The default balance for most tasks." },
        { value: "max", label: "Max", description: "Reserve for the hardest quality-first tasks." },
      ],
      default: "high",
    },
  });
  assert.deepEqual(
    models.slice(1).map((m) => [m.provider, m.id, m.label]),
    [
      ["deepseek-official", "deepseek-v4-pro", "DeepSeek-V4-Pro"],
      ["zai-coding-cn", "glm-4.6v", "GLM-4.6V"],
      ["zai-coding-cn", "glm-5.3-flash", "GLM-5.3-Flash"],
      ["minimax-cn", "MiniMax-M3", "MiniMax-M3"],
    ],
  );
  // reasoning_effort is session-level: every model carries the same levels, none is default.
  assert.equal(models.every((m) => m.thinking?.default === "high"), true);
});

test("parseDshConfigOptions omits thinking when reasoning_effort is absent or not a select", () => {
  const withoutEffort = {
    result: { configOptions: [{ ...FIXTURE.result.configOptions[0] }] },
  };
  const models = parseDshConfigOptions(withoutEffort);
  assert.equal(models.length, 5);
  assert.equal(models.every((m) => m.thinking === undefined), true);

  const effortNotSelect = {
    result: { configOptions: [FIXTURE.result.configOptions[0], { id: "reasoning_effort", type: "toggle" }] },
  };
  assert.equal(parseDshConfigOptions(effortNotSelect).every((m) => m.thinking === undefined), true);
});

test("parseDshConfigOptions skips malformed model choices instead of dying", () => {
  const messy = {
    result: {
      configOptions: [
        {
          id: "model",
          type: "select",
          currentValue: '["p","keep"]',
          options: [
            "not-a-group",
            { /* no options array */ },
            {
              name: "g",
              options: [
                { value: '["p","keep"]', name: "Keep" },           // valid, also the default
                { value: "not-json", name: "Broken" },              // unparseable pair
                { value: '["p"]', name: "Short" },                  // not a 2-element pair
                { value: "[1,2]", name: "Numbers" },                // not string elements
                { value: '["p",""]', name: "Empty model" },         // empty model id
                { value: '["","m"]', name: "Empty provider" },      // empty provider
                { value: '["p","keep"]', name: "Dup" },             // duplicate → dropped
                { value: '["p","noname"]' },                        // missing label → falls back to id
              ],
            },
          ],
        },
      ],
    },
  };
  const models = parseDshConfigOptions(messy);
  assert.deepEqual(models.map((m) => m.id), ["keep", "noname"]);
  assert.equal(models[0]?.default, true);
  assert.equal(models[0]?.label, "Keep");
  assert.equal(models[1]?.label, "noname"); // label falls back to the model id
});

test("parseDshConfigOptions returns [] for empty/malformed responses", () => {
  assert.deepEqual(parseDshConfigOptions(null), []);
  assert.deepEqual(parseDshConfigOptions(undefined), []);
  assert.deepEqual(parseDshConfigOptions("nope"), []);
  assert.deepEqual(parseDshConfigOptions({}), []);
  assert.deepEqual(parseDshConfigOptions({ result: {} }), []);
  assert.deepEqual(parseDshConfigOptions({ result: { configOptions: "x" } }), []);
  assert.deepEqual(parseDshConfigOptions({ result: { configOptions: [] } }), []); // no model select
  assert.deepEqual(parseDshConfigOptions({ result: { configOptions: [{ id: "model", type: "toggle" }] } }), []);
  assert.deepEqual(parseDshConfigOptions({ result: { configOptions: [{ id: "model", type: "select", options: [] }] } }), []);
});

test("parseDshConfigOptions handles the real fixture file verbatim", () => {
  // The committed capture is the ground truth — parse the actual file, not just the trimmed copy.
  const raw = JSON.parse(readFileSync(path.join(here, "__fixtures__", "dsh-session-new.json"), "utf8"));
  const models = parseDshConfigOptions(raw);
  assert.equal(models.length, 16); // 3 deepseek + 10 zai + 3 minimax
  assert.equal(models[0]?.id, "deepseek-v4-flash");
  assert.equal(models[0]?.default, true);
  assert.equal(models.filter((m) => m.provider === "zai-coding-cn").length, 10);
  assert.equal(models.filter((m) => m.provider === "minimax-cn").length, 3);
  assert.equal(models.every((m) => m.thinking?.levels.length === 4 && m.thinking.default === "high"), true);
});

test("budget pair: daemon dsh probe (25s) stays under the server WS-RPC budget (30s)", () => {
  // Regression guard: these are source-shape checks because both maps are module-private constants.
  // If either side silently falls back to the 7s/8s default, the server gives up mid-probe and the
  // runtime-models dropdown renders the static fallback (empty for dsh).
  const daemon = readFileSync(fileURLToPath(new URL("./listModels.ts", import.meta.url)), "utf8");
  assert.match(daemon, /LIST_BUDGET_MS[^;]*\{[^}]*dsh:\s*25_000/s);
  const server = readFileSync(fileURLToPath(new URL("../server/runtimeModels.ts", import.meta.url)), "utf8");
  assert.match(server, /PROBE_BUDGET_MS[^;]*\{[^}]*dsh:\s*30_000/s);
  assert.match(server, /DYNAMIC_RUNTIMES[^;]*["']dsh["']/s);
});
