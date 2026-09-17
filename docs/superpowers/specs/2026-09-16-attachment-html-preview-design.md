# HTML 附件在线预览（sandboxed inline Tier 4）— 设计

日期：2026-09-16 · 状态：待评审 · 范围：v1 仅 HTML，markdown 预览延后

## 背景与目标

open-tag 附件当前三层下载头策略（`safeDownloadHeaders`，`src/server/routes-api/attachments.ts`）：
Tier 1 媒体/PDF inline → Tier 2 SVG inline+CSP sandbox → 其余（含 `text/html`）强制
`application/octet-stream` 下载。HTML 附件因此只能下载后本地打开，无法在线查看。

**目标**：HTML 附件点击即在应用内安全预览，效果对标 GitHub 的 HTML preview——不可信
HTML 在隔离环境中渲染，脚本无法触碰 open-tag origin。

**非目标（v1 明确不做）**：
- markdown 附件渲染（复用 `messageRender.tsx` 栈的方案已论证可行，延后另立切片）
- docx/xlsx 等 office 格式、音频 `<audio>` 播放器、PDF iframe 模态
- 修改 Tier 1–3 任何既有语义

## 威胁模型（为什么必须沙箱）

附件 URL 与 open-tag 应用**同源**（`/api/attachments/<id>?token=…`）。若 HTML 以
`text/html` + `inline` 直接返回：攻击者上传含脚本的 `evil.html` → 受害者点开 → 脚本
运行在应用 origin 内 → 读取 localStorage JWT、以受害者身份调用全部 API（存储型 XSS，
等同账号接管）。GitHub 的解法是独立 origin 渲染；open-tag 单机自托管无第二域名，
等价手段是 **CSP `sandbox` 指令**——文档进入 unique opaque origin，与真实第二域名
隔离效果相同。

## 设计

### ① 服务端：`safeDownloadHeaders` 新增 Tier 4

`src/server/routes-api/attachments.ts`：

- 新集合 `SANDBOXED_INLINE_TYPES = { "text/html", "application/xhtml+xml" }`
- 命中时响应头：`content-type`（存储值如实）、`content-disposition: inline`、
  `x-content-type-options: nosniff`、`referrer-policy: no-referrer`、
  `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox`
  - `sandbox`（无 allow-*）：unique origin、禁脚本、禁表单、禁弹窗、禁顶层导航
  - `default-src 'none'`：断一切外联（脚本/子框架/XHR/追踪像素）
  - `style-src 'unsafe-inline'`：内联样式可渲染
  - `img-src data:`：内嵌 base64 图片可显示
- 判级依旧按**存储 mime**（非上传声明），老库危险记录同享保护——与现有注释语义一致
- 直接导航该 URL 同样被 CSP sandbox 拦截（与 SVG Tier 同一防线），iframe 与直开双路径均安全

### ② 前端：`AttCard` 与 Files 页新增 HTML 预览分支

`web/src/views/Chat.tsx`：

- 判定：**仅**按消息附件元数据 mimeType（`serializeMsg` 已随消息下发）∈
  {`text/html`, `application/xhtml+xml`}。文件扩展名不作判定条件——服务端按存储
  mime 判级，误存 `application/octet-stream` 的 .html 文件服务端仍发 Tier 3 下载头，
  iframe 收到的是下载响应（且不会触发 onError），打开预览只会得到空白弹窗+意外下载。
  故此类文件走现有下载卡行为，不出弹窗。前后端判定条件保持一致，杜绝空白弹窗路径。
- 新组件 `AttPreview`（骨架仿 `Lightbox.tsx`）：文件名标题栏 + 下载按钮 + Esc/遮罩关闭，
  主体为 `<iframe src={attachmentUrl(id)} sandbox title={filename}>`
  - 响应头 CSP sandbox（服务端）+ iframe `sandbox` 属性（客户端）双保险
  - iframe **不**加 `allow-scripts`/`allow-same-origin`
- 消息流 `AttCard`（Chat.tsx 主列表与线程面板共用）与频道 Files 页文件条目，
  HTML 类型点击从 `<a target="_blank">` 改为打开 `AttPreview`
- 渲染失败/浏览器不支持：iframe onError 回退下载卡提示

### ③ 安全不变量（评审与实现的硬约束）

1. Tier 1–3 行为零改动，仅新增 Tier 4 分支
2. HTML 内容永不进入父文档 DOM——不经 `dangerouslySetInnerHTML`、不经 `srcDoc`；
   唯一渲染通道是 sandboxed iframe 的 URL 加载
3. iframe 永不携带 `allow-scripts` 或 `allow-same-origin`
4. `/api/attachments/<id>` 权限门（频道可见性 IDOR-B3 检查、404 不泄露存在性）原样保留
5. `nosniff` 始终在场，MIME 谎报无法改判

### ④ 错误处理

- 附件 >256KB：无限制——Tier 4 走主下载路径（与所有附件下载同路径，整体缓冲后
  `res.end`，不经 `/preview` 端点），无需大小上限（sandbox 隔离与体积无关）
- mime 不在 Tier 4 集合（含误存 octet-stream 的 .html）：不出预览弹窗，走现有下载卡
  （见 §② 判定）
- iframe 加载失败（onError）：降级为下载提示

### ⑤ 验证（完成定义）

- 单测：`safeDownloadHeaders` 枚举四 tier 全部分支，含老库记录 `text/html`、
  谎报 `text/html` 实为脚本的边界（nosniff 在场断言）
- **改写既有安全回归测试 `test/mimeXssGuard.unit.test.ts`**：其中
  `text/html → attachment + octet-stream (core XSS prevention)` 与
  `application/xhtml+xml → attachment` 两条断言被 Tier 4 **取代**（inline + CSP sandbox
  同样阻断 XSS，隔离手段从下载改为沙箱），文件头注释的 fix contract 同步更新。
  这不是放松安全——是防线形态变化，新断言必须验证 CSP sandbox 头在场
- 浏览器实测（chrome-devtools MCP，worktree 隔离栈）：
  1. 上传 `evil.html`（`<script>fetch('/api/auth/me')</script>` + 外联 `<img onerror>`）→
     预览打开：脚本不执行、无 `/api/auth/me` 调用、无外联请求产生实际网络流量
     （DevTools 里 CSP 拦截条目显示为 blocked 属预期，不算失败）
  2. 正常带样式/内嵌图片的 HTML 预览渲染正确
  3. 直开 URL（新标签页访问附件 URL）同样无脚本执行
  4. 权限：非频道成员直开私有频道附件 → 404
- `npm run typecheck`（root + web）通过
- doc-sync：`ARCHITECTURE.md` codemap 若涉及路由/组件条目同步；检查
  `docs/authorization.md`（下载头策略/hardening roadmap 若有提及三层头，需同步为四层）

## 实现载体

`npm run wt:add -- html-preview`（隔离 worktree + 栈），PR 从 worktree 开。
涉及文件：`src/server/routes-api/attachments.ts`、`test/mimeXssGuard.unit.test.ts`
（改写两条被取代断言）、`web/src/views/Chat.tsx`、新增 `web/src/AttPreview.tsx`
（样式：`styles.css` 新增 `.att-preview-*` 类，仿 `lightbox-*` 骨架）、Files 页复用。
不涉及 daemon 包——**无需发版**。

## 备选方案（已否决）

- **纯前端 srcDoc**：fetch `/preview` 文本 → `<iframe sandbox srcDoc>`。不碰服务端，但
  受 256KB 上限、文本经父进程内存、与仓库"服务端集中管控下载头"模式不一致
- **只显源码 `<pre>`**：最安全但失去在线查看意义
- **第二域名渲染**（GitHub 原生解法）：自托管场景部署成本高，CSP sandbox 等价
