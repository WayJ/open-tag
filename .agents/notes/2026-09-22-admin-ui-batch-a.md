# 2026-09-22 — /admin 控制台 UI 重设计 batch A（Task 0 基线 + Task 1 avatar 纯函数 + Task 2 adm- 设计系统）

**分支**: `feature/admin-ui`（worktree `open-tag-admin-ui`）
**计划**: admin console UI redesign implementation plan §Task 0-2（batch A）
**基线**: `9a693f1`（LOCAL main `82c7a46` system-admin 平面合并之后；非 origin/main）

## Task 0 — 基线

- `git log --oneline -2` 顶部为 `9a693f1 docs(plan)` ← `5a7fef0 docs(spec)` ← 基于 `82c7a46`；✓
- `web/src/views/admin/` 5 个 tab 文件齐全（Users/Invites/Workspaces/Audit/Settings）；✓
- 基线三件套全绿：`npm run typecheck`（root+web）、
  `JWT_SECRET=ci DAEMON_BOOTSTRAP_KEY=ci npx tsx --test --test-force-exit web/src/views/*.test.ts`
  （6 pass / 0 fail）、`npm --prefix web run build`（2.4s）。

## Task 1 — avatar 纯函数（TDD，commit `42ba617`）

- 红：先写 `web/src/views/adminAvatar.test.ts`（放 `views/` 单层 —— CI glob
  `web/src/views/*.test.ts` 不进子目录），运行报
  `ERR_MODULE_NOT_FOUND: … web/src/views/admin/avatar.ts`，1 fail。
- 绿：实现 `web/src/views/admin/avatar.ts`（hash-31 取 4 tone；首字符大写，空串兜底 `?`），
  2 pass / 0 fail。中文首字符（`老`）不受 `toUpperCase` 影响，行为正确。

## Task 2 — adm- CSS 段 + 四组件（commit `c4ed4f0`）

- `web/src/styles.css` 末尾追加 admin console 段（B2 浅色侧栏 SaaS）：`.adm` 壳、
  `.adm-side` 侧栏、`.adm-head`/`.adm-stat`/`.adm-card`、`.adm-table`、`.adm-pill` ×4 tone、
  `.adm-menu` ⋯菜单、`.adm-av` 头像点（g-mint/lav/sky/peach）、`.adm-modal`、
  `.adm-form`/`.adm-linkbar`、768px 响应式降级。全部走既有 token，无新颜色字面量；
  `--shadow-N` 是 rgba 颜色，按既有惯例带偏移使用（`0 1px 2px var(--shadow-1)`、
  `0 8px 28px var(--shadow-3)`，与 `.sw-pop` 同款）。追加前逐一核对所有引用 token
  已在 `:root` 定义。
- 新建 4 个组件（本批未接线，Tasks 4-6 各 tab 采用）：
  - `AdmPill.tsx` — 状态胶囊；
  - `StatCard.tsx` — KPI 统计卡；
  - `AdminTable.tsx` — 表格薄封装（uniform thead / rows / empty；cols 支持右对齐列）；
  - `RowMenu.tsx` — ⋯ 行菜单（outside-click + Esc 关闭、模块级 closer 保证同时只开一个、
    danger 项、分隔线、aria-haspopup/expanded）。
- 验证全绿：typecheck（root+web）、测试 glob 8 pass / 0 fail（6 旧 + 2 新）、web build 2.4s。

## 提交

1. `42ba617` feat(web): admin avatar tone/initial pure fns (TDD)
2. `c4ed4f0` feat(web): adm- design-system CSS + RowMenu/StatCard/AdmPill/AdminTable components
3. （本日志）

`web/package-lock.json` 全程未提交（npm 触碰后已 `git checkout --` 恢复）。

## 备注 / 后续

- 组件本批故意不接线 —— Tabs 采用发生在 Tasks 4-6，届时删除各 tab 的 inline styles。
- 测试文件必须留在 `web/src/views/` 单层（CI glob 限制），源码在 `views/admin/` 子目录。
