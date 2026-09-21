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
