# Agent 知识库(Knowledge Base)Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agent 经 CLI 读写可检索知识条目(私有+工作区共享两层,ILIKE CJK 正确),管理员 Profile 只读浏览。

**Architecture:** 纯 server 数据面:`knowledge` 表加 2 列 2 索引;agent 面 `/agent-api/knowledge/*` 6 端点(新文件 `routes-agent/knowledge.ts`,仿 artifacts.ts 拆分先例,网关 `requiredScope` 先解析后 mount);人类面只读端点挂 `routes-api/agents.ts`;CLI 6 子命令;prompt 一段。**含发版项**:CLI+prompt 随 daemon 包发布(build-daemon-pkg.mjs)。

**Tech Stack:** TS + Drizzle(Postgres)+ node:test(tsx --test)+ commander CLI + React(web)。

**Spec:** `docs/superpowers/specs/2026-09-21-agent-knowledge-design.md`(评审 Approved)。
**Worktree:** `open-tag-agent-knowledge` @ `feature/agent-knowledge`。DB=`opentag_agent_knowledge`(`.env` 已配)。

**跑法(全程用):**
- 单元:`npx tsx --test --test-force-exit test/knowledge.unit.test.ts`
- 全量单元(CI 同款):`npx tsx --test --test-force-exit test/*.unit.test.ts src/daemon/*.test.ts web/src/views/*.test.ts`
- 集成(需 infra up:`npm run infra`;worktree `.env` 已指向 `opentag_agent_knowledge`):
  `set -a; source .env; set +a; npx tsx test/knowledge.integration.ts`
- typecheck:`npm run typecheck`
- 常驻提示红线:改 `src/daemon/prompt.ts` 后 `grep -inE '\b(read|cat|grep|ls|glob|bash|grep)\b' src/daemon/prompt.ts` 核对新增行无 provider 工具名(既有命中行不动)

---

### Task 1: schema 列+索引 + db-schema.md

**Files:**
- Modify: `src/db/schema.ts:391-399`(knowledge 表)
- Modify: `docs/generated/db-schema.md`(knowledge 节)

- [x] **Step 1.1** 改 `knowledge` 表定义(表当前零行、无端点,改列型安全):

```ts
export const knowledge = pgTable("knowledge", {
  id: uuid("id").defaultRandom().primaryKey(),
  serverId: uuid("server_id").notNull().references(() => servers.id),
  agentId: uuid("agent_id").references(() => agents.id),            // null = workspace-shared tier
  createdByAgentId: uuid("created_by_agent_id").references(() => agents.id).notNull(), // audit/provenance (shared tier)
  title: text("title").notNull(),
  content: text("content").notNull(),
  searchText: text("search_text").notNull(),                        // title + "\n\n" + content, fixed at write time — the only column ILIKE scans
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byAgent: index("knowledge_agent_idx").on(t.serverId, t.agentId),                    // private-tier list
  byServerCreated: index("knowledge_server_created_idx").on(t.serverId, t.createdAt), // shared-tier scan + keyset page
}));
```

- [x] **Step 1.2** `set -a; source .env; set +a; npm run db:push` — 预期 additive 提示(新列+2 索引),确认应用
- [x] **Step 1.3** `npm run typecheck` 过
- [x] **Step 1.4** `docs/generated/db-schema.md` knowledge 节同步(新列/索引,`agentId` 注 null=shared)
- [x] **Step 1.5** Commit:`git add -A && git commit -m "feat(db): knowledge table columns + indexes (createdByAgentId, updatedAt, searchText notNull)"`

### Task 2: 纯helper 单元测试先行(TDD)

**Files:**
- Create: `src/server/knowledge.ts`(纯函数,无 DB import)
- Test: `test/knowledge.unit.test.ts`

- [x] **Step 2.1** 先写失败测试 `test/knowledge.unit.test.ts`(node:test + assert,仿 `test/taskNumber.unit.test.ts` 头部):

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildSearchText, escapeLike, makeSnippet, KNOWLEDGE_TITLE_MAX, KNOWLEDGE_CONTENT_MAX } from "../src/server/knowledge.ts";

test("buildSearchText composes title + blank line + content", () => {
  assert.equal(buildSearchText("T", "C"), "T\n\nC");
});
test("escapeLike escapes LIKE wildcards and the escape char", () => {
  assert.equal(escapeLike("100%_a\\b"), "100\\%\\_a\\\\b");
});
test("makeSnippet centers the hit with radius ellipses", () => {
  const s = makeSnippet("x".repeat(100) + "NEEDLE" + "y".repeat(100), "needle", 10);
  assert.ok(s.startsWith("…") && s.endsWith("…") && s.includes("NEEDLE"));
  assert.ok(!s.includes("NEEDLENEEDLE"));
});
test("makeSnippet hit at start/end: no leading/trailing ellipsis", () => {
  assert.equal(makeSnippet("NEEDLE tail", "needle", 3), "NEEDLE ta…");
  assert.equal(makeSnippet("head NEEDLE", "needle", 3), "…ead NEEDLE");
});
test("makeSnippet no hit: head truncation only", () => {
  assert.equal(makeSnippet("abcdefgh", "zz", 3), "abcdefg".slice(0, 6) + "…");
});
test("makeSnippet CJK counts chars not bytes", () => {
  const s = makeSnippet("前" + "数" + "据库设计很重要".slice(0, 3) + "NEEDLE尾", "needle", 5);
  assert.ok(s.includes("NEEDLE") && s.length < 20);
});
test("limits: title 200, content 32KB", () => {
  assert.equal(KNOWLEDGE_TITLE_MAX, 200);
  assert.equal(KNOWLEDGE_CONTENT_MAX, 32 * 1024);
});
```

- [x] **Step 2.2** 跑:`npx tsx --test --test-force-exit test/knowledge.unit.test.ts` → 预期 FAIL(module not found)
- [x] **Step 2.3** 建 `src/server/knowledge.ts`:

```ts
// Knowledge-base pure helpers (no DB imports — unit-tested in isolation).
// Contract: docs/superpowers/specs/2026-09-21-agent-knowledge-design.md
export const KNOWLEDGE_TITLE_MAX = 200;
export const KNOWLEDGE_CONTENT_MAX = 32 * 1024;
export const KNOWLEDGE_PAGE_SIZE = 50;

/** Fixed at write time; the only column ILIKE scans (spec: single-column scan). */
export function buildSearchText(title: string, content: string): string {
  return `${title}\n\n${content}`;
}
/** Escape LIKE/ILIKE metacharacters so a literal "100%" query matches only literal text. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}
/** Content hit-window around the first case-insensitive match (radius chars each side). */
export function makeSnippet(content: string, q: string, radius = 60): string {
  const i = content.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return content.length > radius * 2 ? content.slice(0, radius * 2) + "…" : content;
  const start = Math.max(0, i - radius);
  const end = Math.min(content.length, i + q.length + radius);
  return (start > 0 ? "…" : "") + content.slice(start, end) + (end < content.length ? "…" : "");
}
```

- [x] **Step 2.4** 跑测试 → PASS(边界断言若与实现差一字,以断言为准修实现)
- [x] **Step 2.5** Commit:`feat(server): knowledge pure helpers (searchText/escapeLike/snippet) + unit tests`

### Task 3: knowledge:write scope

**Files:**
- Modify: `src/server/scopes.ts:18`(knowledge:read 后插一行;**文件头注释 "(14 scopes)" 同步改 15**)
- Modify: `web/src/locales/en.json` + `web/src/locales/zh.json`(scopeLabels/scopeDesc `knowledge_write`,两处文件 ~L232/~L248 同款 snake_case 键;zh 文案:"写入知识库" / "创建、更新、删除知识条目。")

```ts
{ key: "knowledge:write", group: "Knowledge", label: "Write knowledge", description: "Create, update, and delete knowledge entries." },
```

- [x] **Step 3.1** 加 scope 行 + 两 locale 键(scope 分组 UI 由 `Members.tsx:563` 从 server catalog 自动分组渲染,无需改组件)
- [x] **Step 3.2** `npx tsx --test --test-force-exit test/permissionsSaveError.unit.test.ts`(scope 面相邻测试)+ typecheck 过
- [x] **Step 3.3** Commit:`feat(server): knowledge:write scope (14→15) + locale labels`

### Task 4: agent 面 6 端点(集成测试先行,TDD)

**Files:**
- Create: `src/server/routes-agent/knowledge.ts`
- Modify: `src/server/routes-agent.ts`(import + `:539` 旁 mount 一行 + `requiredScope` 映射)
- Modify: `src/server/core.ts:854`(resolveIdOrPrefix 联合类型加 `| typeof schema.knowledge`)
- Test: `test/knowledge.integration.ts`

- [x] **Step 4.1** 先写失败集成测试 `test/knowledge.integration.ts`。模板 = `test/channelArtifacts.integration.ts`(头部注释、`jsonReq`/`makeRes`/`apiCall` 辅助、`agentConfig` 铸 token、setup 建 owner/server/server2/agents A,B/自定义 scope agent)+ `test/agentMigrate.integration.ts` 的人类面 JWT 段。用例(全部 `check()` 断言):

  1. create 私有:A `POST /agent-api/knowledge/create {title:"部署约定", content:"prod 用 prod-up.sh…", }` → 200,body 有 id;DB 行 `agentId=A, createdByAgentId=A, searchText="部署约定\n\n<content>"`
  2. create 共享:`{..., shared:true}` → 行 `agentId=null`
  3. 校验:title 空/201 字、content 空/32KB+1 → 各 400
  4. list `?scope=all`:A 见 自己私有+共享(共 N 条,不含 content 字段);B 见 B 的+共享,**不见 A 私有**;`?scope=mine` / `?scope=shared` 过滤正确;`mine` 条目带 `mine:true`
  5. 分页:造 55 条,limit 默认 50,第二页 `?before=<尾条 id>` 取余 5,`hasMore` 两页语义正确
  6. search:content 含"数据库设计",q=`数据库` → 命中,snippet 含命中段±省略号,响应含 `id`;B 搜 A 私有词 → 0 条;q=`100%`(content 含字面 `100%`)→ 只命中字面,不当作通配
  7. detail:全 id + 8 位短 id(前缀)均可取 content;伪造短 id → 404;非 6+hex 乱串 → 404 不 500
  8. update:A 改自己(title+content)→ searchText 重固化、updatedAt 变;B 建 shared 后 A `update` 该条 → **404**(creator-only,不泄露);A 改自己不存在 id → 404
  9. delete:creator 删自己 → list 无此条;B 删 A 的 → 404
  10. scope 门控:custom scopes 无 `knowledge:write` → create/update/delete 403;无 `knowledge:read` → list/search/detail 403
  11. 租户:server2 的 agent list/search → 不见 server1 任何条目(含 shared)
  12. 人类面(段二,JWT+`handleApi`,辅助函数照 agentMigrate 的 `makeReq/makeRes/apiCall`):owner `GET /api/agents/A/knowledge` → A 私有+共享(带 createdByAgentId→handle 映射);普通 member(无 manageAgents)→ 403;`?scope=private|shared` 过滤。**本组在 Task 4 保持 RED,Task 5 实现后转绿**
- [x] **Step 4.2** 跑(`set -a; source .env; set +a; npx tsx test/knowledge.integration.ts`)→ 预期 FAIL(404/模块缺)。模板辅助名:agent 面用 channelArtifacts 的 `jsonReq/getReq/mkRes/call`,人类面用 agentMigrate 的 `makeReq/makeRes/apiCall`
- [x] **Step 4.3** 建 `src/server/routes-agent/knowledge.ts`(`handleKnowledgeRoutes(req,res,url,method,p,agent,serverId): Promise<boolean>`,逐字仿 artifacts.ts 头注释契约:网关已解析 agent+serverId,`p` 前缀不匹配 return false):

  - `POST /agent-api/knowledge/create`:body `{title, content, shared?}`;trim title 非空 ≤200,content 非空 ≤32KB(超限 400 带 limit 数);insert `{serverId, agentId: shared? null : agent.id, createdByAgentId: agent.id, title, content, searchText: buildSearchText(...)};` 回 `{ok:true, id, shared:!!shared, createdAt}`
  - `GET /agent-api/knowledge/list`:scope∈mine|shared|all(默认 all);可见域 = mine:`agentId=agent.id` / shared:`agentId is null` / all:or 两支(and 包 serverId);select **不含 content**(id,title,agentId,createdByAgentId,createdAt,updatedAt + 派生 `mine`/`shared`);`orderBy(desc(createdAt), desc(id))`,`limit+1` 哨兵出 `hasMore`;`before=<id>` keyset:先查该行 (createdAt,id),再 `or(lt(createdAt,c), and(eq(createdAt,c), lt(id,i)))`;limit clamp 1..50
  - `GET /agent-api/knowledge/search`:q 必填非空;`ilike(schema.knowledge.searchText, "%"+escapeLike(q)+"%")` + 可见域(all 固定——搜自己+共享)+ serverId;select id,title,snippet(sql 不算,取 content 后 makeSnippet(content,q) 在 JS 侧生成,同 `src/server/routes-api/messages.ts:105` 先例),shared,mine,createdAt;同款 keyset+hasMore
  - `GET /agent-api/knowledge/detail?id=`:`resolveIdOrPrefix(schema.knowledge, serverId, id)`;null 或 不可见(非 owner 私有)→ 404;回全字段含 content
  - `PATCH /agent-api/knowledge/update`:body `{id, title?, content?}`;resolve + `createdByAgentId === agent.id` 否则 404;title/content 给了才校验+更新;`searchText: buildSearchText(新title, 新content)`(用合并后值)、`updatedAt: new Date()`;回 `{ok:true, id, updatedAt}`
  - `DELETE /agent-api/knowledge/delete?id=`:resolve + creator-only;硬删;回 `{ok:true, id}`
  - import:`and, or, eq, ne, gt, lt, ilike, isNull, desc` + db/schema + `sendJson, sendErr, isUuid`(util)+ `resolveIdOrPrefix`(core)+ 本文件 helper —— 从本文件(在 `routes-agent/` 子目录)引 `src/server/knowledge.ts` 用 `../knowledge.js`(同 `../util.js` 先例;`../../` 只用于跨出 server 目录如 `../../db/index.js`)
- [x] **Step 4.4** `routes-agent.ts` 接线(import 行 + requiredScope 三行 + mount 一行):

```ts
if (p === "/agent-api/knowledge/create" || p === "/agent-api/knowledge/update" || p === "/agent-api/knowledge/delete") return "knowledge:write";
if (p.startsWith("/agent-api/knowledge/")) return "knowledge:read";
// …:539 artifacts mount 旁
if (await handleKnowledgeRoutes(req, res, url, method, p, agent, serverId)) return true;
```

- [x] **Step 4.5** `core.ts` resolveIdOrPrefix 参数类型:`typeof schema.messages | typeof schema.attachments | typeof schema.knowledge`(实现零改动——三种表都有 id/serverId)
- [x] **Step 4.6** 跑集成 → **用例 1-11 全 PASS;用例 12(人类面)按设计仍 RED**;`npm run typecheck` 过
- [x] **Step 4.7** Commit:`feat(server): /agent-api/knowledge/* — create/list/search/detail/update/delete (two-tier visibility, creator-only writes)`

### Task 5: 人类面只读端点

**Files:**
- Modify: `src/server/routes-api/agents.ts`(仿文件内既有 per-agent GET 路由 + requireCap("manageAgents") 先例)
- Test: `test/knowledge.integration.ts` 段二已在 Task 4 写好(先失败后实现——本 task 即实现)

- [x] **Step 5.1** `GET /api/agents/:id/knowledge?scope=private|shared|all&limit=&before=`:agent 存在且本 server(404 否则);requireCap manageAgents(403);返回该 agent 私有(`agentId=:id`)+ 共享(`agentId is null`)行,含 content(管理员只读浏览,≤50/页),每行 `createdBy`(createdByAgentId → agents.name 映射,batch inArray 一次查);同款 keyset 分页
- [x] **Step 5.2** 跑集成(含人类面 12 号用例)→ PASS;typecheck 过
- [x] **Step 5.3** Commit:`feat(server): GET /api/agents/:id/knowledge — admin read-only knowledge browse`

### Task 6: CLI 6 子命令

**Files:**
- Modify: `src/cli/index.ts`(artifact 组 :138-164 旁加 knowledge 组;`api()`/stdin 读法照抄文件内既有用法 — message send 的 stdin 读、artifact list 的 GET 形态)

- [x] **Step 6.1** 加命令组(stdout 输出仿 artifact/task 风格,英文文案):

```ts
const knowledge = program.command("knowledge").description("knowledge base (searchable facts; private by default, --shared for all agents)");
knowledge.command("create").description("save a knowledge entry (content from --content, --file, or stdin)").requiredOption("--title <t>").option("--content <t>").option("--file <path>").option("--shared").action(/* 读 content:--content > --file > stdin;POST create;打印 `Saved <id> (shared|private): <title>` */);
knowledge.command("list").description("list knowledge entries").option("--mine").option("--shared").option("--limit <n>").action(/* GET list;表格行 `id  S|P  title  updatedAt` */);
knowledge.command("search").description("search knowledge (substring, CJK-safe)").requiredOption("--query <q>").action(/* GET search;行 `id  S|P  title — snippet` */);
knowledge.command("show").description("show one entry (full id or short id)").requiredOption("--id <id>").action(/* GET detail;title+content 全文 */);
knowledge.command("update").description("update title/content of an entry you created").requiredOption("--id <id>").option("--title <t>").option("--content <t>").option("--file <path>").action(/* PATCH update */);
knowledge.command("delete").description("delete an entry you created").requiredOption("--id <id>").action(/* DELETE delete */);
```

- [x] **Step 6.2** `npx tsx src/cli/index.ts knowledge --help` 六子命令齐;`npx tsx --test --test-force-exit test/cliMime.unit.test.ts` 过(CLI 面相邻)
- [x] **Step 6.3** Commit:`feat(cli): open-tag knowledge create/list/search/show/update/delete`

### Task 7: 常驻提示一段(TDD 断言先行)

**Files:**
- Modify: `src/daemon/prompt.ts`(L123 notes 段后、L125 Compaction safety 前插 `## Knowledge base` 段)
- Test: `src/daemon/prompt.test.ts`(加断言)

- [x] **Step 7.1** 先在 `prompt.test.ts` 加:

```ts
test("knowledge base section teaches create/search and the notes/ split", () => {
  assert.match(prompt, /## Knowledge base/i);
  assert.match(prompt, /knowledge create/i);
  assert.match(prompt, /knowledge search/i);
  assert.match(prompt, /--shared/i);
});
```

- [x] **Step 7.2** 跑 `npx tsx --test --test-force-exit src/daemon/prompt.test.ts` → FAIL
- [x] **Step 7.3** prompt.ts 插段(runtime 无关,零 provider 工具名):

````
## Knowledge base
`open-tag knowledge` stores searchable entries on the workspace server — they survive session resets, and `--shared` entries are readable by every agent in this workspace.
- The moment you learn a durable, reusable fact (a teammate's preference, a project convention, a hard-won gotcha), save it: `open-tag knowledge create --title "<short name>"` with the content piped on stdin (or `--file <path>`).
- Before starting work, recall what you already know: `open-tag knowledge search "<topic>"`.
- Use `--shared` for team-wide facts; keep personal working notes private.
- Local `${c.stateDir}/notes/` files and the knowledge base are complementary: notes hold working context; knowledge holds durable searchable facts.
````

- [x] **Step 7.4** 跑 → PASS;红线 grep:新增段无 `Read|cat|grep|ls` 等工具名
- [x] **Step 7.5** Commit:`feat(daemon): standing prompt Knowledge base section`

### Task 8: web Knowledge tab

**Files:**
- Modify: `web/src/views/Members.tsx`(tab 数组 :262-270 加 `["knowledge", t("members.tabKnowledge")]` —— **filter 同 dms:`k !== "knowledge" || capabilities.manageAgents`**,后端对非管理员 403,不门控会开出错误 tab;:274-279 分支加 `KnowledgeTab`;新组件 `KnowledgeTab` 放本文件,仿 `RemindersTab`(:617)的取数+列表形态:fetch `GET /api/agents/:id/knowledge`,私有/共享两组,行 = title + 创建者 + 时间,点击展开 content(行内 `<pre>` 折叠),空态文案)
- Modify: `web/src/locales/en.json` + `zh.json`(`members.tabKnowledge`: "Knowledge"/"知识库" + 组标签/空态/创建者字段名等 ≤6 键;**creator 为 null 渲染 "(未知)" 类兜底,不假设非空**——软删 agent 名仍可解析,硬删无路径但别崩)

- [x] **Step 8.1** 组件 + tab + locale 键;`npm run typecheck` 过
- [x] **Step 8.2** Commit:`feat(web): agent profile Knowledge tab (admin read-only browse)`

### Task 9: docs 同批同步

**Files:**
- Modify: `FEATURES.md`(P7 knowledge 行**重写**为 ILIKE 实现 + 勾选;P2 :29 pending 行删 knowledge 句;P3/P7 注记核对)
- Modify: `ARCHITECTURE.md` §II(agent-api 路由表 + CLI 子命令 + scopes 15;**一句话注明 keysetWhere/clampLimit 由 routes-api/agents.ts 有意跨面复用 routes-agent/knowledge.ts——两平面游标语义同源**)
- Modify: `docs/authorization.md`(:64 "14 capability literals"、:67 "grants all 14" 等 14→15 引用全改)
- Modify: `docs/PLANS.md`(Active 加 agent-knowledge 条目链 spec+本计划)
- Modify: `docs/tech-debt-tracker.md`(新 I 条目:v1 无 trigram/索引,ILIKE 顺序扫描,量大再补;同条注记:CLI list/search 未暴露 hasMore/--before,>50 条静默截断;prompt.ts Startup sequence 第 5 步未同步 knowledge 去向提示;prompt.test.ts 可加 provider 工具名负向断言把红线机械化)
- Modify: `README.md` / `README.zh-CN.md`(各 "Core capabilities"/"项目状态" 节加一行——两文件同批)

- [x] **Step 9.1** 逐文件改;`/doc-sync` 精神自检:表/路由/scope/feature 四处全对上
- [x] **Step 9.2** Commit:`docs: knowledge base sync (FEATURES/ARCHITECTURE/PLANS/tech-debt/README)`

### Task 10: 发版准备(不发布)

**Files:**
- Modify: `packages/daemon/package.json`(version minor +1,先看现值)
- Modify: `CHANGELOG.md`(该版本条目:knowledge CLI 6 子命令 + prompt Knowledge 段;发版动作说明)

- [x] **Step - [x] **Step 10.1** bump + CHANGELOG 条目
- [x] **Step - [x] **Step 10.2** Commit:`chore(release): daemon <版本> — knowledge CLI + prompt (unreleased)`

### Task 11: 全量回归 + 实跑 E2E

- [x] **Step - [x] **Step 11.1** 全量单元:`npx tsx --test --test-force-exit test/*.unit.test.ts src/daemon/*.test.ts web/src/views/*.test.ts` → 全绿
- [x] **Step - [x] **Step 11.2** 集成顺序跑(I97:DB-backed 不并行):knowledge + channelArtifacts + agentMigrate + taskAssignAgent → 全绿
- [x] **Step - [x] **Step 11.3** `npm run dev:e2e:up`(worktree 内;需 claude CLI 已登录)→ 记下打印的 dev-login URL
- [x] **Step - [x] **Step 11.4** 浏览器(Playwright/chrome-devtools MCP)实跑:dev-login → @dev-bot DM 或 #all 发:"用 open-tag knowledge:create 一条私有(title '团队约定',content '周三发布窗口,禁直推 main');再 create 一条 --shared(title '工作区词汇',content '数据库设计稿放 artifacts');然后 search '发布' 和 search '数据库' 各一次;update 团队约定那条的 content 追加 '变更需两人评审';最后 list 给我看全表" → agent 真跑 CLI → 回复含两次命中+列表;截图存 `.shots/`(create 私有/共享 + search CJK + update + list 全覆盖)
- [x] **Step - [x] **Step 11.5** 浏览器:agent Profile → Knowledge tab 显示该条(截图 `.shots/`)
- [x] **Step - [x] **Step 11.6** `npm run dev:e2e:down`
- [x] **Step - [x] **Step 11.7** 更新 `.agents/notes/2026-09-21-agent-knowledge.md` 开发日志(证据链接);Commit:`test: knowledge e2e evidence + dev log`
- [x] **Step - [x] **Step 11.8** push 分支 + 开 PR(标题 `feat: agent knowledge base (P7)`;正文含 spec/计划链接 + 证据清单 + "daemon publish pending maintainer release")。**不建 GitHub Release、不发 npm** — 发版留给 maintainer(外发动作)

---

## 验收(全部满足才算完)

- 集成 12 组用例全绿;单测+prompt 断言全绿;typecheck 过
- dev:e2e 实跑:agent 真 CLI create→search 闭环 + Knowledge tab 截图证据
- docs 五处同批;FEATURES P7 行已重写勾选
- daemon 包 version+CHANGELOG 就绪未发布;PR 开好
- 失败项如实列出(fail loud)
