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

## Task 4 · agent 面 6 端点(集成测试先行,2026-09-22)

- TDD:先写 `test/knowledge.integration.ts`(12 组用例,agent 面仿
  channelArtifacts 的 jsonReq/getReq/mkRes/call,人类面段二仿 agentMigrate 的
  makeReq/makeRes/apiCall)→ RED 实跑 54 项检查失败(全部 404,路由未挂载)
- 建 `src/server/routes-agent/knowledge.ts`(handleKnowledgeRoutes,逐字仿
  artifacts.ts 头注释契约)+ `routes-agent.ts` 接线(import + requiredScope
  create/update/delete→knowledge:write、其余 knowledge/→knowledge:read + :539 旁
  mount)+ `core.ts:854` resolveIdOrPrefix 表联合类型加 `typeof schema.knowledge`
  (实现零改动)
- GREEN 实跑:用例 1-11 全 PASS(create 私有/共享与 searchText 固化、校验
  title≤200/content≤32KB 带 limit、list 三 scope 不漏 content 且派生 mine/shared、
  55 条分页 limit 50 + before keyset 第二页 5 条、search 命中/snippet/私有不可见/
  `100%` 字面不当作通配(escapeLike)、detail 全 id+8 位短 id、伪造/乱串 404 不
  500、update creator-only(改 B 的共享条目 404 不泄露)+ searchText 重固化、
  delete creator-only、六端点 scope 403、server2 租户隔离);用例 12(人类面
  JWT 浏览)按设计保持 RED,待 Task 5 实现
- 根 typecheck 绿(root+web);channelArtifacts.integration 复跑 ALL PASS
  (mount 无回归)、knowledge.unit.test 7/7
- 实现要点:search 的 snippet 在 JS 侧 makeSnippet(同 messages.ts:105 先例);
  keyset 游标行先在可见域内解析,缺失降级为第一页;limit clamp 1..50(50+1 哨兵
  行出 hasMore);update 用合并后 title/content 重固化 searchText

## Task 5 · 人类面只读端点(2026-09-22)

- `GET /api/agents/:id/knowledge?scope=all|private|shared&limit=&before=`(routes-api/agents.ts,
  逐字仿 workspace-files 先例:requireCap manageAgents 先 403 → agent 存在且本 server
  (含 deletedAt 过滤)否则 404);返回该 agent 私有(agentId=:id)+ 共享(agentId is null)
  行,含 content(≤50/页,clampLimit 1..50 + limit+1 哨兵出 hasMore)
- 复用防漂移:把 routes-agent/knowledge.ts 的 `keysetWhere`/`clampLimit` 从私有导出
  (Task 4 计划允许的两种路径里选导出),人类面直接 import——游标行同样在人类可见域
  (私有∪共享)内解析,缺失降级第一页
- 响应行:id/title/content/agentId/createdByAgentId/createdBy/createdAt/updatedAt,
  **不暴露 searchText**(内部派生列);createdBy = createdByAgentId → agents.name,
  一条 batch inArray 映射(Set 去重、空集跳过查询);agent 面 detail 契约未动
- Task 4 评审遗留 A 修复:update 路径 `db.update` 加 `.returning({id})`,并发 delete
  竞态下 0 行命中现在返回 404(复用 NOT_FOUND 常量,语义同计划文案"knowledge not
  found"),不再谎报 ok:true
- 集成实跑 66/66 ALL PASS(用例 12 由 RED 转绿:owner 浏览含私有+共享、content 与
  createdBy 映射到 @handle、scope=private/shared 过滤、plain member 403);
  knowledge.unit 7/7、channelArtifacts.integration 复跑 ALL PASS、root+web typecheck 绿
