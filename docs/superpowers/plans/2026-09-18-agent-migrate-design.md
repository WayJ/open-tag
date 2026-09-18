# Agent 迁移编排（Manual Migrate）— 设计

日期：2026-09-18 · 状态：待评审 · 定位：跨机三件套收口（scoped sessions + memory sync 之后的编排层）

## 背景与目标

地基已齐：`agents.machineId` 存在、投递按 machine 路由、记忆随 `agent_memory`
服务端持久化、新机首启自动三态恢复。缺的只是**编排命令**：operator 一句话把
agent 从机器 A 迁到机器 B。

**目标（v1）**：`POST /api/agents/:id/migrate {machineId}`——原子地
停旧机 agent → 改绑 machineId → 后续投递自然由新机接管（记忆自动恢复）。

**非目标**：
- 自动故障转移（心跳超时自动改绑——后续）
- UI 一键按钮（API 先行；前端 agent 设置面板后续）
- 会话 transcript 迁移（已决策不做）
- 旧机 stateDir 清理（保留——回迁可用；记忆以 server 为准不冲突）

## API（human 面）

`POST /api/agents/:id/migrate`，body `{"machineId": "<uuid>"}`

- 权限：`manageAgents`（与现有 agent 管理操作同档）
- 校验（按序）：
  1. agent 存在且未删（`deletedAt` null）→ 404
  2. 目标 == 当前 machineId → 200 幂等空操作（`{ok, alreadyThere}`，先于在线检查——
     同机但暂时离线应幂等成功而非 409）
  3. 目标 machine 是本 server（`machines.serverId` 租户校验）且**当前在线**
     （`status === "online" && isMachineConnected`）→ 否则 409 `machine-offline`
     （跨租户 machineId 同走 409，不泄露存在性）
- 流程：
  1. **旧机状态三分支**：
     - 旧机在线且 agent 在 `starting/active/queued` → 经现有 `requestAgentControl`
       发 `agent:stop` **等 settle**（AGENT_CONTROL_ACK，30s 超时）→ 失败
       **503 `stop-failed` 中止，不改绑**
     - 旧机在线且 agent `inactive/sleeping` → 跳过 stop（无在途状态）
     - **旧机整体离线 → 跳过 stop 直接改绑**（旗舰场景：机器报废也要能迁）。
       已知残留：旧机若只是网络分区，孤儿进程仍持有效 agent token——ready 对账
       按 machineId 查询、改绑后不再清理它；v1 文档化接受（token 泄露面与
       DELETE agent 的既有处理同级，后续可加 token 轮换）
  2. 改绑（事务三写）：`agents.machineId = 目标`；`agents.status = "inactive"` +
     `activity: "offline"`（真实枚举，仿 core.ts:1226）+ `publishAgentState` 推 UI；
     **清空会话指针**：`delete agent_sessions where agentId` + `agents.sessionId = null`
     （resetAgent 同款先例——stale scope sessionId 会让新机首次 `--resume` 失败，
     claude runtime 无会话缺失回退）
  3. 响应 `{ok: true, agentId, machineId}`；投递路由即刻切换（按 machineId 解析）

## 数据流（迁移后首条消息）

消息 → dispatch → machineId=新机 → `agent:start` → 新机 daemon startNow：
stateDir 空 → memory restore（态1 原位落盘）→ 冷会话 spawn → agent 记得一切。

## 安全

- human 面 JWT + manageAgents capability（不变量：无新 agent 面/daemon 面端点）
- 目标 machine 必须属于本 server（machines.serverId 校验——防跨租户改绑）
- 改绑是敏感操作：audit log（现有 server log 即可，v1 不建专门审计表）

## 验证（TDD）

- 集成（human 面，镜像现有 routes-api 测试风格）：
  1. 离线目标 → 409；未知 agent → 404；无 manageAgents → 403
  2. running agent + 双机在线 → stop 发往旧机、settle 后改绑 + 会话清空 + inactive/offline
  3. stop 失败（旧机在线但拒绝/超时）→ 503、machineId **不变**
  4. 旧机离线 + agent active → **直接改绑成功**（死机旗舰场景）
  5. inactive/sleeping agent 在线机 → 跳过 stop 直接改绑；同机幂等 → alreadyThere
  6. 跨租户/离线目标机 → 409
- e2e（单栈）：注册第二 machine（模拟：第二个 daemon 进程不同 OPEN_TAG_HOME——
  受 dev-e2e 脚本 env bug 限制，改用 API 层集成覆盖为主，e2e 冒烟迁移后
  dispatch 路由指向新 machineId 即可）
- doc-sync：ARCHITECTURE（codemap + 端点）、FEATURES；**零 daemon 变更——无发版项**

## 实现载体

worktree `agent-migrate`。涉及：`src/server/routes-api/agents.ts`（端点）、
`src/server/core.ts`（stop-then-rebind + 会话清空辅助）、docs（顺手关 tech-debt I77）。
预计 ~120 行 + 测试。
