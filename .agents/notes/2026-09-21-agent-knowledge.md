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

## Task 6 · CLI 六子命令(2026-09-22)

- `src/cli/index.ts` artifact 组后新增 `knowledge` 组 + 共享 `knowledgeContent()` 读法助手:
  create/update 的 content 取值统一 `--content > --file > stdin`(stdin 复用 message send 的
  `readStdin()`,TTY 返回空即报 "content required" + Next action 提示后 exit 1;--file 复用
  attachment/artifact 的 `readFile`),update 另守 "至少一项" 空 update(镜像 profile update)
- 六子命令全部打印服务端真实返回字段(create 用响应里的 `d.shared`/`d.id`,update 用
  `d.updatedAt`),不猜契约;list 行 `id  S|P  title  (updatedAt T→空格)`、search 行
  `id  S|P  title — snippet`、show 打 `[S|P] title` + content 全文、delete 打 `Deleted <id>`
- list `--mine/--shared → scope=mine|shared`,二者缺省 `all`;`--limit` 仅显式传入才带
  (服务端 clampLimit 1..50 兜底);search/show/delete 的 id/query 走 `encodeURIComponent`,
  delete 用 DELETE + query string(与路由取参一致),update 用 PATCH(与路由一致)
- id 显示用完整 uuid(与 reminder list 同款),不截短——服务端 `resolveIdOrPrefix` 接受
  6+ hex 前缀,agent 侧自己复制短 id 也能用
- 验证:`knowledge --help` 六子命令齐、六个子命令 `--help` 均渲染;cliMime 单测 5/5 过;
  root+web typecheck 绿;live CLI 实跑按计划留给 Task 11 e2e

## Task 7 · 常驻提示 Knowledge base 段 + CLI 显示小修(2026-09-22)

- 先行修复 Task 6 评审三处小项(commit A):list/search 行 title/snippet 加
  `.replace(/\s+/g, " ")` 单行折叠(同 `server info` desc1 惯用法,防多行 title/snippet
  打破表格行);update/delete 的 `.description()` 补 "(full id or short id)" 措辞(镜像 show)
- TDD:prompt.test.ts 新增 "knowledge base section teaches create/search and the
  notes/ split" 断言(## Knowledge base / knowledge create / knowledge search /
  --shared),先跑 FAIL(ERR_ASSERTION: /## Knowledge base/i),再插段转 PASS 3/3
- `src/daemon/prompt.ts` 在 notes/ 段后、`## Compaction safety (CRITICAL)` 前插入
  `## Knowledge base` 段(runtime 无关文案,零 provider 工具名;`${c.stateDir}/notes/`
  与 knowledge base 互补:notes=工作上下文,knowledge=耐久可检索事实);startup
  nudge builder 未动
- 红线 grep:新增行命中 `\b(read|cat|grep|ls|glob|bash)\b` 为零;root+web typecheck 绿;
  cliMime 单测 5/5、`knowledge search --help` 渲染正常

## Task 8 · web Knowledge tab(admin 只读浏览)(2026-09-22)

- 先行小修(commit A):CLI `knowledge search` 行 title 也做 `.replace(/\s+/g, " ")`
  单行折叠,与 list 行对称(多行 title 会打破单行输出)
- `Members.tsx` 新增 `KnowledgeTab`(仿 RemindersTab 取数+列表形态):一次
  `GET /api/agents/:id/knowledge?scope=all&limit=50`,客户端按 `agentId===id` /
  `agentId===null` 分成 私有/共享 两组,少一次请求;行 = title + `knowledgeCreatedBy`
  + fmtDateTime,点击展开折叠 `<pre class="ws-content">`(复用 WorkspaceTab 的
  monospace 样式,零新 CSS);空态 knowledgeEmpty;`hasMore` → 尾部一行提示
  knowledgeMoreHint(兄弟 tab 无 load-more 先例,不做按钮,不过度设计)
- tab 数组在 reminders 后插 `["knowledge", ...]`,filter 与 dms 同款
  `capabilities.manageAgents` 门控;`requestedTab` 无 capability 时回落 profile
  (与 dms 同一行);键位 en/zh 各 7 个(tabKnowledge + 组标签×2 + 空态 + 创建者
  + (未知) 兜底 + more 提示;略超 prompt 的 ≤6,unknown 兜底和 hasMore 提示都
  需要本地化文案,硬编码不划算)
- 验证:root+web typecheck 绿;tasksBoardLayout 单测 2/2 过;Members.tsx 无测试
  直接 import(全仓 grep 确认);浏览器实跑留给 e2e

## Task 9 · docs 同批同步 (2026-09-22)

- FEATURES.md:P7 knowledge 行重写为已交付 ILIKE 实现并勾选(两层可见性/creator-only
  写/keyset 分页/escapeLike/无 tsvector-GIN → I113;agent 面 6 路由 + CLI 6 动词 +
  prompt `## Knowledge base` 段 + 人类面 `GET /api/agents/:id/knowledge` 只读浏览);
  P2 :28 子命令表补 knowledge create/list/search/show/update/delete,:29 pending 行
  改为 "CLI subcommand surface complete"(mentions 无需动词的注记保留)
- ARCHITECTURE.md §II:routes-agent 条目补 knowledge 第二个 `/agent-api` 拆分 + 两层
  可见性/creator-only/ILIKE;**一句话注明 keysetWhere/clampLimit 由 routes-api/agents.ts
  有意跨面复用(routes-agent/knowledge.ts),两平面游标语义同源**;scopes 14→15;
  cli/index.ts 子命令树加 knowledge;prompt.ts 描述补 knowledge base 段;
  AgentProfile seven-tab→eight-tab(+knowledge)
- docs/authorization.md §3:14→15 两处;scope 字面量内联列表补 knowledge:read/write
- docs/PLANS.md:Active 加 agent-knowledge 条目(链 spec + 执行计划;e2e 未跑故留
  Active);Roadmap #7 knowledge base ⬜→✅(与 FEATURES 对齐)
- docs/tech-debt-tracker.md:新 I112 后追加 **I113** bundle(v1 无 trigram/GIN,ILIKE
  顺序扫描;CLI list/search 未暴露 hasMore/--before,>50 条静默截断;prompt.ts Startup
  第 5 步未提 knowledge 去向;prompt.test.ts 可加 provider 工具名负向断言;附带观察:
  Members.tsx tab fetch 错误与空态混淆,既有)
- README.md / README.zh-CN.md:Core capabilities / 核心能力 各加一行(真实翻译,非镜像)
- doc-sync 自检:grep 改动文档 —— 路由名两平面各处一致、scope 名一致、scope 数
  "15" 在 ARCHITECTURE+authorization 一致且无残留 "14"、FEATURES 已勾选、tech-debt
  max ID 确认(I112→I113);root+web typecheck 绿
- 本 commit 不含 daemon 发布项(CLI+prompt 随包发布 = Task 10)

## Task 10:发版准备(不发布)

- packages/daemon/package.json:version 0.17.0 → **0.18.0**(新增能力 = minor;diff 仅
  version 一行,`node -e require(...)` 打印 0.18.0 已验证)
- CHANGELOG.md:新增 `## [0.18.0] — pending release` 段(0.17.0 段之前、[Unreleased]
  之后;无日期,per 计划的 "(pending release)" 约定):knowledge CLI 6 子命令
  (create/list/search/show/update/delete;默认私有 `--shared` 共享;search 子串 CJK-safe;
  show/update/delete 支持短 id;update/delete 仅 creator)+ prompt `## Knowledge base`
  段;注明需配套 server 的 `/agent-api/knowledge`(server 走 main 持续部署,不在本包);
  blockquote 写明剩余发版动作 = 维护者切 GitHub Release v0.18.0(触发 publish-daemon.yml
  OIDC 发布)→ 重启各机 daemon;并注明 [Unreleased] 现有条目届时同随 0.18.0 包发出
- 发版动作**全部未执行**:未打 tag、未建 GitHub Release、未发 npm(对外动作留给维护者)
- latestDaemonVersion 告警核对:`src/server/routes-api/servers.ts:17` 的
  LATEST_DAEMON_VERSION 直接读 packages/daemon/package.json 的 version —— 本次 bump 在
  server 侧部署后即喂给 outdated-daemon 告警,无需额外改动
- 暂存清单:packages/daemon/package.json + CHANGELOG.md + 本笔记;web/package-lock.json
  保持未暂存
