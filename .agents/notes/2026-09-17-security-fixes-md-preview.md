# 2026-09-17 · 安全评审修复 + Markdown 附件预览

合并 commits：354ae46（fix/upload-drain）、3de0d01（feature/md-preview）→ main

## A. 安全评审修复（fix/upload-drain）

对已合并的 html-preview + cli-mime 两功能做攻防式安全评审：零 Critical/High，
11 条攻击路径验证关闭。修复两项：

1. **上传挂起回归（Medium）**：sniff Transform tee 引入的缺陷——saveObject 失败
   （S3 坏配置/磁盘满）时被 pipe 反压的源流排不空，请求永久挂起泄漏资源。
   消融实验证明 `destroy()` 或 `resume()` 单独都不够：busboy FileStream 无
   consumer 时 resume 不重启流动。终修 = destroy + noop data listener + resume。
   回归测试 `test/parseUploadDrain.unit.test.ts`（OPEN_TAG_HOME 指向文件迫使
   mkdir 失败；修复前挂起超时，修复后毫秒级 settle）。
2. **referrer-policy 补齐（Low，存量）**：Tier 1/2（inline 媒体/SVG）补
   `no-referrer`，与 Tier 4 对齐——inline 文档内点外链不泄 `?token=`。
   测试断言同步 pin。

Info 两条（Cache-Control 缺失、sniff head 按块计数）记入 docs/tech-debt-tracker.md。
测试 41/41 绿，typecheck 零错。不涉 daemon 包，无需发版。

## B. Markdown 附件预览（feature/md-preview）

- `web/src/AttMdPreview.tsx`：fetch 附件正文 → 复用聊天消息同一条 sanitize 管线
  （react-markdown + rehype-sanitize 白名单 + remarkHtmlAsText）渲染。
  内嵌 HTML 永远显示为源码不执行；GFM 表格/alert 渲染。
- 门控 `isMarkdownDoc`：text/markdown 元数据 或 .md/.markdown 扩展名兜底
  （与 html 的 mime-only 门控不同：md 无 iframe、fetch 读 body 不受 disposition
  影响，无空白弹窗陷阱——注释已说明理由）。
- 纯前端、零服务端改动、零新依赖、不发版。doc-sync：FEATURES.md + ARCHITECTURE.md。
- 浏览器验证：CLI 上传 verify.md → 弹窗渲染标题/表格/alert 引用；`<script>`
  显示为源码、零 console 错误（截图 .shots/tmp-verify/md-preview-verification.png）。
