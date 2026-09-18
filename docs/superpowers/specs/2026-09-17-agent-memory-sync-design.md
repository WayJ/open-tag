# Agent 记忆上行与恢复（Memory Sync）— 设计

日期：2026-09-17 · 状态：待评审 · 定位：跨机迁移地基 + MEMORY.md 并发竞态的 v2 解法

## 背景与目标

agent 记忆（`stateDir/MEMORY.md` + `notes/*.md` + `personality.md`）只存在于 daemon
机器本地：换机/机器故障 = 同事失忆；且 scoped-sessions 引入的多 scope 并发写
MEMORY.md 存在丢失更新竞态（tech-debt 在案）。

**目标**：
1. 记忆变更时**上行** server 持久化（每 agent 一份快照）
2. 新机器首启时**恢复**（三态规则，本地优先、冲突导入不丢失）
3. 上行合并点成为将来跨机迁移/故障转移的地基

**非目标（v1 不做）**：
- 会话 transcript 上传（已决策：记忆=连续性，transcript 脏且脆弱）
- 迁移编排命令（改绑 machineId 已有既有路径；本切片只做数据层）
- 频道记忆分层、工作区共享记忆（后续切片）
- daemon 代理写记忆（仍由 runtime 直接写文件；上行只读快照）

## 数据模型

```ts
// One row per agent: the latest managed-memory snapshot uploaded by the daemon
// that ran the agent. Files are small markdown — stored inline as jsonb
// (path → content), no object storage, no zip, no manifest.
export const agentMemory = pgTable("agent_memory", {
  id: uuid("id").defaultRandom().primaryKey(),
  serverId: uuid("server_id").notNull().references(() => servers.id),
  agentId: uuid("agent_id").notNull().references(() => agents.id),
  files: jsonb("files").notNull().$type<Record<string, string>>(),
  memoryDigest: varchar("memory_digest", { length: 64 }).notNull(), // sha256 of canonical serialization — agentConfig selects ONLY this (no jsonb detoast on hot path)
  uploadedByMachineId: uuid("uploaded_by_machine_id"), // bare (no FK): machines can be deleted/re-registered; audit hint only
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  agentUniq: uniqueIndex("agent_memory_agent_uniq").on(t.agentId),
}));
```

白名单（上行与恢复都只认这三类，其余文件不碰）：
- `MEMORY.md`
- `personality.md`
- `notes/*.md`（一层目录、`.md` 后缀；禁止路径遍历——条目名校验 `^(MEMORY\.md|personality\.md|notes/[A-Za-z0-9_.\-]+\.md)$`（与三类散文一致））

总量上限 **512KB**（超限 server **丢弃 + 日志告警**——WS fire-and-forget 无应答通道，
不存在 400 路径；防 jsonb 灌爆）。

## 协议与流程

### 摘要与拉取（config 不带全量）

- **规范序列化（两侧必须逐字节一致——放共享模块 `src/daemonProtocol.ts`，该文件
  本就是防两平面 wire 契约漂移而设）**：条目按路径 UTF-8 字节序排序，
  `path + "\u0001" + content + "\u0001"` 依次拼接（**字面转义 U+0001 (SOH) 作分隔符**）→ 对拼接结果的 UTF-8 字节取
  sha256（hex）。内容原样读取，**禁止任何换行/编码规范化**。陷阱背景：postgres
  jsonb 不保留键序，Node JSON.stringify 按插入序——不钉死算法则任何 ≥2 文件的
  agent 两侧 digest 恒不等，每次启动伪态 3。跨侧一致性单测：同一 fixture map，
  server 侧与 daemon 侧 import 点各算一次，断言相等
- `agentConfig` 返回值增加 `memoryDigest?: string`（取 `agent_memory.memory_digest`
  列；无行则不带）。每次 start 的 +1 查询只取该 varchar 列，jsonb 不 detoast
- daemon 需要全量时显式拉：WS RPC `memory:get {requestId, agentId}` →
  server 回 `memory:data {requestId, files}`（范式抄 `deliveryCommitWaiters`
  的 requestId 等待器，daemon/index.ts:46-78）。**config 热路径零膨胀**

### 上行（daemon → server）

- 时机：agent **turn 结束**（completeTurn 路径）后读白名单文件 → 算 digest →
  与本 daemon 内存缓存的上次上行 digest 比对——有变才发（缓存仅用于省流量，
  **不参与恢复决策**，daemon 重启丢缓存无害——重启后首个 turn 必重传一次，
  幂等 upsert 无害；restore 评估时的 digest 可顺带播种该缓存）
- **按 agent 去抖 2s**（新 agentId 键控 Map——登记进 agentManager 类头的键控
  清单注释；记忆是 agent 级资源，agent 粒度键控正确，与 controlTails 同类）
- 消息：`agent:memory {agentId, files, machineId}`（machineId 从 index.ts
  readMachineId() 注入 AgentManager）
- server：租户守卫 `and(eq(agents.id), eq(agents.serverId))` + 白名单/条目名/
  大小校验 → **经共享模块对 files 现算 digest** → upsert `agent_memory`（files +
  memoryDigest 列同写）；不 publish（前端 v1 不消费）
- 多 scope 并发收尾：去抖天然合并同一 agent 的多个 scope 触发为一次读+发；
  读文件为瞬时快照语义，收窄竞态窗口

### 恢复（每次 agent 启动评估，startNow seed 之前）

判定输入只有两个：**本地白名单文件集** 与 **server digest**（无 per-daemon
"上次快照"状态——daemon 重启不产生任何副作用）：

```
localDigest = sha256(本地白名单文件规范序列化)   // 空目录 = 空 map 的 digest
server 无 memoryDigest（无行）   → 跳过恢复、本地不动（上线首日普遍路径：
                                   既有 agent 本地有记忆、server 无行；下一次
                                   turn 结束上行自然建立 server 行）
memoryDigest == 空串拼接的 sha256（daemon 本地可算常量）→ 同上跳过
                                   （reset wipe 后的 {} 行；防他机残留本地被空导入）
localDigest == memoryDigest      → 态2: 跳过（同内容，无论血统）
                                ≠ → memory:get 拉全量 →
                                    本地为空   → 态1: 原位落盘（正常迁移）
                                    本地非空  → 态3: server 版写
                                               notes/imported/<yyyymmddTHHMMSSZ>.md
                                               （无冒号，NTFS 安全），并在 MEMORY.md
                                               尾部追加一行索引；下一 turn agent 自行合并
（memory:get 无行 → 回空 map，与跳过分支合流）
```

- **restore 先于 seed 检查**：restore 写出 MEMORY.md 后，seed 的 ENOENT 检查
  自然跳过
- restore 多文件写复用 `atomicWriteManagedFile`，与 seed 同款 EPERM/EEXIST
  容忍（兄弟 scope 并发冷启竞态——scoped-sessions 已有先例）+ 幂等
- **本地已有文件除追加索引行外永不覆盖**
- `notes/imported/` 在白名单之外 → 导入文件是一次性侧信道，**有意不再上行**
  （内容经 agent 合并回流 MEMORY.md/notes 后自然进入下一次快照）

### reset 交互

- `reset(clearMemory/wipeWorkspace)`：取消挂起的去抖上行；wipe 后白名单为空 →
  随后任何 turn 结束上行 `{}` 清空 server 快照（server 行被置空，符合 reset 语义）。
  **已知接受**：reset 后若本机立即退役且再无 turn，他机可从旧快照恢复出 reset 前
  记忆——本地优先模型的固有语义

### LEGACY/混部

- 旧 daemon：不上行不拉取，行为不变；旧 server：`agent:memory` 为无 requestId
  的 fire-and-forget → 落空忽略（ws.ts 无 default 分支）；`memory:get` RPC
  由旧 daemon 不发、新 daemon 发给旧 server 会被**静默丢弃**（旧 server 无 default 分支；
  rpc:nack 只存在于 daemon 侧）→ 拉取等待器靠超时兜底（独立短常量 5s、单发不重发——不沿用 15s+心跳范式）。
  且旧 server 不下发 memoryDigest，新 daemon 根本不会发起拉取——该路径近乎
  不可达，无需版本协商

## 安全

- 租户守卫（上行）+ machineId 记录（审计谁传的）
- 白名单/大小/条目名校验三道；内容为 agent 产出的 markdown（本就是提示词
  级信任内容，不引入新面）
- 恢复写盘仅 stateDir 内固定路径（白名单三类 + `notes/imported/` 一次性侧信道）

## 验证（TDD）

- 单测：白名单/条目名/大小校验；规范序列化与 digest 稳定性；**跨侧一致性**
  （同一 fixture，两侧 import 点各算 digest，断言相等）；恢复决策纯函数
  （输入：本地文件集 + server digest（含无行/空 map 两哨兵）→ 跳过/拉取/态1/态3）
- 集成：上行 upsert + 租户拒绝 + 白名单/大小拒绝；config.memoryDigest 下发
  （有行/无行）；memory:get RPC 往返；daemon turn 结束触发上行（变更才发，
  未变不发）
- e2e（隔离栈）：agent 写记忆 → turn 结束 → DB 有快照；清空 stateDir 重启
  daemon → 记忆原位恢复（态 1）；人工制造分叉（改 server 行）→ 重启 →
  imported 文件（无冒号文件名）+ 索引行（态 3）；daemon 重启后内容未变 →
  零导入零副作用（态 2）；reset clearMemory → server 快照被清
- doc-sync：db-schema/ARCHITECTURE（协议+恢复规则）/FEATURES/CHANGELOG；
  `src/daemon/**` 变更 → Unreleased 归集（与积压两批同窗口发版）

## 实现载体

worktree `memory-sync`。涉及：schema.ts、ws.ts（上行分支 + memory:get/memory:data
RPC）、agentConfig.ts（config.memoryDigest）、agentManager.ts（turn 结束去抖上行、
启动恢复三态+restore 先于 seed）、daemon index.ts（machineId 注入 + RPC 等待器）、
stateFiles.ts（如需读助手）、docs 同步。
