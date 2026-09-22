# 2026-09-22 — /admin 控制台 UI 重设计 batch C（Task 6 三页签 + Task 7 i18n 收尾）

**分支**: `feature/admin-ui`（worktree `open-tag-admin-ui`）
**计划**: docs/superpowers/plans/2026-09-22-admin-ui-redesign.md §Task 6-7（batch C）
**基线**: batch B 顶端 `e3a3564`（docs: admin UI redesign batch B dev log）；LOCAL main `82c7a46`。

## Task 6 — Workspaces / Audit / Settings（commit `7b3d2d3`）

- **WorkspacesTab** 重写：`.adm-head`（h1 `admin.tab.workspaces`，无额外动作）→ `.adm-stats`
  四卡（stats 加载逻辑原样：`Promise.all` stats+servers，失败仅 form-err 不出卡）。
  用户卡 label 换 `admin.stats.totalUsers`，禁用数作为 note（`admin.workspaces.disabledCount`
  带复数插值，优于拼接）；servers/agents/machines 三卡沿用原 key。`AdminTable` 7 列
  （名称/Slug/所有者/成员/Agents/创建时间/右对齐操作列）；删除按钮迁入 RowMenu danger 项，
  `remove()`（confirm + busy + DELETE + reload）逐字保留。
- **AuditTab** 重写：事件下拉迁入 `.adm-head .acts`（`adm-input` + `aria-label`，
  选项 = 全部 + 11 events 原清单）；`AdminTable` 5 列；事件 = AdmPill neutral + 内层
  `span style fontFamily var(--mono)`；操作者/目标沿用 shortId 截断 + title 全 id；
  详情单元格单行截断 + mono + title 全 JSON（原样 + 等宽）。load-more 复用 `.loadmore`
  类（外观），外层 flex 居中包裹、内联覆盖其 28px 侧槽布局（该类原生为 mentions 面板
  设计，直接用在 adm-main 会比表格缩进 28px 不对齐）。loading/err/empty 语义与旧版一致
  （empty 仅在零行且非 loading/err 时渲染于表卡内）。
- **SettingsTab** 轻改：`adm-head` h1（`admin.tab.settings`，与其他页签一致——计划未明写，
  但 batch B 两页签均有 h1，缺失会是视觉回退）+ `adm-card > .adm-setrow`（左 label+regHint
  说明、右 checkbox）。**confirm/forceRender 回弹/挂载单次加载逻辑逐字保留**，仅类名/结构迁移。
- **batch-B 评审遗留修复**（随 Task 6 commit 折叠）：
  1. `.adm-side .who .who-t { min-width: 0; }` —— min-width 原落在 `.who` 层（错误层级），
     flex item `.who-t` 默认 min-width:auto 不收缩，`.nm` 的 ellipsis 永不触发；移到正确层级。
  2. 搜索输入补 `aria-label`：UsersTab 既有搜索框（评审指名）；同先例给 AuditTab 事件
     下拉加 `aria-label`（复用 `admin.audit.event` key，未新增 key）。
- 新 CSS：`.adm-setrow` 四行（设置行布局），全 `adm-` 前缀、零新颜色字面量。
- locales：`admin.menu.deleteWorkspace`（删除 Workspace / Delete workspace）随本 commit 落地
  （消费方在本 commit 内；zh 用大写 Workspace 与相邻 key 一致）。

## Task 7 — i18n 收尾（commit `af49976`）

- spec §6 清单核验全落地（backToWorkspace/navGroup/menu.* 8 项/users.inviteCta/
  stats.totalUsers/disabledUsers/invites.createCta）。
- 删孤儿 key（zh+en 对称删，逐个 grep 零引用后删）：
  - 计划列出的 5 个：`admin.subtitle`、`admin.invites.createdTitle/createdNote/linkLabel/createdAt`；
  - **超出清单的 3 个**（自行判断，见"取舍"）：`admin.workspaces.statsUsers`（Task 6 重写
    直接造成的孤儿——旧用户卡 label，新卡用 stats.totalUsers）、`admin.users.enable/disable`
    （batch B 遗留：kebab 菜单改用 menu.enableUser/disableUser 后失引用，清单漏列）。
- 终检：JSON.parse 双双合法；拍平 zh 739 / en 739，双向 diff 为空；被删 key 零残留；
  反向核验「代码引用的 admin.* key 全部存在于 locales」（`admin.tab.`/`admin.invites.status.`
  两个命中为模板字面量前缀，展开 key 均在）。

## 取舍 / 判断点（评审请关注）

1. **孤儿清理超出清单 3 个 key**——依据是"零引用即删"的同一条规则；statsUsers 是本批自己
   造成的，不删则留下新的 tech debt。若评审不认可可单独 revert 这三行。
2. **SettingsTab 加了 adm-head h1**——计划只写了卡片，但五个页签四个有 h1 而设置页没有
   会显得未完成；复用既有 key，一行成本。
3. **`.loadmore` 居中用内联覆盖**（width:auto + minWidth:200 + margin:0）而非新 CSS 类——
   单点使用，不想为一次覆盖扩 CSS 面。
4. WorkspacesTab 用户卡 label 从「用户」变「用户总数」（totalUsers）——语义更准，zh/en 均有。

## 验证（每 task 后均跑，最终一遍全绿）

- `npm run typecheck`（root + web）✓（无输出错误）
- `JWT_SECRET=ci DAEMON_BOOTSTRAP_KEY=ci npx tsx --test --test-force-exit web/src/views/*.test.ts`
  → 8 pass / 0 fail ✓
- `npm --prefix web run build` → ~2.3s ✓
- locales：JSON.parse ✓；zh/en 拍平 739/739，diff 空 ✓
- `git diff --stat main..HEAD -- src/` = 0（后端零改动）✓
- `web/package-lock.json` 全程未被触碰 ✓

## 提交

1. `7b3d2d3` feat(web): workspaces/audit/settings tabs on adm design system + who-t fix
2. `af49976` feat(web): admin redesign i18n completion (zh/en) + orphan key cleanup
3. （本日志）

## 备注 / 后续

- 浏览器走查（Task 8）归下一批次；本批验证止于 typecheck/单测/build + locales 校验。
- 底行 ⋯ 菜单可能撑出滚动（batch-B 评审已知，Task 8 走查确认）。
