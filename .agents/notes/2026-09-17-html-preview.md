# 2026-09-17 · HTML 附件在线预览（Tier 4 沙箱 inline）

合并 commit：71450bb（Merge branch 'feature/html-preview'）→ main
分支：feature/html-preview（6 commits，worktree open-tag-html-preview）

## 做了什么

HTML 附件点击即在应用内沙箱预览（对标 GitHub HTML preview）：

- **服务端** `src/server/routes-api/attachments.ts`：`safeDownloadHeaders` 新增 Tier 4 —— `text/html` / `application/xhtml+xml` 返回 `inline` + CSP `default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox` + `referrer-policy: no-referrer` + `nosniff`。sandbox 指令把文档关进 unique opaque origin（脚本/表单/弹窗/顶层导航全禁），iframe 内嵌与直开 URL 双路径同等安全。Tier 1-3 行为零改动。
- **前端** `web/src/AttPreview.tsx`（新组件，仿 Lightbox 骨架）：portal 弹窗 + `<iframe sandbox="">`（绝无 allow-*）+ 标题栏下载按钮。接线：Chat.tsx `AttCard`（消息气泡）+ `ChannelFiles`（Files 页），门控 `isHtmlDoc` 仅认元数据 mimeType（与服务端集合字符级一致，不看扩展名——误存 octet-stream 的 .html 不出弹窗，防空白弹窗陷阱）。
- **测试** `test/mimeXssGuard.unit.test.ts`：TDD 改写，html/xhtml 断言反转为 Tier 4，CSP 全串精确钉死（防 allow-scripts 类静默放宽），27/27 绿。

## 安全验证（浏览器实测，隔离栈）

evil.html（脚本偷 /api/auth/me + 外传 + 外链像素）：脚本被沙箱拦截（console 证据）、零 API 调用、外联像素 CSP 断流；直开 URL 同样拦截；正常自包含文档样式渲染保真；非频道成员 404、无 token 401；.js 仍 octet-stream 强制下载。截图在 .shots/tmp-verify/。

## 文档同步

ARCHITECTURE.md 组件表 + FEATURES.md + docs/tech-debt-archive.md S2 附注。docs/authorization.md 检索确认无需改。无 daemon 改动——无需发版。无新依赖。

## 设计/计划文档

- docs/superpowers/specs/2026-09-16-attachment-html-preview-design.md
- docs/superpowers/plans/2026-09-16-attachment-html-preview.md

## 未做（延后）

markdown 附件预览（复用 messageRender 栈方案已论证）；AttPreview Tab 焦点循环（a11y 后续项）。
