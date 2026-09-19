# 2026-09-19 · DSH 动态模型发现（D4，test-first）

分支：feature/dsh-runtime（worktree open-tag-dsh-runtime）
计划：docs/PLANS.md 的 dsh-runtime plan · Task D4（Step 3b 预算修复版）
范围：仅 listModels/runtimeModels；dshRuntime.ts(+test) 与 Members.tsx 由并行任务负责，未触碰。

## 内容

dsh 没有 list-models 一次性命令——目录在 ACP `session/new` 响应的 `result.configOptions` 里。
`src/daemon/listModels.ts` 新增：

- `parseDshConfigOptions(response)` 纯解析器（导出、单测）：
  - `model` select 的 options 是 provider 分组，叶子的 `value` 是 JSON 编码的
    `[provider, model]` 对（如 `["deepseek-official","deepseek-v4-flash"]`）→ id/model/provider
    以该对为准（分组 `name` 仅展示）；`currentValue` 命中原 value 字符串者标 `default:true`。
  - 会话级 `reasoning_effort` select → 每个 model 附同一份 thinking levels（default=currentValue，
    仅当命中某 level）；select 缺失/非 select → 无 thinking。
  - 空/畸形（非对象、无 configOptions、无 model select、value 非 [provider,model] 对、空串、
    重复）一律跳过或整体返回 []，永不 throw。
- `probeDshModels(timeoutMs)` shell 驱动：镜像插件已验证的 smoke 客户端
  （dsh-work-opentag/.../tools/smoke.mjs）——spawn `dsh --profile opentag
  --opentag-auth-token <random hex>`（bin 解析：`OPEN_TAG_DSH_BIN` 优先，否则 PATH 上的 `dsh`；
  env 去 NODE_OPTIONS 同 runList 惯例）→ NDJSON 握手 initialize → authenticate → opentag/auth →
  opentag/setSystemPrompt{text:"probe"}（setSystemPrompt 每进程一次、session/new 强制先注入）
  → session/new{cwd: tmpdir(), mcpServers:[]} → 解析 → best-effort session/close + stdin.end
  （profile 于 EOF 退出）→ kill。S→C 请求（如 session/request_permission）回 -32601 不阻塞。
  单一总 deadline（无逐请求计时器）；spawn error / 提前退出 / 超时 / 空结果 → null。
- 分发：`listModels("dsh")` case；预算 `LIST_BUDGET_MS = { dsh: 25_000 }`（默认仍 7s）。
- fixture 入库：`src/daemon/__fixtures__/dsh-session-new.json`（复制自插件
  tests/fixtures/session-new-response.json，真实捕获）。

`src/server/runtimeModels.ts`：`DYNAMIC_RUNTIMES` 加 `"dsh"`；`PROBE_BUDGET_MS = { dsh: 30_000 }`
（默认仍 8s），`getDynamicModels` 按 runtime 取预算。**配对不变量**：daemon 25s < 服务端 30s，
任一侧静默回落 7s/8s，服务端会在 daemon 仍在探测时放弃 → 弹窗静态回退 → dsh 下拉为空。

测试：`src/daemon/listModels-dsh.test.ts`（6 tests，先红后绿）：fixture 字段级映射、thinking
缺席、畸形叶子跳过/去重、空畸形响应 →[]、真实 fixture 文件逐字解析（16 模型）、**预算对回归**
（以源码形状断言 dsh:25_000 / dsh:30_000 / DYNAMIC_RUNTIMES 含 dsh——两 map 均为模块私有常量）。

## 验证

- 红：`parseDshConfigOptions` 未导出 → SyntaxError（实现前）。
- 绿：`npx tsx --test src/daemon/listModels-dsh.test.ts` → 6/6 pass。
- 回归：`npx tsx --test src/daemon/hermesRuntime.test.ts src/daemon/dshRuntime.test.ts` → 28/28 pass。
- `npx tsc --noEmit`（root）→ 0 错误。
- 未跑活体探测（需 dsh + LLM 凭据，Phase E 覆盖）；驱动逻辑镜像 smoke.mjs 已验证客户端，
  风险点（握手顺序、参数形状）均有 README/源码依据。

## 文档同步

- `ARCHITECTURE.md`：runtimeModels 条目（DYNAMIC_RUNTIMES + PROBE_BUDGET_MS 配对）、
  listModels 条目（dsh 驱动/解析/预算 + OPEN_TAG_DSH_BIN）。
- `CHANGELOG.md` [Unreleased] Added：dsh 动态模型发现条目（版本号不在此批 bump，
  与分支既有做法一致，release 待合并时统一处理）。
