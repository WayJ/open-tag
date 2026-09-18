# 2026-09-18 · mention-candidates 合并记录

`feature/mention-candidates` → `main`(--no-ff)。

- 交付:Composer @ 候选按频道分域(方案 A 服务端单一真源)。`core.mentionCandidates`
  + `GET /api/channels/:id/mention-candidates`(成员 + @-reach 拉人候选,thread 继承
  父频道,排除请求者,存在性隐藏 404);前端 store 懒取缓存(members-updated 整表失效,
  工作区切换清空)+ Composer fail-closed。
- 行为变化:私密频道/DM 不再建议外来者(服务端本就丢弃其 @);任何频道不再建议自己;
  公开频道/线程拉人特性保留。
- 验证:全 TDD(每任务先红后绿);集成 ALL PASS(含 3 鉴权负例 + system agent 用例);
  全量 652t/650p/0f/2s;Playwright 真跑 — 公开频道 {成员✓ 非成员✓ 自己✗},
  DM {仅对端,自己✗}。合并后 main 复验 typecheck + 单测绿。
- 已知无关残留:codexRuntime 2 用例满套件高负载偶发超时(隔离 5/5 绿,存量时序敏感,
  未修)。worktree + DB + 分支已清。
