# 2026-09-17 · 作用域会话（Scoped Sessions）

合并 commit：dc3437d（Merge branch 'feature/scoped-sessions'）→ main
分支：feature/scoped-sessions（10 commits，worktree open-tag-scoped-sessions）
主库迁移：db:push 已建 agent_sessions（合并后即时执行——lesson learned）

## 功能

会话绑定从 agent 粒度迁移到 **(agent, channel|thread) 作用域**，对齐 Claude Tag
「一线程一持久会话 + 频道自有会话」：

- 同 scope 单飞（会话链串行），**跨 scope 并发**——队头阻塞在架构层消除
- server 派发链路解析 scope 随协议直传（agent:start config.scope / agent:deliver
  msg.scope，五处 deliver 构造点同源注入）；`agent:session` 上行带 scope →
  `agent_sessions` 表 upsert；resetAgent 清表
- daemon：Running 与 8 处键控状态全部 scopeKey 化（startQueue/starting/
  pendingDelivers/5 个 fence Map + activeReplyPreviews 三消费者穿透）；
  控制面（stop/sleep/reset/dequeue）保持 agent 粒度；last-survivor 状态上报规则；
  sleepScope 粒度拆分；Windows seed 竞态容错（兄弟 scope 赢得 seed 即续走）
- LEGACY 回退：手动重启 / reconnect catchup（start 与 deliver 已补 scope）/
  新旧混部 → agents.session_id 旧列，顶层 sessionId rollout 期继续下发

## 验证

- 18 单测（防抖 6×）+ 28 集成 + 旧 agentManager 套件**零修改**通过 + CI glob
  基线逐名吻合
- e2e：双线程 80ms 并发 spawn → 各自独立会话 → 并行回复（T1/T2 done 相隔 6s）→
  daemon 重启双 scope resume:true 续链
- 评审链 4×spec + 4×quality + 终审：抓掉 resumeSessionId ?? 串话、兄弟盲区上报、
  Windows seed EPERM、catchup deliver 失效、6 处 deliver 点漏枚举等

## 发版（未做，记账在案）

daemon 包 0.15.1 窗口内积压两批 Unreleased（channel-artifacts + scoped-sessions）。
下次 Release 一次清两批 + 各机 bounce。tech-debt 6 条残留（MEMORY.md 运行时写竞态
最重，v2=记忆上行合流——正是下一个 feature）。
