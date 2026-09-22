# Daemon 由 Server 分发（去 npm 依赖）Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking. 执行全程 TDD（superpowers:test-driven-development）。

**Goal:** 连接/重连/更新 daemon 的命令不再 `npx @fancyboi999/open-tag-daemon@latest`（npm）或本地 tsx 路径，而是从本 server HTTP 下载自包含 bundle 并用 `node` 运行。

**Architecture:** `scripts/build-daemon-pkg.mjs` 已产出零依赖单文件 bundle `packages/daemon/dist/cli.mjs`（ws/commander 全内联，仅要求 node20+）。server 新增公开端点 `GET /daemon/cli.mjs` 直接分发该文件；`GET /api/servers/:id/machines` 响应增加 `daemonBundleAvailable` 标志；web 端命令生成改为平台一键命令（bash `curl … && node …` / PowerShell `Invoke-WebRequest …; node …`），向导与更新弹窗按平台 tab 显示。bundle 缺失（dev 未构建）或 env `OPEN_TAG_DAEMON_CMD_TEMPLATE` 覆盖时，回退现状行为。

**Tech Stack:** TypeScript、裸 node:http server、esbuild 产物、React 前端、node:test。

---

## 现状关键事实（探索已确认）

- 命令模板链：env `OPEN_TAG_DAEMON_CMD_TEMPLATE` 在 [servers.ts:22-25](d:/OpenSource/open-tag/src/server/routes-api/servers.ts) 读取，随 `GET /api/servers/:id/machines` 响应字段 `daemonCommandTemplate` 返回（servers.ts:236）；web 端 [machineUi.ts](d:/OpenSource/open-tag/web/src/machineUi.ts) `DEFAULT_DAEMON_COMMAND`（:32）渲染。
- 消费方：`ConnectComputerWizard.tsx:101,149`（连接/重连）、`misc.tsx` `DaemonUpdateModal`（:283,299，更新）。
- server 无 Express：`src/server/index.ts:119-129` 裸 dispatch；公开文件流先例 `handlePublicAttachmentGet`（routes-api/attachments.ts:120-152）。
- 部署镜像**不含** bundle：Dockerfile build 阶段只跑 `npm run site:build`，runtime 只拷 `packages/daemon/package.json`；`scripts/prod-up.sh:16` 同样只 `site:build`。`packages/daemon/dist` 被 gitignore（构建产物）。
- `LATEST_DAEMON_VERSION` = packages/daemon/package.json 版本（servers.ts:17）。
- 测试惯例：`npx tsx --test --test-force-exit test/<file>`，node:test + assert/strict；`test/daemonConnectCommand.unit.test.ts`、`test/machineUpdateGuide.unit.test.ts` 覆盖现命令。
- **不改 `src/daemon/**`** → 无需 daemon 发版。无 DB schema 变更 → 无迁移。

## 命令形态（已与用户确认；2026-09-22 修订 v2：安装脚本端点）

- **v2 修订原因**：v1 双 bundle 一键命令（mkdir + 2×curl + node）太长。server 生成安装脚本，命令缩成 pipe 风格（rustup/homebrew 同款）。（v2 landed: commit `c8e6f6c`）
- **v1 遗留原因（仍成立）**：bundled daemon 找同目录 sibling `agent-cli.mjs`（openTagBin.ts:15-24）→ 安装脚本必须把两个 bundle 放同一稳定目录。
- bash（macOS/Linux/Git Bash）：
  ```
  curl -fsSL "{origin}/daemon/install.sh?server={origin}&key={key}" | bash
  ```
- PowerShell（Windows）：
  ```
  iwr -useb "{origin}/daemon/install.ps1?server={origin}&key={key}" | iex
  ```
- server 端点：`GET /daemon/install.sh` / `GET /daemon/install.ps1`（公开，`Cache-Control: no-store`；按查询参数 `server`/`key` 生成脚本，值内嵌 + 正确引号转义；缺参数 → 400）。脚本逻辑：建稳定目录 `~/.open-tag/daemon` → 下载 cli.mjs + agent-cli.mjs 到该目录（失败即退非零）→ 启动 daemon（sh `exec node`，PS `& node`）。bundle 端点 `/daemon/cli.mjs` + `/daemon/agent-cli.mjs` 保留（脚本内部使用）。更新流程 = 同一条命令（重下载 + 需先停旧 daemon，弹窗文案已覆盖）。`daemonBundleAvailable` = 两 bundle 都在。
- key 出现在 URL 查询串：与 UI 明文展示同级暴露面；`no-store` 降低代理/日志残留。自托管场景接受。
- 端点公开无鉴权（bundle 无密钥，信任级别同 npm 公开包）。
- 目标机器仍需 node20+（与 npx 相同前提）。

---

### Task 0: worktree + 计划入库

**Files:**
- Create: worktree `open-tag-server-daemon-dist`（`npm run wt:add -- server-daemon-dist`，从 main repo 根执行）
- Create: `docs/superpowers/plans/2026-09-22-daemon-server-distribution.md`（本计划副本，repo 惯例）

- [x] Step 1: 主 checkout 根目录 `npm run wt:add -- server-daemon-dist`
- [x] Step 2: `cd ../open-tag-server-daemon-dist`
- [x] Step 3: 把本计划文件复制为 `docs/superpowers/plans/2026-09-22-daemon-server-distribution.md`，并在 `docs/PLANS.md` 按其惯例挂索引
- [x] Step 4: Commit `docs: plan for server-distributed daemon bundle`

### Task 1: server 端 daemonBundle 模块 + 公开端点（TDD）

**Files:**
- Create: `src/server/daemonBundle.ts`
- Create: `test/daemonBundle.unit.test.ts`
- Modify: `src/server/index.ts`（dispatch 插入，:120 `/health` 之后）
- Modify: `src/server/routes-api/servers.ts:236`（machines 响应加 `daemonBundleAvailable`）

- [x] Step 1: 写失败测试 `test/daemonBundle.unit.test.ts`。可注入路径的纯函数，无需 DB：

```ts
// Run: npx tsx --test --test-force-exit test/daemonBundle.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serveDaemonBundleFrom } from "../src/server/daemonBundle.ts";

function mockRes() {
  const chunks: Buffer[] = []; const headers: Record<string, string | number> = {};
  return {
    res: {
      writeHead(status: number, h: Record<string, string>) { (this as any).status = status; Object.assign(headers, h); },
      end(data?: Buffer | string) { if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data)); },
      statusCode: 0,
    } as any,
    status: () => (mockState.status), headers, body: () => Buffer.concat(chunks),
  };
  // 实现时按实际 mock 形态简化 —— 参照 test/daemonConnectCommand.unit.test.ts 与 src/server 现有
  // mock res 惯例（test/channelAccess.integration.ts:79 的 call() helper 有现成 mock req/res 写法可抄）
}
```

  断言三点：
  1. 文件存在 → 返回 `true`，status 200，`content-type` 以 `text/javascript` 开头，`cache-control: no-cache`，body 为文件字节。
  2. 文件缺失 → 返回 `true`（路由已匹配），status 404 JSON error body。
  3. 路径不匹配（非 GET 或非 `/daemon/cli.mjs`）→ 由 index.ts dispatch 保证，不在本模块测。

- [x] Step 2: 跑测试确认失败（模块不存在）
- [x] Step 3: 实现 `src/server/daemonBundle.ts`：

```ts
// Serves the self-contained daemon bundle (packages/daemon/dist/cli.mjs, built by
// scripts/build-daemon-pkg.mjs) over HTTP so target machines install from THIS server
// instead of npm. Public like /health: the bundle embeds no secrets (same trust level
// as the public npm package it replaces).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendErr } from "./util.js";

export const DAEMON_BUNDLE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/daemon/dist/cli.mjs");

/** Test seam: serve a bundle file (or 404 when absent) from an explicit path. Returns true = route handled. */
export async function serveDaemonBundleFrom(res: import("node:http").ServerResponse, filePath: string): Promise<boolean> {
  let data: Buffer;
  try { data = await readFile(filePath); }
  catch { sendErr(res, 404, "daemon bundle not built — run npm run pkg:daemon:build on the server host"); return true; }
  res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
  res.end(data);
  return true;
}

export async function serveDaemonBundle(res: import("node:http").ServerResponse): Promise<boolean> {
  return serveDaemonBundleFrom(res, DAEMON_BUNDLE_PATH);
}
```

  并加 `daemonBundleExists(): Promise<boolean>`（`stat` try/catch）供 servers.ts 用。

- [x] Step 4: 跑测试确认通过
- [x] Step 5: `src/server/index.ts` dispatch（:120 `/health` 行后）插入（GET+HEAD，同 `/docs` 静态只读惯例；Node 对 HEAD 自动丢弃 body）：

```ts
if ((method === "GET" || method === "HEAD") && url.pathname === "/daemon/cli.mjs") return void await serveDaemonBundle(res);
```

  （import 加 `serveDaemonBundle`。单元测试用 HEAD 再补一条：status/headers 相同、body 为空——mock res 需模拟 Node 丢弃行为或直接断言实现侧对 HEAD 调 `res.end()` 不传 data；KISS：实现里 `res.end(method === "HEAD" ? undefined : data)` 显式化，测试直测该分支。）

- [x] Step 6: `servers.ts:236` machines 响应对象追加字段：`daemonBundleAvailable: await daemonBundleExists()`（import 自 `../daemonBundle.js`）。
- [x] Step 7: `npm run typecheck`（root）通过
- [x] Step 8: Commit `feat(server): serve daemon bundle at GET /daemon/cli.mjs + availability flag`

### Task 2: web 命令生成器（TDD）

**Files:**
- Modify: `web/src/machineUi.ts`
- Modify: `test/daemonConnectCommand.unit.test.ts`（先改测试）
- Modify: `test/machineUpdateGuide.unit.test.ts`（先改测试）

- [x] Step 1: 重写两个测试文件为失败状态。新 API：

```ts
export type DaemonCommandSet = { kind: "custom"; command: string } | { kind: "platform"; bash: string; powershell: string };
export function daemonConnectCommands(origin: string, key: string, opts: { template?: string | null; bundleAvailable?: boolean }): DaemonCommandSet;
export function daemonUpdateCommands(origin: string, opts: { template?: string | null; bundleAvailable?: boolean }): DaemonCommandSet;
```

  断言：
  1. `bundleAvailable: true`、无 template → `kind: "platform"`，bash 含 `curl -fsSL https://x.test/daemon/cli.mjs` + `--server-url https://x.test` + `--api-key sk_machine_abc`；powershell 含 `Invoke-WebRequest -Uri https://x.test/daemon/cli.mjs` + 同参数。
  2. `bundleAvailable: false` → `kind: "custom"`，command = 现行 npx 默认串（`DEFAULT_DAEMON_COMMAND` 保留作回退，含 `{origin}`/`{key}` 已渲染）。
  3. template 提供时无论 flag → `kind: "custom"`，占位符渲染（连接=真 key，更新=`<your sk_machine_... key>`）。
  4. 更新命令：`kind: "platform"` 时 bash/powershell 内 key 位置为 `KEY_PLACEHOLDER`。

- [x] Step 2: 跑两测试确认失败
- [x] Step 3: 实现 machineUi.ts：
  - 保留 `DEFAULT_DAEMON_COMMAND`（改注释：现为回退）、`KEY_PLACEHOLDER`、`renderDaemonCommand`。
  - 新增两模板常量 `BUNDLE_CMD_BASH` / `BUNDLE_CMD_POWERSHELL`（见上文"命令形态"）。
  - 新函数 `daemonConnectCommands` / `daemonUpdateCommands`（逻辑：template 优先 → custom；bundleAvailable → platform 渲染两模板；否则 custom=npx 渲染）。删除旧 `daemonConnectCommand` / `daemonUpdateCommandTemplate`（调用方仅 wizard + modal + 测试，一并改）。
- [x] Step 4: 跑两测试确认通过
- [x] Step 5: Commit `feat(web): platform daemon commands (server-distributed bundle) with npx fallback`

### Task 3: UI — 平台 tab 命令框 + store 标志

**Files:**
- Create: `web/src/views/CommandTabs.tsx`
- Modify: `web/src/store.tsx`（:37-38 类型、:99-100 state、:149 fetch、:419 context —— 加 `daemonBundleAvailable`）
- Modify: `web/src/views/ConnectComputerWizard.tsx:101,148-152`
- Modify: `web/src/views/misc.tsx:281-283,298-299`（DaemonUpdateModal）
- Modify: `web/src/locales/en.json`、`zh.json`（tab 标签 `misc.cmdTabBash`="bash / Linux / macOS"、`misc.cmdTabPowershell`="PowerShell / Windows"；修正 :310 附近硬编码 npx 提示文案）

- [x] Step 1: `CommandTabs.tsx`：props `{ set: DaemonCommandSet }`。`kind: "custom"` → 渲染现单 codebox（复用现有 `.codebox` 结构 + copy 按钮）；`kind: "platform"` → 两 tab（默认按 `navigator.userAgent.includes("Windows")` 选 powershell 否则 bash），codebox 内容随 tab。copy 逻辑复用 `copyText`（`web/src/lib/clipboard.ts`），参考 wizard :102-105。
- [x] Step 2: store 挂 `daemonBundleAvailable` —— machines 响应解析有**两处**：reload `:149` 与 socket `machine:status` 重拉 `:393`，两处都 set 该字段。
- [x] Step 3: wizard `:101` 改 `daemonConnectCommands(window.location.origin, res.key, { template: daemonCommandTemplate, bundleAvailable: daemonBundleAvailable })`，codebox 区换 `<CommandTabs set={...} />`。
- [x] Step 4: DaemonUpdateModal 同改（`daemonUpdateCommands` + `<CommandTabs />`）。
- [x] Step 5: locales 两语言补键、改 npx 提示。
- [x] Step 6: root `npm run typecheck` 通过（已含 web tsconfig；web/package.json 无独立 typecheck 脚本）
- [x] Step 7: Commit `feat(web): platform-tab command box in connect wizard + daemon update modal`

### Task 2.6: 安装脚本端点 + 命令简化（v2 修订，替代 v1 长命令）

**Files:**
- Modify: `src/server/daemonBundle.ts`（新增 `installSh(origin, key)` / `installPs1(origin, key)` 生成函数 + 两个端点 handler；sh 单引号转义、PS 单引号转义；缺 server/key 参数 → 400）
- Modify: `src/server/index.ts`（dispatch 加 `/daemon/install.sh`、`/daemon/install.ps1`，GET，`no-store`）
- Modify: `test/daemonBundle.unit.test.ts`（脚本生成：参数嵌入、转义——`'`/`"`/空格注入样例、400 分支）
- Modify: `web/src/machineUi.ts`（`BUNDLE_CMD_*` 换成 v2 短命令）
- Modify: `test/daemonConnectCommand.unit.test.ts`、`test/machineUpdateGuide.unit.test.ts`（全串断言同步）

- [x] Step 1: RED — 测试先行（脚本生成纯函数 + 命令字符串）
- [x] Step 2: GREEN — 实现生成函数 + 端点 + 命令常量
- [x] Step 3: 三测试文件全绿 + `npm run typecheck`
- [x] Step 4: Commit `feat: server-generated install scripts (install.sh/ps1) shorten connect command to one pipe`

（流程裁剪：Task 2.3/2.5/2.6 合并为 Task 6 前一次综合 review，不再每任务两轮。）

### Task 4: 构建/部署管线带上 bundle

**Files:**
- Modify: `Dockerfile`（build 阶段 :20 追加 `npm run pkg:daemon:build`；runtime 阶段在拷 `packages/daemon/package.json` 处一并 COPY `packages/daemon/dist`，从 build stage 拷）
- Modify: `scripts/prod-up.sh:16`（`site:build` 后加 `npm run pkg:daemon:build`）

- [x] Step 1: Dockerfile 两处修改（`.dockerignore` 排除 `dist` 无碍 —— bundle 在镜像内构建）
- [x] Step 2: prod-up.sh 加构建行
- [x] Step 3: 本地验证可跑：worktree 内 `npm run pkg:daemon:build` 产出存在
- [x] Step 4: Commit `build: ship daemon bundle in deploy image + prod-up`

### Task 5: 文档同步（doc-sync 硬规则）

**Files:**
- Modify: `ARCHITECTURE.md`（codemap 加 `src/server/daemonBundle.ts`、`GET /daemon/cli.mjs` 端点、构建管线变化）
- Modify: `AGENTS.md` + `AGENTS.zh.md`（`OPEN_TAG_DAEMON_CMD_TEMPLATE` 说明改为"覆盖 server 分发命令"；transport env 段落）
- Modify: `FEATURES.md`（新 checkbox）
- Modify: `README.md` / `README.zh-CN.md`（Verified 段落 + 连接命令示例）
- Modify: `docs/self-host.md`、`docs/self-host-windows.md`（连接命令示例换新）
- Modify: `docs/authorization.md`（公开端点清单加 `/daemon/cli.mjs`，说明无密钥）

- [x] Step 1: 逐文件更新
- [x] Step 2: Commit `docs: sync for server-distributed daemon bundle`

### Task 6: 端到端验证（verification-before-completion）

- [x] Step 1: 单测全绿：
  `npx tsx --test --test-force-exit test/daemonBundle.unit.test.ts test/daemonConnectCommand.unit.test.ts test/machineUpdateGuide.unit.test.ts`
- [x] Step 2: `npm run typecheck`（root + web）
- [x] Step 3: 活栈验证（worktree 内）：
  1. `npm run pkg:daemon:build`
  2. 起 server（现有 dev DB 即可）
  3. `curl -fsS -D - -o /dev/null http://localhost:$PORT/daemon/cli.mjs` → 200 + text/javascript；`curl -fsS …/daemon/cli.mjs | head -c 100` 首字节 `#!/usr/bin/env node`；`curl -fsSI`（HEAD）→ 200 空 body
  4. bundle 删除后再 curl → 404 JSON（回退路径成立）
  5. 浏览器（chrome-devtools MCP，`--isolated`）：`/s/<slug>/computer` 重连/添加向导显示双 tab，默认 tab 随平台；复制 bash 命令在本机实际执行 → daemon 上线（`.shots/` 截图，gitignored）
- [x] Step 4: 开发日志 `.agents/notes/2026-09-22-daemon-server-dist.md`
- [x] Step 5: PR from worktree branch

## 边界与不做（YAGNI）

- ~~不做安装脚本端点~~ v2 已推翻：安装脚本端点是命令简化的核心手段。
- 不做版本查询参数/长缓存 —— `no-cache` 足够（一次性下载）。
- 不做 cmd.exe 第三 tab —— Windows 走 PowerShell tab。
- 不动 `src/daemon/**` → 不触发 daemon 发版流程。
- dev 未构建 bundle 时（`tsx` 跑 server）端点 404、UI 回退 npx —— 现状行为保留，不强制 dev 构建 bundle。
