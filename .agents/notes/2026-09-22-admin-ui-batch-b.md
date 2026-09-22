# 2026-09-22 — /admin 控制台 UI 重设计 batch B（Task 3 壳 + Task 4 UsersTab + Task 5 InvitesTab）

**分支**: `feature/admin-ui`（worktree `open-tag-admin-ui`）
**计划**: docs/superpowers/plans/2026-09-22-admin-ui-redesign.md §Task 3-5（batch B）
**基线**: batch A 顶端 `59777e7`（fix(web): batch-A review follow-ups）；LOCAL main `82c7a46`。
视觉-only 重设计（B2 浅色侧栏 SaaS），消费 batch A 的 adm- CSS 段与 4 组件 + avatar 纯函数。

## Task 3 — Admin.tsx 双栏壳（commit `6f08967`）

- `Admin.tsx` 重写为 `<div class="adm">` → `aside.adm-side` + `main.adm-main`：
  - `.logo` 行 `◧ open-tag · {t(admin.title)}`；`.adm-sec` 分节标题 `t(admin.navGroup)`；
  - 导航 = react-router `Link`（渲染 `<a>`，吃 `.adm-side a` 样式；batch A 评审已加
    `text-decoration:none` 即为此准备）+ lucide 图标（Users/Mail/Layers/ScrollText/Settings，
    size 15）；URL 驱动不变：`useParams` section → tab 兜底 users，切换走 Link 客户端导航；
    `role=tablist/tab + aria-selected` 保留；
  - `.foot`：返回工作区 `Link to=/s/${slug}/channel`（ArrowLeft）+ 身份行
    `adm-av g-lav` 首字母 + displayName + `{t(admin.users.sysAdmin)}` small；
  - `AdminApi` 类型导出保留（5 个 tab 均从本文件 import）。
- **batch-A 评审遗留修复**（随本 commit 折叠）：
  1. `.adm-card` 底角出血：末行 hover 底色与 `.adm-linkbar` 全宽底色溢出 8px 圆角。
     不用 `overflow:hidden`（会裁掉 ⋯ 菜单弹层）——改为给 `tbody tr:last-child td:first/last-child`
     打 `border-bottom-*-radius: calc(var(--adm-r) - 1px)`，`.adm-linkbar` 加
     `border-radius: 0 0 calc calc`（内缩 1px 贴边框嵌套）；
  2. ≤768px 补 `.adm-modal { min-width: 0; }`（`.modal` 的 `max-width:92vw` 会小于 380px
     min-width 导致溢出）。
- 新增侧栏身份行样式 `.adm-side .who/.nm/small`（batch A CSS 未覆盖 foot 内身份行布局）。
- locales：`admin.navGroup`（管理/System）、`admin.backToWorkspace`（返回工作区/Back to workspace）。

## Task 4 — UsersTab 重构（commit `86d1ce1`）

- `.adm-head`：h1 + `.acts`（搜索 `adm-input` 回车触发不变；主按钮 `users.inviteCta`
  → `useNavigate` 跳 `/admin/invites`）。
- `.adm-stats` 四卡：独立 effect 取 `GET /api/admin/stats`（失败则卡组隐藏，不阻塞列表）；
  total/disabled → 新 key，systemAdmins → 复用 `admin.users.sysAdmin`，servers → 复用
  `admin.workspaces.statsServers`。
- `AdminTable` 6 列；用户列 = `adm-av`(avatarTone/Initial) + email；角色 blue AdmPill / "—"；
  状态 green 正常 / red 已禁用；操作列 RowMenu（禁用/启用、升降权 sep 后、重置密码）。
- **全部动作逻辑原样复用**：`load`/`patch`/`patchRole`（升降权 confirm）/`resetPw`（danger
  confirm + 一次性临时密码）/`copyPw` 逐字保留；busy 时 RowMenu disabled；self-guard 400 走
  head 下 `form-err` 行；空态在有 err 时不显示（与旧逻辑一致）。
- 临时密码弹窗结构不变，modal div 加 `adm-modal` 类。
- locales：`admin.stats.totalUsers/disabledUsers`、`admin.menu.disableUser/enableUser/promote/
  demote/resetPassword`、`admin.users.inviteCta`（zh/en）。

## Task 5 — InvitesTab 内联化（commit `1d4459c`）

- 主按钮 `invites.createCta` toggle 内联表单卡（默认收起）：`adm-card > adm-form`
  （email / workspace 下拉 / 角色 / 有效期默认 7），**state/校验/提交逻辑原样复用**
  （409 重复等错误走 form-err；servers 加载失败显式报错而非静默，行为不变）。
- 成功：表单保持展开，卡底渲染 `.adm-linkbar`（`<code>` 完整链接 + 复制按钮走 `copyText`，
  1.5s 已复制态沿用 `copiedId:"created"` 单点闪亮机制）。
- 列表 `AdminTable`：邮箱、Workspace、角色、状态 AdmPill（pending=blue / accepted=green /
  expired=neutral，与 server `statusOf` 三值一一对应）、到期、⋯ RowMenu（仅 pending：
  复制链接 `linkOf(token)`；danger 撤销 + confirm，逻辑原样）；accepted/expired 行 em-dash。
- `CreatedInviteModal` 删除（grep 零残留；`useEscClose` import 一并移除）。
  `createdTitle/createdNote/linkLabel` 三个 i18n key 暂无消费者，先保留未删。
- locales：`admin.invites.createCta`、`admin.menu.copyLink/revokeInvite`，另补两个列头
  key `admin.invites.workspace`（Workspace/Workspace）、`admin.invites.role`（角色/Role）
  ——计划清单未列（列头此前不存在裸「角色」可用 key），避免硬编码。
- `inv-*`/`joinbtn` CSS **未删**：`misc.tsx`（工作区级邀请面板）仍在用。

## 验证（每 task 后均跑，最终一遍全绿）

- `npm run typecheck`（root + web）✓
- `JWT_SECRET=ci DAEMON_BOOTSTRAP_KEY=ci npx tsx --test --test-force-exit web/src/views/*.test.ts`
  → 8 pass / 0 fail ✓
- `npm --prefix web run build` → 2.3s ✓
- zh/en locales：JSON.parse 双双合法；拍平后 746/746 键，双向 diff 为空 ✓
- `git diff --stat main..HEAD -- src/` 为 0 行（后端零改动）✓
- `web/package-lock.json` 全程未被触碰 ✓

## 提交

1. `6f08967` feat(web): admin shell — light sidebar + content frame (B2) + card radius fixes
2. `86d1ce1` feat(web): users tab — stat cards + avatar column + kebab menu
3. `1d4459c` feat(web): invites tab — inline create form + link card, drop modal
4. （本日志）

## 备注 / 后续

- `admin.subtitle` key 自 Task 3 起无消费者（旧顶栏标题行移除）；key 保留，zh/en 对称。
- batch A 评审遗留的「宽表横向滚动」未在本批处理（按计划归 Task 6 采用批 / Task 8 走查）。
- 浏览器走查（Task 8）属后续批次；本批验证止于 typecheck/单测/build 三层。
