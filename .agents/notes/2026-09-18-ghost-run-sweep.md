# 2026-09-18 · 幽灵 run 清扫 + 集成测试防误跑主库

分支 `feature/ghost-run-sweep`(worktree `open-tag-ghost-run-sweep`)。起因:用户刷新看到
两张动态卡 — 一张真 run + 一张幽灵(当天批量杀进程留下的无 finalize 悬空行),暴露
live-activity-restore 的启发式守卫残余。

## 加固 1:daemon ready 权威上报 + 服务端清扫

设计要点(否决了最初"ws close 时清扫"的想法):**daemon 断线 ≠ run 死**(进程活着,
重连续流;1005 抖动场景)。权威信号 = daemon 进程自己上报:

- daemon `ready` 帧新增 `runningStreams`(agentManager.activeStreamIds(),来自
  activeReplyPreviews 映射:start 建立、done/error 删除)。
- server `ws.ts` ready 处理器在 catch-up 后调 `core.sweepOrphanedAgentRuns`:
  未认领行归因到该机器 daemon(绑定 agent + 仅此机在线时的未绑定 agent),
  不在上报清单内 → `finalizeAgentActivityRun(..., "error")` 生成回执。
- 语义:同进程重连清单在 → 不误杀;新进程(重启)清单空 → 死流全清。
  旧 daemon 不发字段 → 整体跳过(向后兼容)。
- error 回执走既有同 agent 同频道合并窗口(s5+s6 并一张,测试有断言)。

协议变更 → daemon 0.15.1 → **0.16.0** + CHANGELOG Unreleased 条目。
**GitHub Release 未发**(merged ≠ shipped;发布是外向动作,待维护者执行)。

## 加固 2:集成测试防误跑主库

`test/integrationDbGuard.ts`:`integrationDbName()` 解析库名,`assertIntegrationDbIsolated()`
在库名 === `opentag`(裸 fallback = live 库)时拒绝运行并指引用 isolated DATABASE_URL。
接入 runningActivityRestore / activityLogPrune 两个集成测试 + 单测覆盖解析。
动机:我的集成测试曾跑进主库,测试 agent 泄漏(已手工清理)。

## 验证

- daemon:`agentManager.test.ts` 新增 activeStreamIds 用例,37 tests 35 pass 2 skip。
- 集成(worktree 库,守卫生效):20/20 全绿,含 [4] 清扫 4 流 + 回执合并 + [5] 多机
  在线时未绑定流不扫;未设 DATABASE_URL → 守卫拒绝(exit 1,零写入)。
- 全量 CI 等价:650 tests / 648 pass / 0 fail / 2 skip;typecheck 绿。

## 踩坑

- worktree 从 origin/main 分叉,落后本地 main → 先 `git reset --hard main` 再开工
  (reset 吃掉未提交改动一次,重写)。
- python 批量替换塞测试断言引入裸标识符 ReferenceError — 事后 Read+Edit 重写。
  教训:断言代码不走字符串拼接。

## 文档同步

ARCHITECTURE.md(ws.ts 词条:runningStreams + 清扫语义)、tech-debt(两条 resolved,
含 daemon ≥0.16 生效窗口 + 双 daemon 抖动残余)、CHANGELOG、daemon version bump、本日志。
