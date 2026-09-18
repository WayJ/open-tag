# 2026-09-18 · live-activity-restore 合并记录

`feature/live-activity-restore` → `main`(merge commit 4d43410,--no-ff)。

- 功能:agent 进行中的动态卡片跨页面刷新/重进频道恢复(GET messages 最新页附带 `running[]` +
  前端 `restoreRunningAgentRuns` 重建伪消息)。
- 验证:TDD red→green(21/21 单测 + 集成 ALL PASS + typecheck);真跑 dev:e2e 栈
  (真 claude @dev-bot):run 中 curl 见 `running[]`、浏览器刷新卡片恢复(8 events 一致)、
  run 结束吸收为正式回复 + 15 events 回执。合并后在 main 复验 typecheck + 25/25 单测绿。
- worktree `open-tag-live-activity-restore` 及其 DB/数据目录已清理,分支已删。
- 残余(见 docs/tech-debt-tracker.md):活性守卫为启发式(daemon 崩溃窄窗口最长 24h 幽灵卡片,
  下次发言自愈);REST 快照与 socket 接入间的单次 in-flight 竞态(存量行为)。
