# 2026-09-18 · Agent 迁移编排（Manual Migrate）

合并 commit：见 git log（Merge branch 'feature/agent-migrate'）→ main
分支：feature/agent-migrate（2 commits，worktree open-tag-agent-migrate）
零 daemon 变更——无发版项；无 schema 变更——无迁移项。

## 功能

跨机三件套收口（scoped sessions + memory sync + 本编排）：

`POST /api/agents/:id/migrate {machineId}`（human 面，manageAgents 门）：
- 校验序：404（含软删）→ 同机幂等 alreadyThere（先于在线检查）→ 409
  machine-offline（含跨租户，不泄露存在性）
- 三分支 stop：在线+running(starting/active/queued) → requestAgentControl
  30s settle，失败 503 不改绑；在线+休眠 → 跳过；**旧机整体离线 → 直接改绑**
  （死机旗舰场景；离线判定在 RPC 前的连接态检查，stop 超时结构性进不了此分支）
- 事务改绑：machineId + status inactive + activity offline + publishAgentState +
  **清空 agent_sessions + agents.sessionId**（resetAgent 先例；防新机 stale
  --resume 炸冷启）+ audit log
- 新机接管：消息 → 新 machineId → start → stateDir 空 → 记忆三态恢复 →
  冷会话 spawn（"记得一切的断片同事"）

## 验证

集成 24/24（六分支真 DB + 假 daemon conn，含 sourceWs 守卫注释）；四套件回归 +
typecheck 绿。双机真机 e2e 受 dev-e2e 脚本预存 bug 限制递延（I107）。评审一轮
组合门 Approved（stop 超时误判风险结构性排除；改绑事务比 resetAgent 先例更紧）。

## 遗留（tech-debt）

I77 关闭；I106 分区孤儿 token（v1 接受，后续 rebind-from-offline 轮换 token）；
I107 双机 e2e 待脚本修复。
