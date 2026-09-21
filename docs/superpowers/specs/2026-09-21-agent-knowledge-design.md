# Agent 知识库(Knowledge Base)— 设计

日期:2026-09-21 · 状态:待评审 · 定位:P7 最后一个已规划核心项(agent memory 的可检索层)

## 背景与目标

任务书:**agents that have memory, accumulate memory**。现状 agent 记忆只有
MEMORY.md 单文件(整文件读,无检索);daemon 本地 `notes/*.md` 有提示但同样不可检索。
知识量增长后,agent 无法在开工前快速召回既有事实——知识库补这一层。

既有地基:`knowledge` 表已建(schema.ts:391,id/serverId/agentId 可空/title/content/
searchText/createdAt),`knowledge:read` scope 已定义(scopes.ts:18),无端点无 CLI。
FEATURES P7 描述方向:agent 自建多条 memo,全文检索,受众是 agent 自己。

**目标(v1)**:agent 经 CLI 读写知识条目(私有 + 工作区共享两层),ILIKE 子串检索
(CJK 正确),管理员在 Profile 只读浏览。

**非目标**:
- tsvector/zhparser 全文检索(见"检索方案"决策)
- 人类写入/编辑知识(管理员只读)
- 跨工作区知识、知识导入导出
- embedding/语义检索
- Web UI 上给 agent 写知识的入口(agent 面只有 CLI)

## 归属两层(用户决策 2026-09-21)

| 层 | agentId | 读 | 写/改/删 |
|---|---|---|---|
| 私有 | 必填=owner | 仅 owner agent | 仅 owner |
| 工作区共享 | null | 本 server 全部 agent | 仅创建者 |

- 新列 `created_by_agent_id`(共享条目溯源;私有条目=owner,冗余但统一)
- 新列 `updated_at`
- 索引:`(serverId, agentId)` 列表查询;`(serverId)` 共享层扫描

## 检索方案:ILIKE + snippet(弃 tsvector,用户已确认)

- 沿用 message search 先例(`GET /api/messages/search`:ilike + snippet + hasMore)
- tsvector `simple` 配置对中文无效(连续 CJK 整句成单 token,"数据"匹配不到"数据库设计");
  zhparser/pg_jieba 需自建 PG 镜像,违背零配置自部署
- `searchText` 列 = 写入时固化 `title + "\n\n" + content`,检索只 ILIKE 这一列,
  snippet 从 content 生成
- v1 **不加** pg_trgm 索引(免扩展部署摩擦);条目量自部署规模小,顺序扫描够用;
  记 tech-debt,量大再补

## Scopes

- `knowledge:read`(已存在):读两层
- `knowledge:write`(新增,14→15 个 scope):create/update/delete 两层
- 权限 UI(Permissions tab scope 分组)同步加 knowledge:write

## Agent API(`/agent-api/knowledge/*`,新文件 `src/server/routes-agent/knowledge.ts`)

仿 `routes-agent/artifacts.ts` 拆分先例。全部走 agent token 鉴权 + scope 门控
+ serverId 租户隔离(从 token 上下文取,不信 body)。

- `POST /agent-api/knowledge/create` `{title, content, shared?}`
  - title ≤200 字符 trim 非空;content ≤32KB 非空;`shared:true` → agentId=null,
    否则 agentId=caller。响应含 id、createdAt
- `GET /agent-api/knowledge/list?scope=mine|shared|all&limit=&before=`
  - 默认 all = 自己私有 + 共享,keyset 分页(createdAt+id 倒序),50/页
  - 返回条目:id/title/shared/createdAt/updatedAt/mine(是否自己创建)
  - **不返回 content**(列表瘦身,content 经 search 命中或 detail 取)
- `GET /agent-api/knowledge/search?q=&limit=&before=`
  - q 非空,ILIKE `%q%`(转义 `%_\`)扫 searchText,回 title + snippet(content
    命中段 ±60 字符)+ shared/mine/createdAt;keyset 分页;50/页
- `GET /agent-api/knowledge/detail?id=`(补 content 取回;id 支持前缀解析,
  走 `resolveIdOrPrefix` 同款 uuid 规范——关 tech-debt I87 方向)
- `PATCH /agent-api/knowledge/update` `{id, title?, content?}`
  - 仅创建者(createdByAgentId = caller);他人条目含共享层 → 404(不泄露存在性)
  - 更新时重固化 searchText + updatedAt
- `DELETE /agent-api/knowledge/delete?id=` — 仅创建者,硬删(v1 无引用面)

## 人类面(只读)

`GET /api/agents/:id/knowledge?scope=private|shared|all`
- JWT + `manageAgents` capability 门控
- 返回该 agent 私有条目 + 工作区共享条目(含 createdByAgentId → 前端映射创建者名)
- Agent Profile 新 **Knowledge tab**:私有/共享分组,只读列表 + 查看 content 弹层;
  复用现有 tab 结构(overview/permissions/…/activity 旁加一项)

## CLI(`src/cli/index.ts`)

```
open-tag knowledge create --title "..." [--file f.md | --content "..."] [--shared]
open-tag knowledge list [--mine|--shared] [--limit N]
open-tag knowledge search "query"
open-tag knowledge show <id|prefix>
open-tag knowledge update <id|prefix> [--title ...] [--file ... | --content ...]
open-tag knowledge delete <id|prefix>
```
- create 支持 `--file`(长内容经文件,stdin heredoc 同 message send 先例)
- 输出 stdout 干净(表格/列表),镜像现有子命令风格

## 常驻提示(prompt.ts)

新增 `## Knowledge` 段(与 notes/ 分工):
- notes/ = 本地自由文件(结构自定);knowledge = 服务端可检索条目(标题+正文+检索)
- 行为指引:学到**可复用事实**(队友偏好、项目约定、踩坑结论)即 create;
  开工前先 `knowledge search` 召回;共享层放全组有用的事实,私放个人工作笔记
- runtime 无关措辞(红线:无 provider 工具名)

## 安全

- agent 面:token 鉴权 + scope 双门控 + serverId 租户隔离;id 前缀解析走 uuid 规范
- 越权矩阵:他人私有 → list/search/detail 均不可见(404/空);共享层改删仅创建者
- 人类面:manageAgents 门控,只读
- 无 daemon 面变更(知识库纯 server 数据 + agent HTTP 面)

## 验证(TDD,用户指定)

测试先行,每层:

1. **单元**(`test/knowledge.unit.test.ts`):
   - searchText 固化/重固化;ILIKE 通配符转义;snippet 截取边界(CJK、命中在首尾)
   - scope 门控矩阵(read/write × 私有/共享/他人)
2. **集成**(`test/knowledge.integration.ts`,DB-backed):
   - 可见性:agent B list/search 不见 A 私有;shared 两边可见
   - 写权限:B update/delete A 的共享条目 → 404;A 自己 → 200
   - 分页 keyset 正确性;create 校验(title 空/超长、content 超限)
   - 人类面:无 manageAgents → 403;有 → 只读拿到 A 私有+共享
3. **E2E**(dev:e2e 栈,涉 agent runtime 面必须):
   - @dev-bot 实跑:`knowledge create`(私有+共享)→ `search` 命中(中文查询)
     → `update` → `list` → Profile Knowledge tab 浏览器可见(截图)
4. **doc-sync**:db-schema.md(新列/索引)、ARCHITECTURE §II(路由/CLI)、
   FEATURES P7(勾选 knowledge 行、删 P2 pending 注)、scopes 权限 UI、
   tech-debt(无 trigram 索引注记)

## 实现载体

worktree `agent-knowledge`(分支 `feature/agent-knowledge`)。涉及:
`src/db/schema.ts`(2 列+2 索引)、`src/server/routes-agent/knowledge.ts`(新)、
`src/server/routes-api/agents.ts`(只读端点)、`src/cli/index.ts`(6 子命令)、
`src/daemon/prompt.ts`(1 段)、web(Profile Knowledge tab + 权限 UI 1 行)、docs 同批。
预计 ~400 行 + 测试。

**零 daemon bundle 变更**(prompt.ts 属常驻提示,daemon 已带;无 daemon 协议改动)
——无发版项;但 prompt.ts 变更需 grep provider 工具名 = 零命中(红线)。
