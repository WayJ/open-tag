# dsh Agent Runtime 接入 — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** open-tag 支持第 10 个 agent runtime —— DeepSeek Harness（`dsh`），经标准 ACP v1 + `opentag/*` 扩展（token 握手、协议参数注入 system prompt）。

**Architecture:** 两侧交付。dsh-work 侧：out-of-tree 插件 `dsh-opentag-agent-runtime`（自带派生 ACP server + app 启动半体，零 dsh 源码改动），装进专用 profile `opentag`。open-tag 侧：`src/daemon/dshRuntime.ts`（ACP 客户端）+ 注册/探测/模型发现/UI。system prompt 经 `opentag/setSystemPrompt` 协议参数注入，一次性、进程级；未注入时哨兵变量令 prompt assembly 失败（fail-loud）。

**Tech Stack:** TypeScript / Cordis plugin（dsh 侧）/ `@agentclientprotocol/sdk` 1.4.0 / node:test + tsx（两侧统一）/ esbuild（插件构建）。

**Spec:** `docs/superpowers/specs/2026-09-19-dsh-agent-runtime-design.md`（worktree `feature/dsh-runtime`）

**工作树：**
- open-tag：`D:\OpenSource\open-tag-dsh-runtime`（branch `feature/dsh-runtime`，已建）
- dsh-work：`D:\OpenSource\dsh-work-opentag`（branch `feature/opentag-agent-runtime`，Task 0 建；dsh-work 主检出在 `master`）

**路径约定：** 下文 `OT=` 指 open-tag worktree，`DW=` 指 dsh-work worktree。bash 形式：`/d/OpenSource/open-tag-dsh-runtime`、`/d/OpenSource/dsh-work-opentag`。

**测试运行方式（两侧统一，无 vitest）：**
- open-tag：`npx tsx --test src/daemon/<file>.test.ts`（既有惯例，见 codexRuntime.test.ts 头注释）
- 插件：`npx tsx --test tests/<file>.test.ts`（devDep tsx；纯逻辑测试不 import dsh 运行时代码）

---

## Phase 0 — dsh-work worktree 与插件脚手架

### Task 0.1: dsh-work worktree

- [ ] **Step 1:** 在 dsh-work 主检出建 worktree（从 master）：

```bash
cd /d/OpenSource/dsh-work
git worktree add ../dsh-work-opentag -b feature/opentag-agent-runtime
```

- [ ] **Step 2:** 验证：`git -C /d/OpenSource/dsh-work-opentag branch --show-current` 输出 `feature/opentag-agent-runtime`；`ls /d/OpenSource/dsh-work-opentag/plugins` 应含 brand-profile 等。

### Task 0.2: 插件包脚手架

**Files (DW):**
- Create: `plugins/dsh-opentag-agent-runtime/package.json`
- Create: `plugins/dsh-opentag-agent-runtime/tsconfig.json`
- Create: `plugins/dsh-opentag-agent-runtime/build.mjs`
- Create: `plugins/dsh-opentag-agent-runtime/LICENSE`
- Create: `plugins/dsh-opentag-agent-runtime/.gitignore`

- [ ] **Step 1:** 写 `package.json`（仿 brand-profile，host-only 无 client 半体）：

```json
{
  "name": "dsh-opentag-agent-runtime",
  "description": "open-tag dedicated agent runtime for DeepSeek Harness: derived automation-only ACP server with token-gated system-prompt injection.",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
  "scripts": {
    "build": "node build.mjs",
    "test": "tsx --test tests/*.test.ts"
  },
  "dependencies": {
    "@agentclientprotocol/sdk": "1.4.0",
    "@deepseek-ai/dsh-brand": "<已发布范围，见下>",
    "@deepseek-ai/schemastery": "^3.18.1"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-agent": "<已发布范围>",
    "@deepseek-ai/dsh-attachment": "<已发布范围>",
    "@deepseek-ai/dsh-cmdline": "<已发布范围>",
    "@deepseek-ai/dsh-llm": "<已发布范围>",
    "@deepseek-ai/dsh-mcp-client": "<已发布范围>",
    "@deepseek-ai/dsh-session": "<已发布范围>",
    "@deepseek-ai/dsh-session-persistence": "<已发布范围>",
    "@deepseek-ai/dsh-token-meter": "<已发布范围>",
    "@deepseek-ai/dsh-user-approval": "<已发布范围>",
    "commander": "<acp-app 现用范围>"
  },
  "peerDependenciesMeta": {
    "@deepseek-ai/dsh-token-meter": { "optional": true }
  },
  "devDependencies": {
    "tsx": "^4.19.0"
  },
  "files": ["lib", "src", "build.mjs", "cordis.patch.yml", "LICENSE", "README.md", "README.zh.md"],
  "license": "MIT"
}
```

注 1（依赖范围，评审 Issue 2 修正）：本插件在 dsh-work 无 workspace，`workspace:^` 协议不可解析。所有 `@deepseek-ai/*` 范围用 **brand-profile 式已发布版本范围**（形如 `>=0.1.0-rc.1 <0.2.0-0`）。取值方法：对每个包跑 `npm view <pkg> versions --json`，选覆盖本机 submodule 构建版本的最低已发布范围；`npm view` 查不到的包（未发布）记入风险闸口 6 处置（build.mjs 内联打包）。
注 2：`@deepseek-ai/dsh-brand` / `@deepseek-ai/schemastery` 是上游 dsh-acp 的 **dependencies**（非 peer），随本插件 dependencies 声明。commander 版本以 `packages/bundle/acp-app/package.json` 现值为准。

- [ ] **Step 2:** 写 `tsconfig.json`（拷 brand-profile，去 jsx）：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noImplicitAny": true,
    "skipLibCheck": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3:** 写 `build.mjs`（拷 brand-profile 的 build.mjs，只保留 host 半体，**双入口**：`src/index.ts → lib/index.js` + `src/app.ts → lib/app.js`，deps/peerDeps 全 external；见 B3 注 2）。LICENSE 放 dsh-work 根 LICENSE 同文（MIT，版权行与 dsh-work 根一致）。`.gitignore`：`node_modules/\nlib/\n`.

- [ ] **Step 4:** 提交：

```bash
cd /d/OpenSource/dsh-work-opentag/plugins/dsh-opentag-agent-runtime
git add -A && git commit -m "feat: scaffold dsh-opentag-agent-runtime plugin package"
```

---

## Phase A — 插件纯逻辑单元（TDD，零 dsh 依赖）

### Task A1: token 鉴权模块

**Files (DW):**
- Create: `src/auth.ts`
- Test: `tests/auth.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// Run: npx tsx --test tests/auth.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuthGate } from "../src/auth.ts";

test("no expected token means every call rejected", () => {
  const gate = createAuthGate(null);
  assert.equal(gate.verify("anything"), false);
  assert.equal(gate.isAuthorized(), false);
});

test("correct token authorizes exactly once, wrong token does not", () => {
  const gate = createAuthGate("a".repeat(64));
  assert.equal(gate.verify("b".repeat(64)), false);
  assert.equal(gate.isAuthorized(), false);
  assert.equal(gate.verify("a".repeat(64)), true);
  assert.equal(gate.isAuthorized(), true);
});

test("length mismatch does not throw (constant-time guard)", () => {
  const gate = createAuthGate("abc");
  assert.equal(gate.verify("abcd"), false);
});

test("verify stays idempotent after authorization", () => {
  const gate = createAuthGate("t".repeat(64));
  gate.verify("t".repeat(64));
  assert.equal(gate.verify("t".repeat(64)), true);
});
```

- [ ] **Step 2:** 运行确认失败：`npx tsx --test tests/auth.test.ts` → FAIL（模块不存在）。

- [ ] **Step 3: 最小实现**

```ts
// src/auth.ts — token gate for opentag/* extension methods.
// The expected token arrives via argv at spawn; the caller must echo it over the
// protocol before any opentag/* method is honored. Constant-time compare.
import { timingSafeEqual } from "node:crypto";

export interface AuthGate {
  verify(presented: string): boolean;
  isAuthorized(): boolean;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

export function createAuthGate(expected: string | null): AuthGate {
  let authorized = false;
  return {
    verify(presented: string): boolean {
      if (expected === null || !safeEqual(presented, expected)) return false;
      authorized = true;
      return true;
    },
    isAuthorized(): boolean {
      return authorized;
    },
  };
}
```

- [ ] **Step 4:** 测试过 → **Step 5:** 提交 `feat: token auth gate (constant-time)`。

### Task A2: prompt 哨兵门

**Files (DW):**
- Create: `src/prompt-gate.ts`
- Test: `tests/prompt-gate.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPromptGate } from "../src/prompt-gate.ts";

test("resolver is undefined before injection (assembly must fail)", () => {
  const gate = createPromptGate();
  assert.equal(gate.resolve(), undefined);
});

test("set once stores text; second set returns error", () => {
  const gate = createPromptGate();
  assert.equal(gate.set("persona text"), null);
  assert.equal(gate.resolve(), "persona text");
  assert.ok(gate.set("again") instanceof Error);
  assert.equal(gate.resolve(), "persona text");
});

test("empty or whitespace text is rejected", () => {
  const gate = createPromptGate();
  assert.ok(gate.set("") instanceof Error);
  assert.ok(gate.set("   \n") instanceof Error);
  assert.equal(gate.resolve(), undefined);
});
```

- [ ] **Step 2:** 红 → **Step 3: 实现**

```ts
// src/prompt-gate.ts — one-shot system-prompt store backing the sentinel variable.
// resolve() returning undefined makes dsh-system-prompt treat
// {{opentag_standing_prompt}} as unresolved → assembly fails loudly (P4).
export interface PromptGate {
  set(text: string): Error | null;
  resolve(): string | undefined;
  isSet(): boolean;
}

export function createPromptGate(): PromptGate {
  let stored: string | undefined;
  return {
    set(text: string): Error | null {
      if (stored !== undefined) return new Error("system prompt already set for this process");
      if (typeof text !== "string" || text.trim().length === 0) return new Error("system prompt text must be non-empty");
      stored = text;
      return null;
    },
    resolve(): string | undefined {
      return stored;
    },
    isSet(): boolean {
      return stored !== undefined;
    },
  };
}
```

- [ ] **Step 4:** 绿 → **Step 5:** 提交 `feat: one-shot prompt gate with sentinel resolution`。

### Task A3: opentag/* 方法分发策略（纯函数）

**Files (DW):**
- Create: `src/policy.ts`
- Test: `tests/policy.test.ts`

- [ ] **Step 1: 写失败测试**（矩阵）：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleOpentagCall } from "../src/policy.ts";
import { createAuthGate } from "../src/auth.ts";
import { createPromptGate } from "../src/prompt-gate.ts";

const make = () => ({ auth: createAuthGate("t".repeat(64)), prompt: createPromptGate() });

test("non-opentag methods are not governed", () => {
  const s = make();
  assert.equal(handleOpentagCall(s, "session/new"), false); // caller: handled by ACP layer
});

test("opentag/* requires auth first", () => {
  const s = make();
  const r = handleOpentagCall(s, "opentag/setSystemPrompt");
  assert.ok(r instanceof Error && /auth/i.test(r.message));
});

test("opentag/auth passes token through gate", () => {
  const s = make();
  const r = handleOpentagCall(s, "opentag/auth", { token: "t".repeat(64) });
  assert.equal(r, null);
  assert.equal(s.auth.isAuthorized(), true);
});

test("setSystemPrompt after auth stores; double set errors", () => {
  const s = make();
  handleOpentagCall(s, "opentag/auth", { token: "t".repeat(64) });
  assert.equal(handleOpentagCall(s, "opentag/setSystemPrompt", { text: "p" }), null);
  assert.ok(handleOpentagCall(s, "opentag/setSystemPrompt", { text: "p2" }) instanceof Error);
});

test("unknown opentag method errors", () => {
  const s = make();
  handleOpentagCall(s, "opentag/auth", { token: "t".repeat(64) });
  assert.ok(handleOpentagCall(s, "opentag/nope") instanceof Error);
});
```

- [ ] **Step 2:** 红 → **Step 3: 实现**

```ts
// src/policy.ts — pure dispatch policy for opentag/* extension methods.
// Returns false when the method is not an opentag/* method (caller handles it),
// null when allowed (side effects already applied), or an Error to reject with.
import type { AuthGate } from "./auth.ts";
import type { PromptGate } from "./prompt-gate.ts";

export interface OpentagState {
  auth: AuthGate;
  prompt: PromptGate;
}

export function handleOpentagCall(
  state: OpentagState,
  method: string,
  params?: { token?: string; text?: string },
): false | null | Error {
  if (!method.startsWith("opentag/")) return false;
  if (method === "opentag/auth") {
    if (typeof params?.token !== "string" || !state.auth.verify(params.token)) {
      return new Error("opentag: authentication failed");
    }
    return null;
  }
  if (!state.auth.isAuthorized()) return new Error("opentag: not authenticated");
  if (method === "opentag/setSystemPrompt") {
    if (typeof params?.text !== "string") return new Error("opentag: text parameter required");
    return state.prompt.set(params.text);
  }
  return new Error(`opentag: unknown method ${method}`);
}
```

- [ ] **Step 4:** 绿 → **Step 5:** 提交 `feat: opentag/* dispatch policy`。

---

## Phase B — 派生 server、app 半体、profile patch

### Task B1: app 启动半体（fork dsh-acp-app + token 参数）

**Files (DW):**
- Create: `src/app.ts`

参照物：`deepseek-harness/packages/bundle/acp-app/src/index.ts`（读全文，逐行理解后派生）。

- [ ] **Step 1:** 拷该文件为 `src/app.ts`，做且仅做以下修改：
  1. 文件头加派生声明注释（来源包名、上游 MIT、fork 日期）
  2. `name` 改 `'opentag-app-startup'`
  3. service 常量改并导出 `OPENTAG_APP_STARTUP_SERVICE = 'opentagAppStartup'`
  4. command 改名 `dsh --profile opentag`，description 改 open-tag 专用描述
  5. command 增加必选 option：`.requiredOption('--opentag-auth-token <hex>', 'per-spawn token the daemon must echo via opentag/auth')`
  6. action 内 `exitOnStdinEnd(ctx, 'opentag-app.stdin')` + `ctx.provide(OPENTAG_APP_STARTUP_SERVICE, { accepted: true })` —— service 仅承担 stdio claim 顺序依赖；**token 权威路径是 server 半体读 cmdlineArgs 共享快照**（B2 修改点 3），此处不重复携带

- [ ] **Step 2:** typecheck（需 submodule 已 build：见 C1；若未 build 先跳过 typecheck，C1 后回补）：`npx tsc --noEmit`（DW 插件目录）。
- [ ] **Step 3:** 提交 `feat: app startup half with auth-token option`。

### Task B2: 派生 ACP server（核心任务）

**Files (DW):**
- Create: `src/` 下对上游 `packages/acp/acp/src/` 的**全量镜像**（以 `ls` 实际清单为准 —— 评审核对为 7 个：index/content/mcp/model-control/session/codec/updates，勿手工挑文件）

**Fork 范围（评审 Issue 1 修正）：上游 `packages/acp/acp/src/index.ts` 不是自包含文件** —— 它 import 同包 `./content.ts`、`./mcp.ts`、`./model-control.ts`、`./session.ts`（session.ts 再引 `./codec.ts`、`./updates.ts` 及 dsh-agent/dsh-llm/dsh-session 等），且发布包 `files` 只含 `lib/index.js` 单文件 bundle —— 从 `@deepseek-ai/dsh-acp` 包 import 内部模块不可行。因此派生 = **整目录 fork**：把上游 `packages/acp/acp/src/` 全部 `.ts` 原样拷进本插件 `src/`（上游已是 `.ts` 后缀导入；执行时 grep 确认无 `.js` 后缀残留即可），包导入（`@deepseek-ai/*`、`@agentclientprotocol/sdk`）保持不动。这是 spec §8"派生范围最小化"的修订：fork 面是整个 acp src，修改面仍只有 index.ts 的下列各点。

- [ ] **Step 0:** 全目录 fork（`ls` 清单核对拷全 + grep 无 `.js` 后缀残留 + `npx tsc --noEmit` 通过零语义改动基线；此时尚未加 opentag 逻辑）。
- [ ] **Step 1:** 在 `src/index.ts` 做且仅做以下修改（每条一个 commit-able 小步）：

  1. **导入**：加 `import { handleOpentagCall } from './policy.ts'`、`import { createAuthGate } from './auth.ts'`、`import { createPromptGate } from './prompt-gate.ts'`、`import type { OpentagState } from './policy.ts'`
  2. **inject**：`['agents', 'llm', 'sessionPersistence', 'sessions']` → 追加 `'cmdlineArgs'` 与 `'opentagAppStartup'`（后者等 app 半体 publish 后才 claim stdio，对齐上游 acp 行 `inject: [acpAppStartup]` 的接线方式 —— 拷 `packages/bundle/acp-app/cordis.patch.yml` 里 acp 行的 `inject` 写法）
  3. **apply() 开头**建 state，token 从 cmdlineArgs 快照读（app 半体定义了 `--opentag-auth-token` option，其 opts 出现在共享快照；**不用 config 模板传 service 值** —— bundle config 是静态 YAML，加载期求值拿不到运行期 service，评审已预判此路不通）：
     ```ts
     const authToken = (ctx.cmdlineArgs as { opentagAuthToken?: string } | undefined)?.opentagAuthToken ?? null
     const authGate = createAuthGate(authToken)
     const promptGate = createPromptGate()
     const opentag: OpentagState = { auth: authGate, prompt: promptGate }
     ```
     cmdlineArgs 快照字段名以 `@deepseek-ai/dsh-cmdline` 现源码为准核对（camelCase 转换与否）。
  4. **哨兵注册**（apply 内，服务可用后）：
     ```ts
     ctx.systemPrompt.section({
       name: 'opentag-standing-prompt',
       order: -500,           // 唯一 complete section，order 无效但显式给
       complete: true,
       text: '{{opentag_standing_prompt}}',
     })
     ctx.systemPrompt.variable('opentag_standing_prompt', () => promptGate.resolve())
     ```
     注意：`ctx.systemPrompt` 服务的确切 API 以 `packages/core/system-prompt/src` 现源码为准（section/variable 签名可能有出入，就地核对，勿凭 README 记忆写）。
  5. **JSON-RPC 方法挂载**（在 `createAcpAgentApp(...)` 链上追加）：
     ```ts
     .onRequest('opentag/auth' as never, async ({ params }: { params: { token?: string } }) => {
       const verdict = handleOpentagCall(opentag, 'opentag/auth', params)
       if (verdict instanceof Error) throw internalError(verdict.message)
       return {}
     })
     .onRequest('opentag/setSystemPrompt' as never, async ({ params }: { params: { text?: string } }) => {
       const verdict = handleOpentagCall(opentag, 'opentag/setSystemPrompt', params)
       if (verdict instanceof Error) throw internalError(verdict.message)
       return {}
     })
     ```
     `as never` 视 SDK 类型而定 —— 若 `onRequest` 强类型枚举 method，用 SDK 提供的自定义 method 注册路径；实现时以 `node_modules/@agentclientprotocol/sdk` 的 .d.ts 现签名核对。错误码用上游既有 `internalError` helper（invalidParams 更贴切则用之）。
  6. **`session/new` 门禁报错文案**：上游在 prompt assembly 失败时会以 dsh-system-prompt 的错误冒泡；验证错误信息可辨识（含 `opentag_standing_prompt` 变量名即可）。若上游把 assembly 错误吞成 generic internal error，在 `newSession` 入口加前置检查：`if (!promptGate.isSet()) throw invalidParams('open-tag persona not injected: call opentag/setSystemPrompt before session/new')`（这是确定性更强的显式门禁，保留哨兵作为第二道防线）。
  7. 其余逻辑（session/prompt/update/permission/resume/close/persistence）**零改动**。

- [ ] **Step 2:** 每完成一小步 `npx tsc --noEmit`（C1 build 后回补核对）。
- [ ] **Step 3:** 提交（允许按修改点拆多 commit）`feat: derived ACP server with opentag extension + sentinel`。

### Task B3: cordis.patch.yml

**Files (DW):**
- Create: `plugins/dsh-opentag-agent-runtime/cordis.patch.yml`
- 参照：`deepseek-harness/packages/bundle/acp-app/cordis.patch.yml`（disable/insert 语法）+ `plugins/brand-profile/cordis.patch.yml`（out-of-tree 注释风格）

- [ ] **Step 1:** 写入（YAML 语法以上游 acp-app patch 为准逐字段核对）：

```yaml
# dsh-opentag-agent-runtime bundle patch: replaces the acp app+server rows with
# the open-tag derived server (token-gated persona injection), and makes the
# system-prompt service fully owned by the injected persona.
# Install with `dsh plugin --profile opentag add <path-or-npm>` (profile created
# from the shipped acp template first).

- id: acp-app-startup
  disabled: true

- id: acp
  disabled: true

- id: system-prompt
  config:
    includeHarnessIdentity: false
    personaPrefix: ''
    personaSuffix: ''

- insert:
    - id: opentag-app-startup
      name: 'dsh-opentag-agent-runtime#app'

    - id: opentag-agent-runtime
      name: 'dsh-opentag-agent-runtime'
      inject: [cmdlineArgs, opentagAppStartup]
```

注 1：包内子入口 `#app` 语法以 dsh bundle 加载器现实现为准（brand-profile 是 exports 多入口 + dsh.client 声明，本插件 host-only 双入口可仿其 exports 写法：`"./app": "./lib/app.js"`，patch 行 name 用 `dsh-opentag-agent-runtime/app`）—— 以 C2 `--dump-config` 为校验场，报错就地调整。
注 2：token 不经 config（静态 YAML 加载期拿不到运行期 service 值，评审已预判）；server 半体经 `inject: [cmdlineArgs]` 读共享快照（B2 修改点 3）。`build.mjs` 相应构建两个入口：`lib/index.js` + `lib/app.js`。

- [ ] **Step 2:** 提交 `feat: profile patch (replace acp rows, own system-prompt)`。

---

## Phase C — profile 落地与冒烟

### Task C1: submodule 构建与 profile 建立

- [ ] **Step 1:** 构建 dsh host 库（若未构建）：

```bash
cd /d/OpenSource/dsh-work-opentag/deepseek-harness
git submodule update --init
pnpm install && pnpm run build:lib:host
```

- [ ] **Step 2:** 构建插件：`cd ../plugins/dsh-opentag-agent-runtime && pnpm install && pnpm run build`（tsx devDep 安装后测试也应能跑：`pnpm test` 全绿）。
- [ ] **Step 3:** 插件目录 typecheck 回补：`npx tsc --noEmit`（B1/B2 遗留项）。有类型错就地修。
- [ ] **Step 4:** 建 profile 并装插件：

```bash
export DSH_HOME="$HOME/.dsh"
pnpm dsh --profile opentag --from-default-profile acp   # 在 deepseek-harness 目录用 pnpm dsh；或全局 dsh CLI
dsh plugin --profile opentag add file:/d/OpenSource/dsh-work-opentag/plugins/dsh-opentag-agent-runtime
ls "$DSH_HOME/profiles/opentag"                          # 确认 node_modules 有本插件
cat "$DSH_HOME/profiles/opentag/dsh.profile"             # bundles 列表若未自动含 dsh-opentag-agent-runtime，手工加入并记录进 README
```

### Task C2: dump-config 校验

- [ ] **Step 1:** `dsh --profile opentag --dump-config > /tmp/opentag-dump.yaml`，断言三件事：
  1. `acp-app-startup` / `acp` 行 `disabled: true`（或不存在）
  2. `opentag-app-startup` / `opentag-agent-runtime` 行存在且 inject 正确
  3. `system-prompt` config 为 `includeHarnessIdentity: false` + 空 persona
- [ ] **Step 2:** 不符则修 `cordis.patch.yml`（B3 注记的调整路径）重装重验。
- [ ] **Step 3:** 提交（若有改动）`fix: patch layer per dump-config`。

### Task C3: 活体冒烟（协议走通 + 负路径）

**Files (DW):**
- Create: `tools/smoke.mjs`（NDJSON 客户端脚本，stdin/stdout 直连 spawn 的 dsh）

- [ ] **Step 1:** 写 `tools/smoke.mjs`：spawn `dsh --profile opentag --opentag-auth-token <hex>`，逐行 JSON-RPC：initialize(protocolVersion 1) → authenticate → opentag/auth → opentag/setSystemPrompt("You are Smoke-Test Agent...") → session/new{cwd} → 断言 configOptions 非空 → session/close → 退出码 0。输出每步摘要。
- [ ] **Step 2:** 正路径跑通。**顺手捕获 fixture**：把 session/new 的完整响应 JSON 存 `tests/fixtures/session-new-response.json`（Phase D 的模型解析测试要用真实形状）。
- [ ] **Step 3:** 负路径六连（脚本带 `--negative` 分支或手工）：
  1. 错 token → `opentag/auth` 返回错误
  2. 未 auth 直接 setSystemPrompt → 错误
  3. 二次 setSystemPrompt → 错误
  4. 不注入直接 session/new → 错误（错误信息含 persona 指引）
  5. resume cwd 漂移（session/new cwd A → close → 新进程 session/resume cwd B）→ 上游 `sameDirectory` 拒绝（spec 钉住的回归点）
  6. 单遍插值源验证：注入含 `{{not_a_real_var}}` 字面量的 persona → session 跑一轮不炸、模型请求的 system 位含该字面量原样（grep 上游 system-prompt `renderPrompt` 源码确认 substituted values not re-scanned；若源码语义相悖 → 触发风险闸口 5）
- [ ] **Step 4:** README.md / README.zh.md（DW 插件目录）：用途、安装两条命令、协议扩展说明（两方法 + 门禁语义）、冒烟用法、维护注意（上游漂移 diff 上游 index.ts）。提交 `feat: live smoke + negative paths + README`。

---

## Phase D — open-tag 侧（TDD，worktree feature/dsh-runtime）

### Task D1: 纯函数层

**Files (OT):**
- Create: `src/daemon/dshRuntime.ts`（本任务只放 pure 导出）
- Test: `src/daemon/dshRuntime.test.ts`

- [ ] **Step 1: 写失败测试**（文件头注明 `Run: npx tsx --test src/daemon/dshRuntime.test.ts`）覆盖：

```ts
// buildDshArgs
buildDshArgs({ authToken: "abc" })            // → ["--profile","opentag","--opentag-auth-token","abc"]
// mapAcpUpdate: SessionNotification 形状（ACP SDK 类型对齐 fixture；agent_message_chunk → [{kind:"text"}]
//   agent_thought_chunk → [{kind:"thinking"}]；tool_call(title,kind,status) → [{kind:"tool",toolName}]；
//   未知 sessionUpdate → []；null 安全）
// permissionAnswer(options): [{optionId,kind:"allow_once"...},{kind:"reject_once"...}] → 选第一个 allow_*
//   无 allow 项 → null（上层拒绝）
// DeliverQueue 状态机: enqueue 两项 → 仅第一项在飞；ack() 后第二项自动出发；reject() 传播错误给当前项
```

具体断言按 ACP SDK 1.4.0 的 `SessionNotification`/`PermissionRequest` 类型现场写全（tests 里手写最小对象字面量，不 import SDK —— daemon 不依赖 SDK，见 D2 注）。

- [ ] **Step 2:** 红 → **Step 3: 实现 pure 部分**（`buildDshArgs`、`mapAcpUpdate`、`permissionAnswer`、`DeliverQueue`，全部无副作用可单测）→ **Step 4:** 绿。
- [ ] **Step 5:** 提交 `feat(daemon): dsh runtime pure helpers (test-first)`。

### Task D2: Runtime 主体

**Files (OT):**
- Modify: `src/daemon/dshRuntime.ts`（加 `dshRuntime: Runtime` 导出）

**注：daemon 不引入 `@agentclientprotocol/sdk` 依赖** —— JSON-RPC NDJSON 帧极简（id 计数 + method/params + result/error 回填），仿 `codexRuntime.ts` 的 CodexClient 手写 ~60 行即齐，避免给 daemon 包加依赖。类型用本地 `any` 收窄 + fixture 测试钉形状。

- [ ] **Step 1: 写失败测试**（集成风格，仿 codexRuntime.test.ts：mkdtemp 假 dsh）：

```ts
// 假 dsh：tmpdir 下可执行脚本（.cmd/.sh 按 platform），读 stdin 行：
//   initialize → 回 capabilities；authenticate → {}；opentag/auth/setSystemPrompt → {}
//   session/new → {sessionId:"s1", configOptions:[…fixture 形状]}
//   session/prompt → 先发 update(agent_message_chunk) 再回 {stopReason:"end_turn"}
//   session/request_permission → 收到应答后继续
// 断言：start() 触发 onSession("s1")、onActivity working→online、onTrajectory 收到 text 条目、
//   deliver() promise 在 turnDone 后 resolve、stop() 走 session/cancel+close 再退出
// 负路径：假 dsh 对 opentag/auth 回 error → start 的 initialAdmission reject + onActivity offline
```

- [ ] **Step 2:** 红 → **Step 3: 实现** `dshRuntime: Runtime`：
  - `start(opts, cb)`：`randomBytes(32).toString("hex")` → `spawnSafe("dsh", buildDshArgs(...), {cwd: opts.cwd, stdio:["pipe","pipe","pipe"], env: opts.env})`
  - 握手序列（`initialize` → `authenticate` → `opentag/auth` → `opentag/setSystemPrompt{text: opts.systemPrompt}` → `opts.sessionId ? session/resume : session/new` → `set_config_option`（model/reasoningEffort 有则发））
  - `deliver`：DeliverQueue 串行 → `session/prompt {sessionId, prompt:[{type:"text",text}]}`，`PromptResponse.stopReason` 到达 = 本轮 admission accept；错误 = reject（复用 `protocolAdmission`，exactly-once）。turn 前钩子：`opts.model`/effort 与上次已发值不同 → 先发 `session/set_config_option`（覆盖 E2 的存活期模型切换，不用等 wake 重生）
  - `session/update` 通知 → `mapAcpUpdate` → `cb.onTrajectory` + `onActivity`（tool_call running → working；turnDone → online）
  - `session/request_permission` 服务端请求 → `permissionAnswer(options)` → 回 `{outcome:{outcome:"selected", optionId}}`；null → reject 选项
  - `stop()`：发 `session/cancel` + `session/close`（不等回包）→ `killTree(proc)`
  - `onExit`/error 路径对齐 claudeRuntime（offline + finish(code)）
- [ ] **Step 4:** 绿 → **Step 5:** 提交 `feat(daemon): dsh runtime ACP client`。

### Task D3: 注册与探测

**Files (OT):**
- Modify: `src/daemon/runtimes.ts`
- Test: `src/daemon/dshRuntime.test.ts`（追加）

- [ ] **Step 1: 失败测试**：`detectRuntimes` 在 PATH 有假 `dsh` + `$DSH_HOME/profiles/opentag` 存在时含 `"dsh"`；缺 profile 时不含；`DSH_HOME` env 覆盖生效（测试内设 env + tmpdir）。
- [ ] **Step 2:** 红 → **Step 3:** 实现：`has("dsh")` + `existsSync(join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "profiles", "opentag"))`；REG 加 `dsh: dshRuntime`；头注释 registry 行更新。
- [ ] **Step 4:** 绿 → **Step 5:** 提交 `feat(daemon): register dsh runtime with profile detection`。

### Task D4: 模型发现

**Files (OT):**
- Modify: `src/daemon/listModels.ts`
- Modify: `src/server/runtimeModels.ts:34`
- Test: `src/daemon/listModels.test.ts` 或就近（有现成测试文件则追加）

- [ ] **Step 1: 失败测试**：`parseDshConfigOptions(fixture)`（用 C3 捕获的 `session-new-response.json`）→ `DiscoveredModel[]`（id/label 正确、reasoning effort 选项映射 thinking levels）；空/畸形输入 → `[]`。
- [ ] **Step 2:** 红 → **Step 3:** 实现：pure parser + shell driver `probeDshModels()`（spawn dsh、握手、注入 stub persona "probe"、session/new 读 configOptions、close、退出；失败返 null）。挂进 `listModels` 分发；`DYNAMIC_RUNTIMES` 加 `"dsh"`。
- [ ] **Step 3b（评审 Issue 3 修正 — 超时预算对齐）：** dsh 探测要完整 boot（spawn+握手+session/new），跑不进既有 7s。两处预算改为 per-runtime：
  - `src/daemon/listModels.ts`：`LIST_TIMEOUT_MS = 7_000` 旁加 `const LIST_BUDGET: Record<string, number> = { dsh: 25_000 }`，取 `LIST_BUDGET[runtime] ?? LIST_TIMEOUT_MS`（注释保留"必须低于服务端预算"的因果说明，写明 dsh 对应服务端 30s）
  - `src/server/runtimeModels.ts`：`PROBE_TIMEOUT_MS = 8_000` 同样 per-runtime 化：`dsh: 30_000`，其余 8_000；dsh 缓存 TTL 沿用 60s 共用即可
  - 附测试：预算 map 存在性与 dsh 键值（防未来静默回退 7s 让下拉框永远空）
- [ ] **Step 4:** 绿 → **Step 5:** 提交 `feat(daemon): dsh dynamic model discovery via ACP config options`。

### Task D5: UI 选项

**Files (OT):**
- Modify: `web/src/views/Members.tsx:768`

- [ ] **Step 1:** RUNTIMES 数组加 `{ value: "dsh", label: "DeepSeek Harness" }`（hermes/reasonix 之后）。Landing.tsx ENGINES 不加（hermes/reasonix 先例：落地页未列）。
- [ ] **Step 2:** `npm run typecheck`（根 + web）过。
- [ ] **Step 3:** 提交 `feat(web): DeepSeek Harness runtime option`。

---

## Phase E — E2E、文档、发版

### Task E1: 全量静态检查

- [ ] `cd /d/OpenSource/open-tag-dsh-runtime && npm run typecheck`（根 + web）
- [ ] `npx tsx --test src/daemon/dshRuntime.test.ts src/daemon/codexRuntime.test.ts src/daemon/claudeRuntime.test.ts`（新旧 runtime 测试同绿）
- [ ] DW 插件 `pnpm test && npx tsc --noEmit`

### Task E2: 隔离栈 E2E（AGENTS.md 硬要求）

前置：本机 dsh 已按 C1 建好 opentag profile（E2E 与 dev 同一 `$DSH_HOME` —— daemon 与 dsh 同机，符合部署模型）。

- [ ] `cd /d/OpenSource/open-tag-dsh-runtime && npm run dev:e2e:up`
- [ ] 浏览器（chrome-devtools MCP）走：dev-login → Members 建 agent（runtime=DeepSeek Harness，model 选 configOptions 之一）→ #all 发消息 @agent → 断言：回复到达、轨迹（thinking/text/tool）显示、activity working→online
- [ ] sleep（agent:sleep 或等 idle）→ 再 @ 一次 → 断言 resume（session id 不变，日志可见 session/resume）
- [ ] 模型切换（spec §7）：编辑该 agent 的 model → 下一轮 turn 触发 `session/set_config_option`（daemon 日志可见）→ 回复正常
- [ ] 截图存 `.shots/`（gitignored，勿提交）
- [ ] `npm run dev:e2e:down`

### Task E3: doc-sync（同 commit 纪律）

**Files (OT):**
- Modify: `ARCHITECTURE.md`（codemap 加 dshRuntime.ts + 插件边界说明：runtime↔plugin 协议契约两方法）
- Modify: `FEATURES.md`（checkbox）
- Modify: `README.md`（Verified 段：dsh runtime E2E 证据 + 前置安装两条命令）
- Modify: `docs/tech-debt-tracker.md`（新增：派生 server 上游漂移维护债 —— dsh 升级时 diff `packages/acp/acp/src/index.ts`；模型发现已动态化，不新增 I39 类债）
- Modify: `CHANGELOG.md` + `packages/daemon/package.json`（0.16.0 → **0.17.0**，新 runtime = minor；Unreleased 段落移入 0.17.0，条目：dsh runtime + token 握手 + persona 注入 + 动态模型发现）

- [ ] 全部改完一个 commit：`docs: dsh runtime sync (ARCHITECTURE/FEATURES/README/tech-debt) + daemon 0.17.0`

### Task E4: 开发日志

- [ ] OT：`.agents/notes/2026-09-19-dsh-runtime.md`（决策摘要、验证证据、跳过项 fail-loud 声明）
- [ ] DW：`.agents/notes/`（dsh-work 侧对等日志，仿其现有格式）
- [ ] 提交两侧。

### Task E5: PR

- [ ] OT：push `feature/dsh-runtime` → 开 PR（base main；描述含 E2E 证据摘要 + spec 链接）
- [ ] DW：push `feature/opentag-agent-runtime`（PR 或直接合，按用户偏好问一次）

### Task E6: daemon 发版（外向动作，执行前向用户确认）

- [ ] merge 后：`gh release create v0.17.0 --notes "<CHANGELOG 0.17.0 段>"` —— 触发 `publish-daemon.yml` 发 npm
- [ ] 提醒：长驻 daemon 需 `npx @fancyboi999/open-tag-daemon@latest` 重启才吃到新包

---

## 风险闸口（执行时遇到即停，回报用户）

1. B2 的 SDK `onRequest` 自定义方法类型不通且无注册路径 → 回退方案：插件内不挂 opentag/* 于 ACP app，改在 `ndJsonStream` 外再包一层逐行分发（协议分流：`opentag/` 前缀行进插件，其余进 ACP app）—— 需回 spec 补记
2. C2 dump-config 的 insert/config 写法与 B3 模板不符且两种调整路径都走不通 → 回报
3. C3 冒烟发现 session/new 前置检查吞错、哨兵不触发 → 启用 B2 Step1.6 的显式前置检查为主门禁（已在计划内，非阻塞）
4. E2 发现 configOptions 与 fixture 形状漂移 → D4 parser 以 E2E 实测为准修 fixture
5. C3.6 单遍插值假设破产（persona 内 `{{…}}` 被再解析）→ 回退 spec §8 方案：放弃哨兵变量，改"未注入时注册抛错的占位 complete section + setSystemPrompt 时替换"—— 需回 spec 补记
6. Task 0.2 注 1 中某 `@deepseek-ai/*` 包 npm 查无已发布版本 → 该包及其传递闭包改由 build.mjs 从 submodule 构建产物内联打包（esbuild 不 external），并在 README 维护说明中记录内联清单与升级再内联步骤
