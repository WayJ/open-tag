# Channel Artifacts（频道制品）Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CLI 可发布带制品名+说明的版本化制品（频道内同名演进 v1→v2→…），消息卡片显示制品名/vN/说明。

**Architecture:** 双表（`artifacts` 频道内唯一名 + `artifact_versions` 递增版本指向附件）；agent 面三端点（publish/list/versions）复用 parseUpload 与 resolveTarget 门；序列化双路径（serializeMsg socket + attachMentions REST）都带制品元数据；UI 纯文本卡片增强。

**Tech Stack:** TypeScript、drizzle/pg、node:test（单测+集成）、React18。新依赖：无。

**Spec:** `docs/superpowers/specs/2026-09-17-channel-artifacts-design.md`

---

## 前置：worktree

- [ ] **Step 0.1:** 主仓库 `npm run wt:add -- channel-artifacts`，`cd ../open-tag-channel-artifacts`。后续路径相对该 worktree。`cd docs-site && npm install`（e2e 构建需要，每个新 worktree 都缺）。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/db/schema.ts` | Modify | artifacts + artifact_versions 两表 |
| `src/server/core.ts` | Modify | `artifactMetaByAttachmentIds` helper、serializeMsg 可选 Map 参数、3 个非空调件调用点接线 |
| `src/server/routes-api/shared.ts` | Modify | attachMentions 合并制品元数据（REST 路径） |
| `src/server/routes-agent/artifacts.ts` | Create | publish/list/versions 三端点 |
| `src/server/routes-agent.ts` | Modify | 挂载 artifacts 路由 + requiredScope 三行 |
| `src/cli/index.ts` | Modify | `artifact` 命令组（publish/list/versions） |
| `src/daemon/prompt.ts` | Modify | CLI 规范一行 |
| `web/src/store.tsx` | Modify | `Att` 类型加可选制品字段 |
| `web/src/views/Chat.tsx` | Modify | AttCard 制品名/vN/说明；两个弹窗 label |
| `web/src/AttPreview.tsx` / `AttMdPreview.tsx` | Modify | 可选 `label` prop 覆盖标题 |
| `web/src/styles.css` | Modify | `.msg-att-art` 徽标/副行样式 |
| `packages/daemon/package.json` + `CHANGELOG.md` | Modify | 0.16.0 + 条目 |
| `docs/generated/db-schema.md` 等 | Modify | doc-sync（Task 8） |
| `test/channelArtifacts.integration.ts` | Create | API 集成测试 |
| `test/artifactMeta.unit.test.ts` | Create | 序列化元数据测试 |

---

### Task 1: 数据模型（schema + push + 文档）

**Files:** Modify `src/db/schema.ts`（attachments 表 ~287 行后追加）

- [ ] **Step 1.1: schema.ts 追加两表**（跟随现有 uuid/timestamp/索引命名惯例）

```ts
// Channel artifacts: versioned deliverables agents publish via CLI (`open-tag artifact publish`).
// name is unique per channel; every publish appends a version row pointing at a fresh
// attachment (attachmentId unique — one attachment belongs to at most one version).
// No independent ACL: visibility rides attachments.channelId through the existing channel gates.
export const artifacts = pgTable("artifacts", {
  id: uuid("id").defaultRandom().primaryKey(),
  serverId: uuid("server_id").notNull().references(() => servers.id),
  channelId: uuid("channel_id").notNull().references(() => channels.id),
  name: text("name").notNull(),
  description: text("description"),
  createdByType: text("created_by_type").notNull(),        // agent | user
  createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  chanUniq: uniqueIndex("artifacts_channel_name_uniq").on(t.channelId, t.name),
}));

export const artifactVersions = pgTable("artifact_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  artifactId: uuid("artifact_id").notNull().references(() => artifacts.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id),
  channelId: uuid("channel_id").notNull().references(() => channels.id),
  version: integer("version").notNull(),
  attachmentId: uuid("attachment_id").notNull().references(() => attachments.id), // no cascade: deleting a referenced attachment is blocked (intentional)
  note: text("note"),
  createdByType: text("created_by_type").notNull(),
  createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  verUniq: uniqueIndex("artifact_versions_artifact_version_uniq").on(t.artifactId, t.version),
  attUniq: uniqueIndex("artifact_versions_attachment_uniq").on(t.attachmentId),
  byChannel: index("artifact_versions_channel_idx").on(t.channelId),
}));
```

（`integer`/`uniqueIndex`/`index` 若未从 drizzle-orm 导入则补——先查文件头 import。）

- [ ] **Step 1.2:** `set -a; source .env; set +a; npm run db:push` → 输出两新表 applied。
- [ ] **Step 1.3:** **手动**更新 `docs/generated/db-schema.md`（头注释明说无生成脚本、手动同步）——按文件内既有表格格式补 artifacts / artifact_versions 两节。
- [ ] **Step 1.4:** `npm run typecheck` 绿。
- [ ] **Step 1.5: Commit** `git add src/db/schema.ts docs/generated/db-schema.md && git commit -m "feat(db): artifacts + artifact_versions tables"`

### Task 2: 序列化双路径带制品元数据（TDD）

**Files:** Modify `src/server/core.ts`、`src/server/routes-api/shared.ts`；Create `test/artifactMeta.unit.test.ts`

- [ ] **Step 2.1: 失败测试**（直连 DB 的集成风格单测，镜像 `test/channelAccess.integration.ts` 的 env/setup 惯例）

```ts
// Run: JWT_SECRET=x DAEMON_BOOTSTRAP_KEY=y npx tsx --test --test-force-exit test/artifactMeta.unit.test.ts
// Covers: artifactMetaByAttachmentIds mapping + serializeMsg optional-meta merge + attachMentions merge.
// Setup: seed server/channel/agent/attachment/artifact/v2 rows directly (mirror channelAccess.integration.ts helpers).
// 1) helper returns Map {attachmentId → {artifactName, artifactVersion, artifactDescription}}
// 2) serializeMsg(msg, [], [att], [], meta) → attachments[0].artifactName === "report" && artifactVersion === 2
// 3) serializeMsg without meta → attachments[0] has NO artifactName key (back-compat)
// 4) attachMentions([msgWithArtifactAttachment]) → attachments[0].artifactVersion present (REST path)
```

- [ ] **Step 2.2:** 跑测试确认失败（helper 不存在 / 字段缺失）。
- [ ] **Step 2.3: core.ts 实现**

```ts
export type ArtifactMeta = { artifactName: string; artifactVersion: number; artifactDescription: string | null };
/** Batch artifact metadata for serialization. Single inArray query (N+1 forbidden). */
export async function artifactMetaByAttachmentIds(ids: string[]): Promise<Map<string, ArtifactMeta>> {
  if (!ids.length) return new Map();
  const rows = await db.select({
    attachmentId: schema.artifactVersions.attachmentId,
    version: schema.artifactVersions.version,
    name: schema.artifacts.name,
    description: schema.artifacts.description,
  }).from(schema.artifactVersions)
    .innerJoin(schema.artifacts, eq(schema.artifacts.id, schema.artifactVersions.artifactId))
    .where(inArray(schema.artifactVersions.attachmentId, ids));
  return new Map(rows.map((r) => [r.attachmentId, { artifactName: r.name, artifactVersion: r.version, artifactDescription: r.description }]));
}
```

`serializeMsg` 签名加第 5 参 `artifactMeta?: Map<string, ArtifactMeta>`（保持同步纯函数），`atts.map` 内合并：
```ts
attachments: atts.map((a) => {
  const am = artifactMeta?.get(a.id);
  return { id: a.id, filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes,
    ...(am ? { artifactName: am.artifactName, artifactVersion: am.artifactVersion, artifactDescription: am.artifactDescription } : {}) };
}),
```
三个**有附件**的调用点接线（`atts` 非空处）：core.ts:291（历史读取）、514、516（createMessage 发布前）——在 serialize 前 `const ameta = await artifactMetaByAttachmentIds(atts.map((x) => x.id));` 传入。744/763/782 无附件不动。

- [ ] **Step 2.4: shared.ts attachMentions**——atts 查询后加 `const ameta = await artifactMetaByAttachmentIds(atts.map((a) => a.id));`，映射处同字段合并。
- [ ] **Step 2.5:** 测试转绿 + typecheck。
- [ ] **Step 2.6: Commit** `feat(server): artifact metadata on both serialization paths`

### Task 3: agent 面三端点（TDD）

**Files:** Create `src/server/routes-agent/artifacts.ts`、`test/channelArtifacts.integration.ts`（镜像 `test/taskAssignAgent.integration.ts` 的 agent 面范式：真实 agent token + 直调 handleAgentApi）；Modify `src/server/routes-agent.ts`

- [ ] **Step 3.1: 失败集成测试**（真实 DB；镜像 `test/channelAccess.integration.ts` harness；对 handler 直接发伪 req 或走 http 层——采用该文件现有做法）

用例清单：
1. publish 首次 → `{version:1, name}`，DB 有 artifact+version，attachment 带 MIME sniff 管线产物
2. 同名再 publish → version 2；description 更新生效
3. 同名不同频道 → 独立制品（各自 v1）
4. target 解析失败 → 404 TARGET_FAILED（不落 null 频道）
5. 线程 target（`thread:shortid` / `#chan:shortid`）→ 400（注意：resolveTarget 已把线程归一化为线程频道 id 且 `threadId: null`——**门控必须查 channel 行 `ch.type === "thread"` 判 400**，不能用 tgt.threadId，那是死代码）
6. name 空/201 字符 → 400
7. 非频道成员 agent 对私有频道 publish → 404/403（resolveTarget 语义）
8. custom scope 无 `attachment:upload` → 403（requiredScope 生效）
9. list 返回 latestVersion 倒序；versions 按 version 倒序含 note
10. 跨租户：构造第二 server 的制品，list/versions 不可见（serverId 过滤）

- [ ] **Step 3.2:** 跑测试全红（端点 404）。

- [ ] **Step 3.3: routes-agent/artifacts.ts 实现**——**首个 agent 面拆分文件**（现 routes-agent.ts 是单体 `handleAgentApi` 内联 if 链，无 ctx 对象、无 routes-agent/ 目录；本任务开先例）。签名按作用域实际值：
`export async function handleArtifactRoutes(req: IncomingMessage, res: ServerResponse, url: URL, method: string, p: string, agent: typeof schema.agents.$inferSelect, serverId: string): Promise<boolean>`
自行 import db/schema/parseUpload/resolveTarget/sendJson/sendErr/deleteObject；p/method 匹配处理返回 true，否则 false。

publish 核心（要点；`const chId = tgt.channelId` 先绑定，事务块统一用 `chId`）：
- `parseUpload` → files[0]（多文件取首个，多余忽略并日志 warn）
- `resolveTarget(serverId, fields.channel, agent.id)` → null → 404 TARGET_FAILED
- **线程门**：resolveTarget 把线程归一化为线程频道（threadId 恒 null），须查 channel 行：
  `const ch = (await db.select().from(schema.channels).where(eq(schema.channels.id, tgt.channelId)))[0]; if (ch?.type === "thread") return (sendErr(res, 400, "artifacts publish to channels, not threads"), true);`
- name 校验 1-200
- 先插 attachment 行（channelId 必填、uploaderType "agent"），再事务：
```ts
const out = await db.transaction(async (tx) => {
  let art = (await tx.select().from(schema.artifacts).where(and(eq(schema.artifacts.channelId, chId), eq(schema.artifacts.name, name))).limit(1))[0];
  if (!art) [art] = await tx.insert(schema.artifacts).values({ serverId, channelId: chId, name, description, createdByType: "agent", createdByAgentId: agent.id }).returning();
  else if (description !== null) await tx.update(schema.artifacts).set({ description, updatedAt: new Date() }).where(eq(schema.artifacts.id, art!.id));
  const mx = (await tx.select({ v: max(schema.artifactVersions.version) }).from(schema.artifactVersions).where(eq(schema.artifactVersions.artifactId, art!.id)))[0]?.v ?? 0;
  const [ver] = await tx.insert(schema.artifactVersions).values({ artifactId: art!.id, serverId, channelId: chId, version: mx! + 1, attachmentId: att.id, note, createdByType: "agent", createdByAgentId: agent.id }).returning();
  await tx.update(schema.artifacts).set({ updatedAt: new Date() }).where(eq(schema.artifacts.id, art!.id));
  return { artifactId: art!.id, version: ver!.version };
});
```
- 外层 catch：唯一索引冲突（`e.code === "23505"`）重试一次；二次冲突 → `deleteObject(att.storageKey)` 清理 + 409。`max` 从 drizzle-orm import。

list：resolveTarget → `canAgentReadChannel` 已内含 → 查 artifacts（channelId+serverId）left join 最新 version（子查询取 `max(version)` 对应行；实现可用两步：先 artifacts，再 inArray 取每制品最新版本行）→ updatedAt 倒序。
versions：`?id=` 或 `?channel=&name=` 定位制品 → 校验 serverId + canAgentReadChannel(artifact.channelId) → version 倒序 join attachments 取 filename/mimeType。

- [ ] **Step 3.4: routes-agent.ts 挂载**——import 后在 attachment upload（~524 行）附近插入 `if (await handleArtifactRoutes(req, res, url, method, p, agent, serverId)) return true;`；requiredScope 加三行：
```ts
if (p === "/agent-api/artifact/publish") return "attachment:upload";
if (p === "/agent-api/artifact/list" || p === "/agent-api/artifact/versions") return "attachment:view";
```

- [ ] **Step 3.5:** 集成测试转绿 + typecheck。
- [ ] **Step 3.6: Commit** `feat(server): /agent-api/artifact publish|list|versions`

### Task 4: CLI 命令组

**Files:** Modify `src/cli/index.ts`（attachment 命令组后）

- [ ] **Step 4.1:** 新命令组（publish 走 multipart，镜像 attachment upload 范式）：

```ts
const artifact = program.command("artifact").description("versioned channel artifacts");
artifact.command("publish").description("upload a file as a new version of a named artifact (re-publishing the same name appends a version)").requiredOption("--file <path>").requiredOption("--name <n>").requiredOption("--channel <channel>", "#name").option("--desc <t>").option("--note <t>").action(async (opts) => {
  const buf = await readFile(opts.file);
  const fd = new FormData();
  fd.append("channel", opts.channel); fd.append("name", opts.name);
  if (opts.desc) fd.append("description", opts.desc);
  if (opts.note) fd.append("note", opts.note);
  fd.append("files", new Blob([new Uint8Array(buf)], { type: mimeFor(opts.file) }), basename(opts.file));
  const res = await fetch(BASE + "/agent-api/artifact/publish", { method: "POST", headers: { authorization: `Bearer ${KEY}`, "x-agent-id": AGENT }, body: fd });
  const d: any = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`Error: ${d.error ?? res.statusText}`); if (d.code) console.error(`Code: ${d.code}`); process.exit(1); }
  console.log(`Published ${d.name} v${d.version} -> attachmentId ${d.attachmentId} (attach with: message send --attach ${d.attachmentId})`);
});
artifact.command("list").description("list artifacts in a channel").requiredOption("--channel <channel>").action(async (opts) => { /* api GET /agent-api/artifact/list?channel=…; 打印 name vN desc updated */ });
artifact.command("versions").description("version history of an artifact").requiredOption("--name <n>").requiredOption("--channel <channel>").action(async (opts) => { /* GET versions?channel&name; 打印 vN filename note created */ });
```

- [ ] **Step 4.2:** typecheck 绿（CLI 无单测设施——Task 7 e2e 真路径验证）。
- [ ] **Step 4.3: Commit** `feat(cli): open-tag artifact publish|list|versions`

### Task 5: prompt + daemon 0.16.0 + CHANGELOG

**Files:** Modify `src/daemon/prompt.ts`（CLI 列表 attachment 行后）、`packages/daemon/package.json`、`CHANGELOG.md`

- [ ] **Step 5.1:** prompt.ts 加一行（runtime-agnostic，无 provider 工具名）：
```
- \`open-tag artifact publish --file <path> --name <n> --channel <t> [--desc <t>] [--note <t>]\`(versioned deliverable: re-publishing the same name in a channel appends a new version; use the returned attachmentId with \`message send --attach\`) · \`open-tag artifact list --channel <t>\`(artifacts with latest version) · \`open-tag artifact versions --name <n> --channel <t>\`(history)
```
- [ ] **Step 5.2:** daemon 0.15.1 → **0.16.0**（新能力 minor）；CHANGELOG `## [0.16.0] — 2026-09-17` `### Added` 条目（channel artifacts 一段）。**发版提醒**：合并后需 GitHub Release `v0.16.0` 才 publish（与前序未发的 0.15.1 顺序：先发 0.15.1 再 0.16.0，或合并说明——执行时把 0.15.1 的 Unreleased 修复并入 0.16.0 一次发布亦可，CHANGELOG 里两版本并存）。
- [ ] **Step 5.3:** grep prompt.ts 无 provider 工具名（`Read`/`cat`/`grep` 等按 code-quality 规则核查）。
- [ ] **Step 5.4: Commit** `feat(daemon): artifact CLI in agent prompt; 0.16.0`

### Task 6: Web 卡片增强

**Files:** Modify `web/src/store.tsx`（Att 类型）、`web/src/views/Chat.tsx`（AttCard + 两弹窗调用）、`AttPreview.tsx`/`AttMdPreview.tsx`（label prop）、`styles.css`

- [ ] **Step 6.1:** `Att` 加 `artifactName?: string; artifactVersion?: number; artifactDescription?: string | null;`
- [ ] **Step 6.2:** 两个弹窗加 `label?: string` prop（默认 filename）：标题栏 `<span className="att-preview-name">{label ?? filename}</span>`、aria-label 同步。
- [ ] **Step 6.3:** AttCard 有制品字段时：
```tsx
const label = a.artifactName ? `${a.artifactName} · v${a.artifactVersion}` : undefined;
// 卡片：<span className="grow">{label ?? a.filename}{a.artifactDescription && <span className="msg-att-desc">{a.artifactDescription}</span>}</span> + 徽标 <span className="msg-att-ver">v{a.artifactVersion}</span>
// 弹窗：<AttPreview … label={label} /> / <AttMdPreview … label={label} />
```
纯文本节点渲染（制品名/说明不进任何 markdown/HTML 管线——安全不变量）。
- [ ] **Step 6.4:** styles.css `.msg-att-ver`（小徽标 pill）+ `.msg-att-desc`（12px muted 单行省略）。
- [ ] **Step 6.5:** typecheck（root+web）。
- [ ] **Step 6.6: Commit** `feat(web): artifact name/version/description on attachment cards`

### Task 7: 浏览器 e2e（worktree 栈）

前置：`npm run dev:e2e:up`；chrome-devtools/Playwright MCP。

- [ ] **Step 7.1:** CLI：`artifact publish` 同名 PNG ×2（v1→v2）+ html + md 各一；`artifact list`/`versions` 输出核对。
- [ ] **Step 7.2:** `message send --attach <v2-id>` → 卡片显示 `制品名 · v2` + 说明副行 + v 徽标；无制品的旧附件照旧（回归）。
- [ ] **Step 7.3:** 点击 html 制品 → AttPreview 沙箱预览，标题 = `名 · v2`；md 制品 → 渲染管线预览；png → 内联图。
- [ ] **Step 7.4:** **刷新页面**（REST 路径回归）→ 制品元数据仍在（双序列化路径验证）。
- [ ] **Step 7.5:** `npm run dev:e2e:down`。

### Task 8: doc-sync + 收尾

- [ ] **Step 8.1:** `ARCHITECTURE.md` codemap：routes-agent/artifacts.ts、CLI 子命令、AttCard 变化、两新表提及处。
- [ ] **Step 8.2:** `FEATURES.md` 勾选项（CLI 子命令行补 artifact 组 + 新功能行）。
- [ ] **Step 8.3:** `docs/authorization.md`：scope 表若逐条列 /agent-api 路径 → 补三行映射（先搜，无则不加）。
- [ ] **Step 8.4:** 全量回归：四个 mime 测试文件 + channelArtifacts + artifactMeta 全绿；typecheck 双绿。
- [ ] **Step 8.5: Commit** `docs: sync channel artifacts across codemap/features/authz` + push 分支 + `gh pr create`（gh 未认证则报告，不伪造）。
- [ ] **Step 8.6:** PR 描述声明一处 spec 偏离：publish 写门采用 resolveTarget 读门语义（= message send 同款，无独立 canAgentWriteChannel——当前不存在 agent 可读不可写的频道），spec 中"新写门"按此实现。

## 验证汇总（对齐 spec §验证）

单测/集成（Task 2/3）→ typecheck → 浏览器六步（Task 7）→ doc-sync（Task 8）。**未验证即未完成，PR 里明示跳过项。**
