# 2026-09-22 — system-admin 平面 batch D（Task 8-9：workspace 列表/删除 + stats + audit-logs + 收尾）

**分支**: `feature/system-admin`（worktree `open-tag-system-admin`）
**设计**: `docs/superpowers/specs/2026-09-22-system-admin-plane-design.md` §8-§9

## 需求

Batch D = Task 8（`GET /api/admin/servers`、`DELETE /api/admin/servers/:id` 硬级联、
`GET /api/admin/stats`、`GET /api/admin/audit-logs`）与 Task 9（`SYSTEM_ADMIN_EMAILS`
提升幂等性测试 + 全量验证 + doc 同步）。TDD（红→绿），逐 task 提交。

## Task 8 — servers/stats/audit-logs（commit 88eefc1）

### FK 枚举（删除事务的核心，schema 全表审计结果）

删除顺序 = 子表先于父表；直接 `serverId` 列的表按列删，无 serverId 的表
（channel/message-scoped）用 `in (select …)` 子查询按本 server 的 channel/message id 删：

| # | 表 | 删除路径 |
|---|---|---|
| 1 | message_mentions | messageId in (select 本 server 消息 id) — 无 serverId 列 |
| 2 | reactions | messageId in (select 同上) — 无 serverId 列 |
| 3 | agent_activity_log | 直接 serverId（bare uuid 列，非 FK，仍可按列过滤） |
| 4 | artifact_versions | 直接 serverId（须先于 artifacts + attachments：attachmentId FK 无级联） |
| 5 | agent_message_decisions | 直接 serverId（messageId×2 / agentId×2 / channelId FKs） |
| 6 | agent_message_observations | 直接 serverId（schema 有级联，仍显式删） |
| 7 | saved_messages | 直接 serverId |
| 8 | attachments | 直接 serverId（先于 messages：messageId FK 无级联） |
| 9 | messages | 直接 serverId |
| 10 | causal_edges | 直接 serverId（先于 turns + agents） |
| 11 | conversation_turns | 直接 serverId（schema 对 serverId/channelId 有级联，仍显式删） |
| 12 | knowledge | 直接 serverId（agentId/createdByAgentId FKs → 先于 agents） |
| 13 | agent_sessions | 直接 serverId（agentId + scopeId→channels） |
| 14 | agent_memory | 直接 serverId（agentId） |
| 15 | artifacts | 直接 serverId（channelId + createdByAgentId） |
| 16 | reminders | 直接 serverId（channelId） |
| 17 | channel_members | channelId in (select 本 server 频道 id) — **无 serverId 列，任务已知表清单遗漏** |
| 18 | channels | 直接 serverId |
| 19 | agents | 直接 serverId（machineId → 先于 machines） |
| 20 | machines | 直接 serverId |
| 21 | join_links | 直接 serverId |
| 22 | system_invites | 直接 serverId |
| 23 | server_sidebar_prefs | 直接 serverId |
| 24 | server_members | 直接 serverId |
| 25 | audit_logs | **UPDATE set targetServerId=null**（FK 指向 servers，NO ACTION；置空保历史而非删行） |
| 26 | servers | 删行本身 |

conversationTurns/causalEdges/agentMessageObservations 三张表的 serverId FK 带
`onDelete: "cascade"`（schema.ts:161/237/305）——级联存在，但只在 servers 行被删除时
触发，而全部显式删除**先于** servers 删行执行，级联只是永不依赖的兜底；其余 20+ 张
子表的 FK 无级联，仍需全枚举。bare uuid 列（无 FK）不影响删除，但
agentActivityLog.serverId 按列过滤一并清理。

### 对任务给定片段的偏离（评审时注意）

1. **`server.deleted` 审计行不能带 `targetServerId`**：`audit_logs.target_server_id`
   有 FK → servers.id（NO ACTION），事务提交后 server 行已不存在，带该字段插入会
   23505/23503 FK 违例 → 500。改为 id + name + slug 放 `metadata`。同理，事务内先把
   已有 audit 行的 `targetServerId` 置空（保 append-only 历史，不删行）。
2. **测试补满全部子表**：任务给的测试只插 servers/channels/members/messages/reactions
   ——空表穿不过 FK，删除路径等于没测。补插 18 张表的行（machine、agent、turn、
   causalEdge、mentions、saved、decisions、observations、activityLog、attachment、
   artifact、version、session、memory、knowledge、reminder、sidebarPrefs、joinLink、
   systemInvite），DELETE 真正穿过每个 FK；删后逐表断言清零（带表名的失败消息）。
   `agentCount === 0` 断言随之改为 `=== 1`（tmp 里现在有 agent，反而真正测到了计数）。
3. **`user.login` 断言自足**：测试内先登录一次 admin，保证 `audit-logs?limit=200`
   必有 user.login 行（不依赖更早测试的副作用，文件既有"无顺序依赖"惯例）。
4. `messages` 插入字段对齐 schema：`seq`（number，手工挑出 Redis 区间，惯例同
   conversationTurns.integration.test.ts）/ `content` / `senderName`；searchText 可空省略。

### 路由行为

- `GET /api/admin/servers`：全量 + ownerName + memberCount + agentCount
  （agentCount 排除软删 deletedAt）。
- `DELETE /api/admin/servers/:id`：isUuid → 404；未找到 → 404；重复删 → 404。
  单事务清全部子表；**不杀 daemon/agent 进程**——server 行没了，agent 认证与
  daemon 重连自然失败（代码内有注释）。提交后 audit `server.deleted`。
- `GET /api/admin/stats`：users total/disabled/systemAdmins、servers（`count()`）、
  agents total（排除软删）/active（thinking|working）、machines total/online。
- `GET /api/admin/audit-logs`：`event` 精确过滤 + `before`（createdAt ISO 游标，
  `Date.parse` 校验）+ newest-first（desc createdAt）+ limit 夹取 1-200。

## Task 9 — 收尾（commit f4eeb74）

- `SYSTEM_ADMIN_EMAILS` 提升测试：设 env → 提升两次（幂等）→ system_admin；
  清 env 再跑 → 仍是 system_admin（promote-only 不降级）；finally 恢复 env。

## 验证（证据）

- 红（Task 8）：`npx tsx --test --test-force-exit src/server/systemAdmin.api.test.ts`
  → 4 pass + 新场景 `TypeError: Cannot read properties of undefined (reading 'find')`
  （`/api/admin/servers` 落 404 fallback，`list.servers` undefined）。
- 绿（Task 8 基础版）：5 pass / 0 fail。
- 加固后（补满子表 + 逐表断言）：一次变量名 `scoped` 与既有 gate-2 检查冲突
  （TS2451）+ agentCount 断言更新 → **5 pass / 0 fail**——DELETE 事务穿过全部
  FK 无违例。
- Task 9 后全量：同命令 → **6 pass / 0 fail**。
- `npm run typecheck`（root + web）→ exit 0（两次）。
- CI 全量：`JWT_SECRET=ci-test-secret DAEMON_BOOTSTRAP_KEY=ci-test-bootstrap-key
  npx tsx --test --test-force-exit test/*.unit.test.ts src/daemon/*.test.ts
  web/src/views/*.test.ts` → 725 tests / 722 pass / 0 fail / 3 skip（既知 skip；
  codexRuntime EPERM flake 未出现）。
- `npm run seed` → "open-tag workspace already exists, nothing to do"（幂等 ✓）。

## 文档同步（docs commit）

- `ARCHITECTURE.md` routes-api admin 组：补 servers 列表/硬级联删除（含
  inArray 路径 + audit_logs 置空保历史 + 不杀进程）、stats、audit-logs 三组端点。
- `docs/authorization.md` system-admin surface：补 Workspaces / Stats / Audit logs
  三条（含 gate-2 立即失效、targetServerId 不能引用已删行的说明）。

## 已知问题 / 未验证

- **附件磁盘文件成孤儿**：attachments.storageKey 指向本地文件，DB 行删除后文件
  保留。代码库现状没有任何附件文件删除先例（attachment 行从不硬删），本批与现状
  一致；如需回收应加 best-effort unlink（记 tech-debt 候选）。
- 删除 workspace 不通知在线成员（无 socket 事件广播 server.deleted）——客户端
  下一次请求才 403。UI 侧后续处理。
- `GET /api/admin/servers` 无分页（当前规模全量返回，与 users 列表同口径）。
- 未跑浏览器 E2E（本批纯 REST，无 UI）。

## 评审修复（同日：`fix(admin): batch-D review follow-ups`）

质量评审通过后的 follow-up（一个 commit）：

- [Important] **inArray 数组形态的 65,535 绑定上限**：预收集 msgIds/chanIds 再
  `inArray(col, array)` 每元素一个绑定参数，大 workspace 删除必 500（Postgres 单语句
  绑定上限）。改为 drizzle 子查询形态 `inArray(col, tx.select({id}).from(...).where(...))`
  （生成 `in (select …)` 单语句）；messageMentions / reactions / channelMembers 三处
  同改，预收集数组删除。
- [Minor] **注释/dev log 事实修正**：三条 serverId FK 带 `onDelete: "cascade"`
  （schema.ts:161/237/305），非"servers 行零级联"。准确措辞：级联存在但显式删除
  先于 servers 删行执行，是永不依赖的兜底；全枚举的理由不变（其余 FK 无级联）。
- [Minor] **反射 meta-test**：`SERVER_DELETE_TABLES` 提为 admin.ts 导出的有序数组并
  **驱动实际删除循环**（清单=行为，不会脱节）；meta-test 用 `getTableColumns` 反射
  schema 中所有含 serverId 列的表，断言全被数组覆盖——schema 新增含 serverId 表而
  忘加删除时变红。变异验证：临时移除 joinLinks → meta-test 红（列出 join_links），
  同时级联行为测试也红（FK 500），双保险；还原后全绿。
- [Minor] **audit 置空路径测试**：删除前直插 `invite.created`（targetServerId=tmp）
  审计行，删后断言行存活且 targetServerId 为 null（append-only 历史保留）。
- [Minor] tech-debt 新增：I119（audit-logs `before` 游标同刻跳行）、I120（servers
  DELETE 并发窗口——两请求可同时过存在检查，一个 200 一个 FK 500 而非 404）、
  I121（`?limit=` 空串被夹到 1 而非回退 50）。
- 证据：`npx tsx --test --test-force-exit src/server/systemAdmin.api.test.ts` →
  7 tests / 7 pass / 0 fail（含 meta-test 与 audit 置空断言）；
  `npm run typecheck` → exit 0。
