# /admin 控制台视觉重构实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `/admin` 从 inline-style 功能态重构为 B2 浅色侧栏 SaaS 控制台（Linear 式密度 + open-tag 暖灰语言），零新依赖。

**Architecture:** 纯视觉层重构——`styles.css` 末尾新增 `adm-` 前缀 CSS 段（复用现有 token，新增变量仅 2 个）；`Admin.tsx` 换双栏壳；五个 tab 全部迁入新组件（RowMenu/StatCard/AdmPill/AdminTable）。数据获取、路由、confirm/i18n 机制不动；唯一逻辑豁免 = UsersTab 新增一次 `GET /api/admin/stats`。

**Tech Stack:** React + react-router + react-i18next + plain CSS（现有栈，零新依赖）。

**Spec:** `docs/superpowers/specs/2026-09-22-admin-ui-redesign-design.md`（本 worktree）。

**Worktree:** `d:/OpenSource/open-tag-admin-ui`，branch `feature/admin-ui`（已 rebase 到**本地 main** `82c7a46`——system-admin 合并尚未推 origin，勿以 origin/main 为基线做任何 diff 判断）。端口：server 7801 / vite 5301。前端开发跑 `(cd web && npm run dev)`（vite 已在 wt:add 装好依赖；若 node_modules 缺失先 `npm --prefix web install`）。

**验证命令：**
- `npm run typecheck`（root + web）
- `JWT_SECRET=ci DAEMON_BOOTSTRAP_KEY=ci npx tsx --test --test-force-exit web/src/views/*.test.ts`
- `npm --prefix web run build`
- 浏览器：server 起在 7801（`npm run start`），vite 5301 代理；或 build 后直接 7801。Playwright/chrome-devtools 走查 + 截图 `.shots/`（主仓 `.shots/`，gitignored）

**纪律：** 不动 `src/server/**`、不动 `adminGuard.ts`、不动 store 数据层；`web/package-lock.json` 若被 npm 触碰，提交前 `git checkout -- web/package-lock.json`。每个 Task 一个 commit。

---

## 文件结构总览

| 文件 | 动作 | 职责 |
|---|---|---|
| `web/src/styles.css` | 改（末尾追加） | `adm-` 前缀样式段（侧栏/页头/统计卡/表格/菜单/pill/响应式） |
| `web/src/views/Admin.tsx` | 重写 | 双栏壳：侧栏导航 + 内容区路由出口 |
| `web/src/views/admin/AdmPill.tsx` | 建 | 状态胶囊 |
| `web/src/views/admin/StatCard.tsx` | 建 | 统计卡 |
| `web/src/views/admin/RowMenu.tsx` | 建 | ⋯ 浮层菜单（外点/Esc/单开） |
| `web/src/views/admin/AdminTable.tsx` | 建 | 表格薄封装 |
| `web/src/views/admin/avatar.ts`（源）+ `web/src/views/adminAvatar.test.ts`（测试，CI glob 层） | 建 | 头像 tone 纯函数（TDD） |
| `web/src/views/admin/UsersTab.tsx` | 重构 | 统计卡 + ⋯ 菜单 + 头像列 |
| `web/src/views/admin/InvitesTab.tsx` | 重构 | 内联表单卡 + 链接卡；删 `CreatedInviteModal` |
| `web/src/views/admin/WorkspacesTab.tsx` | 重构 | 统计卡迁页头下 + ⋯ 删除 |
| `web/src/views/admin/AuditTab.tsx` | 重构 | 过滤器入页头 + 等宽 metadata |
| `web/src/views/admin/SettingsTab.tsx` | 改 | 设置卡视觉对齐（逻辑不动） |
| `web/src/locales/zh.json` / `en.json` | 改 | 增量 key（spec §6 清单） |

---

### Task 0: 基线

- [ ] **Step 0:** 确认分支基线含 system-admin 平面：`git log --oneline -2` 应见 `82c7a46 Merge feature/system-admin…`；`ls web/src/views/admin/` 应有 5 个 tab 文件。缺则 STOP 报 BLOCKED（不要自行 rebase）。
- [ ] **Step 1:** `cd d:/OpenSource/open-tag-admin-ui && npm run typecheck && JWT_SECRET=ci DAEMON_BOOTSTRAP_KEY=ci npx tsx --test --test-force-exit web/src/views/*.test.ts && npm --prefix web run build` — 全绿才继续；红则 BLOCKED 报告。

---

### Task 1: avatar 纯函数（TDD）

**Files:** Create `web/src/views/admin/avatar.ts`（源）、`web/src/views/adminAvatar.test.ts`（测试——必须落在此层，CI glob 是 `web/src/views/*.test.ts`，`views/admin/` 不在 glob 内）

- [ ] **Step 1: 失败测试**

```ts
// web/src/views/adminAvatar.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { avatarInitial, avatarTone } from "./admin/avatar.ts";

test("avatarTone: stable per email, distributes over 4 tones", () => {
  assert.equal(avatarTone("you@open-tag.local"), avatarTone("you@open-tag.local")); // 稳定
  const tones = new Set(["you@open-tag.local", "admin@local.com", "lao@wang.cn", "a@b.co", "c@d.ef"].map(avatarTone));
  assert.ok(tones.size >= 2 && tones.size <= 4); // 有分散
  for (const t of tones) assert.ok(["g-mint", "g-lav", "g-sky", "g-peach"].includes(t));
});
test("avatarInitial: first char uppercased, tolerant of weird input", () => {
  assert.equal(avatarInitial("you@open-tag.local"), "Y");
  assert.equal(avatarInitial("老王@wang.cn"), "老");
  assert.equal(avatarInitial(""), "?");
});
```

- [ ] **Step 2:** 跑红：`npx tsx --test --test-force-exit web/src/views/adminAvatar.test.ts` → ERR_MODULE_NOT_FOUND。
- [ ] **Step 3:** 最小实现：

```ts
// web/src/views/admin/avatar.ts — pure: pick a stable avatar tone + initial from an email.
const TONES = ["g-mint", "g-lav", "g-sky", "g-peach"] as const;
export type AvatarTone = (typeof TONES)[number];
export function avatarTone(email: string): AvatarTone {
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) | 0;
  return TONES[Math.abs(h) % TONES.length];
}
export function avatarInitial(email: string): string {
  const c = email.trim().charAt(0);
  return c ? c.toUpperCase() : "?";
}
```

- [ ] **Step 4:** 跑绿：`npx tsx --test --test-force-exit web/src/views/adminAvatar.test.ts` → 2 pass。
- [ ] **Step 5:** Commit `feat(web): admin avatar tone/initial pure fns (TDD)`

---

### Task 2: adm- CSS 段 + 新组件库

**Files:** Modify `web/src/styles.css`（末尾）；Create `AdmPill.tsx`、`StatCard.tsx`、`RowMenu.tsx`、`AdminTable.tsx`

- [ ] **Step 1: styles.css 末尾追加**（骨架——实现者按此结构写全，值全部引用现有变量）：

```css
/* ── admin console (B2 light sidebar SaaS) ───────────────────── */
:root { --adm-side-w: 200px; --adm-r: 8px; }

/* 壳：侧栏 + 内容区 */
.adm { display: flex; height: 100vh; }
.adm-side { width: var(--adm-side-w); flex: none; background: var(--canvas-soft); border-right: 1px solid var(--hair); display: flex; flex-direction: column; padding: 14px 10px; }
.adm-side .logo { font-size: 13px; font-weight: 700; padding: 0 6px; margin-bottom: 14px; color: var(--ink); }
.adm-side .sec { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted-soft); padding: 10px 8px 4px; }
.adm-side a { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: 6px; font-size: 13px; color: var(--body); margin-bottom: 1px; cursor: pointer; }
.adm-side a:hover { background: var(--surface-strong); }
.adm-side a.on { background: var(--ink); color: var(--on-ink); }
.adm-side .foot { margin-top: auto; border-top: 1px solid var(--hair); padding-top: 10px; }
.adm-main { flex: 1; overflow: auto; background: var(--canvas); padding: 20px 24px; }

/* 页头行 / 统计卡 / 内容卡 */
.adm-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.adm-head h1 { font-size: 18px; font-weight: 650; margin: 0; }
.adm-head .acts { display: flex; gap: 8px; align-items: center; }
.adm-btn-primary { background: var(--ink); color: var(--on-ink); border: none; border-radius: 6px; font-size: 12.5px; padding: 7px 14px; cursor: pointer; }
.adm-btn-primary:hover { opacity: .88; }
.adm-input { border: 1px solid var(--hair-strong); border-radius: 6px; padding: 7px 12px; font-size: 13px; background: var(--surface); min-width: 220px; }
.adm-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 16px; }
.adm-stat { background: var(--surface); border: 1px solid var(--hair); border-radius: var(--adm-r); padding: 12px 14px; }
.adm-stat .l { font-size: 11.5px; color: var(--muted); }
.adm-stat .v { font-size: 22px; font-weight: 650; color: var(--ink); }
.adm-stat .n { font-size: 11px; color: var(--success); }
.adm-card { background: var(--surface); border: 1px solid var(--hair); border-radius: var(--adm-r); box-shadow: 0 1px 2px var(--shadow-1); }

/* 表格 */
.adm-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.adm-table th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 500; padding: 9px 12px; border-bottom: 1px solid var(--hair); background: var(--surface); white-space: nowrap; }
.adm-table td { padding: 9px 12px; border-bottom: 1px solid var(--canvas-soft); vertical-align: middle; }
.adm-table tr:last-child td { border-bottom: none; }
.adm-table tbody tr:hover td { background: var(--canvas-soft); }
.adm-empty { padding: 32px; text-align: center; color: var(--muted); font-size: 13px; }

/* 胶囊 */
.adm-pill { display: inline-block; padding: 2px 9px; border-radius: 99px; font-size: 11.5px; line-height: 1.5; white-space: nowrap; }
.adm-pill.green { background: var(--tint-green); color: var(--success); }
.adm-pill.red { background: var(--tint-rose); color: var(--tint-rose-ink); }
.adm-pill.blue { background: var(--tint-blue); color: var(--tint-blue-ink); }
.adm-pill.neutral { background: var(--surface-strong); color: var(--muted); }

/* ⋯ 菜单 */
.adm-menu-wrap { position: relative; }
.adm-menu-btn { border: none; background: none; font-size: 16px; line-height: 1; color: var(--muted); border-radius: 6px; padding: 4px 8px; cursor: pointer; }
.adm-menu-btn:hover, .adm-menu-wrap.open .adm-menu-btn { background: var(--surface-strong); color: var(--ink); }
.adm-menu { position: absolute; right: 0; top: calc(100% + 4px); background: var(--surface); border: 1px solid var(--hair); border-radius: var(--adm-r); box-shadow: 0 8px 28px var(--shadow-3); min-width: 148px; padding: 4px; z-index: 40; }
.adm-menu button { display: block; width: 100%; text-align: left; border: none; background: none; font-size: 12.5px; padding: 7px 10px; border-radius: 5px; color: var(--ink-2); cursor: pointer; }
.adm-menu button:hover { background: var(--canvas-soft); }
.adm-menu button.danger { color: var(--error); }
.adm-menu button.danger:hover { background: var(--error-soft); }
.adm-menu hr { border: none; border-top: 1px solid var(--hair); margin: 4px 2px; }

/* 头像点 */
.adm-av { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%; font-size: 11px; font-weight: 600; color: var(--ink-2); flex: none; }
.adm-av.g-mint { background: var(--g-mint); } .adm-av.g-lav { background: var(--g-lav); }
.adm-av.g-sky { background: var(--g-sky); } .adm-av.g-peach { background: var(--g-peach); }
.adm-av + .adm-email { margin-left: 8px; }

/* 弹窗打磨（临时密码沿用 modal-bg/modal，仅加此类微调） */
.adm-modal { min-width: 380px; max-width: 480px; padding: 22px 24px; }
.adm-modal code { font-family: var(--mono); font-size: 14px; background: var(--canvas-soft); padding: 6px 10px; border-radius: 6px; display: block; margin: 10px 0; word-break: break-all; }

/* 内联表单卡 / 链接卡（invites） */
.adm-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; align-items: end; padding: 14px 16px; }
.adm-linkbar { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--hair); background: var(--canvas-soft); }
.adm-linkbar code { font-family: var(--mono); font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 响应式：侧栏折叠为顶部横向页签 */
@media (max-width: 768px) {
  .adm { flex-direction: column; height: auto; min-height: 100vh; }
  .adm-side { width: 100%; flex-direction: row; align-items: center; overflow-x: auto; border-right: none; border-bottom: 1px solid var(--hair); padding: 8px 12px; }
  .adm-side .logo, .adm-side .sec, .adm-side .foot { display: none; }
  .adm-side a { margin: 0 2px 0 0; white-space: nowrap; }
  .adm-main { padding: 14px; }
}
```

（以上为完整样式，实现时可微调数值但**不得**引入变量表以外的新颜色字面量。）

- [ ] **Step 2: 四个组件**（完整代码）：

```tsx
// AdmPill.tsx
export function AdmPill({ tone, children }: { tone: "green" | "red" | "blue" | "neutral"; children: React.ReactNode }) {
  return <span className={`adm-pill ${tone}`}>{children}</span>;
}
// StatCard.tsx
export function StatCard({ label, value, note }: { label: string; value: React.ReactNode; note?: string }) {
  return <div className="adm-stat"><div className="l">{label}</div><div className="v">{value}</div>{note && <div className="n">{note}</div>}</div>;
}
// AdminTable.tsx — thin wrapper: uniform thead/rows/empty state; children = <tbody> rows
export function AdminTable({ cols, children, empty }: { cols: (string | { label: string; right?: boolean })[]; children: React.ReactNode; empty?: string }) {
  const rows = Array.isArray(children) ? children : [children];
  return (
    <div className="adm-card">
      <table className="adm-table">
        <thead><tr>{cols.map((c, i) => <th key={i} style={typeof c === "object" && c.right ? { textAlign: "right" } : undefined}>{typeof c === "object" ? c.label : c}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
      {!rows.some(Boolean) && empty && <div className="adm-empty">{empty}</div>}
    </div>
  );
}
// RowMenu.tsx — ⋯ menu: single-open (module-level closer), outside-click + Esc close, danger section
let closeAllMenus: (() => void) | null = null;
export function RowMenu({ items, ariaLabel }: { items: { label: string; danger?: boolean; sep?: boolean; onClick: () => void }[]; ariaLabel?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    closeAllMenus = () => setOpen(false); // register as the single open menu's closer
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div className={"adm-menu-wrap" + (open ? " open" : "")} ref={ref}>
      <button className="adm-menu-btn" aria-label={ariaLabel ?? "row actions"} aria-haspopup="menu" aria-expanded={open}
        onClick={() => { closeAllMenus?.(); setOpen(!open); }}>⋯</button>
      {open && <div className="adm-menu" role="menu">
        {items.map((it, i) => (
          <Fragment key={i}>
            {it.sep && <hr />}
            <button role="menuitem" className={it.danger ? "danger" : undefined} onClick={() => { setOpen(false); it.onClick(); }}>{it.label}</button>
          </Fragment>
        ))}
      </div>}
    </div>
  );
}
```

（import 按需补：`useState/useEffect/useRef` from react、`Fragment`；单开语义：打开新菜单先调 `closeAllMenus`——简化实现可接受「同一时刻手动互斥不完美」，但外点/Esc 必须可靠。）

- [ ] **Step 3:** `npm run typecheck` + `npm --prefix web run build` 绿。
- [ ] **Step 4:** Commit `feat(web): adm- design-system CSS + RowMenu/StatCard/AdmPill/AdminTable components`

---

### Task 3: Admin.tsx 双栏壳

**Files:** Rewrite `web/src/views/Admin.tsx`

- [ ] **Step 1:** 新壳结构（导航数组 = `[["users","◉"],["invites","✉"],["workspaces","▦"],["audit","≡"],["settings","⚙"]]`，图标用文本符号——或查 `web/src/Layout.tsx`（注意：在 `web/src/` 下，不在 `views/` 里）的 Shield import 方式换 lucide 的 `Users/Mail/Layers/ScrollText/Settings`，二选一）；`useStore` 取 `me`/`slug`；侧栏底部「返回工作区」`nav(\`/s/${slug}/channel\`)` + 身份行（Me 接口无 email——用 displayName 首字母 + `--g-lav` 固定 tone，不引 email）。页签内容渲染保持「五组件 + useParams section 匹配」逻辑不变。
- [ ] **Step 2:** typecheck + build + vite 起来人肉看一眼侧栏（或直接进 Task 4 后统一走查）。
- [ ] **Step 3:** Commit `feat(web): admin shell — light sidebar + content frame (B2)`

---

### Task 4: UsersTab 重构

**Files:** Rewrite `web/src/views/admin/UsersTab.tsx`

- [ ] **Step 1:** 结构：`.adm-head`（h1 用户 + `.acts`：搜索 `adm-input`（回车触发，行为不变）+ 主按钮「＋ 邀请用户」`nav("/admin/invites")`）→ `.adm-stats` 四卡（`api("GET","/api/admin/stats")`：`stats.users.total`→`admin.stats.totalUsers`、`stats.users.disabled`→`admin.stats.disabledUsers`、`stats.users.systemAdmins`→复用 `admin.users.sysAdmin`、`stats.servers`→复用 `admin.workspaces.statsServers`）→ `AdminTable` 列：`[用户, 系统角色, 状态, WS, 加入时间, {label:"", right:true}]`。用户列 = `adm-av`(avatarTone/Initial) + email；角色/状态 = AdmPill（blue 系统管理员 / green 正常 / red 已禁用）；操作列 = RowMenu：禁用/启用、撤/设管理员（sep 后）、重置密码——**onClick 全部复用现有 patch/resetPw 逻辑（含 confirm 与 busy 态，busy 时 RowMenu 按钮 disabled）**。临时密码弹窗加 `adm-modal` 类。
- [ ] **Step 2:** typecheck + build。
- [ ] **Step 3:** Commit `feat(web): users tab — stat cards + avatar column + kebab menu`

---

### Task 5: InvitesTab 内联化

**Files:** Rewrite `web/src/views/admin/InvitesTab.tsx`（删 `CreatedInviteModal` 及其调用）

- [ ] **Step 1:** `.adm-head`（h1 邀请 + 主按钮「＋ 生成邀请」toggle 表单开合，默认收起）→ 开时 `adm-card > .adm-form`（email/workspace 下拉/角色/有效期——复用现有 state 与校验，错误 `form-err` 行为不变）→ 提交成功：表单保持展开、底部渲染 `.adm-linkbar`（`<code>` 完整链接 `location.origin + r.url` + 复制按钮走 `copyText` + 1.5s 已复制态沿用 `copiedId: "created"`）→ 列表 `AdminTable`：邮箱、workspace、角色、状态 AdmPill（pending=blue/accepted=green/expired=neutral）、到期、⋯（pending：复制链接；danger：撤销）。workspaces 下拉加载失败错误行不变。
- [ ] **Step 2:** typecheck + build。确认 `CreatedInviteModal` 无残留引用。
- [ ] **Step 3:** Commit `feat(web): invites tab — inline create form + link card, drop modal`

---

### Task 6: Workspaces / Audit / Settings 三页签

**Files:** Rewrite `WorkspacesTab.tsx`、`AuditTab.tsx`；轻改 `SettingsTab.tsx`

- [ ] **WorkspacesTab**：`.adm-head`（h1 Workspaces）→ stats 四卡（现逻辑迁入）→ `AdminTable`：名称、slug、所有者、成员、Agents、创建时间、⋯（danger 删除 + confirm，逻辑不变）。
- [ ] **AuditTab**：`.adm-head`（h1 审计日志 + 事件下拉 `adm-input` 移右侧）→ `AdminTable`：时间、事件（`adm-pill neutral` + 等宽）、操作者/目标（截断 + title）、metadata（`code` 风格单行截断 + title 全文）→ 加载更多居中（复用 `.loadmore` 类）。
- [ ] **SettingsTab**：`adm-card` 内设置行（label + 说明 `regHint` + 开关），confirm/回弹逻辑零改动，仅类名迁移。
- [ ] typecheck + build + Commit `feat(web): workspaces/audit/settings tabs on adm design system`

---

### Task 7: i18n + 收尾

**Files:** `web/src/locales/zh.json` / `en.json`

- [ ] **Step 1:** 按 spec §6 清单补 key（`admin.backToWorkspace`、`admin.navGroup`、`admin.menu.disableUser/enableUser/promote/demote/resetPassword/copyLink/revokeInvite/deleteWorkspace`、`admin.users.inviteCta`、`admin.stats.totalUsers`、`admin.stats.disabledUsers`、`admin.invites.createCta`），zh/en 同步；JSON.parse 校验 + 双语键位 diff 为空。
- [ ] **Step 2:** 全量：typecheck + web 单测（含 avatar.test.ts）+ build。
- [ ] **Step 3:** Commit `feat(web): admin redesign i18n keys (zh/en)`

---

### Task 8: 浏览器走查（real-run 层）

- [ ] **Step 1:** worktree 起栈：`npm run start`（7801，读 worktree .env）+ （可选 `(cd web && npm run dev)` 热更走查后最终用 build 版复查）。管理员会话：worktree .env 无 SYSTEM_ADMIN_EMAILS → 追加 `SYSTEM_ADMIN_EMAILS=you@open-tag.local` 后重启；浏览器 `http://localhost:7801/?as=you`。
- [ ] **Step 2:** Playwright 逐项走查 + 截图到主仓 `.shots/`（adminui-*.png）：
  1. `/admin/users` 侧栏+统计卡+表格+头像列；⋯ 菜单开合、外点关闭、Esc 关闭
  2. ⋯ → 重置密码 → confirm → 临时密码弹窗（adm-modal）
  3. `/admin/invites`：＋ 生成邀请 → 内联表单 → 提交 → 链接卡复制；列表 ⋯ 撤销（confirm）
  4. `/admin/workspaces`：统计卡 + 删除菜单项（不真删 open-tag）
  5. `/admin/audit`：过滤器 + 等宽 metadata + 加载更多
  6. `/admin/settings`：开关 + confirm 回弹
  7. 375px 宽度：侧栏折叠为横排
  8. en 语言抽查（localStorage 切语言或 i18n 机制）
- [ ] **Step 3:** 记录截图清单（Task 9 dev log 引用）。

---

### Task 9: 文档 + 开发日志

- [ ] **Step 1:** `.agents/notes/2026-09-22-admin-ui-redesign.md` 开发日志（决策链 B/B2/⋯、实现摘要、走查证据清单、已知取舍）。FEATURES.md/README 不改（纯视觉，功能与验证证据不变）——若 REVIEWER 认为 FEATURES 视觉描述需要更新再补。
- [ ] **Step 2:** 终验：`npm run typecheck && JWT_SECRET=ci DAEMON_BOOTSTRAP_KEY=ci npx tsx --test --test-force-exit web/src/views/*.test.ts && npm --prefix web run build` 全绿。
- [ ] **Step 3:** Commit `docs: admin UI redesign dev log`

---

## 完成定义

- [ ] Task 0-9 全部勾选；typecheck / web 单测 / build 全绿
- [ ] `git diff --stat main..HEAD -- src/` 为空（后端零改动；基线是**本地 main**——system-admin 合并尚未推 origin）
- [ ] styles.css 新段全部 `adm-` 前缀、新变量仅 `--adm-side-w/--adm-r`
- [ ] 浏览器走查 8 项全过 + 截图在 `.shots/`
- [ ] zh/en 键位 diff 为空

## 明确不做（对照 spec §8）

组件库、暗色模式、抽屉/折叠侧栏、主应用其他页面统一、新单测（avatar 纯函数除外）、任何后端/守卫/数据层重构。
