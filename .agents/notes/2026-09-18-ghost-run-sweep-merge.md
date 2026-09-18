# 2026-09-18 · ghost-run-sweep 合并记录

`feature/ghost-run-sweep` → `main`(merge commit 见 git log,--no-ff)。

- 交付:daemon `ready.runningStreams` 权威上报(0.16.0,协议向后兼容)+ server
  `sweepOrphanedAgentRuns` 清扫崩溃孤儿 run 为 error 回执;集成测试 DB 守卫拒跑主库。
- 验证:agentManager 37t/35p/2s;集成 20/20(worktree 库);全量 650t/648p/0f/2s;
  typecheck 绿;守卫拒跑实证(exit 1 零写入)。合并后 main 复验 36 pass 0 fail。
- 生效条件:本地 tsx watch server 自动热载;**daemon 进程需重启**才会上报
  runningStreams(旧进程无字段 → 清扫休眠)。prod 需 daemon Release(未发,待维护者)。
- worktree + DB + 分支已清。
