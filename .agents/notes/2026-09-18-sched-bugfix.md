# 2026-09-18 · 调度器存量 bug 簇修复（五连）

合并 commit：见 git log（Merge branch 'feature/sched-bugfix'）→ main
分支：feature/sched-bugfix（7 commits，worktree open-tag-sched-bugfix）
来源：P0 调度硬化 brainstorm 的三路并行评审（架构契合/故障攻防/协议交互）挖出，
按维护者决定只修 bug、不做新设计。零 schema 变更；daemon 变更入第四批 Unreleased。

## 五修

1. **idle 误杀 mid-turn**（91f282e）：`sleepScope` 前查 `turnActive`（idle=turn 间语义，
   注释钉死不变式）；`onTrajectory` 也续期 idle timer（codex turn 期只发 trajectory）。
   修复前 >10min 安静 turn 被杀；修复后卡死 turn 不再被误杀（watchdog 留待后续 PR，
   tech-debt 在案）。
2. **starting 准入超时**（0e60405）：`START_ADMISSION_TIMEOUT_MS` 默认 3min（env 可调）
   → 超时走 failStart（进程停、预算释放、pending 投递拒绝）。修复前 claude 认证过期
   等 = scope 永卡 starting、budget 槽泄漏——最常见真实挂死。
3. **reasonix 不报 turn 失败**（018c2d8）：非零退出+everSucceeded 补
   `onAcceptedTurnFailure`（镜像 one-shot 契约）。修复后 turnActive 不再永久 true、
   投递不再堆积——与修 1 协同闭合（否则卡死从误杀变永久泄漏）。
4. **killTree 双平台**（02564a7）：Linux spawnSafe 统一 `detached:true`（组杀首次真正
   可达，孙进程不再孤儿双写）；Windows Job Object 加
   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`（0x2000；LimitFlags OR 组合防顶掉内存帽）。
   Linux 侧代码审查级验证（本机 Windows），CI ubuntu 兜底。
5. **publishing grant 孤儿**（ccc05e8）：`releaseUnavailableReplyGrant` WHERE 扩含
   publishing——崩溃在 reserve/publish 之间的 grant 首次可释放。
   评审修正（d47fe00）：failStart 的 rejectPendingDeliverKey 提前到 await exit 之前，
   封死晚到准入假 ACK 竞态。

## 验证

新 schedBugfix 单测 4/4（全 RED 先行）+ reasonix 入 runtimeStop 矩阵（3/3）+
replyCoordination 集成 14/14（publishing 三态+consumed 对照）+ 旧套件零修改 +
typecheck。CI 基线逐名对比零新增失败。

## 后续（tech-debt 在案，刻意不做）

mid-turn 静默 watchdog（alert-only 分层）、崩溃自愈+degraded、grant TTL/turn:aborted
上行——即被搁置的 P0 设计，等维护者再启。
