# Agent Migrate Implementation Plan

> **For agentic workers:** REQUIRED: superpowers:subagent-driven-development. Steps use `- [ ]` tracking.

**Goal:** `POST /api/agents/:id/migrate {machineId}` — 停旧机 agent（三分支）→ 改绑 + 清会话指针 → 新机自然接管（记忆自动恢复）。

**Architecture:** 纯 server：routes-api/agents.ts 端点 + core.ts 三分支辅助（在线运行→stop-settle；在线休眠→跳过；旧机离线→直接改绑）；改绑三写（machineId/status+publish/清 agent_sessions+sessionId）。

**Spec:** docs/superpowers/specs/2026-09-18-agent-migrate-design.md（两轮评审通过）

## Task 1（单任务全量）

**Files:** Modify `src/server/routes-api/agents.ts`、`src/server/core.ts`；Create `test/agentMigrate.integration.ts`

- [ ] 1.1 失败集成测试（六分支对齐 spec 验证节；镜像现有 agents 路由测试 harness；fake daemon conn 拦截 agent:stop 并可控 settle/拒绝）
- [ ] 1.2 红
- [ ] 1.3 实现：core.ts `migrateAgent(serverId, agentId, machineId, actor)` 导出（校验序：404 → 同机幂等 → 409 租户+在线；三分支 stop；三写改绑；publishAgentState；audit log）；agents.ts 挂端点（manageAgents 门，POST /api/agents/:id/migrate）
- [ ] 1.4 绿 + typecheck + 回归（memorySync/scopedSessions/channelArtifacts 三集成 + agentMachineOfflineState 单测）
- [ ] 1.5 Commit `feat(server): agent migrate endpoint (stop-settle/rebind/session-reset)`
- [ ] 1.6 e2e 冒烟（单栈）：迁移到不存在的在线 machine 场景由集成覆盖；真机双 daemon e2e 受脚本 bug 限制记 tech-debt 注记
- [ ] 1.7 doc-sync：ARCHITECTURE（端点+迁移语义）、FEATURES、tech-debt（关 I77 + 孤儿 token 残留注记 + 双机 e2e 待脚本修复）；Commit docs + push + PR body 存档
