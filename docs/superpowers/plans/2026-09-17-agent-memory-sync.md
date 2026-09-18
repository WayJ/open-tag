# Agent Memory Sync（记忆上行/恢复）Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agent 记忆（白名单 markdown）turn 结束去抖上行 server（一行 jsonb+digest），新机/分叉按三态恢复——跨机迁移的数据地基。

**Architecture:** 规范序列化+digest 放共享模块 `src/daemonProtocol.ts`（防两平面漂移）；config 只带 digest、全量走 `memory:get` RPC；恢复在 startNow seed 前评估，判定仅靠 本地↔server digest 直比。

**Tech Stack:** TS、drizzle（补 `varchar` import）、node crypto sha256、无新依赖。

**Spec:** `docs/superpowers/specs/2026-09-17-agent-memory-sync-design.md`（规范序列化/决策树/白名单为硬约束）

---

## 前置

- [ ] **0.1** `npm run wt:add -- memory-sync`；`cd ../open-tag-memory-sync`；`cd docs-site && npm install`。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/daemonProtocol.ts` | Modify | `MEMORY_WHITELIST`、`canonicalMemoryFiles()`（排序+U+0001 拼接）、`memoryFilesDigest()`（sha256 hex）、`EMPTY_MEMORY_DIGEST`、`validateMemoryFiles()`（条目名/数量/512KB）、`decideMemoryRestore()`（三态+两哨兵纯函数） |
| `src/db/schema.ts` | Modify | `agent_memory` 表（files jsonb + memoryDigest varchar(64) + machine 审计列）+ import `varchar` |
| `src/server/agentConfig.ts` | Modify | config 增 `memoryDigest?`（只 select varchar 列） |
| `src/server/ws.ts` | Modify | `agent:memory` 上行分支（租户守卫+校验+现算 digest+upsert）；`memory:get` RPC（requestId 回 `memory:data` 或空 map） |
| `src/daemon/agentManager.ts` | Modify | turn 结束去抖上行（agentId 键控 Map 登记类头）；startNow 恢复三态（先于 seed） |
| `src/daemon/index.ts` | Modify | machineId 注入 AgentManager；`memory:data` 等待器 |
| `src/daemon/stateFiles.ts` | Modify（如需） | 白名单枚举助手 `listManagedMemoryFiles(root)` |
| `test/memoryProtocol.unit.test.ts` | Create | 跨侧一致性+digest 稳定性+校验 |
| `test/memorySync.integration.ts` | Create | server 侧集成 |
| `test/agentMemory.unit.test.ts` | Create | daemon 侧（上行/恢复） |

---

### Task 1: 共享协议模块（TDD——全特性地基）

**Files:** Modify `src/daemonProtocol.ts`；Create `test/memoryProtocol.unit.test.ts`

- [ ] **1.1 失败测试**：
  1. `canonicalMemoryFiles`：键按 UTF-8 字节序排序（构造 `{"b.md":"1","a.md":"2","notes/z.md":"3"}` → 序列化以 `a.md` 开头、`notes/z.md` 结尾）；分隔符为字面 `\u0001`（断言输出含 `"\u0001"` 字节）；内容原样（CRLF/尾空行不动）
  2. `memoryFilesDigest`：同一 map 两次调用相等；键序不同（JS 对象插入序）的等价 map digest 相同（**键序无关性——jsonb 陷阱的正面锁**）；`{}` 的 digest = 空串 sha256（钉死哨兵常量 `EMPTY_MEMORY_DIGEST`）
  3. `validateMemoryFiles`：白名单三类通过；`../evil.md`/`notes/a/b.md`/`x.txt`/`子目录`/`README.md`（非白名单根级名）拒绝；>512KB 拒绝；>64 文件拒绝（防灌爆）；返回 `{ok}` 或 `{ok:false, reason}`
  4. `decideMemoryRestore(localFiles, serverDigest)`：serverDigest undefined → skip；== EMPTY_MEMORY_DIGEST → skip；== 本地 digest → skip；≠ 且本地空 → pull+restoreInPlace；≠ 且本地非空 → pull+import（返回动作对象，纯函数）
- [ ] **1.2** 红（导出不存在）。
- [ ] **1.3 实现**（daemonProtocol.ts，crypto `createHash`；白名单正则收紧为散文三类 `^(MEMORY\.md|personality\.md|notes/[A-Za-z0-9_.\-]+\.md)$`（与 spec「只认这三类」一致，杜绝任意根级 .md））。
- [ ] **1.4** 绿 + typecheck。
- [ ] **1.5** Commit `feat(protocol): canonical memory serialization + digest + validation`

### Task 2: schema

**Files:** Modify `src/db/schema.ts`（import 行加 `varchar`）、`docs/generated/db-schema.md`

- [ ] **2.1** `agent_memory` 表（spec §数据模型逐字，含两条注释）；import 补 `varchar`
- [ ] **2.2** `set -a; source .env; set +a; npm run db:push` → 表+唯一索引 applied
- [ ] **2.3** db-schema.md 手动一节；**2.4** typecheck；**2.5** Commit `feat(db): agent_memory table`

### Task 3: server 侧（TDD）

**Files:** Modify `agentConfig.ts`、`ws.ts`；Create `test/memorySync.integration.ts`（镜像 channelArtifacts harness）

- [ ] **3.1 失败测试**：
  1. `agentConfig`：agent_memory 有行 → config.memoryDigest = 行 digest；无行 → 无该键（select 只取 varchar 列——断言查询列集可用 explain 或直接信实现+代码审查）
  2. `agent:memory`（files 合法）→ 行 upsert（files+digest+machineId+updatedAt）；同 agent 二次不同内容 → 更新
  3. 上行租户守卫：跨 server agentId → 丢弃无行
  4. 非法条目名/超限 → 丢弃无行（日志告警）
  5. server 计算的 digest == daemon 侧 `memoryFilesDigest` 同输入（**跨侧一致性在集成层再锁一次**）
  6. `memory:get {requestId}` → `memory:data {requestId, files}`；无行 → files={}
- [ ] **3.2** 红 → **3.3 实现**：agentConfig +1 查询（leftJoin agent_memory 只取 memory_digest）；ws 分支两处（上行放 agent:session 邻近；memory:get 仿现有 RPC 分支——requestId 必须回包）
- [ ] **3.4** 绿 + typecheck + scopedSessions/channelArtifacts 集成回归
- [ ] **3.5** Commit `feat(server): agent:memory uplink + memory:get RPC + config digest`

### Task 4: daemon 上行（TDD）

**Files:** Modify `agentManager.ts`、`index.ts`；Create `test/agentMemory.unit.test.ts`（镜像 agentManagerScope mock 风格）

- [ ] **4.1 失败测试**：
  1. turn 结束（completeTurn 触发）后 2s 去抖窗内只读一次文件、只发一条 `agent:memory`（mock conn 捕获；files 为白名单实读 tmp stateDir）
  2. 内容未变（第二个 turn 结束）→ 不发（内存缓存 digest 命中）
  3. 同 agent 两 scope 先后 turn 结束 → 合并为一条（去抖按 agentId）
  4. machineId 随消息携带
  5. `reset(clearMemory)` → 取消挂起去抖 timer；随后 turn 结束上传**白名单实际内容**（clearMemory 后为 reset 存根、wipe 重启后为 seed 内容——均达成 server 旧快照被替换的 reset 语义；注意自然流中 `{}` 不可达，勿断言它）
- [ ] **4.2** 红 → **4.3 实现**：AgentManager 构造注入 machineId（index.ts readMachineId()）；新 `memoryUploadTimers: Map<agentId, timer>` + `memoryUploadCache: Map<agentId, digest>`（**登记类头键控清单注释**）；completeTurn 内 `scheduleMemoryUpload(agentId)`；读文件用 stateFiles 白名单枚举
- [ ] **4.4** 绿 + agentManagerScope.unit.test.ts 旧断言零修改（注：旧测试面为 test/agentManagerScope.unit.test.ts 19 用例） + agentManagerScope 19 项回归 + typecheck
- [ ] **4.5** Commit `feat(daemon): debounced memory upload on turn end`

### Task 5: daemon 恢复三态（TDD）

**Files:** Modify `agentManager.ts`（startNow 恢复段（插点见 5.3））、`index.ts`（memory:data 等待器）；扩 `test/agentMemory.unit.test.ts`

- [ ] **5.1 失败测试**（恢复决策纯函数 `decideMemoryRestore(localFiles, serverDigest)` 放 daemonProtocol——**补进 Task 1**：输入本地集+server digest（含 undefined/EMPTY 两哨兵）→ {action: skip|pull|restoreInPlace|import}，排序/哨兵全测；本任务测 daemon 接线）：
  1. 态1：stateDir 空 + config.memoryDigest=X + mock RPC 回 files → 启动后白名单文件落盘，seed 跳过（MEMORY.md 存在）
  2. 态2：本地内容 digest == config.memoryDigest → 不发 memory:get、零写盘
  3. 无行哨兵：config 无 memoryDigest → 不发 RPC、零写盘（本地非空也不动）
  4. 空 map 哨兵：config.memoryDigest == EMPTY_MEMORY_DIGEST → 同上跳过
  5. 态3：本地非空 + digest 不等 → server 版写 `notes/imported/<yyyymmddTHHMMSSZ>.md`（**断言文件名无冒号**）+ MEMORY.md 尾部追加索引行（断言原内容未动、仅追加）；本地其余文件不覆盖
  6. restore 先于 seed：restore 后 seed 的 ENOENT 检查不触发写
  7. EPERM 容忍：兄弟 scope 并发 restore（复用 seed 同款 mock 竞态）→ 双方启动成功
- [ ] **5.2** 红 → **5.3 实现**要点：restore 插在 `ensureManagedDirectory` 之后、seed 的 ENOENT 读取之前；态3 追加索引行遇 MEMORY.md 缺失（ENOENT）→ 新建含索引行的最小 MEMORY.md；兄弟 scope 并发态3 可能双份导入（同秒同名 EEXIST/双索引行）——**无害，接受**；`memory:data` 等待器（新短常量 `MEMORY_GET_TIMEOUT_MS = 5s`——**不要**沿用 15s+心跳重发范式，单发+超时即弃；串在启动路径上，常态分支零延迟；超时=放弃恢复按无行处理+日志）；restore 段在 seed 检查前；`atomicWriteManagedFile` 复用；失败不阻塞启动（try/catch 全包，恢复失败 = 本地行为）
- [ ] **5.4** 绿 + 全回归（agentManager 旧/新 + scopedSessions 集成）+ typecheck
- [ ] **5.5** Commit `feat(daemon): three-state memory restore before seed`

### Task 6: CHANGELOG + e2e + doc-sync + PR

- [ ] **6.1** CHANGELOG `[Unreleased]`（Added: agent memory sync）。
- [ ] **6.2 e2e**（dev:e2e 栈）：
  1. 触发 agent 一个 turn（线程消息）→ 等 turn 结束+去抖 → `agent_memory` 行存在且 digest==本地算
  2. 停栈 → 清空该 agent stateDir → 起栈 → 再触发 → 记忆原位恢复（MEMORY.md 内容回来，态1）
  3. 手改 DB 行内容（模拟他机分叉）→ 重启 daemon → 触发 → `notes/imported/` 出现无冒号文件 + MEMORY.md 索引行（态3）
  4. 无改动重启 → 零导入（态2）；reset clearMemory → 下次 turn 后 server 行不再含 reset 前记忆
- [ ] **6.3** doc-sync：ARCHITECTURE（协议：agent:memory/memory:get、恢复规则三态、白名单）、FEATURES、db-schema（Task 2 已做）、tech-debt（MEMORY.md 并发写竞态条目更新为「上行去抖已收窄+运行时写竞态仍存」）。
- [ ] **6.4** 全量测试 + typecheck；Commit docs；push；`gh pr create`（未认证 → PR body 存 docs/superpowers/ 并报网页入口）。

## 验证汇总

单测（协议跨侧/上行去抖/三态接线）→ 集成（upsert/守卫/RPC 往返/跨侧 digest）→ e2e 四态实测 → doc-sync。旧测试零修改红线贯穿。
