# 2026-09-18 · Composer @ 候选按频道分域

分支 `feature/mention-candidates`(worktree `open-tag-mention-candidates`)。
Spec: `docs/superpowers/specs/2026-09-18-mention-candidates-design.md`(评审 9/9);
Plan: `docs/superpowers/plans/2026-09-18-mention-candidates.md`(评审通过,7 条意见吸收)。

## 问题

@ 自动补全候选 = 全工作区(与生俱来的注释:"公开频道 @ 非成员会拉人,intended"),但:
1. 私聊/私密频道也全工作区候选 — 服务端对这些外来 @ 是静默 no-op → 误导;
2. 能 @ 自己。

## 方案(方案 A,服务端单一真源;用户在 A/B 讨论后拍板 A)

- `core.mentionCandidates(serverId, ch, requesterId)`:包装私有 `mentionAutoJoinPool`
  (thread 继承父频道 reach)+ `channelMembers`,排除请求者,member 标志,成员优先排序。
- `GET /api/channels/:id/mention-candidates`:canUserReadChannel 读门 + 存在性隐藏 404
  (非 UUID / 跨租户 / 非成员一律 404),avatarUrl 从 agents/users 补齐,user→human 映射。
- 前端:`web/src/lib/mentionCandidates.ts`(handleKey 迁入 + filterMentionCandidates);
  store 懒取缓存(`mentionCandidatesByChannel`,`channel:members-updated` 整表失效 +
  工作区切换清空);Composer `atQuery !== null` 触发懒取,fail-closed(失败=空,绝不回落
  全工作区)。

## TDD 过程(全 5 任务先红后绿)

1. core 函数:集成 RED(export missing)→ GREEN 10/10(setup 踩坑:humans 池来自
   serverMembers,测试忘了插 → 补)。
2. 路由:进程内 handleApi + mock req/res(照 channelAccessB2 模式),RED 4 败 → GREEN,
   含三负例(他人 private 404 / 跨租户 404 / 非 UUID 404)。
3. filterMentionCandidates 纯函数:单测 RED(模块缺失)→ GREEN。
4. store/Composer 接线:契约测试 RED → GREEN(typecheck 修两处:useCallback import、
   loader 移到 api 声明后;契约正则对齐 putMentionCandidates 包装器)。
5. 回归 + 真跑 + 文档。

## 验证

- 全量 CI 等价:652 tests / 650 pass / 0 fail / 2 skip(一次运行)+ 集成 ALL PASS。
  **注意**:codexRuntime 两个用例在满套件高负载下偶发超时(三次采样 0/1/2 fail,
  隔离跑两侧各 5/5 绿)— 存量时序敏感,与本改动无关(diff 零接触 codex),未修。
- 真跑(worktree 7801 + Playwright):
  - 公开频道 @:Ada(成员)✓、Bob(非成员,拉人特性保留)✓、自己 ✗;
  - DM @:仅 Ada(对端),Bob ✗、自己 ✗;
  - 网络面板确认候选来自 `/mention-candidates`(200)。

## 文档同步

ARCHITECTURE(channels 路由词条)、FEATURES 勾选、docs/authorization.md 门禁清单行、
本日志。无 schema / daemon 变更(不发版)。
