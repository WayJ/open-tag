# 2026-09-19 · DSH runtime 纯函数层（D1，test-first）

分支：feature/dsh-runtime（worktree open-tag-dsh-runtime）
计划：docs/PLANS.md 的 dsh-runtime plan · Task D1（D2 Runtime 实现接线在后续 commit）

## 内容

新增 `src/daemon/dshRuntime.ts`（仅纯函数，无进程/IO）+ `src/daemon/dshRuntime.test.ts`（10 tests，
先红后绿）。DSH 走 ACP（Agent Client Protocol）；daemon 不引入 @agentclientprotocol/sdk，
D2 手写 ~60 行 stdio JSON-RPC 客户端，故本层零依赖（仅 node builtins + ./runtime.js 类型）。

导出：
- `buildDshArgs({authToken})` → `--profile opentag --opentag-auth-token <tok>`
- `mapAcpUpdate(update)` → TrajectoryEntry[]：agent_message_chunk→text、agent_thought_chunk→thinking、
  tool_call→{tool toolName:title, toolInput:""}（title 缺失→""）；usage_update/未知/null→[]。
  clip 2000 与 claude/pi 等 runtime 同约定。
- `acpActivity(update)` → tool_call(pending|in_progress)→working/detail=title、
  agent_message_chunk→thinking/""；其余 null（D2 接 onActivity）。
- `permissionAnswer(options)` → 首个 kind 以 "allow" 开头的选项 → {outcome:"selected",optionId}；否则 null。
- `createDeliverQueue()` → 严格串行任务队列：前一任务 settle（resolve/reject 皆可）后下一任务才启动；
  rejection 只传给各自的调用方，不毒化队列。
- `parseAcpPromptStopReason(response)` → result.stopReason 字符串，null-safe。

形状 ground truth：dsh-work-opentag plugins/dsh-opentag-agent-runtime tests/fixtures/
（session-updates.ndjson 真实捕获 agent_message_chunk/usage_update；prompt-response.json stopReason）。
tool_call 为 ACP v1 形状，fixture 未含，测试内合成最小样本。

## 验证

- 红：ERR_MODULE_NOT_FOUND（实现未写前）。
- 绿：`npx tsx --test src/daemon/dshRuntime.test.ts` → 10 pass / 0 fail。
- `npx tsc --noEmit` 通过（修复一处 noUncheckedIndexedAccess：解构 [entry] 改 entries[0]?.）。
- 既有 suite 抽查 prompt.test.ts 2 pass，未改动任何其他文件。
- 未做（fail loud）：D2 接线（onTrajectory/onActivity/串行投递）未验证 —— 本任务范围外。
