# 2026-09-18 · 刷新后恢复进行中的 agent 动态卡片

分支 `feature/live-activity-restore`(worktree `open-tag-live-activity-restore`)。

## 问题

Agent 计算某条消息期间,聊天气泡显示 "动态 online" 卡片;刷新页面 / 重进 channel 后卡片消失,
run 结束后再进才能看到新回复 + 已完成的动态回执。

## 根因

- 卡片是纯客户端伪消息 `agent_reply_preview`,只能由 socket `agent:reply op=start` 现场搭建,不落库。
- 服务端全程在 `agent_activity_log` 留痕(run 未结束时 `message_id=null`),但初始加载
  `GET /api/messages/channel/:id` 只返回已落库消息 → 进行中 run 在 REST 响应里不存在;
  socket 事件不可回放 → 刷新即丢。
- 佐证:agent 中途发过公开消息的 run(消息带 `agentActivityState="running"`)刷新后卡片**能**显示。

## 方案(方案 A,对比过"server 预建占位消息"后否决)

占位消息方案污染消息流语义(占 seq → unread 误增、空壳清理状态机、每事件写放大、绕过
700ms 入场延迟),故走"随最新页附带聚合":

1. **服务端** `src/server/agentActivity.ts` 新增 `runningAgentRunsInChannel(serverId, channelId)`:
   未认领行(`message_id IS NULL AND stream_id NOT NULL`)按 agent+streamId 聚合,
   返回 `{agentId, agentName, streamId, startedAt, items[]}`。
   活性守卫:agent 未软删 + status ∈ {active, starting, queued} + 机器在线
   (未绑定机器的 agent = unbound daemon 拓扑,看"服务器任一在线机器")+ 最新行龄 < 24h
   (`RUNNING_RUN_MAX_AGE_MS`,对齐已搁置 watchdog 设计的 L3 墙钟)。
2. **路由** `routes-api/messages.ts`:仅最新页(`before == null`)响应加 `running[]`;
   翻历史页永不携带。
3. **前端** `web/src/lib/agentReplyPreview.ts` 新增 `restoreRunningAgentRuns`:
   - 已有同 streamId 的 running 消息 → 只回填比其最后事件更新的行(补漏);
   - 否则合成与 socket 路径同构的 preview(`streamVisible: true`,跳过 700ms 入场延迟);
   - 后续 socket 事件按 streamId 走既有 `findStreamTargetIndex` 续流,`done/error` 走既有
     absorb 替换为真消息。Chat.tsx 频道视图 + 线程视图两处初始加载接入。

## TDD 过程

初版实现先写码后补测试(违规);用户要求"删码重做"后严格执行:剥实现留测试(stub throw)
→ 确认 RED(5 单测 + 集成 not-implemented)→ 最小实现 → GREEN(21/21 单测 + 集成 ALL PASS)。
守卫的 unbound-agent 放行也是测试先行(RED → 改守卫 → GREEN)。

## 验证证据

- 单测:`test/agentReplyPreview.unit.test.ts` 21/21(新增 restore×4 + 契约×1)。
- 集成:`test/runningActivityRestore.integration.ts` 全绿(聚合/守卫/认领移除,
  需要 `npm run infra` + worktree DATABASE_URL)。
- typecheck(root + web)干净。
- 真跑(dev:e2e 栈,真 claude @dev-bot):
  - run 进行中 `curl GET /api/messages/channel/:id` → `running:[{Dev Bot, items=2,…}]`;
  - 浏览器 live 卡片在场(Working / Bash / 8 events / Stop)→ **整页刷新 → 卡片恢复**(同 8 events);
  - run 结束 → 同位置变为正式回复(3000 字长文)+ "Activity online 15 events" 回执。
- 存量失败(与本次无关,干净 main 复现):Windows EPERM symlink 家族 15 个
  (workspace/memory/project-root symlink 测试,CI 在 Linux 不受影响)。

## 踩坑记录

- Windows 下 `kill $(cat pidfile)` 只杀 npx wrapper,node 孙进程继续占端口 → 旧代码继续服务,
  验证全空。教训:bounce 后必须 `netstat` 对比监听 PID。tech-debt 里已有 down.sh 同类记录。
- Git Bash 管道喂 python 会按 GBK 截断多字节中文 → JSON parse 报错;走临时文件 + 显式 utf-8。
- seed:dev 的 dev-bot `machine_id=null`(unbound 拓扑)→ 守卫初版误杀,真跑才暴露;
  单测环境造不出这个形态。跨环境差异提醒。

## 文档同步

- ARCHITECTURE.md:agentActivity.ts 词条 + running[] 语义。
- FEATURES.md:Agent Run Activity 段落勾选。
- docs/tech-debt-tracker.md:守卫启发式残余 + 快照/插座竞态残余。
- 无 schema 变更(db-schema.md 不动)、无 daemon 变更(不发版)。
