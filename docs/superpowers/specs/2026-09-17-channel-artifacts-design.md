# 频道制品（Channel Artifacts）— 设计

日期：2026-09-17 · 状态：待评审

## 背景与目标

agent 通过 CLI 反复上传同名交付物（架构报告、截图等），每次都是孤立附件：
名字不稳定（甚至捡到服务端落盘键名 `<uuid>__<原名>` 再传）、无说明、无版本关联、
无法回答"这份报告的最新版是哪个"。

**目标**：CLI 上传时可指定**制品名 + 制品说明**；同一频道内同名制品的重复上传
**演进为版本**；消息卡片显示制品名 / 说明 / `vN`。

**非目标（v1 明确不做）**：
- 制品删除、归档、跨频道移动
- 人类面 REST/UI 上传制品（agent/CLI 面先行；UI 仅展示）
- Files 页制品库/版本历史 UI（卡片增强先行，库后续另立切片）
- 版本间 diff、下载统计

## 数据模型（`src/db/schema.ts`）

```ts
artifacts = pgTable("artifacts", {
  id, serverId FK, channelId FK channels,
  name: text notNull,               // 展示名，频道内唯一（大小写敏感精确匹配，与 mime 门控同哲学）
  description: text,
  createdByType: "agent"|"user", createdByAgentId?, createdByUserId?,
  createdAt, updatedAt,
}, uniqueIndex("artifacts_channel_name_uniq").on(channelId, name))

artifact_versions = pgTable("artifact_versions", {
  id, artifactId FK artifacts (cascade), serverId, channelId,   // 冗余 server/channel 便于门控与查询
  version: integer notNull,        // artifact 内递增，从 1 起
  attachmentId FK attachments,     // 一个版本指向一个附件（附件仍可独立存在于消息）
  note: text,                      // 版本级备注（可空）
  createdByType, createdByAgentId?, createdByUserId?,
  createdAt,
}, uniqueIndex("artifact_versions_artifact_version_uniq").on(artifactId, version))
```

设计要点：
- **版本 = 落库时 `max(version)+1`**，在 publish 事务内计算；并发 publish 同名制品时
  唯一索引兜底冲突（重试一次或 409，实现取重试一次）。
- attachment 与 version 是**引用而非独占**：附件照常可被 `message send --attach`
  引用。attachmentId FK 无 cascade（将来若有附件删除端点，删除被版本引用的附件会被 FK 报错
  阻断——这是刻意的完整性保护；v1 无删除端点，不建"删附件→版本悬挂"测试）。
  字节缺失（存储层）沿现有 `readObject` 404 路径。
- `artifact_versions.attachmentId` 加唯一索引：一个附件至多属于一个版本，
  AttCard join 语义无歧义。
- 可见性：制品没有独立 ACL——一切经 `attachmentId → attachments.channelId` 走现有
  频道可见性门（`canAgentReadChannel` / `canUserReadChannel`，IDOR-B3 同款）。

## 服务端 API（agent 面，`src/server/routes-agent.ts` + 新 `src/server/routes-agent/artifacts.ts`）

- **scope 登记（必须）**：`requiredScope`（routes-agent.ts:28）新增映射——
  `/agent-api/artifact/publish` → `attachment:upload`；`/agent-api/artifact/list` 与
  `/agent-api/artifact/versions` → `attachment:view`。未登记路径在 custom scope 模式
  下不受门控 = 新增越权例外，不可接受。
- `POST /agent-api/artifact/publish` — multipart：`file` + `channel`（target 解析同
  attachment upload；**解析失败 → 404**，与 message send 一致——制品唯一性依赖
  channelId，不可像裸 attachment upload 那样落 null 频道）+ `name` + `description`? + `note`?
  流程：parseUpload（含 MIME sniff/管线全复用）→ 频道写权限门（**新检查**：
  scope `attachment:upload` + resolveTarget 读门 + canAgentWriteChannel 式写门——
  注意裸 attachment upload 现无独立写门/403，不可照抄）→ upsert artifact（按 channelId+name）→ 事务内取 next version →
  插 version 行 → 返回 `{artifactId, name, version, attachmentId, filename, mimeType}`。
  幂等性：无（重复 publish = 新版本，这是设计语义）。
- `GET /agent-api/artifact/list?channel=<target>` — 该频道制品列表：
  `{artifacts: [{id, name, description, latestVersion, latestAttachmentId, latestMime, updatedAt}]}`，
  按 updatedAt 倒序。权限：agent 对频道可读。
- `GET /agent-api/artifact/versions?id=<artifactId>`（或 `?channel=&name=`）—
  版本流水：`{versions: [{version, attachmentId, filename, mimeType, note, createdAt}]}` 倒序。
  权限：同上（经 artifact.channelId）。

## CLI（`src/cli/index.ts`）

```
open-tag artifact publish --file <path> --name <n> --channel <t> [--desc <text>] [--note <text>]
open-tag artifact list --channel <t>
open-tag artifact versions --name <n> --channel <t>
```

publish 输出 `Published <name> v<N> -> attachmentId <id>`，提示可用
`message send --attach <id>` 挂进消息（与现有流程一致，不自动发消息）。

## 系统提示词（`src/daemon/prompt.ts`）

CLI 规范新增 artifact 组（publish/list/versions，一句话语义：可版本化交付物，
重复发布同名 = 新版本）。**daemon 打包范围 → 需发版 0.16.0（新能力 minor）+ CHANGELOG。**

## UI：卡片增强（仅展示）

- attachments 元数据扩展 `{id, filename, mimeType, sizeBytes, artifactName?, artifactVersion?, artifactDescription?}`。
  **两个生产者都要改**（漏一个 = 实时有制品名、刷新 REST 后消失）：
  1. 实时 socket：`core.ts serializeMsg`（纯同步函数，不自行查库）
  2. REST 历史/任务：`src/server/routes-api/shared.ts attachMentions()`（messages.ts /
     tasks.ts 用的独立映射，同形输出）
  实现：新增 helper `artifactMetaByAttachmentIds(ids): Promise<Map<attachmentId, meta>>`
  （一次 `inArray(artifact_versions.attachmentId, ids)` 查询，join artifacts 取 name/
  description；N+1 禁止）。`serializeMsg` 增加可选参数 `artifactMeta?: Map`（保持同步
  纯函数），六个调用点（core.ts:291/514/516/744/763/782）在有序列化上下文处先取
  map 再传入；`attachMentions` 同样先取 map 合并字段。
- `AttCard`（`web/src/views/Chat.tsx`）：有 artifactName 时主标题用制品名，
  徽标 `vN`，说明作副行（title/副文本）；无制品照旧。AttMdPreview/AttPreview
  弹窗标题优先制品名（`vN · 制品名`）。
- Files 页 v1 不改。

## 错误处理

- publish 到不可写频道 → 403（新写门，见上文；裸 attachment upload 无此路径）
- name 为空 / >200 字符 → 400
- versions/list 查不存在的制品 → 404
- 并发 publish 版本冲突（唯一索引）→ 服务端重试一次，仍冲突 409
- 附件字节读取失败沿现有 readObject 404 路径

## 安全

- 三平面不变量不新增例外：agent 面全部走 resolveAgent + 频道门；
  artifacts 表行含 serverId 冗余，查询一律 `and(eq(serverId), …)` 防跨租户
- 制品名/说明是 agent 可控文本 → **只以纯文本渲染**（AttCard 文本节点，
  不进 markdown/HTML 管线），零 XSS 面
- publish 权限 = 该频道附件上传权，无提权

## 验证

- 单测/集成：publish 首版= v1、重复 publish 递增、同名跨频道互不影响、
  非成员 agent publish/list/versions 拒绝（403/404）、serializeMsg 元数据带制品
  字段、并发冲突路径
- 浏览器（worktree 隔离栈）：CLI publish html/md/png 各一次（同名两次→v2）→
  `message send --attach` → 卡片显示制品名+vN+说明 → 点击预览照常（html 沙箱/
  md 管线/图片内联）
- `npm run typecheck` 双绿；doc-sync：db-schema.md / ARCHITECTURE codemap /
  FEATURES / CHANGELOG；daemon 版本 0.16.0

## 实现载体

worktree `channel-artifacts`（wt:add），PR 从 worktree。涉及：schema.ts、
routes-agent(+新文件)、core.ts serializeMsg、cli/index.ts、prompt.ts、
web Chat.tsx + AttPreview/AttMdPreview 标题、packages/daemon 0.16.0、CHANGELOG、
docs 同步。
