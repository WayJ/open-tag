# 2026-09-21 · agent 知识库(knowledge base)开发日志

## 决策(brainstorm,用户拍板)

- 方向:Agent 知识库(FEATURES P7 最后一个已规划核心项)入选下一需求
- 归属两层:agent 私有(agentId 必填)+ 工作区共享(agentId null,写删仅创建者)
- 人类可见:管理员 manageAgents 只读浏览(Agent Profile Knowledge tab)
- 检索:ILIKE + snippet(message-search 先例),弃 tsvector(simple 配置对 CJK
  无效、zhparser 违背零配置自部署);v1 不加 pg_trgm 索引,记 tech-debt
- 流程:superpowers 全程 + TDD(用户指定)

## 进度

- [x] 设计 spec:`docs/superpowers/specs/2026-09-21-agent-knowledge-design.md`
  (schema 2 列+2 索引、`/agent-api/knowledge/*` 6 端点、CLI 6 子命令、
  knowledge:write scope、prompt 一段、Profile tab、TDD 三层验证)
- [x] spec 评审循环:首轮 1 阻塞项(CLI/prompt 均随 daemon 包发布,
  "无发版项"声明错误——#44 失败模式)+ 4 advisory;全部修正后复审 **Approved**
- [ ] 用户过目 spec → 实施计划(writing-plans)
- [ ] 实现 + 测试 + dev:e2e 实跑

## Task 2 · 纯 helper 单元测试先行(2026-09-22)

- TDD:先写 `test/knowledge.unit.test.ts`(7 用例)→ FAIL(ERR_MODULE_NOT_FOUND)→
  建 `src/server/knowledge.ts`(buildSearchText/escapeLike/makeSnippet + 3 常量,
  无 DB import)→ PASS 7/7,根 typecheck 绿
- 边界差一字:makeSnippet 左边界断言钉死 `…ead NEEDLE`(radius=3、命中前 4 字),
  按计划规则"以断言为准修实现"——实现左缘保留 radius+1 字符("…" 视觉上占一个
  上下文位),注释已标注出处
- 顺带修复(Task 1 代码评审遗留):`scripts/drop-showcase.mjs` 的 knowledge DELETE
  原本只按 `agent_id` 清理;新增 `created_by_agent_id` 也是 FK onto agents.id,
  共享层行(agent_id NULL、created_by_agent_id 有值)会让 agents DELETE 违反外键
  回滚整个清理。条件扩为 `agent_id IN (...) OR created_by_agent_id IN (...)`
