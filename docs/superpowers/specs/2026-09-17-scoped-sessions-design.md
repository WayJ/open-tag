# 作用域会话（Scoped Sessions）— 设计

日期：2026-09-17 · 状态：待评审 · v1 边界：仅会话作用域（记忆分层/记忆上行为后续切片）

## 背景与目标

现状：会话绑定在 agent 粒度——一个 agent 跨所有频道/线程共享**一条** session 链
（`agents.session_id` 单值，`claude --resume` 单链）。后果：
1. **队头阻塞**：线程 A 的长任务占线，线程 B / 频道顶层消息只能排队
2. **上下文稀释**：无关频道消息混进同一条会话链
3. 与 Claude Tag 的「一线程一持久会话 + 频道自有会话」模型不符

**目标（v1）**：会话绑定到 **(agent, scope)**——scope = 频道（顶层消息）或 线程
（thread 频道）。同 agent 不同 scope 各自独立会话链、**可并发运行**；
同 scope 内维持单飞（session 链串行 append 的既有约束不变）。

**非目标（v1 明确不做）**：
- 记忆分层（频道共享/私有记忆）——后续切片
- agent 记忆上行/跨机迁移——已另行设计，本切片不依赖
- 单 agent 多 scope 的 MEMORY.md 并发写竞态修复（见「已知风险」，文档化接受）
- 会话正文（jsonl）上云/跨机——维持 Claude Tag 语义：平台持久的是**会话 id 绑定与
  线程消息本体**（server DB 已有），runtime 本地 transcript 仍是机器私有、可丢可重建

## 数据模型（`src/db/schema.ts`）

```ts
// Scoped sessions: one persistent runtime session per (agent, channel|thread),
// mirroring the "one persistent session per thread" model. agents.session_id is
// legacy (agent-wide single chain) — kept readable for compat; no longer written by
// scoped dispatch, but scope-less/LEGACY uplinks still write it (see fallback section).
export const agentSessions = pgTable("agent_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  serverId: uuid("server_id").notNull().references(() => servers.id),
  agentId: uuid("agent_id").notNull().references(() => agents.id),
  scopeType: text("scope_type").notNull(),   // "channel" | "thread"
  scopeId: uuid("scope_id").notNull().references(() => channels.id), // thread scope → thread's own channel id
  sessionId: text("session_id"),             // null until first runtime report
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  scopeUniq: uniqueIndex("agent_sessions_scope_uniq").on(t.agentId, t.scopeType, t.scopeId),
  byAgent: index("agent_sessions_agent_idx").on(t.agentId),
}));
```

线程 scope 的 `scopeId` = 线程自身的 channel id（线程在 channels 表有独立行，
`parentMessageId` 指回父消息）——与 `resolveTarget` 归一化结果一致。

## 服务端改动

### 路由（wake/start/deliver 带 scope）

现有链路：`conversationTurnDispatch` → `sendAgentStart(serverId, target, agentId, …)`
（conversationTurnDispatch.ts:42）→ core.ts:1038 组 `{type:"agent:start", agentId, config}`
发到 machine。改动：
- `agentConfig` 组装处（core.ts `target.cfg` / agentConfig.ts）按消息 target 解析 scope
  （线程 target → `(thread, threadChannelId)`；频道 target → `(channel, channelId)`），
  查 `agent_sessions` 得 `scopeSessionId`（无行 = null 冷启），一并放进 config：
  `config.scope = { type, id, sessionId }`
- deliver 消息（同通道构造）同样带 `scope`
- `agents.session_id`：**scoped 派发路径停写**（scope-less 上行分支继续写，见回退键节）；读兼容保留；tech-debt 记录

### WS 上行（`agent:session` 协议扩展）

现 ws.ts:128：`{type:"agent:session", agentId, sessionId}` → 写 agents 列。
改为：消息带 `scope?: {type, id}` 时 upsert `agent_sessions`（冲突更新 sessionId +
updatedAt）；无 scope（旧 daemon）仍写旧列——**新旧协议双向兼容**。

### 兼容与迁移

- 旧 daemon 连新 server：行为不变（走旧列，agent 级单链）
- 新 daemon 连旧 server：上行带 scope 被忽略?——不做版本协商，v1 以部署顺序保证
  （先 server 后 daemon；自托管单仓）
- 既有 agents.session_id 数据：不迁移。切到作用域模型后所有 scope 首启为冷启
  （会话链重新开始；记忆与频道历史都在，损失=旧链的工具中间态上下文——与
  Claude Tag「沙箱释放」语义同级，可接受）

## daemon 改动（`src/daemon/agentManager.ts`，核心面）

`Running` Map 键 `agentId` → **`scopeKey = agentId + ":" + scopeType + ":" + scopeId`**。
**除 Map 键外，agentManager 内全部按 agentId 键控的状态必须同步迁移**（评审逐一核实，
漏一处即并发 bug）：

| 状态（行号） | 迁移 |
|---|---|
| startQueue 去重 :305-312（`q.agentId === agentId` 命中即**覆盖排队 config**） | 按 scopeKey 去重——否则压力下线程 scope 排队项被频道 scope start 静默顶掉 |
| `pendingDelivers` :54（queuePendingDeliver / acceptPendingStartup） | 按 scopeKey——否则任一 scope 先启动吃掉整队投递 |
| `starting` Map :53（launchStart set :329 / delete :334；admitDelivery `starting.has` :744；stopAll 迭代 :141） | 按 scopeKey——否则 scope A 启动在途时 scope B 的 start() 在 :305 直接拿到 A 的 promise（**B 被静默丢弃**）、投递走错排队分支 |
| `activeReplyPreviews` :55 / startReplyPreview :263（`existing` 即弃） | 键改 `scopeKey`（或 agentId+channelId）——否则第二 scope 的打字指示永不开启 |
| `deliveryEpochs` / `deliveryCancellationErrors` / `deliveryPreparations` / `deliveryPreparationTails` / `controlTails` :57-62（五个 Map） | 按 scopeKey——否则一个 scope 的 teardown 作废另一 scope 在途 durable admission（假 NACK） |
| `running(): string[]` :127（index.ts:149 上报 → server ws.ts:63/207-215 对账标 stale） | **继续返回 agentId**——从 scopeKey 派生去重，daemon 重连对账不破 |
| `agent:stop` / `agent:reset`（index.ts:117-119，按 agentId） | stop = 停该 agent **全部** scope；reset 追加清空该 agent 的 `agent_sessions` 行 + 逐 scope 上行 `agent:session null` |

`deliver` 路由：消息带 scope（server 直传 `{type,id}`，daemon 不自行推导——杜绝
两端推导分叉）；无 Running 则 wake 该 scope 进程。单飞/idle/nudge/turnId 级投递缓冲
随 Running 天然 per-scope。

**sleeping 语义**：某 scope idle 睡眠仅在**该 agent 无其它存活 scope** 时上报
`sleeping`（否则 UI 会看到"睡了但还在打字"的矛盾状态）。

## scope-less 路径与混合机队（统一回退键）

三条真实存在的无 scope 路径 + 新旧混部，统一解法——**daemon 定义 `LEGACY` 回退 scope**
（scopeKey 后缀 `:legacy`，会话用 `agents.session_id` 旧列）：

1. **手动重启**（core.ts:1211 `agentConfig(agentId)` 无频道上下文）：走 LEGACY scope，
   resume 旧列——重启语义保持今天的单链行为
2. **reconnectCatchup**（:188 硬离线 start 无 scope；:192-195 软离线 deliver
   `target: ""`）：均路由 LEGACY scope
3. **新 daemon + 旧 server**（daemon 是独立 npm 包，机器各自更新，可能先于 server
   升级——与 AGENTS.md「merged ≠ shipped」机型一致）：config 无 scope 字段 →
   LEGACY scope，行为等同旧版单链
4. **旧 daemon + 新 server**：忽略 config.scope、上行无 scope → server 写旧列。
   config 顶层 `sessionId` **rollout 期继续下发**（旧 daemon 依赖），新 daemon 以
   `scope.sessionId` 优先、顶层字段仅 LEGACY scope 使用

两种 daemon 各自自洽、无跨写污染（旧只写旧列、新 scoped 路径只写 agent_sessions）。

### scope 解析（**server 侧**纯函数，单测点；daemon 不做推导，仅按协议直传的 scope 拼 key）

```ts
function scopeOf(target: string, meta: { threadChannelId?: string; channelId: string }): { type: "channel" | "thread"; id: string }
// 线程 target（thread:shortid / #chan:shortid 解析后的 threadChannelId 存在）→ ("thread", threadChannelId)
// 否则 → ("channel", channelId)
```
协议直传 scope、daemon 只拼 key（**已选**：server 已解析 target，直接下发
`{type,id}`，杜绝两端推导分叉）。

## 已知风险（v1 接受并记录）

**同 agent 多 scope 并发写 MEMORY.md**：两个 scope 的 turn 同时收尾、各自
read-modify-write stateDir 下 MEMORY.md → 后写覆盖前写（丢失更新）。窗口=turn 收尾
瞬间重叠；影响=丢一次记忆增量。Claude Tag 以「平台管记忆 + 沙箱隔离」规避；
open-tag 文件记忆带此竞态。v1 文档化 + tech-debt 条目；v2 解法与「记忆上行为
server 数据」的设计合流（daemon 代理写或上行时合并）。

## 验证（TDD）

- **单测**：agent_sessions upsert 冲突更新；config.scope 组装（频道/线程 target 两态）；
  新旧 agent:session 协议分支（带/不带 scope）
- **集成**：dispatch 线程消息 → agent:start config.scope.sessionId 取到已存在行；
  冷启（无行）→ runtime 上行 → 行建立；同 agent 两个 scope 各自 upsert 互不覆盖
- **e2e（隔离栈）**：同 agent 加入频道 + 开两条线程；两线程同时触发 →
  daemon 起**两个** runtime 进程并发处理 → 各自线程内正确回复；
  同线程后续消息 resume 同一 sessionId；频道顶层消息走频道 scope 独立链；
  记忆竞态场景人工演示（记录窗口存在，不修）；daemon 断线重连 → running() 对账
  不误杀在跑 agent（回归锚点）
- LEGACY 回退三路径各一条冒烟（手动重启 / catchup / 旧 server 模拟）
- typecheck 双绿；doc-sync：db-schema.md / ARCHITECTURE（daemon 调度模型描述）/
  FEATURES / CHANGELOG；`src/daemon/**` 变更 → **daemon 发版**（版本号随下次发版批次，
  沿用当前「Unreleased 归集」策略）

## 实现载体

worktree `scoped-sessions`。涉及：schema.ts、core.ts（config/agent:start、deliver、手动重启路径、ws 上行分支）、
agentConfig.ts、conversationTurnDispatch.ts（scope 透传）、reconnectCatchup.ts、
agentManager.ts（Running 键 + 上表全部键控状态迁移 + deliver 路由 + onSession +
stop/reset 语义）、daemon index.ts（上报/协议）、runtime 层零改动（sessionId 既有传参）、docs 同步。
