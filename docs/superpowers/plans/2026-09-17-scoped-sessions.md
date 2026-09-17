# Scoped Sessions（作用域会话）Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 会话绑定从 agent 粒度迁移到 (agent, channel|thread) 作用域——同 scope 单飞、跨 scope 并发，消除队头阻塞；LEGACY 回退覆盖无 scope 路径与混合机队。

**Architecture:** server 在派发链路解析 scope 并随 `agent:start`/`agent:deliver` 协议直传 `{type,id}` + `agent_sessions` 表存会话 id；daemon 以 `scopeKey` 键控 Running 与全部 8 处派生状态；无 scope 消息统一落 LEGACY scope（旧列）。

**Tech Stack:** TypeScript、drizzle/pg、node:test（tsassert 风格同既有测试）、无新依赖。

**Spec:** `docs/superpowers/specs/2026-09-17-scoped-sessions-design.md`（迁移表+LEGACY 节为硬约束）

---

## 前置：worktree

- [ ] **Step 0.1:** 主仓库 `npm run wt:add -- scoped-sessions`，`cd ../open-tag-scoped-sessions`；`cd docs-site && npm install`。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/db/schema.ts` | Modify | `agent_sessions` 表 |
| `src/server/agentConfig.ts` | Modify | config 增 `scope?: {type,id,sessionId}`（按 target 上下文） |
| `src/server/core.ts` | Modify | scope 解析注入 start/deliver；sendAgentDeliver/sendAgentStart 透传；手动重启保持无 scope（天然 LEGACY） |
| `src/server/conversationTurnDispatch.ts` | Modify | 派发点带 scope（已有 channel 行，type 判 thread） |
| `src/server/reconnectCatchup.ts` | **不改** | 硬离线 start 无 scope=LEGACY、软离线 target:""=LEGACY（设计如此；验证即可） |
| `src/server/ws.ts` | Modify | `agent:session` 带 scope → upsert agent_sessions；无 scope → 旧列 |
| `src/server/core.ts resetAgent()` | Modify | 成功后 delete agent_sessions 该 agent 全部行 |
| `src/daemon/agentManager.ts` | Modify | scopeKey 体系 + 8 状态迁移表 + sleeping 规则 + stop/reset 语义 |
| `src/daemon/index.ts` | Modify | start/deliver 传 scope 进 mgr；running() 上报不变（内部已派生） |
| `test/scopedSessions.integration.ts` | Create | server 侧集成 |
| `test/agentManagerScope.unit.test.ts` | Create | daemon 侧单测（扩展 agentManager.test.ts 风格） |
| `CHANGELOG.md` | Modify | Unreleased 归集（不 bump 版本，沿用当前策略） |

---

### Task 1: schema + db-schema.md

**Files:** Modify `src/db/schema.ts`（agent_sessions，紧随 agents 表注释风格）、`docs/generated/db-schema.md`（手动）

- [ ] **Step 1.1** schema 追加（spec §数据模型逐字）+ 注释含 "no longer written by scoped dispatch; scope-less/LEGACY uplinks still write it"
- [ ] **Step 1.2** `set -a; source .env; set +a; npm run db:push` → 两表 applied（agent_sessions + 索引）
- [ ] **Step 1.3** db-schema.md 手动补一节
- [ ] **Step 1.4** typecheck 绿
- [ ] **Step 1.5** Commit `feat(db): agent_sessions table`

### Task 2: server scope 解析与协议注入（TDD）

**Files:** Modify `agentConfig.ts`、`core.ts`、`conversationTurnDispatch.ts`；Create `test/scopedSessions.integration.ts`

- [ ] **Step 2.1 失败测试**（镜像 `test/channelArtifacts.integration.ts` 的 DB harness；直调函数或构造消息。**注：integration 文件不在 CI glob（ci.yml:46 只收 *.unit.test.ts + src/daemon/*.test.ts），本地跑 `npx tsx test/…` + DB env**）：
  1. `resolveScope(channel row)`：type=thread → ("thread", id)；type=channel → ("channel", id)（纯函数单测点，spec §scope 解析）
  2. dispatch 线程消息 → 发出的 `agent:start` config 含 `scope={type:"thread",id:线程频道id,sessionId:null}`（冷启）
  3. 预置 agent_sessions 行 → config.scope.sessionId 取到该行值
  4. 频道顶层消息 → scope.type="channel"
  5. `agent:deliver` 消息体含同款 scope
  6. 手动重启（startAgent/agentStartTarget 无频道上下文）→ config **无 scope 字段**（LEGACY），顶层 sessionId 照旧下发
- [ ] **Step 2.2** 跑测试确认红。
- [ ] **Step 2.3 实现**：
  - `agentConfig(agentId, scopeCtx?: {channelId})`：有 ctx → 查 channels 行判 type → 查 agent_sessions 得 sessionId → 返回 `{...原字段, scope: {type, id, sessionId}}`（顶层 sessionId 字段**继续返回**，rollout 兼容）
  - dispatch/`agentStartTarget` 装配处传 ctx；`sendAgentStart`/`sendAgentDeliver`（core.ts:1038/1051）把 target 侧 scope 并入消息（start→config.scope；deliver→msg.scope）
  - `startAgent`（core.ts:1205 手动重启）不传 ctx → 无 scope
  - deliver 构造点（**grep `sendAgentDeliver` 调用点**，不是 grep 字面 "agent:deliver"——946/1070/1088 的 payload 不含该字面量）：`core.ts:946`（assignTask，线程 ctx 现成）、`core.ts:1003`（setTaskStatus）、`core.ts:1070`（wakeAgentForReplyCoordination）、`core.ts:1088`（wakeAgentForLifecycleNotice——频道已删场景拿不到频道行 → 自然落 LEGACY；DM → ("channel", dmChannelId)。**均为有意行为**）、`conversationTurnDispatch.ts:167`（主派发）——五处加 msg.scope；`reconnectCatchup.ts:193` **故意不加**（LEGACY）
  - `agentStartTarget`（core.ts:1157）加可选 ctx 参 + `ConversationTurnDispatchDeps.agentStartTarget`（conversationTurnDispatch.ts:39）接口加可选参 + 调用点（core.ts:943/999/1067/1085/1206、conversationTurnDispatch.ts **:153**（deliverAgentResponsibility，真需传 ctx）与 :364（能力预检，可不变）——可选参兼容既有 mock
- [ ] **Step 2.4** 测试绿 + typecheck。
- [ ] **Step 2.5** Commit `feat(server): scope resolution + protocol injection for start/deliver`

### Task 3: ws 上行分支（TDD）

**Files:** Modify `src/server/ws.ts:128` 区

- [ ] **Step 3.1 失败测试**（并入 scopedSessions.integration.ts）：
  7. `agent:session {agentId, sessionId, scope:{type,id}}` → agent_sessions upsert（不存在则建、存在则更新 sessionId+updatedAt）
  8. 同 agent 两个 scope 两次上行 → 两行互不覆盖
  9. 无 scope 上行 → agents.session_id 旧列照写（旧 daemon 兼容）
- [ ] **Step 3.2** 红 → 实现分支 → 绿 → typecheck
- [ ] **Step 3.3** Commit `feat(server): scoped agent:session uplink`

### Task 4: daemon scope 体系（TDD——键与路由）

**Files:** Modify `agentManager.ts`、`daemon/index.ts`；Create `test/agentManagerScope.unit.test.ts`（镜像 `agentManager.test.ts` 既有 mock runtime 风格）

- [ ] **Step 4.1 失败测试**：
  1. `scopeKey(agentId, scope?)`：`a:t:chan` / `a:thread:th` / 无 scope → `a:legacy`
  2. `deliver(agentId, …, {scope})` 两次不同 scope → 起**两个** runtime（mock runtime 计数）
  3. 同 scope 二次 deliver → 复用同一 Running（单飞）
  4. `running()` 返回 **agentId 去重**（两个 scope 运行 → 一个 agentId）
  5. config.scope.sessionId 传给 runtime spawn 的 sessionId 参数；LEGACY 用 config 顶层 sessionId
  6. `onSession` 上行消息带 `scope: running.config.scope`（无则不带）——mock conn 断言
- [ ] **Step 4.2** 红。
- [ ] **Step 4.3 实现**：
  - `AgentConfig` 加 `scope?: {type:"channel"|"thread", id:string, sessionId:string|null}`
  - `index.ts:104` start 传 `{...msg.config, serverUrl}`（scope 已在 config）；`:106` deliver meta 加 `scope: msg.scope`
  - agentManager：`scopeOf(config|meta)` → key；`start(agentId, config)` 全链以 key 判重/入队/launch；`deliver` 以 meta.scope 路由
- [ ] **Step 4.4** 绿 + typecheck + 既有 `agentManager.test.ts` 全绿（LEGACY 键使旧用例无 scope → 行为等价，**不应需要改旧断言**；需要改=红旗，停下检查）
- [ ] **Step 4.5** Commit `feat(daemon): scopeKey routing for start/deliver`

### Task 5: daemon 8 状态迁移（TDD——并发正确性）

**Files:** Modify `agentManager.ts`（按 spec §daemon 改动表逐行）；扩 `test/agentManagerScope.unit.test.ts`

- [ ] **Step 5.1 失败测试**（每行迁移表至少一断言，含三行 sender 穿透）：
  6. 压力排队中 scope-A 的 start 不被 scope-B start 覆盖 config（startQueue 按 scopeKey 去重）
  7. scope-A starting 在途 → scope-B start 返回**自己的** promise（不是 A 的）
  8. pendingDelivers 按 scope 消费（B 的 startup 不吃 A 队列）
  9. stop(agentId) 停该 agent **全部** scope：两 Running 皆清 **且在途 scoped start 被取消**（starting 前缀遍历）
  10. reset → 逐 scope 上行 `agent:session null`；server 侧清表落点 = **core.ts `resetAgent()`（:1240 result.ok 后，与现有 sessionId:null 同处追加 `delete agent_sessions where agentId`）**——它是下行控制发送方，ws/index 侧不存在 agent:reset 接收分支
  11. sleeping 仅当无其它存活 scope，**且 idle 收尾只停自己的 scope**：scope-A idle 睡、B 在跑 → 不上报 sleeping + **B 的 runtime 仍存活**；实现要求：resetIdle 定时器 fire 调 `sleepScope(scopeKey)`（新），用户 stop/sleep/reset 走 `sleep(agentId)`=停全部
  12. deliveryEpochs/`deliveryPreparationTails`/deliveryCancellationErrors/deliveryPreparations/controlTails（**五个 Map，:57-62**）按 scopeKey——A teardown 不作废 B 在途 admission（mock 断言 epoch 隔离）；`:56 deliveryAdmissions` 按 deliveryId 键控，**显式不迁**（防误改）
  13. activeReplyPreviews 键 scopeKey **且三个消费者穿透**：`sendAgentActivity`(:278)/`sendAgentTrajectory`(:283)/`finishReplyPreview`(:288) 签名从 agentId 加 scope 维度——mock 断言两 scope 并发时各自的打字指示流都开启、activity 归因不串台
  14. `dequeue(agentId)`：队列项 per-scope 化后遍历删除该 agentId **全部**排队项；`invalidateDeliveryLifecycle`/`rejectPendingDeliver` 以 agentId 前缀遍历 scopeKey 键控的 Map（排队 scope 的 pending deliver 被正确拒绝）
- [ ] **Step 5.2** 红 → 按 spec 表逐项迁移 → 绿 → 全量回归（agentManager.test.ts + 三个 scopedSessions + 既有 mime/artifact 套件）。
- [ ] **Step 5.3** Commit `feat(daemon): per-scope keyed state migration (8 sites, senders threaded) + teardown granularity`

### Task 6: CHANGELOG + 发版记账

- [ ] **Step 6.1** CHANGELOG `[Unreleased]` 加 scoped sessions 条目（不 bump 版本——沿用「归集待发」策略，PR 描述注明 daemon 变更待下次 Release）。
- [ ] **Step 6.2** Commit `docs(changelog): scoped sessions (unreleased batch)`

### Task 7: e2e（隔离栈）

- [ ] **Step 7.1** `npm run dev:e2e:up`；agent 加入 #all；开两条线程 T1/T2，**同时**触发两线程消息 → 观察 daemon 日志两个 runtime 进程并发、各自线程内回复正确
- [ ] **Step 7.2** T1 后续消息 → `agent_sessions` 出现 thread 行且 sessionId 稳定复用（DB 查证）；频道顶层消息 → channel 行独立
- [ ] **Step 7.3** daemon 断线重连（杀 daemon 进程重启）→ running() 对账不误杀，agent 不被标 inactive
- [ ] **Step 7.4** LEGACY 冒烟：UI 手动重启 agent（无 scope 路径）→ 正常起、走旧列；`wt` 内模拟旧 server 不可行则以单测 6 覆盖为准（PR 注明）
- [ ] **Step 7.5** `dev:e2e:down`

### Task 8: doc-sync + PR

- [ ] **Step 8.1** ARCHITECTURE.md：daemon 调度模型描述（per-agent 单链 → per-scope）、agent_sessions、协议 scope 字段、LEGACY 回退。
- [ ] **Step 8.2** FEATURES.md 勾选项；`docs/tech-debt-tracker.md`：MEMORY.md 并发竞态条目（spec 已知风险）+ agents.session_id 停写（scoped 路径）注记 + **scoped sessions 需下次 daemon 发版才到 prod**（merged ≠ shipped）。
- [ ] **Step 8.3** 全量：schema push 后全部测试 + typecheck 双绿。
- [ ] **Step 8.4** Commit docs + push + `gh pr create`（未认证则存 PR body 于 docs/superpowers/ 并报告）。

## 验证汇总（对齐 spec §验证）

单测（scope 解析/键/路由/8 状态）→ 集成（config.scope 组装、协议双分支、upsert 隔离）→ e2e（双线程并发、sessionId 复用、重连对账、LEGACY 冒烟）→ doc-sync。**旧行为回归锚点：agentManager.test.ts 旧断言零修改通过。**
