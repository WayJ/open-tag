# 2026-09-17 · 频道制品（Channel Artifacts）

合并 commit：见 `git log`（Merge branch 'feature/channel-artifacts'）→ main
分支：feature/channel-artifacts（10 commits，worktree open-tag-channel-artifacts）
**daemon 版本按维护者决定保持 0.15.1**——变更留在 CHANGELOG [Unreleased]，发版延后（届时再 bump + Release）。

## 功能

agent 经 CLI 发布**版本化制品**：同名在频道内演进 v1→v2→…；消息卡片显示制品名/说明/vN。

- `open-tag artifact publish --file --name --channel [--desc] [--note]` → 返回 vN + attachmentId（可 `message send --attach`）
- `open-tag artifact list --channel` / `artifact versions --name --channel`
- 表：`artifacts`（频道内唯一名）+ `artifact_versions`（max+1 事务、双唯一索引、attachmentId 唯一）
- API：首个 agent 面拆分文件 `src/server/routes-agent/artifacts.ts`（publish/list/versions；scope=attachment:upload/view；租户 serverId 过滤；线程门查 channel.type；无泄漏 404；严格单文件契约+失败清理+409 清理）
- 序列化双路径（socket serializeMsg 可选 Map 参数 + REST attachMentions）带 artifactName/Version/Description
- Web：文件卡制品名+说明副行（grow 内第二行）+vN 徽标，纯文本渲染；AttPreview/AttMdPreview label
- prompt.ts CLI 规范行（runtime-agnostic 红线零命中）

## 验证

50/50 测试 + typecheck；浏览器 e2e：CLI v1→v2、卡片三要素、双弹窗、刷新后元数据不丢、plain 对照件无污染（截图 .shots/tmp-verify/artifacts-e2e-cards.png）。评审链抓掉 5 个真问题：多文件上传存储孤儿、测试强度假阳性（case-7）、说明副行 CSS 失效、CLI 短 id 诱导 500、upsert 缺 serverId。

## 遗留（tech-debt 已记）

并发 23505 路径无测试；图片制品卡片无标识（待制品库 UI）；写门偏离（resolveTarget 读门语义，I105）。

## 发版提醒（延后）

下次发版时：CHANGELOG [Unreleased] 的 artifacts 条目归入新版本号；`src/cli`+`prompt.ts` 在 daemon 打包范围——不 Release 则 npm 包用户拿不到 artifact 命令。
